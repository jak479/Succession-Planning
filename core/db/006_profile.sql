-- Build item 3: profile builder. Conflicts are listed, never resolved (CLAUDE.md core data model).
create unique index conflict_once on ws.conflict (workspace_id, field, value_a, value_b);

-- One row per build, attorney-readable: what was filled, what was dropped and why, what no source addresses.
create table ws.profile_run (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  at           timestamptz not null default now(),
  model        text,
  result       jsonb not null
);
alter table ws.profile_run enable row level security;
create policy read on ws.profile_run for select using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy ins on ws.profile_run for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'agent');
grant select, insert on ws.profile_run to ws_app;

-- Source strength for precedence: the attorney's call, then documents, public records, connected systems,
-- the client's description, agent-derived.
create function ws.source_rank(kind text) returns int language sql immutable as $$
  select case kind when 'CALL' then 6 when 'DOC' then 5 when 'PUB' then 4 when 'API' then 3 when 'CLIENT' then 2 else 1 end
$$;

-- A value may rest on several sources (e.g. personal guaranties in the lease and in the loan). profile_value.source_id
-- is the strongest of them; every supporting source is listed here.
create table ws.profile_value_source (
  workspace_id uuid not null references ws.workspace(id),
  field        text not null,
  source_id    uuid not null,
  primary key (workspace_id, field, source_id),
  foreign key (workspace_id, field) references ws.profile_value(workspace_id, field) on delete cascade,
  foreign key (workspace_id, source_id) references ws.source(workspace_id, id)
);
alter table ws.profile_value_source enable row level security;
create policy read on ws.profile_value_source for select using (ws.in_scope(workspace_id));
create policy w on ws.profile_value_source for all using (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'))
  with check (ws.in_scope(workspace_id) and ws.my_role() in ('attorney','agent'));
grant select, insert, delete on ws.profile_value_source to ws_app;
