-- Retention follows the Florida Bar's guidelines for disposing of closed files (read 2026-11-09 from the Bar's
-- "Answers to Frequently Asked Ethics Questions", which summarizes Opinions 81-8 and 63-3; the opinions themselves
-- are not yet read at the source):
--   * no fixed period, except trust accounting records (Rule 5-1.2(f)), contingent-fee contracts and closing
--     statements (Rule 4-1.5(f)(5)) and the insured client's statement of rights (Rule 4-1.8(j)), 6 years each.
--     This practice holds none of those in the workspace (no trust: CLAUDE.md rule 7; no contingent fees).
--   * the length depends on the nature of the matter and the material in the file;
--   * first try to contact the client and obtain directions on disposing of the file;
--   * if the client cannot be reached, review the file, remove original documents and important papers that may
--     later be vital to the client, index them and keep them a reasonable time; dispose of the rest;
--   * protect confidentiality when disposing.
-- So: the client's direction governs; "unreachable" keeps originals for a second, longer period; the attorney
-- marks which documents are originals or important papers (executed originals are marked automatically).

alter table ws.retention_policy add column originals_months integer check (originals_months > 0);
comment on column ws.retention_policy.period_months is 'months after the engagement ends before any purge (attorney judgment; no rule fixes it)';
comment on column ws.retention_policy.originals_months is 'months after the engagement ends that marked originals are kept when the client cannot be reached';

alter table ws.file_closure
  add column client_direction text check (client_direction in ('return','destroy','firm_keep')),
  add column direction_at     timestamptz,
  add column unreachable_at   timestamptz,          -- attorney records that the client could not be reached
  add column contact_log      text,                 -- the attempts made (dates, means); required with unreachable_at
  add column originals_purged_at timestamptz,
  add constraint closure_direction_or_unreachable check (client_direction is null or unreachable_at is null),
  add constraint closure_direction_dated check ((client_direction is null) = (direction_at is null)),
  add constraint closure_unreachable_logged check (unreachable_at is null or (contact_log is not null and length(contact_log) > 0));
comment on column ws.file_closure.notice_sent_at is 'the written request to the client for directions on disposing of the file';

create or replace function ws.check_closure() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if (new.purged_at, new.originals_purged_at) is distinct from (old.purged_at, old.originals_purged_at)
     and current_setting('app.purge', true) is distinct from 'on' then
    raise exception 'purged_at is set by ws.purge_documents() only'; end if;
  if old.originals_purged_at is not null or (old.purged_at is not null and old.unreachable_at is null) then
    raise exception 'a purged file is closed'; end if;
  if new.unreachable_at is not null and new.notice_sent_at is null then
    raise exception 'request the client''s directions before recording the client as unreachable'; end if;
  return new;
end $$;

-- Originals and important papers: executed originals are marked on filing; the attorney marks others on review.
alter table ws.document add column retain_original boolean not null default false;
update ws.document set retain_original = true where kind = 'executed';
create function ws.mark_original() returns trigger language plpgsql as $$
begin if new.kind = 'executed' then new.retain_original := true; end if; return new; end $$;
create trigger mark_original before insert on ws.document for each row execute function ws.mark_original();

-- Purge the session's workspace. Common conditions: attorney; file closed; period set from the rule and passed.
--   client directed "return": the export package was delivered (rule 8); purge everything.
--   client directed "destroy": purge everything.
--   client directed "firm_keep": refuse.
--   client unreachable (after a written request): purge everything except marked originals; a later call, once
--     the originals period has also passed, purges those.
--   no direction and not recorded unreachable: refuse.
-- Contents go; the index, hashes, execution records and audit log stay. Backups age out on the host's schedule.
create or replace function ws.purge_documents() returns integer language plpgsql security definer set search_path = ws as $$
declare cl file_closure; pol retention_policy; n integer; stage text;
begin
  if ws.my_role() is distinct from 'attorney' or not ws.in_scope(ws.cur_ws()) then raise exception 'attorney only'; end if;
  select * into pol from retention_policy;
  if pol.period_months is null then raise exception 'no retention period set: read the governing rule first'; end if;
  select * into cl from file_closure where workspace_id = ws.cur_ws();
  if cl.workspace_id is null then raise exception 'the file is not closed'; end if;
  if cl.originals_purged_at is not null or (cl.purged_at is not null and cl.unreachable_at is null) then raise exception 'already purged'; end if;
  if current_date < cl.engagement_ended_on + make_interval(months => pol.period_months) then
    raise exception 'retention period runs until %', (cl.engagement_ended_on + make_interval(months => pol.period_months))::date; end if;
  if cl.client_direction = 'firm_keep' then raise exception 'the client directed the Firm to keep the file'; end if;
  if cl.client_direction is null and cl.unreachable_at is null then
    raise exception 'obtain the client''s directions first, or record that the client could not be reached (Op. 81-8)'; end if;
  if cl.client_direction = 'return' and cl.export_delivered_at is null then
    raise exception 'deliver the client''s export package first (rule 8)'; end if;

  perform set_config('app.purge', 'on', true);
  if cl.unreachable_at is null then
    stage := 'all';
    update doc_version set content_md = null, bytes = null, blob_source = null, purged_at = now()
      where workspace_id = ws.cur_ws() and purged_at is null;
    get diagnostics n = row_count;
    delete from file_blob where workspace_id = ws.cur_ws();
    update file_closure set purged_at = now() where workspace_id = ws.cur_ws();
  elsif cl.purged_at is null then
    stage := 'all but originals';
    update doc_version v set content_md = null, bytes = null, blob_source = null, purged_at = now()
      from document d where d.id = v.document_id and v.workspace_id = ws.cur_ws() and v.purged_at is null and not d.retain_original;
    get diagnostics n = row_count;
    delete from file_blob b where b.workspace_id = ws.cur_ws()
      and not exists (select 1 from document d where d.source_id = b.source_id and d.retain_original);
    update file_closure set purged_at = now() where workspace_id = ws.cur_ws();
  else
    if pol.originals_months is null then raise exception 'no originals period set'; end if;
    if current_date < cl.engagement_ended_on + make_interval(months => pol.originals_months) then
      raise exception 'originals are kept until %', (cl.engagement_ended_on + make_interval(months => pol.originals_months))::date; end if;
    stage := 'originals';
    update doc_version set content_md = null, bytes = null, blob_source = null, purged_at = now()
      where workspace_id = ws.cur_ws() and purged_at is null;
    get diagnostics n = row_count;
    delete from file_blob where workspace_id = ws.cur_ws();
    update file_closure set originals_purged_at = now() where workspace_id = ws.cur_ws();
  end if;
  perform set_config('app.purge', 'off', true);
  insert into event_log (workspace_id, actor, tbl, op, row_data)
    values (ws.cur_ws(), ws.me(), 'purge', 'PURGE', jsonb_build_object('stage', stage, 'versions', n,
      'direction', cl.client_direction, 'unreachable', cl.unreachable_at is not null, 'rule', pol.rule_cite));
  return n;
end $$;
