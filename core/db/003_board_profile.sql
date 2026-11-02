-- Custom board with the change-order signature step; profile field rules; external system refs.

-- ---------- Profile: field catalog enforces tier and who may fill ----------
alter table ws.profile_value add foreign key (field) references ws.profile_field_def(field);
create function ws.check_profile() returns trigger language plpgsql security definer set search_path = ws as $$
declare d ws.profile_field_def; s ws.source;
begin
  select * into d from ws.profile_field_def where field = new.field;
  if d.tier <> (select tier from ws.workspace where id = new.workspace_id) then
    raise exception 'profile field "%" is kept in the % tier', d.field, d.tier; end if;
  select * into s from ws.source where id = new.source_id;
  if not d.agent_may and (ws.my_role() <> 'attorney' or s.kind <> 'CALL') then
    raise exception 'profile field "%" is recorded by the attorney from the call', d.field; end if;
  return new;
end $$;
create trigger profile_check before insert or update on ws.profile_value
  for each row execute function ws.check_profile();

-- ---------- Board ----------
alter table ws.board_item add foreign key (co_id) references ws.change_order_def(id);
alter table ws.board_item
  add column proposed_price integer check (proposed_price >= 0),
  add column scope_text     text,           -- the written scope the client signs
  add column proposed_at    timestamptz;

-- Attorney-only working notes (scan finding, attorney note). Clients never read these.
create table ws.board_note (
  item_id      uuid primary key references ws.board_item(id),
  workspace_id uuid not null references ws.workspace(id),
  finding      text, attorney_note text
);
alter table ws.board_note enable row level security; alter table ws.board_note force row level security;
create policy a on ws.board_note for all using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select, insert, update on ws.board_note to ws_app;

-- The signed change order: what was approved, by whom, at what price. Immutable.
create table ws.change_order_approval (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references ws.board_item(id),
  workspace_id uuid not null references ws.workspace(id),
  signer       uuid not null references ws.person(id),
  typed_name   text not null check (length(trim(typed_name)) > 1),
  price        integer not null,
  scope_text   text not null,
  digest       text not null,       -- sha256 of scope_text || price, so the record proves what was signed
  signed_at    timestamptz not null default now()
);
alter table ws.change_order_approval enable row level security; alter table ws.change_order_approval force row level security;
create policy read on ws.change_order_approval for select using (ws.in_scope(workspace_id));
grant select on ws.change_order_approval to ws_app;

-- Allowed moves only; price and scope frozen once approved.
create function ws.board_guard() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  -- Identified → Scoped needs proof in the database itself: a signed approval row for this card at this
  -- price (only approve_change_order can write one), or Schedule A included work at price 0.
  if old.col = 'Identified' and new.col = 'Scoped' and not (
       (new.approval_ref = 'Schedule A — included' and new.price = 0
          and exists (select 1 from ws.change_order_def d where d.id = new.co_id and d.schedule = 'A'))
    or exists (select 1 from ws.change_order_approval a
                where a.id::text = new.approval_ref and a.item_id = new.id and a.price = new.price)) then
    raise exception 'a card is scoped only by the client''s signed approval or as Schedule A included work'; end if;
  if old.col <> 'Identified' and (new.price is distinct from old.price or new.scope_text is distinct from old.scope_text) then
    raise exception 'price and scope are fixed once approved; issue a new change order'; end if;
  if new.col <> old.col and not (
       (old.col = 'Identified' and new.col = 'Scoped') or (old.col = 'Scoped' and new.col in ('In progress','Identified')) or
       (old.col = 'In progress' and new.col = 'Done')) then
    raise exception 'board move % → % is not allowed', old.col, new.col; end if;
  if old.col = 'Scoped' and new.col = 'Identified' then   -- withdrawn before work: approval no longer applies
    new.price := null; new.approval_ref := null; new.approved_at := null; new.proposed_at := null; end if;
  return new;
end $$;
create trigger board_guard before update on ws.board_item for each row execute function ws.board_guard();
create function ws.board_insert_guard() returns trigger language plpgsql as $$
begin
  if new.col <> 'Identified' then raise exception 'cards start in Identified'; end if;
  return new;
