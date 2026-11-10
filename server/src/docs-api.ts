// Drafting tool and document routes (docs/design/drafting-tool.md step 2). Each handler runs inside one person's
// session in one workspace (core/src/store.ts), so RLS and the triggers in core/db/011–016 decide what is allowed.
// The attorney drafts; the client sees only what was sent; the agent never drafts.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { zipSync } from "fflate";
import { assemble, blockers, executionModes, type Facts, type SourceKind, type Template } from "../../core/src/drafting.ts";
import { TEMPLATES } from "../../core/src/templates.ts";
import { createDraft, exportPackage, listDocuments, saveAssembled, saveVersion, sendVersion, supersede } from "../../core/src/documents.ts";
import { docxClean, docxRedline } from "./docx.ts";
import { decideSuggestion, reviewVersion, suggestEdits, ownerTierAllowed } from "./engine/drafting.ts";
import type { Model } from "./engine/model.ts";
import { inSession, type Session } from "../../core/src/store.ts";

const tplFile = (t: Template) => readFileSync(new URL("../../" + t.file, import.meta.url), "utf8");
const tpl = (id: string) => { const t = TEMPLATES.find(x => x.id === id); if (!t) throw new Error("unknown template"); return t; };
/** Nodes a new draft is meant to satisfy; the auto-green rule (db/012) reads them on execution. */
export const DEFAULT_NODES: Record<string, string[]> = { "oa-continuity": ["N0", "N2", "N3"], "dpoa-rider": ["N2"] };

/** How the console asks for each field: free text, yes/no, or one of the template's bracketed options. */
export function inputsOf(t: Template) {
  const all: any[] = [];
  const walk = (bs: Template["bindings"]) => bs.forEach(b => { all.push(b); if ((b.kind === "optional" || b.kind === "variant") && b.inner) walk(b.inner); });
  walk(t.bindings);
  return t.vars.map(v => {
    const b = all.find(x => "id" in x && x.id === v.id && x.kind !== "ifChoice");
    const gate = t.sections?.some(s => s.id === v.id);
    const kind = gate || (b && ["optional", "variant", "lineIf"].includes(b.kind)) ? "bool" : b?.kind === "choice" ? "choice" : "text";
    return { ...v, input: kind, options: kind === "choice" ? b.text.slice(1, -1).split("/").map((x: string) => x.trim()) : undefined,
      group: v.client ? "client" : v.advisor ? "advisor" : v.from ? "fact" : "drafting" };
  });
}

const attorneyOnly = (role: string) => { if (role !== "attorney") throw new Error("not permitted"); };
const one = async (c: pg.PoolClient, q: string, p: unknown[] = []) => (await c.query(q, p)).rows[0];

/** Facts from the console arrive as {field: {value, source_id}}. The source's kind is read from the database, never
 *  taken from the request, so a value cannot claim to come from the call when it did not (rule 6; § 2a). */
export async function resolveFacts(c: pg.PoolClient, raw: Record<string, { value: string | boolean; source_id: string }>): Promise<Facts> {
  const ids = [...new Set(Object.values(raw ?? {}).map(f => f.source_id))];
  const kinds = new Map<string, SourceKind>((await c.query("select id::text, kind from ws.source where id::text = any($1)", [ids])).rows.map(r => [r.id, r.kind]));
  const out: Facts = {};
  for (const [field, f] of Object.entries(raw ?? {})) {
    if (f.value === "" || f.value === undefined || f.value === null) continue;
    const kind = kinds.get(f.source_id); if (!kind) throw new Error(`fact ${field} cites a source that is not in this workspace`);
    out[field] = { value: f.value, source: f.source_id, kind };
  }
  return out;
}

async function draftRow(c: pg.PoolClient, id: string) {
  const d = await one(c, "select id, kind, title, template_id, nodes, status from ws.document where id = $1", [id]);
  if (!d) throw new Error("no such document");
  return d;
}
const latest = (c: pg.PoolClient, id: string) => one(c, "select * from ws.doc_version where document_id = $1 order by n desc limit 1", [id]);

/** The assembler's view of a fact set: highlighted text for the editor, choices, blockers, allowed execution modes. */
function view(t: Template, facts: Facts) {
  const a = assemble(t, tplFile(t), facts, { highlight: true });
  return { highlighted: a.text, choices: a.choices, open: a.open, checks: a.checks, blockers: blockers(a), execution: executionModes(t.id, facts) };
}

/** Highlights for a version edited by hand: its saved text, with each client choice marked where its text appears
 *  (the template's bracket while the choice is undecided, the recorded value once decided). */
