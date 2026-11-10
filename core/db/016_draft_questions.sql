-- Draft questions on the Thursday agenda (drafting-tool.md § 2a). Each draft version stores the open and unconfirmed
-- client choices as neutral call questions (core callQuestions). The agenda shows the latest version's questions for
-- every active draft, to the client and the attorney alike, without exposing the draft itself: only the question
-- text and node leave this function. Drafts are per workspace, so the questions stay in their own tier (rule 3).
alter table ws.doc_version add column questions jsonb;
create function ws.draft_questions() returns table (key text, title text, node text, at timestamptz)
  language sql stable security definer set search_path = ws as $$
  select q->>'key', q->>'title', q->>'node', v.created_at
  from document d
  join lateral (select * from doc_version x where x.document_id = d.id and x.content_md is not null order by n desc limit 1) v on true
  cross join lateral jsonb_array_elements(coalesce(v.questions, '[]'::jsonb)) q
  where d.workspace_id = ws.cur_ws() and ws.in_scope(d.workspace_id) and d.kind = 'draft' and d.status = 'active'
$$;
revoke all on function ws.draft_questions() from public;
grant execute on function ws.draft_questions() to ws_app;
