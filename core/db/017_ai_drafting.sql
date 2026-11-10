-- Drafting tool step 3: AI review and AI-assisted drafting (docs/design/drafting-tool.md § 1). Attorney-only.
-- A review writes no document text: it is a list of findings on one version. A suggestion is a proposed
-- replacement of one exact passage of one version; nothing enters the document until the attorney accepts it,
-- and acceptance saves a new version (mode ai_draft) through the normal version rules.
create table ws.doc_review (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  version_id     uuid not null,
  model          text not null,
  prompt_version text not null,
  findings       jsonb not null,            -- kept: each quotes the draft verbatim
  dropped        jsonb not null,            -- discarded by the server, with the reason
  citations      jsonb not null,            -- deterministic: sections cited but not confirmed (core/src/statutes.ts)
  requested_by   uuid not null default ws.me() references ws.person(id),
  at             timestamptz not null default now(),
  foreign key (workspace_id, version_id) references ws.doc_version(workspace_id, id)
);
create table ws.doc_suggestion (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  version_id     uuid not null,             -- the version the passage was found in
  instruction    text not null,
  model          text not null,
  prompt_version text not null,
  find           text not null,             -- exact passage, found once in that version
  replace_with   text not null,
  reason         text not null,
  uses           text[] not null default '{}',   -- fields whose recorded values it relies on
  status         text not null default 'proposed' check (status in ('proposed','accepted','rejected','stale')),
  decided_by     uuid references ws.person(id),
  decided_at     timestamptz,
  result_version uuid,                      -- the version acceptance created
  requested_by   uuid not null default ws.me() references ws.person(id),
  at             timestamptz not null default now(),
  foreign key (workspace_id, version_id) references ws.doc_version(workspace_id, id),
  check ((status = 'proposed') = (decided_at is null))
);
do $$ declare t text; begin
  foreach t in array array['doc_review','doc_suggestion'] loop
    execute format('alter table ws.%I enable row level security', t);
    execute format('create policy read on ws.%I for select using (ws.in_scope(workspace_id) and ws.my_role() = ''attorney'')', t);
    execute format('create policy w on ws.%I for insert with check (ws.in_scope(workspace_id) and ws.my_role() = ''attorney'')', t);
    execute format('create trigger a after insert or update or delete on ws.%I for each row execute function ws.audit()', t);
    execute format('create trigger no_delete before delete on ws.%I for each row execute function ws.no_delete()', t);
  end loop;
end $$;
create policy u on ws.doc_suggestion for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney')
  with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
-- A decision is final; only status, decider, time and result version change, once.
create function ws.check_suggestion() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if old.status <> 'proposed' then raise exception 'a decided suggestion is final'; end if;
  if (to_jsonb(new) - array['status','decided_by','decided_at','result_version']) is distinct from
     (to_jsonb(old) - array['status','decided_by','decided_at','result_version']) then raise exception 'a suggestion is decided, not edited'; end if;
  return new;
end $$;
create trigger check_suggestion before update on ws.doc_suggestion for each row execute function ws.check_suggestion();
grant select, insert on ws.doc_review to ws_app;
grant select, insert, update on ws.doc_suggestion to ws_app;
