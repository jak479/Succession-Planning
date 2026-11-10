// Drafting tool step 3: AI review and AI-assisted drafting (docs/design/drafting-tool.md § 1). Attorney-only: no
// output here is ever shown to a client, so the client-facing gate (rule 1) does not run; the attorney is the gate.
// What the model receives: the draft version's text, the template's drafter notes, and the recorded facts with the
// kind of source each came from. Never other documents, never the other tier (rule 3), never medical information
// (the workspace holds none: rule 3). The model writes no document text in review; in drafting it proposes exact
// replacements that the attorney accepts or rejects one by one.
import { z } from "zod";
import type pg from "pg";
import type { Model } from "./model.ts";
import { inSession, type Session } from "../../../core/src/store.ts";
import { assemble, type Facts, type Template } from "../../../core/src/drafting.ts";
import { unconfirmedCitations, CONFIRMED } from "../../../core/src/statutes.ts";
import { saveVersion } from "../../../core/src/documents.ts";

export const DRAFTING_PROMPT_VERSION = "drafting-2026-11-10.1";

// ---------- Review ----------
export const ReviewSchema = z.object({
  findings: z.array(z.object({
    category: z.enum(["value_mismatch", "unfilled", "cross_reference", "missing_schedule", "internal_inconsistency", "execution", "statutory", "drafting"]),
    quote: z.string(),
    problem: z.string(),
    fix_hint: z.string(),
  })),
});
export const REVIEW_SYSTEM = `You review a draft legal instrument for a Florida lawyer before it goes to the client. You are a second reader for the lawyer, not the drafter. You never write or rewrite the document.

You receive: the draft text; the drafter's notes for the template it came from; the facts recorded for this draft, each with the kind of source it came from (CALL = the client said it to the lawyer on a call; DOC = a document in the file; PUB = a public record; CLIENT = the client's own description; AGENT = derived by the intake assistant).

Report each problem you find as one finding:
- value_mismatch: a name, date, number or term in the draft differs from the recorded fact, or the draft uses two different values for the same thing.
- unfilled: a bracketed blank or choice is still open in a place that matters for signing.
- cross_reference: a section, article, schedule or paragraph reference points to something that does not exist or is numbered differently.
- missing_schedule: the draft relies on a schedule, exhibit, certificate or form that is not attached or not described.
- internal_inconsistency: two provisions conflict, or a defined term is used before or without its definition, or is used with a different meaning.
- execution: the signature, witness, notary or consent blocks do not match what the draft itself requires.
- statutory: the draft's use of a cited statute looks wrong on the face of the draft (for example a subsection that does not fit the proposition). Say what to check; do not state what the statute says unless the draft or the notes quote it.
- drafting: ambiguity, a dangling clause, or wording that could be read two ways.

Rules:
- "quote" must be copied character for character from the draft, 5 to 300 characters, and must locate the problem. A finding without an exact quote is discarded.
- Be specific and short. One problem per finding. No praise, no summary, no general advice.
- Do not suggest changes to a client's choices (who serves, amounts, periods, which option). Report only that a choice is open or inconsistent.
- If you find nothing, return an empty list.`;

// ---------- Drafting ----------
export const SuggestSchema = z.object({
  suggestions: z.array(z.object({ find: z.string(), replace_with: z.string(), reason: z.string(), uses: z.array(z.string()) })),
  declined: z.string(),
});
export const SUGGEST_SYSTEM = `You help a Florida lawyer revise a draft legal instrument. The lawyer gives an instruction; you propose exact edits. The lawyer accepts or rejects each one. You never decide anything for the client.

Each suggestion replaces one passage:
- "find" is copied character for character from the draft and appears in it exactly once. Keep it as short as the edit allows (a clause or a sentence, not a whole section).
- "replace_with" is the new text for that passage, in the draft's own style and defined terms. Markdown as in the draft (**bold**, *italic*).
- "reason" says in one sentence how the edit carries out the instruction.
- "uses" lists the field ids of any recorded facts the new text relies on, or is empty.

Rules:
- Use only facts given in the recorded facts. Never invent a name, date, amount, period or other value. If the instruction needs a value that is not recorded, do not guess: leave the bracket in place and say so in "declined".
- Never fill in or change a bracketed client choice (who serves, amounts, periods, options) that the facts list as not decided; those are decided by the client on the call.
- Do not cite a statute section the draft does not already cite.
- If the instruction cannot be done safely, or asks for advice rather than an edit, return no suggestions and explain in "declined". Otherwise "declined" is an empty string.`;

