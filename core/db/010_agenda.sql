-- Thursday agenda inputs (core/src/agenda.ts). Deadlines and the attorney's moves; both shape what the client sees, so
-- clients may read them; only the attorney writes them. Every deadline cites the source it came from (rule 6).

create table ws.deadline (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references ws.workspace(id),
  node_id      text not null references ws.node_def(id),
  label        text not null check (length(trim(label)) > 3),   -- client wording, e.g. "the lease term ends"
  due          date not null,
  source_id    uuid not null references ws.source(id),
  created_by   uuid not null default ws.me() references ws.person(id),
  created_at   timestamptz not null default now()
);
alter table ws.deadline enable row level security;
create policy read on ws.deadline for select using (ws.in_scope(workspace_id));
create policy write on ws.deadline for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy del on ws.deadline for delete using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select, insert, delete on ws.deadline to ws_app;

-- One standing move per agenda item. item_key: 'q:<question id>' or 'co:<board item id>'.
create table ws.agenda_override (
  workspace_id uuid not null references ws.workspace(id),
  item_key     text not null check (item_key ~ '^(q|co):[0-9a-f-]{36}$'),
  action       text not null check (action in ('first','hold','done')),
  reason       text not null check (length(trim(reason)) > 3),   -- shown to the client
  until_date   date,
  set_by       uuid not null default ws.me() references ws.person(id),
  set_at       timestamptz not null default now(),
  primary key (workspace_id, item_key)
);
alter table ws.agenda_override enable row level security;
create policy read on ws.agenda_override for select using (ws.in_scope(workspace_id));
create policy write on ws.agenda_override for insert with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy upd on ws.agenda_override for update using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney') with check (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
create policy del on ws.agenda_override for delete using (ws.in_scope(workspace_id) and ws.my_role() = 'attorney');
grant select, insert, update, delete on ws.agenda_override to ws_app;
