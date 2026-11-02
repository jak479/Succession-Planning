-- Build item 2: front door. A client question, the attorney-only brief, and the client-visible reply.
-- The reply is assembled by the server from the five permitted forms; the model never writes it freely.

-- Readable text of a document in hand, per workspace. The engine reads only the session's workspace.
create table ws.document_text (
  source_id    uuid primary key,
  workspace_id uuid not null references ws.workspace(id),
  doc_key      text not null,             -- short id used in citations, e.g. OA-Art9
  title        text not null,
  body         text not null,
  unique (workspace_id, doc_key),
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);

-- Client-visible question record. A client sees only their own questions.
create table ws.question (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws.workspace(id),
  asked_by      uuid not null default ws.me() references ws.person(id),
  asked_at      timestamptz not null default now(),
  body          text,                     -- null when withheld (health/capacity: never stored)
  withheld      boolean not null default false,
  outside_text  text,                     -- check-this lane: pasted outside-AI answer
  context_node  text references ws.node_def(id),
  status        text not null default 'received' check (status in ('received','answered','held')),
  reply         jsonb,                    -- rendered permitted forms; see server/src/engine/render.ts
  agenda_position integer,
  confirmed_scope text check (confirmed_scope in ('included','quoted','mixed')),  -- shown only once the attorney confirms
  check (withheld = (body is null))
);

-- Attorney-only brief. Suggested scope lives here until the attorney confirms it (rule 2).
create table ws.brief (
  question_id     uuid primary key references ws.question(id),
  workspace_id    uuid not null references ws.workspace(id),
  topic           text,
  urgent          boolean not null,
  stop_reason     text,                   -- why the line stopped (stop rules), if it did
  suggested_scope text check (suggested_scope in ('included','quoted','mixed')),
  scope_reason    text,
  documents_say   jsonb not null default '[]',
  no_clause_for   jsonb not null default '[]',
  facts_needed    jsonb not null default '[]',
  check_this      jsonb not null default '[]',
  anchor_proximity text,
  agenda_line     text,
  attorney_note   text,
  gate            jsonb not null,         -- every check run and its result
  model           text,
  prompt_version  text not null,
  created_at      timestamptz not null default now(),
  confirmed_by    uuid references ws.person(id),
  confirmed_at    timestamptz
);

do $$ declare t text; begin
  foreach t in array array['document_text','question','brief'] loop
    execute format('alter table ws.%I enable row level security', t);
    execute format('alter table ws.%I force row level security', t);
  end loop;
end $$;

create policy read on ws.document_text for select using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
create policy w on ws.document_text for insert with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));

create policy read on ws.question for select using (ws.in_scope(workspace_id) and (ws.my_role() in ('attorney','agent') or asked_by = ws.me()));
create policy ins on ws.question for insert with check (ws.in_scope(workspace_id) and asked_by = ws.me());
create policy upd on ws.question for update using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent')) with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));

create policy read on ws.brief for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy ins on ws.brief for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'agent');
create policy upd on ws.brief for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');

-- Only the attorney sets confirmed scope; the agent may not.
create function ws.question_guard() returns trigger language plpgsql security definer set search_path = ws as $$
begin
  if new.confirmed_scope is distinct from old.confirmed_scope and ws.my_role() <> 'attorney' then
    raise exception 'scope is confirmed by the attorney only'; end if;
  if new.body is distinct from old.body or new.asked_by <> old.asked_by then
    raise exception 'a question is not edited after it is asked'; end if;
  return new;
end $$;
create trigger question_guard before update on ws.question for each row execute function ws.question_guard();

create function ws.confirm_scope(p_question uuid, p_scope text) returns void language plpgsql security invoker as $$
begin
  update ws.brief set confirmed_by = ws.me(), confirmed_at = now() where question_id = p_question;
  if not found then raise exception 'brief not found'; end if;
  update ws.question set confirmed_scope = p_scope where id = p_question;
end $$;

grant select, insert on ws.document_text to ws_app;
grant select, insert, update on ws.question, ws.brief to ws_app;
grant execute on function ws.confirm_scope(uuid, text) to ws_app;
create trigger a after insert or update on ws.question for each row execute function ws.audit();
create trigger a after insert or update on ws.brief for each row execute function ws.audit();
