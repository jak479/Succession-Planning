-- (1) Filing an executed original turns green the nodes that document alone satisfies (decided 2026-11-08).
-- (2) Retention: purge a closed file's contents after a set period, once the client has its export (decided 2026-11-08).
--     The period is unset until the governing Florida Bar text is read; until then purge refuses.

-- ---------- (1) Auto-green ----------
-- Per template: node → signatures that must be on the executed copy for the document alone to satisfy the node.
-- OA amendment, from the node red rules in core/src/catalog.ts:
--   N0 "clause unsigned, or incapacity standard undefined" → signed by the Principal and all members.
--   N2 "... document unsigned; manager consent not on file" → also the Interim Manager's consent.
--   N3 "no alternate" → also the Alternate's consent (stricter than the red rule: the alternate has consented).
-- Not here: N4, N5, N14, N15a–c need facts or papers beyond this document (signatory card, reserve balance,
-- information list, branch instructions). The rider is owner-tier; node status is entity-tier only (rule 3), so the
-- attorney sets any node the rider affects by hand.
alter table ws.doc_template add column auto_green jsonb not null default '{}';
update ws.doc_template set auto_green =
  '{"N0": ["principal","members"], "N2": ["principal","members","interim_manager"], "N3": ["principal","members","alternate_im"]}'
  where id = 'oa-continuity';

alter table ws.doc_execution add column signatures text[] not null default '{}'
  check (signatures <@ array['principal','members','interim_manager','alternate_im','business_agent','alternate_agent','witnesses','notary']);

create function ws.auto_green() returns trigger language plpgsql security definer set search_path = ws as $$
declare d document; p document; rule jsonb; k text; need jsonb;
begin
  select * into d from document where id = new.document_id;
  select * into p from document where id = d.parent_id;
  if p.id is null or (select tier from workspace where id = d.workspace_id) <> 'entity' then return null; end if;
  select auto_green into rule from doc_template where id = p.template_id;
  for k, need in select * from jsonb_each(coalesce(rule, '{}')) loop
    continue when not (k = any (p.nodes));
    continue when not (array(select jsonb_array_elements_text(need)) <@ new.signatures);
    insert into node_status (workspace_id, node_id, status, fact, source_id)
      values (d.workspace_id, k, 'green',
              format('Executed %s on %s; signed by %s', p.title, new.executed_on, array_to_string(new.signatures, ', ')), d.source_id)
      on conflict (workspace_id, node_id) do update
        set status = 'green', fact = excluded.fact, source_id = excluded.source_id, set_by = ws.me(), set_at = now();
  end loop;
  return null;
end $$;
create trigger auto_green after insert on ws.doc_execution for each row execute function ws.auto_green();

-- ---------- (2) Retention ----------
create table ws.retention_policy (
  id           boolean primary key default true check (id),   -- one row
  period_months integer check (period_months > 0),            -- null: purge refuses
  rule_cite    text,                                           -- the rule or opinion the period comes from
  read_on      date,                                           -- when the attorney read it at the source
  check ((period_months is null) = (rule_cite is null) and (rule_cite is null) = (read_on is null))
);
insert into ws.retention_policy default values;

create table ws.file_closure (
  workspace_id        uuid primary key references ws.workspace(id),
  engagement_ended_on date not null,
  export_delivered_at timestamptz,                             -- the client's export package was delivered
  notice_sent_at      timestamptz,                             -- written notice to the client that the file will be purged
  purged_at           timestamptz,
  recorded_by         uuid not null default ws.me() references ws.person(id)
);
alter table ws.file_closure enable row level security;
create policy read on ws.file_closure for select using (ws.in_scope(workspace_id));
create policy w on ws.file_closure for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy u on ws.file_closure for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney')
  with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
alter table ws.retention_policy enable row level security;
create policy read on ws.retention_policy for select using (true);
grant select on ws.retention_policy to ws_app;
grant select, insert, update on ws.file_closure to ws_app;
create trigger a after insert or update or delete on ws.file_closure for each row execute function ws.audit();
create function ws.check_closure() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if new.purged_at is distinct from old.purged_at and current_setting('app.purge', true) is distinct from 'on' then
    raise exception 'purged_at is set by ws.purge_documents() only'; end if;
  if old.purged_at is not null then raise exception 'a purged file is closed'; end if;
  return new;
end $$;
create trigger check_closure before update on ws.file_closure for each row execute function ws.check_closure();

-- Purged versions keep their row, hash and audit trail; only the contents go.
alter table ws.doc_version add column purged_at timestamptz;
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'ws.doc_version'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%num_nonnulls%' loop
    execute format('alter table ws.doc_version drop constraint %I', c);
  end loop;
