-- Litigation hold (decided 2026-11-10). While a hold is active the file cannot be purged, even on the client's
-- direction to destroy. Holds are the attorney's: placed with a reason, released with a reason, never deleted.
-- Clients do not see holds (the reason may concern a claim involving the client or the Firm).
create table ws.legal_hold (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references ws.workspace(id),
  reason         text not null check (length(reason) > 0),
  placed_by      uuid not null default ws.me() references ws.person(id),
  placed_at      timestamptz not null default now(),
  released_by    uuid references ws.person(id),
  released_at    timestamptz,
  release_reason text,
  check ((released_at is null) = (released_by is null) and (released_at is null) = (release_reason is null))
);
alter table ws.legal_hold enable row level security;
create policy read on ws.legal_hold for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.legal_hold for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy u on ws.legal_hold for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney')
  with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select, insert, update on ws.legal_hold to ws_app;
create function ws.check_hold() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if tg_op = 'INSERT' then
    if new.released_at is not null then raise exception 'place the hold, then release it'; end if;
    return new; end if;
  if old.released_at is not null then raise exception 'a released hold is final; place a new one'; end if;
  if (to_jsonb(new) - array['released_by','released_at','release_reason']) is distinct from
     (to_jsonb(old) - array['released_by','released_at','release_reason']) then
    raise exception 'a hold can only be released'; end if;
  return new;
end $$;
create trigger check_hold before insert or update on ws.legal_hold for each row execute function ws.check_hold();
create trigger no_delete before delete on ws.legal_hold for each row execute function ws.no_delete();
create trigger a after insert or update or delete on ws.legal_hold for each row execute function ws.audit();

-- Purge refuses while any hold on the workspace is active.
create function ws.purge_hold_guard() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if new.purged_at is not null and old.purged_at is null
     and exists (select 1 from legal_hold where workspace_id = new.workspace_id and released_at is null) then
    raise exception 'litigation hold in place: the file cannot be purged'; end if;
  return new;
end $$;
create trigger purge_hold_guard before update on ws.file_closure for each row execute function ws.purge_hold_guard();
