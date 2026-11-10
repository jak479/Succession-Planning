-- Every request for suggested edits is logged with its outcome, including requests that produced no suggestion
-- (Claude declined) and proposals the server refused. Attorney-only, append-only, audited.
create table ws.doc_ai_request (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  version_id     uuid not null,
  instruction    text not null,
  model          text not null,
  prompt_version text not null,
  outcome        text not null check (outcome in ('suggested','declined','refused','unavailable')),
  declined       text not null default '',      -- Claude's reason, if it declined
  refused        jsonb not null default '[]',   -- proposals the server refused, each with the reason
  kept           integer not null default 0,    -- suggestions stored for accept or reject
  requested_by   uuid not null default ws.me() references ws.person(id),
  at             timestamptz not null default now(),
  foreign key (workspace_id, version_id) references ws.doc_version(workspace_id, id)
);
alter table ws.doc_ai_request enable row level security;
create policy read on ws.doc_ai_request for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy w on ws.doc_ai_request for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create trigger a after insert or update or delete on ws.doc_ai_request for each row execute function ws.audit();
create trigger no_delete before delete on ws.doc_ai_request for each row execute function ws.no_delete();
grant select, insert on ws.doc_ai_request to ws_app;