end $$;
alter table ws.doc_version add constraint doc_version_one_content
  check ((purged_at is null and num_nonnulls(content_md, bytes, blob_source) = 1)
      or (purged_at is not null and num_nonnulls(content_md, bytes, blob_source) = 0));

create or replace function ws.check_version() returns trigger language plpgsql security definer set search_path = ws as $$
declare d document; k text; f jsonb; nxt integer;
begin
  if tg_op = 'UPDATE' then
    if current_setting('app.purge', true) = 'on' then
      if (to_jsonb(new) - array['content_md','bytes','blob_source','purged_at']) is distinct from
         (to_jsonb(old) - array['content_md','bytes','blob_source','purged_at']) then
        raise exception 'purge removes contents only'; end if;
      return new;
    end if;
    if old.purged_at is not null then raise exception 'versions are immutable'; end if;
    if old.sent_at is not null or new.sent_at is null or
       (to_jsonb(new) - 'sent_at') is distinct from (to_jsonb(old) - 'sent_at') then
      raise exception 'versions are immutable'; end if;
    if new.content_md is null or coalesce(new.blockers, '[]'::jsonb) <> '[]'::jsonb then
      raise exception 'not ready to send: %', coalesce(new.blockers::text, 'no assembler report'); end if;
    return new;
  end if;
  select * into d from document where id = new.document_id;
  if d.status = 'superseded' then raise exception 'a superseded document takes no new versions'; end if;
  if exists (select 1 from file_closure where workspace_id = new.workspace_id and purged_at is not null) then
    raise exception 'a purged file is closed'; end if;
  select coalesce(max(n), 0) + 1 into nxt from doc_version where document_id = new.document_id;
  if new.n <> nxt then raise exception 'next version is %', nxt; end if;
  if new.sent_at is not null or new.purged_at is not null then raise exception 'save the version, then send it'; end if;
  if (d.kind = 'draft') <> (new.content_md is not null) then raise exception 'drafts hold text; other kinds hold files'; end if;
  if d.kind = 'draft' and (new.mode is null or new.facts is null or new.blockers is null) then
    raise exception 'a draft version records its mode, facts and blockers'; end if;
  if new.blob_source is not null and (d.kind <> 'client_upload' or new.blob_source is distinct from d.source_id) then
    raise exception 'only a client upload points at its own file'; end if;
  for k, f in select * from jsonb_each(coalesce(new.facts, '{}'::jsonb)) loop
    if not exists (select 1 from source s where s.workspace_id = new.workspace_id and s.id::text = f->>'source'
                     and s.kind = f->>'kind') then
      raise exception 'fact % cites a source that is not in this workspace with kind %', k, f->>'kind'; end if;
  end loop;
  return new;
end $$;

-- Purge the session's workspace: attorney only; engagement ended; period set and passed; export delivered;
-- written notice sent. Removes document contents and uploaded file bytes; keeps the index, hashes, execution
-- records and the audit log. Returns the number of versions purged.
create function ws.purge_documents() returns integer language plpgsql security definer set search_path = ws as $$
declare cl file_closure; pol retention_policy; n integer;
begin
  if ws.my_role() is distinct from 'attorney' or not ws.in_scope(ws.cur_ws()) then raise exception 'attorney only'; end if;
  select * into pol from retention_policy;
  if pol.period_months is null then raise exception 'no retention period set: read the governing rule first'; end if;
  select * into cl from file_closure where workspace_id = ws.cur_ws();
  if cl.workspace_id is null then raise exception 'the file is not closed'; end if;
  if cl.purged_at is not null then raise exception 'already purged'; end if;
  if cl.export_delivered_at is null then raise exception 'deliver the client''s export package first (rule 8)'; end if;
  if cl.notice_sent_at is null then raise exception 'send the client written notice first'; end if;
  if current_date < cl.engagement_ended_on + make_interval(months => pol.period_months) then
    raise exception 'retention period runs until %', (cl.engagement_ended_on + make_interval(months => pol.period_months))::date; end if;
  perform set_config('app.purge', 'on', true);
  update doc_version set content_md = null, bytes = null, blob_source = null, purged_at = now()
    where workspace_id = ws.cur_ws() and purged_at is null;
  get diagnostics n = row_count;
  delete from file_blob where workspace_id = ws.cur_ws();
  update file_closure set purged_at = now() where workspace_id = ws.cur_ws();
  perform set_config('app.purge', 'off', true);
  insert into event_log (workspace_id, actor, tbl, op, row_data)
    values (ws.cur_ws(), ws.me(), 'purge', 'PURGE', jsonb_build_object('versions', n, 'period_months', pol.period_months, 'rule', pol.rule_cite));
  return n;
end $$;
revoke all on function ws.purge_documents() from public;
grant execute on function ws.purge_documents() to ws_app;
