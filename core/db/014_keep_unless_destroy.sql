-- Retention, revised 2026-11-10: keep digital files indefinitely; purge only on the client's direction to destroy.
-- Basis: Opinions 81-8 and 63-3 permit disposal and never require it; Opinion 06-1 allows electronic-only storage if
-- the files stay "readily reproducible and protected from inadvertent modification, degradation or destruction";
-- § 501.171(2) requires reasonable security for electronic personal information for as long as it is held, and
-- § 501.171(8) governs disposal only "when the records are no longer to be retained". With no repose for legal
-- malpractice (§ 95.11(5)(b)), the file is the Firm's record. The client's direction controls (Op. 81-8).
--   destroy:   purge everything, at once (no waiting period).
--   return:    deliver the export package; the Firm keeps its copy.
--   firm_keep, unreachable, or no direction: keep.
comment on table ws.retention_policy is 'unused since 014: no time-based purge';

create or replace function ws.purge_documents() returns integer language plpgsql security definer set search_path = ws as $$
declare cl file_closure; n integer;
begin
  if ws.my_role() is distinct from 'attorney' or not ws.in_scope(ws.cur_ws()) then raise exception 'attorney only'; end if;
  select * into cl from file_closure where workspace_id = ws.cur_ws();
  if cl.workspace_id is null then raise exception 'the file is not closed'; end if;
  if cl.purged_at is not null or cl.originals_purged_at is not null then raise exception 'already purged'; end if;
  if cl.client_direction is distinct from 'destroy' then
    raise exception 'files are kept unless the client directs destruction (current: %)', coalesce(cl.client_direction, case when cl.unreachable_at is not null then 'unreachable' else 'no direction' end); end if;
  perform set_config('app.purge', 'on', true);
  update doc_version set content_md = null, bytes = null, blob_source = null, purged_at = now()
    where workspace_id = ws.cur_ws() and purged_at is null;
  get diagnostics n = row_count;
  delete from file_blob where workspace_id = ws.cur_ws();
  update file_closure set purged_at = now(), originals_purged_at = now() where workspace_id = ws.cur_ws();
  perform set_config('app.purge', 'off', true);
  insert into event_log (workspace_id, actor, tbl, op, row_data)
    values (ws.cur_ws(), ws.me(), 'purge', 'PURGE', jsonb_build_object('stage', 'client directed destruction', 'versions', n,
      'direction_at', cl.direction_at, 'basis', 'Op. 81-8; § 501.171(8)'));
  return n;
end $$;

-- A destroy direction is the client's written instruction: it needs the request for directions on file first.
create or replace function ws.check_closure() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if (new.purged_at, new.originals_purged_at) is distinct from (old.purged_at, old.originals_purged_at)
     and current_setting('app.purge', true) is distinct from 'on' then
    raise exception 'purged_at is set by ws.purge_documents() only'; end if;
  if old.purged_at is not null then raise exception 'a purged file is closed'; end if;
  if new.unreachable_at is not null and new.notice_sent_at is null then
    raise exception 'request the client''s directions before recording the client as unreachable'; end if;
  return new;
end $$;

-- Integrity and readability checks (Op. 06-1: "readily reproducible"). Run on a schedule; attorney-only results.
create table ws.integrity_check (
  id          bigint generated always as identity primary key,
  workspace_id uuid not null,
  version_id  uuid not null,
  checked_at  timestamptz not null default now(),
  hash_ok     boolean not null,
  opens_ok    boolean not null,
  detail      text,
  foreign key (workspace_id, version_id) references ws.doc_version(workspace_id, id)
);
alter table ws.integrity_check enable row level security;
create policy read on ws.integrity_check for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.integrity_check for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select, insert on ws.integrity_check to ws_app;
grant usage on sequence ws.integrity_check_id_seq to ws_app;
