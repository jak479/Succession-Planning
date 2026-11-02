-- Client surfaces: each intake turn belongs to one client's conversation. A client reads only their own thread
-- (Luis never sees Dana's intake); the attorney and the agent read all turns in the workspace.
alter table ws.intake_turn add column for_person uuid references ws.person(id);
update ws.intake_turn set for_person = person_id where speaker = 'client';
drop policy read on ws.intake_turn;
create policy read on ws.intake_turn for select using (ws.in_scope(workspace_id) and
  (ws.my_role() in ('attorney','agent') or person_id = ws.me() or for_person = ws.me()));
