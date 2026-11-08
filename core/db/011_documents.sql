-- Document management (decided 2026-11-08; docs/design/drafting-tool.md § 8). In-house, one index per workspace,
-- so the two tiers stay separate exactly as the rest of the state file does (rule 3).
-- Four kinds share the index: drafts (from the assembler), executed originals, client uploads, counterparty papers.
-- Versions are immutable. Nothing is deleted; a document is superseded. Every write is in the audit log.

-- Templates the assembler knows, with their tier. core/test/rls.test.ts checks this matches core/src/templates.ts.
create table ws.doc_template (
  id    text primary key,
  title text not null,
  tier  text not null check (tier in ('entity','owner'))
);
insert into ws.doc_template values
  ('oa-continuity', 'Amendment to Operating Agreement — Continuity', 'entity'),
  ('dpoa-rider', 'Durable Power of Attorney — Business Powers Rider', 'owner');

create table ws.document (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  kind         text not null check (kind in ('draft','executed','client_upload','counterparty')),
  title        text not null,
  template_id  text references ws.doc_template(id),
  nodes        text[] not null default '{}',        -- nodes the document is meant to satisfy (status stays the attorney's)
  status       text not null default 'active' check (status in ('active','sent','executed','superseded')),
  parent_id    uuid,                                -- executed original or counterparty paper → the draft it answers
  source_id    uuid,                                -- the ws.source this document is cited as (uploads, executed copies)
  created_by   uuid not null default ws.me() references ws.person(id),
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, parent_id) references ws.document(workspace_id, id),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id),
  check (kind = 'draft' or status in ('active','superseded')),
  check ((kind = 'draft') = (template_id is not null) or kind = 'executed')
);

create table ws.doc_version (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id  uuid not null,
  n            integer not null check (n >= 1),
  content_md   text,                                -- drafts: the assembled or edited text
  bytes        bytea,                               -- files: executed scans, counterparty papers
  blob_source  uuid,                                -- client uploads: the bytes stay in ws.file_blob
  filename     text, mime text,
  sha256       text not null,
  mode         text check (mode in ('manual','ai_draft','ai_review','import')),  -- how a draft version was made
  facts        jsonb,                               -- drafts: {field: {value, source, kind}} used by the assembler
  blockers     jsonb,                               -- drafts: core blockers() at save; must be [] to send
  note         text,
  sent_at      timestamptz,                         -- set once, when this version goes to the client
  created_by   uuid not null default ws.me() references ws.person(id),
  created_at   timestamptz not null default now(),
  unique (document_id, n),
  unique (workspace_id, id),
  foreign key (workspace_id, document_id) references ws.document(workspace_id, id),
  check (num_nonnulls(content_md, bytes, blob_source) = 1)
);

create table ws.doc_execution (
  document_id  uuid primary key,                    -- the executed-original document
  workspace_id uuid not null,
  draft_version uuid,                               -- the version that was signed
  mode         text not null check (mode in ('in_person','esign_only','ron_witnesses_present','ron_remote_witnesses')),
  executed_on  date not null,
  ron_provider text,
  journal_ref  text,                                -- where the notary's electronic journal/record can be produced (§ 709.2120(4)(d))
  recorded_by  uuid not null default ws.me() references ws.person(id),
  foreign key (workspace_id, document_id) references ws.document(workspace_id, id),
  foreign key (workspace_id, draft_version) references ws.doc_version(workspace_id, id),
  check ((mode like 'ron%') = (ron_provider is not null and journal_ref is not null))
);

-- ---------- Integrity ----------
create function ws.check_document() returns trigger language plpgsql security definer set search_path = ws as $$
declare t text;
begin
  if new.template_id is not null then
    select tier into t from ws.doc_template where id = new.template_id;
    if t <> (select tier from ws.workspace where id = new.workspace_id) then
      raise exception 'template % is kept in the % tier', new.template_id, t; end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.workspace_id, new.kind, new.template_id, new.created_by, new.created_at) is distinct from
       (old.workspace_id, old.kind, old.template_id, old.created_by, old.created_at) then
      raise exception 'a document''s identity does not change'; end if;
    if old.status = 'superseded' then raise exception 'a superseded document is final'; end if;
    if new.status = 'sent' and old.status <> 'sent' then
      if not exists (select 1 from doc_version v where v.document_id = new.id and v.sent_at is not null) then
        raise exception 'mark a version sent first'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger check_document before insert or update on ws.document for each row execute function ws.check_document();

-- Versions: immutable once written, except that sent_at may be set once. Draft facts must cite this workspace's
-- own sources (rule 6; an owner-tier source can never be cited in an entity draft). A version is sent only when
-- the assembler reported no blockers: every client choice decided, every blank filled.
create function ws.check_version() returns trigger language plpgsql security definer set search_path = ws as $$
declare d document; k text; f jsonb; nxt integer;
begin
  if tg_op = 'UPDATE' then
    if old.sent_at is not null or new.sent_at is null or
       (to_jsonb(new) - 'sent_at') is distinct from (to_jsonb(old) - 'sent_at') then
      raise exception 'versions are immutable'; end if;
    if new.content_md is null or coalesce(new.blockers, '[]'::jsonb) <> '[]'::jsonb then
      raise exception 'not ready to send: %', coalesce(new.blockers::text, 'no assembler report'); end if;
    return new;
  end if;
  select * into d from document where id = new.document_id;
  if d.status = 'superseded' then raise exception 'a superseded document takes no new versions'; end if;
  select coalesce(max(n), 0) + 1 into nxt from doc_version where document_id = new.document_id;
  if new.n <> nxt then raise exception 'next version is %', nxt; end if;
  if new.sent_at is not null then raise exception 'save the version, then send it'; end if;
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
create trigger check_version before insert or update on ws.doc_version for each row execute function ws.check_version();
create function ws.no_delete() returns trigger language plpgsql as $$
begin raise exception 'documents are superseded, never deleted'; end $$;
create trigger no_delete before delete on ws.document for each row execute function ws.no_delete();
create trigger no_delete before delete on ws.doc_version for each row execute function ws.no_delete();
create trigger no_delete before delete on ws.doc_execution for each row execute function ws.no_delete();