type Deps = { pool: pg.Pool; model: Model };

function inputFor(t: Template, templateFile: string, text: string, facts: Facts) {
  const notes = templateFile.slice(0, templateFile.indexOf(t.start)) + "\n" + (templateFile.split(t.end)[1] ?? "");
  const a = assemble(t, templateFile, facts);
  const choices = a.choices.map(c => `${c.id} (${c.label}): ${c.status}${c.value !== undefined ? ` = ${JSON.stringify(c.value)}` : ""}`).join("\n");
  const factLines = Object.entries(facts).map(([k, f]) => `${k} = ${JSON.stringify(f.value)} [${f.kind ?? "unknown"}]`).join("\n") || "(none)";
  return { a, user: `<draft>\n${text}\n</draft>\n\n<drafter_notes>\n${notes.trim()}\n</drafter_notes>\n\n<recorded_facts>\n${factLines}\n</recorded_facts>\n\n<client_choices>\n${choices || "(none)"}\n</client_choices>` };
}

/** Owner-tier drafts go to the model only when the Firm has turned that on (docs/design/drafting-tool.md § 1). */
export const ownerTierAllowed = () => process.env.OWNER_TIER_AI === "on";

async function loadVersion(c: pg.PoolClient, documentId: string, versionId: string) {
  const v = (await c.query(`select v.id, v.content_md, v.facts, v.blockers, v.questions, d.template_id, w.tier from ws.doc_version v
    join ws.document d on d.id = v.document_id join ws.workspace w on w.id = d.workspace_id where v.id = $1 and v.document_id = $2`, [versionId, documentId])).rows[0];
  if (!v?.content_md) throw new Error("no such draft version");
  if ((await c.query("select ws.my_role() r")).rows[0].r !== "attorney") throw new Error("not permitted");
  if (v.tier === "owner" && !ownerTierAllowed()) throw new Error("AI drafting is off for owner-tier documents");
  return v;
}

export async function reviewVersion(deps: Deps, s: Session, t: Template, templateFile: string, documentId: string, versionId: string) {
  const v = await inSession(deps.pool, s, c => loadVersion(c, documentId, versionId));
  const text: string = v.content_md;
  const citations = unconfirmedCitations(text).map(sec => ({ section: sec, note: "cited but not confirmed at the source" }));
  const { user } = inputFor(t, templateFile, text, v.facts ?? {});
  const r = await deps.model.json({ system: REVIEW_SYSTEM, user, schema: ReviewSchema, effort: "high", maxTokens: 16000 });
  const kept: any[] = [], dropped: any[] = [];
  if (r.ok) for (const f of r.value.findings) {
    if (f.quote.length < 5 || !text.includes(f.quote)) dropped.push({ ...f, why: "quote not found in the draft" });
    else kept.push(f);
  }
  const model = r.ok ? r.model : "unavailable: " + r.reason;
  const id = await inSession(deps.pool, s, async c => (await c.query(`insert into ws.doc_review (workspace_id, version_id, model, prompt_version, findings, dropped, citations)
    values (ws.cur_ws(), $1, $2, $3, $4, $5, $6) returning id`, [versionId, model, DRAFTING_PROMPT_VERSION, JSON.stringify(kept), JSON.stringify(dropped), JSON.stringify(citations)])).rows[0].id);
  return { id, ok: r.ok, model, findings: kept, dropped, citations, confirmed: Object.keys(CONFIRMED).length };
}

