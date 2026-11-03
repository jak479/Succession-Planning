-- Estimate and offer terms on board cards (Rule 4-7.14(a)(7); docs/design/marketing-copy.md rule 12).
-- An estimate or change-order price shown to the client states what else the client may owe and the date it is good through,
-- at least 90 days out. Before that date the figure may be lowered, never raised.

alter table ws.board_item
  add column estimate_good_through date,   -- the allowance (estimate) shown to the client is good through this date
  add column offered_price        integer check (offered_price >= 0),  -- last change-order price offered to the client
  add column offer_good_through   date,     -- the offered price is honored through this date
  add column other_costs          text;     -- filing or third-party costs the client may owe for this work, as stated by the attorney
alter table ws.change_order_approval add column other_costs text;

create function ws.estimate_terms() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.allowance is distinct from old.allowance then
    if tg_op = 'UPDATE' and new.allowance > old.allowance and old.estimate_good_through >= current_date then
      raise exception 'the estimate of $% is good through %; it can be lowered, not raised, before then', old.allowance, old.estimate_good_through;
    end if;
    new.estimate_good_through := greatest(coalesce(new.estimate_good_through, current_date + 90), current_date + 90);
  end if;
  return new;
end $$;
create trigger board_estimate_terms before insert or update of allowance on ws.board_item
  for each row execute function ws.estimate_terms();

drop function ws.propose_change_order(uuid, integer, text);
create function ws.propose_change_order(p_item uuid, p_price integer, p_scope text, p_other_costs text, p_good_through date default null) returns void
language plpgsql security invoker as $$
declare it ws.board_item; gt date := greatest(coalesce(p_good_through, current_date + 90), current_date + 90);
begin
  if p_price is null or p_price <= 0 then raise exception 'a change order needs a price above zero'; end if;
  if length(trim(coalesce(p_scope, ''))) < 10 then raise exception 'a change order needs a written scope'; end if;
  if length(trim(coalesce(p_other_costs, ''))) < 2 then raise exception 'state any filing or third-party costs the client may owe, or "None"'; end if;
  select * into it from ws.board_item where id = p_item and col = 'Identified';
  if it.id is null then raise exception 'card not found or not in Identified'; end if;
  if it.offered_price is not null and it.offer_good_through >= current_date and p_price > it.offered_price then
    raise exception 'the offered price of $% is honored through %; it can be lowered, not raised, before then', it.offered_price, it.offer_good_through;
  end if;
  update ws.board_item set proposed_price = p_price, scope_text = p_scope, other_costs = p_other_costs, proposed_at = now(),
         offered_price = p_price, offer_good_through = greatest(gt, coalesce(it.offer_good_through, gt))
   where id = p_item;
end $$;

create or replace function ws.approve_change_order(p_item uuid, p_typed_name text) returns uuid
language plpgsql security definer set search_path = ws as $$
declare it ws.board_item; ap uuid;
begin
  select * into it from ws.board_item where id = p_item and workspace_id = ws.cur_ws();
  if it.id is null then raise exception 'card not found'; end if;
  if ws.cur_tier() <> 'entity' then raise exception 'change orders are approved in the entity tier'; end if;
  if not exists (select 1 from ws.membership where person_id = ws.me() and workspace_id = it.workspace_id and signer) then
    raise exception 'only an authorized signer may approve a change order'; end if;
  if it.col <> 'Identified' or it.proposed_at is null then raise exception 'no proposed change order to approve'; end if;
  if it.offer_good_through < current_date then
    raise exception 'this change order was offered through %; it needs to be offered again before it can be approved', it.offer_good_through; end if;
  insert into ws.change_order_approval (item_id, workspace_id, signer, typed_name, price, scope_text, other_costs, digest)
  values (it.id, it.workspace_id, ws.me(), p_typed_name, it.proposed_price, it.scope_text, it.other_costs,
          encode(sha256(convert_to(it.scope_text || '|' || it.proposed_price || '|' || coalesce(it.other_costs, ''), 'UTF8')), 'hex'))
  returning id into ap;
  update ws.board_item set col = 'Scoped', price = it.proposed_price, approval_ref = ap::text, approved_at = now() where id = it.id;
  return ap;
end $$;

grant execute on function ws.propose_change_order(uuid, integer, text, text, date) to ws_app;
