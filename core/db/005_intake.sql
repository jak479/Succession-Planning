-- Build item 3: intake agent (entity tier). Conflict check first; ask-last pulls; file drop; agent turns.
create extension if not exists pg_trgm;

-- ---------- Conflict check (intake-agent-spec § Sequence 1; Rule 4-1.18 for what follows) ----------
-- Firm-wide name index. Firm-wide on purpose: a conflict check must see every client. Attorney only.
create function ws.norm_name(t text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(lower(t),
    '\m(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|p\.?a|p\.?l\.?l\.?c|ltd|l\.?l\.?p|l\.?p|the)\M\.?', ' ', 'g'),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;
create table ws.firm_party (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid references ws.client(id),           -- null for adverse parties not tied to one client file
  name      text not null,
  norm      text generated always as (ws.norm_name(name)) stored,
  relation  text not null check (relation in ('client_entity','owner','co_owner','spouse','successor','family','adverse','other')),
  added_at  timestamptz not null default now()
);
create index firm_party_trgm on ws.firm_party using gin (norm gin_trgm_ops);

create table ws.conflict_check (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references ws.client(id),
  names        jsonb not null,                        -- [{name, relation}]
  status       text not null default 'pending' check (status in ('pending','cleared','declined')),
  requested_by uuid not null default ws.me() references ws.person(id),
  requested_at timestamptz not null default now(),
  decided_by   uuid references ws.person(id),
  decided_at   timestamptz
);
create table ws.conflict_hit (
  check_id     uuid not null references ws.conflict_check(id),
  party_id     uuid not null references ws.firm_party(id),
  queried_name text not null,
  similarity   real not null,
  primary key (check_id, party_id, queried_name)
);

alter table ws.firm_party enable row level security;     alter table ws.firm_party force row level security;
alter table ws.conflict_check enable row level security; alter table ws.conflict_check force row level security;
alter table ws.conflict_hit enable row level security;   alter table ws.conflict_hit force row level security;
create policy a on ws.firm_party for all using (ws.my_role() = 'attorney') with check (ws.my_role() = 'attorney');
-- Members see the status of their own client's check (pending / cleared / declined), never the hits.
create policy read on ws.conflict_check for select using (
  exists (select 1 from ws.workspace w where w.client_id = conflict_check.client_id and ws.in_scope(w.id)));
create policy a on ws.conflict_hit for select using (ws.my_role() = 'attorney');
grant select, insert on ws.firm_party to ws_app;
grant select on ws.conflict_check, ws.conflict_hit to ws_app;

-- The agent (or attorney) submits names; hits are computed against every other client and stored for the attorney.
create function ws.request_conflict_check(p_names jsonb) returns uuid
language plpgsql security definer set search_path = ws, public as $$
declare cid uuid; chk uuid; n jsonb;
begin
  if ws.my_role() not in ('attorney','agent') then raise exception 'conflict checks are run by the agent or the attorney'; end if;
  select client_id into cid from ws.workspace where id = ws.cur_ws() and ws.in_scope(id);
  if cid is null then raise exception 'workspace not in scope'; end if;
  if jsonb_array_length(p_names) = 0 then raise exception 'no names to check'; end if;
  insert into ws.conflict_check (client_id, names) values (cid, p_names) returning id into chk;
  for n in select * from jsonb_array_elements(p_names) loop
    insert into ws.conflict_hit (check_id, party_id, queried_name, similarity)
    select chk, f.id, n->>'name', similarity(f.norm, ws.norm_name(n->>'name'))
      from ws.firm_party f
     where (f.client_id is distinct from cid)
       and (f.norm = ws.norm_name(n->>'name') or similarity(f.norm, ws.norm_name(n->>'name')) >= 0.5)
    on conflict do nothing;
  end loop;
  return chk;
end $$;

-- Only the attorney decides. Clearing adds this client's names to the firm index for future checks.
create function ws.decide_conflict(p_check uuid, p_decision text) returns void
language plpgsql security definer set search_path = ws, public as $$
declare c ws.conflict_check; n jsonb;
begin
  if ws.my_role() <> 'attorney' then raise exception 'only the attorney decides a conflict check'; end if;
  if p_decision not in ('cleared','declined') then raise exception 'decision must be cleared or declined'; end if;
  select * into c from ws.conflict_check where id = p_check;
  if c.id is null or not exists (select 1 from ws.workspace w where w.client_id = c.client_id and ws.in_scope(w.id)) then raise exception 'check not found'; end if;
  if c.status <> 'pending' then raise exception 'check already decided'; end if;
  update ws.conflict_check set status = p_decision, decided_by = ws.me(), decided_at = now() where id = p_check;
  if p_decision = 'cleared' then
    for n in select * from jsonb_array_elements(c.names) loop
      insert into ws.firm_party (client_id, name, relation) values (c.client_id, n->>'name', coalesce(n->>'relation','other'));
    end loop;
  end if;
end $$;
grant execute on function ws.request_conflict_check(jsonb), ws.decide_conflict(uuid, text) to ws_app;

create function ws.client_cleared(w uuid) returns boolean language sql stable security definer set search_path = ws as $$
  select exists (select 1 from ws.conflict_check c join ws.workspace x on x.client_id = c.client_id where x.id = w and c.status = 'cleared')
$$;

-- No substantive intake before the attorney clears the check: intake answers and front-door questions are refused.
create function ws.require_cleared() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if ws.my_role() <> 'attorney' and not ws.client_cleared(new.workspace_id) then
    raise exception 'conflict check not cleared: no substantive intake yet'; end if;
  return new;
end $$;
create trigger require_cleared before insert on ws.intake_status for each row execute function ws.require_cleared();
create trigger require_cleared before insert on ws.question for each row execute function ws.require_cleared();

-- ---------- File drop ----------
create table ws.file_blob (
  source_id    uuid primary key,
  workspace_id uuid not null references ws.workspace(id),
  filename     text not null,
  mime         text not null,
  bytes        bytea not null,
  sha256       text not null,
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);
alter table ws.file_blob enable row level security; alter table ws.file_blob force row level security;
create policy read on ws.file_blob for select using (ws.in_scope(workspace_id) and (ws.my_role() in ('attorney','agent')
  or exists (select 1 from ws.source s where s.id = source_id and s.created_by = ws.me())));
create policy ins on ws.file_blob for insert with check (ws.in_scope(workspace_id));
grant select, insert on ws.file_blob to ws_app;
-- Which intake item an upload was sent for (so the engine can set its status after reading it).
alter table ws.source add column intake_item text references ws.intake_def(id);

-- ---------- Public-record pulls (checklist mode) ----------
create table ws.record_pull (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  record_id    text not null,                         -- core/src/intake.ts PUBLIC_RECORDS id
  query        text not null,                         -- the name searched
  status       text not null default 'to_do' check (status in ('to_do','found','nothing_found','not_applicable')),
  source_id    uuid,                                  -- the PUB source holding the result, when found
  done_by      uuid references ws.person(id),
  done_at      timestamptz,
  unique (workspace_id, record_id, query),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id),
  check ((status = 'found') = (source_id is not null))
);
alter table ws.record_pull enable row level security; alter table ws.record_pull force row level security;
create policy read on ws.record_pull for select using (ws.in_scope(workspace_id));
create policy w on ws.record_pull for all using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'))
  with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