export function markEdited(text: string, choices: ReturnType<typeof view>["choices"]): string {
  const spots: { s: string; id: string }[] = [];
  for (const c of choices) {
    if (c.status !== "decided" && /^\[.*\]$/s.test(c.template)) spots.push({ s: c.template, id: c.id });
    else if (c.status === "decided" && c.value && c.value !== "true" && c.value !== "false" && c.value.length > 1) spots.push({ s: c.value, id: c.id });
  }
  const uniq = [...new Map(spots.sort((a, b) => b.s.length - a.s.length).map(x => [x.s, x])).values()];
  if (!uniq.length) return text;
  const re = new RegExp(uniq.map(x => x.s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const by = new Map(uniq.map(x => [x.s, x.id]));
  return text.replace(re, m => `⟦choice:${by.get(m)}⟧${m}⟦/choice⟧`);
}

export type JsonRoute = [string, RegExp, (x: { c: pg.PoolClient; body: any; role: string }, m: RegExpExecArray) => Promise<unknown>];
export const docRoutes: JsonRoute[] = [
  ["GET", /^\/api\/docs$/, async ({ c, role }) => {
    const tier = (await one(c, "select ws.cur_tier() t")).t;
    return { tier, templates: role === "attorney" ? TEMPLATES.filter(t => t.tier === tier).map(t => ({ id: t.id, title: t.title })) : [],
      documents: await listDocuments(c) };
  }],
  ["POST", /^\/api\/docs$/, async ({ c, body, role }) => {
    attorneyOnly(role); const t = tpl(String(body.template));
    const id = await createDraft(c, t, Array.isArray(body.nodes) ? body.nodes.map(String) : DEFAULT_NODES[t.id] ?? []);
    await saveAssembled(c, id, t, tplFile(t), {}, "manual", "opened from template");
    return { id };
  }],
  ["GET", /^\/api\/docs\/([0-9a-f-]{36})$/, async ({ c, role }, m) => {
    const d = await draftRow(c, m[1]);
    const versions = (await c.query(`select id, n, mode, note, sent_at, created_at, purged_at, filename, jsonb_array_length(coalesce(blockers,'[]')) as blocker_count
      from ws.doc_version where document_id = $1 order by n desc`, [m[1]])).rows;
    if (d.kind !== "draft" || role !== "attorney") return { document: d, versions };
    const t = tpl(d.template_id), v = await latest(c, m[1]);
    const vw = view(t, v.facts ?? {}), edited = assemble(t, tplFile(t), v.facts ?? {}).text !== v.content_md;
    // A hand-edited version shows its own saved text, not a fresh assembly from the facts.
    return { document: d, versions, template: { id: t.id, title: t.title, tier: t.tier, inputs: inputsOf(t) },
      current: { versionId: v.id, n: v.n, text: v.content_md, facts: v.facts, ...vw, edited,
        highlighted: edited ? markEdited(v.content_md, vw.choices) : vw.highlighted } };
  }],
  ["GET", /^\/api\/docs\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/, async ({ c }, m) => {
    const v = await one(c, "select id, n, mode, note, content_md as text, facts, blockers, sent_at, created_at from ws.doc_version where id = $2 and document_id = $1", [m[1], m[2]]);
    if (!v) throw new Error("no such version"); return v;
  }],
  // Live preview while the attorney fills in facts: nothing is saved.
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/preview$/, async ({ c, body, role }, m) => {
    attorneyOnly(role); const d = await draftRow(c, m[1]); return view(tpl(d.template_id), await resolveFacts(c, body.facts));
  }],
  // Assemble from facts and save as the next version.
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/assemble$/, async ({ c, body, role }, m) => {
    attorneyOnly(role); const d = await draftRow(c, m[1]); const t = tpl(d.template_id);
    const facts = await resolveFacts(c, body.facts);
    const r = await saveAssembled(c, m[1], t, tplFile(t), facts, "manual", body.note ? String(body.note) : undefined);
    return { versionId: r.versionId, n: r.n, ...view(t, facts) };
  }],
  // Save hand-edited text as the next version. It keeps the facts, blockers and call questions of the version it
  // started from: editing text does not decide a client choice.
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/edit$/, async ({ c, body, role }, m) => {
    attorneyOnly(role); await draftRow(c, m[1]);
    const base = await one(c, "select facts, blockers, questions from ws.doc_version where id = $1 and document_id = $2", [String(body.base), m[1]]);
    if (!base) throw new Error("no such version");
    const text = String(body.text ?? ""); if (!text.trim()) throw new Error("empty text");
    return saveVersion(c, m[1], text, base.facts, base.blockers, "manual", body.note ? String(body.note) : "edited", base.questions ?? []);
  }],
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/send$/, async ({ c, body, role }, m) => { attorneyOnly(role); await sendVersion(c, m[1], String(body.version)); return { ok: true }; }],
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/supersede$/, async ({ c, role }, m) => { attorneyOnly(role); await supersede(c, m[1]); return { ok: true }; }],
  // AI review and suggestions on file for this draft (attorney-only by RLS).
  ["GET", /^\/api\/docs\/([0-9a-f-]{36})\/ai$/, async ({ c, role }, m) => {
    attorneyOnly(role);
    const reviews = (await c.query(`select r.id, r.version_id, v.n, r.model, r.prompt_version, r.findings, r.dropped, r.citations, r.at from ws.doc_review r
      join ws.doc_version v on v.id = r.version_id where v.document_id = $1 order by r.at desc limit 5`, [m[1]])).rows;
    const suggestions = (await c.query(`select s.id, s.version_id, v.n, s.instruction, s.find, s.replace_with, s.reason, s.uses, s.status, s.model, s.at
      from ws.doc_suggestion s join ws.doc_version v on v.id = s.version_id where v.document_id = $1 order by s.at desc limit 40`, [m[1]])).rows;
    const tier = (await one(c, "select ws.cur_tier() t")).t;
    return { reviews, suggestions, aiAllowed: tier === "entity" || ownerTierAllowed() };
  }],
  ["POST", /^\/api\/docs\/([0-9a-f-]{36})\/suggestions\/([0-9a-f-]{36})$/, async ({ c, body, role }, m) => {
    attorneyOnly(role); await draftRow(c, m[1]); return decideSuggestion(c, m[1], m[2], body.accept === true);
  }],
  // Sources a fact may cite, newest first. The attorney records a client choice against a call source.
  ["GET", /^\/api\/sources$/, async ({ c, role }) => {
    attorneyOnly(role);
    return { sources: (await c.query("select id, label, kind, name, pulled_at from ws.source order by pulled_at desc")).rows };
  }],
  ["POST", /^\/api\/sources\/call$/, async ({ c, body, role }) => {
    attorneyOnly(role);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const label = `CALL-${date}`;
    const have = await one(c, "select id from ws.source where label = $1", [label]);
    if (have) return { id: have.id, label };
    const r = await one(c, "insert into ws.source (workspace_id, label, kind, name) values (ws.cur_ws(), $1, 'CALL', $2) returning id", [label, `Call with the client, ${date}`]);
    return { id: r.id, label };
  }],
];

