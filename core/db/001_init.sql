-- Build item 1: shared state file, per-client workspace, two isolated tiers, roles.
-- Enforcement lives here (RLS + triggers) so no caller (UI, agent, script) can bypass it.
-- Session contract: every transaction sets app.person_id and app.workspace_id (SET LOCAL).
-- A session sees exactly one workspace. That is the tier-isolation primitive (rule 3):
-- an agent run, a UI request, or the attorney's view is always inside one tier.

create extension if not exists pgcrypto;
create schema ws;

-- ---------- People, clients, workspaces ----------
create table ws.person (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('attorney','client','agent'))
);
create table ws.client (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  onboarding_fee integer check (onboarding_fee >= 0)   -- Phase 1 flat fee from the signed letter
);
create table ws.workspace (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references ws.client(id),
  tier      text not null check (tier in ('entity','owner')),
  unique (client_id, tier)
);
create table ws.membership (
  person_id    uuid not null references ws.person(id),
  workspace_id uuid not null references ws.workspace(id),
  signer       boolean not null default false,          -- authorized to approve change orders (Rule 4-1.13 officer)
  primary key (person_id, workspace_id)
);

-- ---------- Catalog (seeded from core/src/catalog.ts) ----------
create table ws.node_def (
  id text primary key,
  kind text not null check (kind in ('contingency','coordination'))
);
create table ws.intake_def (
  id       text primary key,
  kind     text not null check (kind in ('doc','fact')),
  tier     text not null check (tier in ('entity','owner')),
  core     boolean not null,
  asked_by text not null check (asked_by in ('agent','attorney'))
);

create table ws.change_order_def (
  id text primary key, name text not null, low integer not null, high integer not null,
  clears text[] not null, schedule text not null check (schedule in ('A','B'))
);
create table ws.profile_field_def (
  field     text primary key,
  section   text not null check (section in ('Business','Owner')),
  tier      text not null check (tier in ('entity','owner')),
  agent_may boolean not null      -- false: attorney records it from the call
);

-- ---------- Session helpers ----------
create function ws.me() returns uuid language sql stable as
  $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;
create function ws.cur_ws() returns uuid language sql stable as
  $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create function ws.my_role() returns text language sql stable security definer set search_path = ws as
  $$ select role from ws.person where id = ws.me() $$;
create function ws.cur_tier() returns text language sql stable security definer set search_path = ws as
  $$ select tier from ws.workspace where id = ws.cur_ws() $$;
-- In scope: the row is in the session's workspace, and the person is the attorney or a member of it.
create function ws.in_scope(w uuid) returns boolean language sql stable security definer set search_path = ws as
  $$ select w = ws.cur_ws() and (
       ws.my_role() = 'attorney'
       or exists (select 1 from ws.membership m where m.person_id = ws.me() and m.workspace_id = w)) $$;

-- ---------- State file ----------
-- Sources: every profile value and every received document points at one (rule 6).
create table ws.source (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  label        text not null,                      -- S0, S1 … shown in citations
  kind         text not null check (kind in ('PUB','DOC','API','CALL','AGENT','CLIENT')),
  -- PUB public record · DOC document in hand · API consented link · CALL attorney on the call
  -- AGENT agent derived · CLIENT client's own description (shows as "described")
  name         text not null,
  citation     text,                               -- record id / URL / page-section
  readable     boolean,                            -- DOC only: false = received, unread
  pulled_at    timestamptz not null default now(),
  created_by   uuid not null default ws.me() references ws.person(id),
  unique (workspace_id, id),
  unique (workspace_id, label),
  check ((kind = 'DOC') = (readable is not null))
);

-- Node status. Contingency nodes live only in the entity tier. Coordination (C) status lives in
-- the entity tier as status only; its contents live in the owner tier (coordination_detail).
create table ws.node_status (
  workspace_id uuid not null references ws.workspace(id),
  node_id      text not null references ws.node_def(id),
  status       text not null check (status in ('green','amber','red','planned','unassessed')),
  fact         text,                               -- the fact that set it (intake Part E.4)
  source_id    uuid,
  set_by       uuid not null default ws.me() references ws.person(id),
  set_at       timestamptz not null default now(),
  primary key (workspace_id, node_id),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);
create table ws.coordination_detail (
  workspace_id uuid not null references ws.workspace(id),
  node_id      text not null references ws.node_def(id),
  personal_side text not null,                     -- what the personal document provides
  source_id    uuid not null,
  primary key (workspace_id, node_id),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);

create table ws.intake_status (
  workspace_id uuid not null references ws.workspace(id),
  item_id      text not null references ws.intake_def(id),
  status       text not null check (status in ('missing','requested','stated','received','received_unread')),
  source_id    uuid,
  set_by       uuid not null default ws.me() references ws.person(id),
  set_at       timestamptz not null default now(),
  primary key (workspace_id, item_id),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id),
  check (status in ('missing','requested') or source_id is not null)
);