grant select, insert, update on ws.record_pull to ws_app;

-- ---------- Intake conversation ----------
create table ws.intake_turn (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references ws.workspace(id),
  person_id    uuid not null default ws.me() references ws.person(id),
  speaker      text not null check (speaker in ('client','agent')),
  body         text,                                  -- null when withheld (health or capacity)
  withheld     boolean not null default false,
  item_id      text references ws.intake_def(id),     -- the item an agent question asks about
  deferred     boolean not null default false,        -- agent turn deferred an advice request to the call
  at           timestamptz not null default now(),
  check (withheld = (body is null))
);
create table ws.intake_turn_gate (
  turn_id      bigint primary key references ws.intake_turn(id),
  workspace_id uuid not null references ws.workspace(id),
  gate         jsonb not null,
  flag         text                                   -- stop-rule reason, when the line stopped
);
alter table ws.intake_turn enable row level security;      alter table ws.intake_turn force row level security;
alter table ws.intake_turn_gate enable row level security; alter table ws.intake_turn_gate force row level security;
create policy read on ws.intake_turn for select using (ws.in_scope(workspace_id));
create policy ins on ws.intake_turn for insert with check (ws.in_scope(workspace_id) and (speaker = 'agent') = (ws.my_role() = 'agent'));
create policy read on ws.intake_turn_gate for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy ins on ws.intake_turn_gate for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'agent');
grant select, insert on ws.intake_turn, ws.intake_turn_gate to ws_app;
create trigger require_cleared before insert on ws.intake_turn for each row execute function ws.require_cleared();