end $$;
create trigger board_insert_guard before insert on ws.board_item for each row execute function ws.board_insert_guard();

-- Attorney proposes the change order (price + written scope), ordinarily on the weekly call.
create function ws.propose_change_order(p_item uuid, p_price integer, p_scope text) returns void
language plpgsql security invoker as $$
begin
  if p_price is null or p_price <= 0 then raise exception 'a change order needs a price above zero'; end if;
  if length(trim(coalesce(p_scope, ''))) < 10 then raise exception 'a change order needs a written scope'; end if;
  update ws.board_item set proposed_price = p_price, scope_text = p_scope, proposed_at = now()
   where id = p_item and col = 'Identified';
  if not found then raise exception 'card not found or not in Identified'; end if;
end $$;

-- Client signer approves in writing. Security definer: the client cannot update cards directly,
-- so this function checks membership, signer authority and tier itself.
create function ws.approve_change_order(p_item uuid, p_typed_name text) returns uuid
language plpgsql security definer set search_path = ws as $$
declare it ws.board_item; ap uuid;
begin
  select * into it from ws.board_item where id = p_item and workspace_id = ws.cur_ws();
  if it.id is null then raise exception 'card not found'; end if;
  if ws.cur_tier() <> 'entity' then raise exception 'change orders are approved in the entity tier'; end if;
  if not exists (select 1 from ws.membership where person_id = ws.me() and workspace_id = it.workspace_id and signer) then
    raise exception 'only an authorized signer may approve a change order'; end if;
  if it.col <> 'Identified' or it.proposed_at is null then raise exception 'no proposed change order to approve'; end if;
  insert into ws.change_order_approval (item_id, workspace_id, signer, typed_name, price, scope_text, digest)
  values (it.id, it.workspace_id, ws.me(), p_typed_name, it.proposed_price, it.scope_text,
          encode(sha256(convert_to(it.scope_text || '|' || it.proposed_price, 'UTF8')), 'hex'))
  returning id into ap;
  update ws.board_item set col = 'Scoped', price = it.proposed_price, approval_ref = ap::text, approved_at = now() where id = it.id;
  return ap;
end $$;

-- Schedule A work needs no change order; the attorney scopes it as included, price 0.
create function ws.scope_included(p_item uuid) returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from ws.board_item b join ws.change_order_def d on d.id = b.co_id
                  where b.id = p_item and d.schedule = 'A') then
    raise exception 'only Schedule A items are included work'; end if;
  update ws.board_item set col = 'Scoped', price = 0, approval_ref = 'Schedule A — included', approved_at = now() where id = p_item;
end $$;
grant execute on function ws.propose_change_order(uuid, integer, text), ws.approve_change_order(uuid, text), ws.scope_included(uuid) to ws_app;

-- Budget (client-visible). Allowances are estimates, never payable.
create view ws.budget with (security_invoker = true) as
  select w.id as workspace_id, c.onboarding_fee,
    coalesce(sum(b.price) filter (where b.col <> 'Identified'), 0) as approved,
    coalesce(sum(b.price) filter (where b.col = 'Done'), 0)        as completed,
    coalesce(sum(b.allowance) filter (where b.col = 'Identified'), 0) as allowances
  from ws.workspace w join ws.client c on c.id = w.client_id
  left join ws.board_item b on b.workspace_id = w.id
  where w.id = ws.cur_ws() group by w.id, c.onboarding_fee;
grant select on ws.budget to ws_app;

-- ---------- External systems (LEAP, WealthCounsel) ----------
-- One LEAP matter per workspace (entity engagement / personal engagement). Ids only; no credentials here.
create table ws.external_ref (
  workspace_id uuid not null references ws.workspace(id),
  system       text not null check (system in ('leap','wealthcounsel')),
  kind         text not null check (kind in ('matter','contact','document','invoice')),
  local_id     text not null,
  external_id  text not null,
  synced_at    timestamptz not null default now(),
  primary key (workspace_id, system, kind, local_id)
);
alter table ws.external_ref enable row level security; alter table ws.external_ref force row level security;
create policy a on ws.external_ref for all using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent')) with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
grant select, insert, update on ws.external_ref to ws_app;