create table ws.profile_value (
  workspace_id uuid not null references ws.workspace(id),
  field        text not null,
  value        text not null,
  source_id    uuid not null,                      -- rule 6: no unsourced value
  set_at       timestamptz not null default now(),
  primary key (workspace_id, field),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);
-- Conflicts are listed, never resolved by the system.
create table ws.conflict (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  field        text not null,
  value_a text not null, source_a uuid not null,
  value_b text not null, source_b uuid not null,
  foreign key (workspace_id, source_a) references ws.source(workspace_id, id),
  foreign key (workspace_id, source_b) references ws.source(workspace_id, id)
);

-- Open Items board. Money in whole dollars. No hours column anywhere.
create table ws.board_item (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references ws.workspace(id),
  co_id          text,
  title          text not null,
  clears         text[] not null,
  col            text not null default 'Identified' check (col in ('Identified','Scoped','In progress','Done')),
  allowance      integer not null default 0 check (allowance >= 0),  -- estimate; never collected
  price          integer check (price >= 0),
  approval_ref   text,          -- the client's written approval (signed CO id); required past Identified
  approved_at    timestamptz,
  check (col = 'Identified' or (price is not null and approval_ref is not null and approved_at is not null))
);

-- Append-only audit trail.
create table ws.event_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references ws.workspace(id),
  actor uuid, tbl text not null, op text not null, row_data jsonb not null,
  at timestamptz not null default now()
);

-- ---------- Integrity triggers ----------
create function ws.check_node_status() returns trigger language plpgsql security definer set search_path = ws as $$
declare t text; k text;
begin
  select tier into t from ws.workspace where id = new.workspace_id;
  select kind into k from ws.node_def where id = new.node_id;
  if t <> 'entity' then raise exception 'node status is kept in the entity tier only'; end if;
  return new;
end $$;
create trigger node_status_tier before insert or update on ws.node_status
  for each row execute function ws.check_node_status();

create function ws.check_coordination_detail() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if (select tier from ws.workspace where id = new.workspace_id) <> 'owner' then
    raise exception 'coordination contents are kept in the owner tier only'; end if;
  if (select kind from ws.node_def where id = new.node_id) <> 'coordination' then
    raise exception 'only C nodes have coordination contents'; end if;
  return new;
end $$;
create trigger coordination_detail_tier before insert or update on ws.coordination_detail
  for each row execute function ws.check_coordination_detail();

-- Intake: tier match; rule 4 (C-2–C-7 attorney only, recorded from the call); rule 6 (verification).
create function ws.check_intake() returns trigger language plpgsql security definer set search_path = ws as $$
declare d ws.intake_def; s ws.source; t text;
begin
  select * into d from ws.intake_def where id = new.item_id;
  select tier into t from ws.workspace where id = new.workspace_id;
  if d.tier <> t then raise exception 'intake item % belongs to the % tier', d.id, d.tier; end if;
  if d.asked_by = 'attorney' and ws.my_role() <> 'attorney' then
    raise exception 'intake item % is asked only by the attorney on the call', d.id; end if;
  if new.source_id is not null then select * into s from ws.source where id = new.source_id; end if;
  if d.asked_by = 'attorney' and new.status = 'stated' and s.kind <> 'CALL' then
    raise exception 'intake item % must be recorded from the call', d.id; end if;
  if d.kind = 'fact' and new.status in ('received','received_unread') then
    raise exception 'an answer is stated, not received'; end if;
  if d.kind = 'doc' and new.status = 'stated' then
    raise exception 'a document is received, not stated'; end if;
  if new.status = 'received' and not (s.kind = 'DOC' and s.readable) then
    raise exception 'received requires a readable document in hand'; end if;
  if new.status = 'received_unread' and not (s.kind = 'DOC' and not s.readable) then
    raise exception 'received, unread requires an unreadable document'; end if;
  return new;
end $$;
create trigger intake_check before insert or update on ws.intake_status
  for each row execute function ws.check_intake();

-- Sources: CALL only by the attorney.
create function ws.check_source() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if new.kind = 'CALL' and ws.my_role() <> 'attorney' then raise exception 'CALL sources are the attorney''s'; end if;
  return new;
end $$;
create trigger source_check before insert or update on ws.source
  for each row execute function ws.check_source();