-- Filing an execution record: the document must be an executed original whose draft (if any) was sent, and the
-- signed version must belong to that draft. The executed copy becomes a DOC source the profile and nodes can cite.
create function ws.check_execution() returns trigger language plpgsql security definer set search_path = ws as $$
declare d document; v doc_version; s uuid;
begin
  if tg_op = 'UPDATE' then raise exception 'execution records are final'; end if;
  select * into d from document where id = new.document_id;
  if d.kind <> 'executed' then raise exception 'execution records attach to executed originals'; end if;
  if not exists (select 1 from doc_version where document_id = d.id) then raise exception 'file the signed copy first'; end if;
  if d.parent_id is not null then
    select * into v from doc_version where id = new.draft_version;
    if v.id is null or v.document_id <> d.parent_id or v.sent_at is null then
      raise exception 'the signed version must be a sent version of the draft'; end if;
    update document set status = 'executed' where id = d.parent_id;
  end if;
  if d.source_id is null then
    insert into source (workspace_id, label, kind, name, citation, readable)
      values (d.workspace_id, 'EX-' || left(d.id::text, 8), 'DOC', d.title, 'executed ' || new.executed_on, true)
      returning id into s;
    update document set source_id = s where id = d.id;
  end if;
  return new;
end $$;
create trigger check_execution before insert or update on ws.doc_execution for each row execute function ws.check_execution();

-- Client uploads join the index automatically, pointing at the existing file (no second copy).
create function ws.index_upload() returns trigger language plpgsql security definer set search_path = ws as $$
declare d uuid;
begin
  insert into document (workspace_id, kind, title, source_id, created_by)
    values (new.workspace_id, 'client_upload', new.filename, new.source_id, coalesce(ws.me(), (select created_by from source where id = new.source_id)))
    returning id into d;
  insert into doc_version (workspace_id, document_id, n, blob_source, filename, mime, sha256, created_by)
    values (new.workspace_id, d, 1, new.source_id, new.filename, new.mime, new.sha256, coalesce(ws.me(), (select created_by from source where id = new.source_id)));
  return new;
end $$;
create trigger index_upload after insert on ws.file_blob for each row execute function ws.index_upload();

create trigger a after insert or update or delete on ws.document      for each row execute function ws.audit();
create trigger a after insert or update or delete on ws.doc_version   for each row execute function ws.audit();
create trigger a after insert or update or delete on ws.doc_execution for each row execute function ws.audit();

-- ---------- Who sees and writes what ----------
-- Attorney: everything in scope. Agent: executed originals and client uploads (it reads; it never drafts).
-- Client: executed originals, their workspace's uploads, and a draft only once sent, and then only its sent versions.
-- Counterparty papers and unsent drafts are the attorney's alone.
create function ws.doc_visible(d uuid) returns boolean language sql stable security definer set search_path = ws as $$
  select exists (select 1 from document x where x.id = d and ws.in_scope(x.workspace_id) and (
    ws.my_role() = 'attorney'
    or (x.kind in ('executed','client_upload'))
    or (ws.my_role() = 'client' and x.kind = 'draft' and x.status in ('sent','executed')))) $$;
alter table ws.document enable row level security;
alter table ws.doc_version enable row level security;
alter table ws.doc_execution enable row level security;
alter table ws.doc_template enable row level security;
create policy read on ws.doc_template for select using (true);
create policy read on ws.document for select using (ws.in_scope(workspace_id) and (   -- same test as doc_visible, on the row itself
  ws.my_role() = 'attorney' or kind in ('executed','client_upload')
  or (ws.my_role() = 'client' and kind = 'draft' and status in ('sent','executed'))));
create policy read on ws.doc_version for select using (ws.doc_visible(document_id)
  and (ws.my_role() <> 'client' or (select kind from ws.document where id = document_id) <> 'draft' or sent_at is not null));
create policy read on ws.doc_execution for select using (ws.doc_visible(document_id));
create policy w on ws.document for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy u on ws.document for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.doc_version for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy u on ws.doc_version for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.doc_execution for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select on ws.doc_template to ws_app;
grant select, insert, update on ws.document, ws.doc_version to ws_app;
grant select, insert on ws.doc_execution to ws_app;

-- The client's export package (rule 8): executed originals with their execution records, newest version of each.
create view ws.export_index with (security_invoker = true) as
  select d.id as document_id, d.title, d.nodes, e.mode, e.executed_on, e.ron_provider, e.journal_ref,
         v.id as version_id, v.n, v.filename, v.mime, v.sha256
  from ws.document d
  join ws.doc_execution e on e.document_id = d.id
  join lateral (select * from ws.doc_version x where x.document_id = d.id order by n desc limit 1) v on true
  where d.kind = 'executed';
grant select on ws.export_index to ws_app;
