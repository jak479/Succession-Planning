-- Estimates state other costs too (Rule 4-7.14(a)(7): disclose "all fees and expenses for which the client might be liable").
-- Any estimate above zero needs the attorney's statement of filing or third-party costs ("None" allowed).
-- Like the estimate itself, the statement is fixed through the estimate's good-through date.

alter table ws.board_item add column estimate_costs text;

create or replace function ws.estimate_terms() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.allowance is distinct from old.allowance then
    if tg_op = 'UPDATE' and new.allowance > old.allowance and old.estimate_good_through >= current_date then
      raise exception 'the estimate of $% is good through %; it can be lowered, not raised, before then', old.allowance, old.estimate_good_through;
    end if;
    new.estimate_good_through := greatest(coalesce(new.estimate_good_through, current_date + 90), current_date + 90);
  end if;
  if tg_op = 'UPDATE' and new.estimate_costs is distinct from old.estimate_costs and old.estimate_costs is not null
     and old.estimate_good_through >= current_date then
    raise exception 'the costs stated with this estimate are fixed through %', old.estimate_good_through;
  end if;
  if new.allowance > 0 and length(trim(coalesce(new.estimate_costs, ''))) < 2 then
    raise exception 'an estimate needs a statement of any filing or third-party costs the client may owe, or "None"';
  end if;
  return new;
end $$;
drop trigger board_estimate_terms on ws.board_item;
create trigger board_estimate_terms before insert or update of allowance, estimate_costs on ws.board_item
  for each row execute function ws.estimate_terms();