-- Board: Done ⇒ cleared nodes green; only forward/back moves the loop allows.
create function ws.board_move() returns trigger language plpgsql security definer set search_path = ws as $$
declare n text;
begin
  if tg_op = 'UPDATE' and old.col = 'Done' and new.col <> 'Done' then raise exception 'Done cards do not move'; end if;
  if new.col = 'Done' and (tg_op = 'INSERT' or old.col <> 'Done') then
    foreach n in array new.clears loop
      insert into ws.node_status (workspace_id, node_id, status, fact, set_by)
      values (new.workspace_id, n, 'green', 'Cleared by board item ' || new.title, ws.me())
      on conflict (workspace_id, node_id) do update set status = 'green', fact = excluded.fact, set_by = excluded.set_by, set_at = now();
    end loop;
  end if;
  return new;
end $$;
create trigger board_move after insert or update on ws.board_item
  for each row execute function ws.board_move();

create function ws.audit() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  insert into ws.event_log (workspace_id, actor, tbl, op, row_data)
  values (coalesce(new.workspace_id, old.workspace_id), ws.me(), tg_table_name, tg_op, to_jsonb(coalesce(new, old)));
  return null;
end $$;
create trigger a after insert or update or delete on ws.node_status   for each row execute function ws.audit();
create trigger a after insert or update or delete on ws.intake_status for each row execute function ws.audit();
create trigger a after insert or update or delete on ws.profile_value for each row execute function ws.audit();
create trigger a after insert or update or delete on ws.board_item    for each row execute function ws.audit();

-- ---------- Row-level security ----------
do $$ declare t text; begin
  foreach t in array array['source','node_status','coordination_detail','intake_status','profile_value','conflict','board_item','event_log'] loop
    execute format('alter table ws.%I enable row level security', t);
    execute format('create policy read on ws.%I for select using (ws.in_scope(workspace_id))', t);
  end loop;
end $$;

-- Who writes what. Attorney: everything in scope. Agent: sources, profile, conflicts, agent-askable intake.
-- Client: document/description sources and agent-askable intake answers. Nobody else sets node status or moves cards.
-- A client upload enters unread; only the agent (after server OCR) or the attorney marks it readable.
create policy w on ws.source for insert with check (ws.in_scope(workspace_id) and (ws.my_role() <> 'client' or (kind = 'CLIENT' or (kind = 'DOC' and readable = false))));
create policy u on ws.source for update using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent')) with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
create policy w on ws.node_status for all using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.coordination_detail for all using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.intake_status for all using (ws.in_scope(workspace_id)) with check (ws.in_scope(workspace_id));
create policy w on ws.profile_value for all using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent')) with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
create policy w on ws.conflict for insert with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
create policy w on ws.board_item for all using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
-- event_log: no write policy; only the security-definer audit trigger inserts.

-- Catalog and identity tables: readable, not writable, by the app role.
do $$ begin if not exists (select from pg_roles where rolname = 'ws_app') then create role ws_app nologin; end if; end $$;  -- cluster-wide; shared by databases
-- Requests run as ws_app (SET LOCAL ROLE), so row-level security always applies to them. The owner that runs these
-- migrations is exempt (no FORCE), which is what lets the checked SECURITY DEFINER functions and triggers work on a
-- managed database whose owner is not a superuser (e.g. Cloud SQL). The owner must be able to SET ROLE ws_app.
grant ws_app to current_user;
grant usage on schema ws to ws_app;
grant select on ws.person, ws.client, ws.workspace, ws.membership, ws.node_def, ws.intake_def, ws.change_order_def, ws.profile_field_def to ws_app;
grant select, insert, update on ws.source, ws.node_status, ws.coordination_detail, ws.intake_status, ws.profile_value, ws.board_item to ws_app;
grant select, insert on ws.conflict to ws_app;
grant select on ws.event_log to ws_app;

-- Profile view with the verification flag the UI shows (rule 6).
create view ws.profile_view with (security_invoker = true) as
  select p.workspace_id, p.field, p.value, s.label as source, s.kind,
         case s.kind when 'CLIENT' then 'described' when 'DOC' then case when s.readable then 'document' else 'unread' end
                     when 'PUB' then 'public record' when 'API' then 'connected system' when 'CALL' then 'attorney call' else 'agent' end as basis
  from ws.profile_value p join ws.source s on s.id = p.source_id;
grant select on ws.profile_view to ws_app;

-- Identity tables: a session sees only its own workspace, its client, and the people in it.
-- Without this, any signed-in person could list every client and person in the firm.
alter table ws.workspace  enable row level security;
alter table ws.client     enable row level security;
alter table ws.membership enable row level security;
alter table ws.person     enable row level security;
create policy read on ws.workspace  for select using (ws.in_scope(id));
create policy read on ws.client     for select using (exists (select 1 from ws.workspace w where w.client_id = client.id and ws.in_scope(w.id)));
create policy read on ws.membership for select using (ws.in_scope(workspace_id));
create policy read on ws.person     for select using (id = ws.me() or exists (select 1 from ws.membership m where m.person_id = person.id and ws.in_scope(m.workspace_id)));