/** Downloads: Word (clean or redline) and the client's export package. */
export async function docDownload(c: pg.PoolClient, role: string, path: string, q: URLSearchParams): Promise<{ mime: string; filename: string; bytes: Uint8Array } | null> {
  let m = /^\/api\/docs\/([0-9a-f-]{36})\/docx$/.exec(path);
  if (m) {
    const d = await draftRow(c, m[1]);
    const v = await one(c, "select id, n, content_md, created_by, created_at from ws.doc_version where id = $1 and document_id = $2", [q.get("v"), m[1]]);
    if (!v?.content_md) throw new Error("no such version");
    const base = `${d.title} v${v.n}`.replace(/[^\w.\- ]+/g, "_");
    if (!q.get("against")) return { mime: DOCX, filename: `${base}.docx`, bytes: docxClean(v.content_md, d.title) };
    attorneyOnly(role);
    const a = await one(c, "select n, content_md from ws.doc_version where id = $1 and document_id = $2", [q.get("against"), m[1]]);
    if (!a?.content_md) throw new Error("no such version");
    const author = (await one(c, "select name from ws.person where id = $1", [v.created_by]))?.name ?? "Counsel";
    return { mime: DOCX, filename: `${base} redline from v${a.n}.docx`, bytes: docxRedline(a.content_md, v.content_md, d.title, author, new Date(v.created_at).toISOString()) };
  }
  if (path === "/api/export.zip") {
    const files = await exportPackage(c);
    return { mime: "application/zip", filename: "executed-documents.zip", bytes: zipSync(Object.fromEntries(files.map(f => [f.path, f.bytes]))) };
  }
  return null;
}
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** AI routes: they call the model outside a database transaction, so they take the pool and the session. */
export async function docAi(deps: { pool: pg.Pool; model: Model }, s: Session, path: string, body: any) {
  const m = /^\/api\/docs\/([0-9a-f-]{36})\/(review|suggest)$/.exec(path); if (!m) return null;
  const { templateId, versionId } = await inSession(deps.pool, s, async c => {
    const d = await draftRow(c, m[1]); const v = await latest(c, m[1]);
    return { templateId: d.template_id as string, versionId: (body.version ? String(body.version) : v.id) as string };
  });
  const t = tpl(templateId);
  return m[2] === "review" ? reviewVersion(deps, s, t, tplFile(t), m[1], versionId)
    : suggestEdits(deps, s, t, tplFile(t), m[1], versionId, String(body.instruction ?? ""));
}