export async function suggestEdits(deps: Deps, s: Session, t: Template, templateFile: string, documentId: string, versionId: string, instruction: string) {
  if (instruction.trim().length < 4) throw new Error("give an instruction");
  const v = await inSession(deps.pool, s, c => loadVersion(c, documentId, versionId));
  const text: string = v.content_md;
  const { a, user } = inputFor(t, templateFile, text, v.facts ?? {});
  const r = await deps.model.json({ system: SUGGEST_SYSTEM, user: `${user}\n\n<instruction>\n${instruction}\n</instruction>`, schema: SuggestSchema, effort: "high", maxTokens: 16000 });
  if (!r.ok) return { ok: false, model: "unavailable: " + r.reason, suggestions: [], dropped: [], declined: "" };
  // Server checks: the passage is in the draft exactly once, and the edit does not touch a client choice the client
  // has not decided (the bracket text of an open or unconfirmed choice may not be removed).
  const undecided = a.choices.filter(c => c.status !== "decided" && /^\[.*\]$/s.test(c.template) && text.includes(c.template));
  const count = (h: string, n: string) => n ? h.split(n).length - 1 : 0;
  const kept: any[] = [], dropped: any[] = [];
  for (const g of r.value.suggestions) {
    const hit = undecided.find(c => count(g.find, c.template) > count(g.replace_with, c.template));
    if (count(text, g.find) !== 1) dropped.push({ ...g, why: "passage not found exactly once in the draft" });
    else if (g.find === g.replace_with) dropped.push({ ...g, why: "no change" });
    else if (hit) dropped.push({ ...g, why: `would decide a client choice not yet decided: ${hit.label}` });
    else kept.push(g);
  }
  const ids = await inSession(deps.pool, s, async c => {
    const out: string[] = [];
    for (const g of kept) out.push((await c.query(`insert into ws.doc_suggestion (workspace_id, version_id, instruction, model, prompt_version, find, replace_with, reason, uses)
      values (ws.cur_ws(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`, [versionId, instruction, r.model, DRAFTING_PROMPT_VERSION, g.find, g.replace_with, g.reason, g.uses])).rows[0].id);
    return out;
  });
  return { ok: true, model: r.model, suggestions: kept.map((g, i) => ({ id: ids[i], ...g })), dropped, declined: r.value.declined };
}

/** Accept: apply the replacement to the latest version and save it as a new version (mode ai_draft). The new version
 *  keeps the facts, blockers and call questions of the version it was made from: an edit decides no client choice.
 *  A suggestion whose passage is no longer in the latest version is marked stale. Reject: recorded, nothing else. */
export async function decideSuggestion(c: pg.PoolClient, documentId: string, suggestionId: string, accept: boolean) {
  const g = (await c.query("select * from ws.doc_suggestion where id = $1", [suggestionId])).rows[0];
  if (!g) throw new Error("no such suggestion");
  if (!accept) { await c.query("update ws.doc_suggestion set status = 'rejected', decided_by = ws.me(), decided_at = now() where id = $1", [suggestionId]); return { status: "rejected" }; }
  const latest = (await c.query("select id, content_md, facts, blockers, questions from ws.doc_version where document_id = $1 order by n desc limit 1", [documentId])).rows[0];
  const count = latest.content_md.split(g.find).length - 1;
  if (count !== 1) { await c.query("update ws.doc_suggestion set status = 'stale', decided_by = ws.me(), decided_at = now() where id = $1", [suggestionId]); return { status: "stale" }; }
  const v = await saveVersion(c, documentId, latest.content_md.replace(g.find, () => g.replace_with), latest.facts, latest.blockers, "ai_draft",
    `accepted: ${g.reason}`.slice(0, 300), latest.questions ?? []);
  await c.query("update ws.doc_suggestion set status = 'accepted', decided_by = ws.me(), decided_at = now(), result_version = $2 where id = $1", [suggestionId, v.versionId]);
  return { status: "accepted", ...v };
}
