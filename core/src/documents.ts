// Document management wired to the assembler (db/011_documents.sql; docs/design/drafting-tool.md § 8).
// Every call runs inside an inSession() transaction, so RLS and the triggers decide who may do what.
import { createHash } from "node:crypto";
import type pg from "pg";
import { assemble, blockers, callQuestions, executionModes, type AssembleOptions, type ExecMode, type Facts, type Template } from "./drafting.ts";

export type DraftMode = "manual" | "ai_draft" | "ai_review" | "import";
/** Who signed the executed copy. The template's auto-green rule (db/012) reads this to turn nodes green. */
export type Signature = "principal" | "members" | "interim_manager" | "alternate_im" | "business_agent" | "alternate_agent" | "witnesses" | "notary";
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const one = async (c: pg.PoolClient, q: string, p: unknown[]) => (await c.query(q, p)).rows[0];

/** Open a draft document for a template in the session's workspace (the DB refuses a template from the other tier). */
export async function createDraft(c: pg.PoolClient, t: Template, nodes: string[], title = t.title): Promise<string> {
  return (await one(c, "insert into ws.document (workspace_id, kind, title, template_id, nodes) values (ws.cur_ws(), 'draft', $1, $2, $3) returning id", [title, t.id, nodes])).id;
}

/** Assemble from facts and save the result as the draft's next version, with the facts, their sources and the blockers. */
export async function saveAssembled(c: pg.PoolClient, documentId: string, t: Template, templateFile: string, facts: Facts, mode: DraftMode = "manual", note?: string) {
  const a = assemble(t, templateFile, facts);
  const questions = callQuestions(t, a, new Date().toISOString()).map(({ key, title, node }) => ({ key, title, node }));
  return { ...(await saveVersion(c, documentId, a.text, facts, blockers(a), mode, note, questions)), assembly: a };
}

/** Save edited text as the next version. `blockers` comes from the assembler run the text started from. */
export async function saveVersion(c: pg.PoolClient, documentId: string, text: string, facts: Facts, open: string[], mode: DraftMode, note?: string,
  questions: { key: string; title: string; node: string | null }[] = []) {
  const n = (await one(c, "select coalesce(max(n), 0) + 1 as n from ws.doc_version where document_id = $1", [documentId])).n;
  const r = await one(c, `insert into ws.doc_version (workspace_id, document_id, n, content_md, sha256, mode, facts, blockers, note, questions)
    values (ws.cur_ws(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, n`, [documentId, n, text, sha(text), mode, JSON.stringify(facts), JSON.stringify(open), note ?? null, JSON.stringify(questions)]);
  return { versionId: r.id as string, n: r.n as number };
}

/** Send one version to the client. The DB refuses unless that version has no blockers. */
export async function sendVersion(c: pg.PoolClient, documentId: string, versionId: string) {
  await c.query("update ws.doc_version set sent_at = now() where id = $1 and document_id = $2", [versionId, documentId]);
  await c.query("update ws.document set status = 'sent' where id = $1", [documentId]);
}

/** Add a file as a new document (counterparty paper) or as a new version of an existing non-draft document. */
export async function addFile(c: pg.PoolClient, kind: "counterparty" | "executed", title: string, file: { filename: string; mime: string; bytes: Uint8Array }, opts: { parentId?: string; nodes?: string[] } = {}) {
  const d = (await one(c, "insert into ws.document (workspace_id, kind, title, parent_id, nodes) values (ws.cur_ws(), $1, $2, $3, $4) returning id",
    [kind, title, opts.parentId ?? null, opts.nodes ?? []])).id as string;
  const v = (await one(c, `insert into ws.doc_version (workspace_id, document_id, n, bytes, filename, mime, sha256)
    values (ws.cur_ws(), $1, 1, $2, $3, $4, $5) returning id`, [d, Buffer.from(file.bytes), file.filename, file.mime, sha(file.bytes)])).id as string;
  return { documentId: d, versionId: v };
}

/** File an executed original against the sent draft version it signs. The execution mode must be one the template's
 *  rules allow for the facts that version used (§ 709.2105, § 117.285, § 709.2202(6)); the DB checks the rest. */
export async function fileExecuted(c: pg.PoolClient, t: Template, draftId: string, signedVersionId: string,
  file: { filename: string; mime: string; bytes: Uint8Array }, exec: { mode: ExecMode; executedOn: string; ronProvider?: string; journalRef?: string; signatures?: Signature[] }) {
  const v = await one(c, "select facts, sent_at from ws.doc_version where id = $1 and document_id = $2", [signedVersionId, draftId]);
  if (!v) throw new Error("no such version of this draft");
  const rule = executionModes(t.id, v.facts as Facts).find(r => r.mode === exec.mode)!;
  if (!rule.allowed) throw new Error(`execution mode ${exec.mode} not allowed: ${rule.why}`);
  const draft = await one(c, "select title, nodes from ws.document where id = $1", [draftId]);
  const { documentId } = await addFile(c, "executed", draft.title + " (executed)", file, { parentId: draftId, nodes: draft.nodes });
  await c.query(`insert into ws.doc_execution (document_id, workspace_id, draft_version, mode, executed_on, ron_provider, journal_ref, signatures)
    values ($1, ws.cur_ws(), $2, $3, $4, $5, $6, $7)`, [documentId, signedVersionId, exec.mode, exec.executedOn, exec.ronProvider ?? null, exec.journalRef ?? null, exec.signatures ?? []]);
  const green = (await c.query("select node_id from ws.node_status where source_id = (select source_id from ws.document where id = $1) and status = 'green' order by node_id", [documentId])).rows.map(r => r.node_id as string);
  return { documentId, requires: rule.requires ?? [], green };
}

/** Retire a document; it stays in the index and the audit log. */
export async function supersede(c: pg.PoolClient, documentId: string) {
  await c.query("update ws.document set status = 'superseded' where id = $1", [documentId]);
}

/** The document index the session may see, newest first. */
export async function listDocuments(c: pg.PoolClient) {
  return (await c.query(`select d.id, d.kind, d.title, d.template_id, d.nodes, d.status, d.parent_id, d.created_at,
      (select max(n) from ws.doc_version v where v.document_id = d.id) as versions
    from ws.document d order by d.created_at desc`)).rows;
}

/** Re-open a saved draft version in the assembler, e.g. after a client choice is recorded on the call. */
export async function reassemble(c: pg.PoolClient, versionId: string, t: Template, templateFile: string, more: Facts = {}, opts: AssembleOptions = {}) {
  const v = await one(c, "select facts from ws.doc_version where id = $1", [versionId]);
  return assemble(t, templateFile, { ...(v.facts as Facts), ...more }, opts);
}

/** Rule 8 export package: every executed original with its execution record, as files plus an index. */
export async function exportPackage(c: pg.PoolClient): Promise<{ path: string; bytes: Uint8Array }[]> {
  const rows = (await c.query(`select i.*, coalesce(v.bytes, b.bytes) as bytes from ws.export_index i
      join ws.doc_version v on v.id = i.version_id left join ws.file_blob b on b.source_id = v.blob_source
      where v.purged_at is null order by i.executed_on, i.title`)).rows;
  const safe = (s: string) => s.replace(/[^\w.\- ]+/g, "_");
  const files = rows.map((r, i) => ({ path: `${String(i + 1).padStart(2, "0")} ${safe(r.title)}${r.filename?.match(/\.\w+$/)?.[0] ?? ""}`, bytes: new Uint8Array(r.bytes), r }));
  const index = ["# Executed documents", "", "| File | Executed | How signed | Notary record | SHA-256 |", "|---|---|---|---|---|",
    ...files.map(f => `| ${f.path} | ${new Date(f.r.executed_on).toISOString().slice(0, 10)} | ${f.r.mode} | ${f.r.ron_provider ? `${f.r.ron_provider}: ${f.r.journal_ref}` : "—"} | ${f.r.sha256} |`),
    "", "This package holds the executed originals in your file and the record of how each was signed."].join("\n");
  return [{ path: "INDEX.md", bytes: new TextEncoder().encode(index) }, ...files.map(f => ({ path: f.path, bytes: f.bytes }))];
}

/** Close the file at the end of the engagement (db/012, db/013). Disposal follows the Bar's guidelines (Op. 81-8 via
 *  the Bar's ethics FAQ): ask the client for directions; if the client cannot be reached, keep marked originals longer. */
export async function closeFile(c: pg.PoolClient, endedOn: string) {
  await c.query("insert into ws.file_closure (workspace_id, engagement_ended_on) values (ws.cur_ws(), $1)", [endedOn]);
}
/** "directions_requested": the written request to the client for directions (stored as notice_sent_at). */
export async function markClosure(c: pg.PoolClient, step: "export_delivered" | "directions_requested") {
  await c.query(`update ws.file_closure set ${step === "export_delivered" ? "export_delivered_at" : "notice_sent_at"} = now() where workspace_id = ws.cur_ws()`);
}
export async function recordDirection(c: pg.PoolClient, direction: "return" | "destroy" | "firm_keep") {
  await c.query("update ws.file_closure set client_direction = $1, direction_at = now() where workspace_id = ws.cur_ws()", [direction]);
}
export async function recordUnreachable(c: pg.PoolClient, contactLog: string) {
  await c.query("update ws.file_closure set unreachable_at = now(), contact_log = $1 where workspace_id = ws.cur_ws()", [contactLog]);
}
/** Mark a document as an original or important paper to keep if the client cannot be reached. */
export async function markOriginal(c: pg.PoolClient, documentId: string, keep = true) {
  await c.query("update ws.document set retain_original = $2 where id = $1", [documentId, keep]);
}
/** Purge the closed file's contents; the index, hashes, execution records and audit log stay. */
export async function purgeFile(c: pg.PoolClient): Promise<number> {
  return (await one(c, "select ws.purge_documents() as n", [])).n;
}

/** Integrity and readability check over every stored version in the session's workspace (db/014; Op. 06-1):
 *  the stored hash still matches, and the bytes still look like the format they claim. Results are attorney-only. */
export async function verifyIntegrity(c: pg.PoolClient) {
  const rows = (await c.query(`select v.id, v.sha256, v.mime, v.filename, v.content_md, coalesce(v.bytes, b.bytes) as bytes
    from ws.doc_version v left join ws.file_blob b on b.source_id = v.blob_source where v.purged_at is null`)).rows;
  const out: { versionId: string; hashOk: boolean; opensOk: boolean; detail: string }[] = [];
  for (const r of rows) {
    const data: Uint8Array | null = r.content_md != null ? new TextEncoder().encode(r.content_md) : r.bytes ? new Uint8Array(r.bytes) : null;
    let hashOk = false, opensOk = false, detail = "";
    if (!data) detail = "contents missing";
    else {
      hashOk = sha(data) === r.sha256;
      const kind = r.content_md != null ? "text" : formatOf(r.mime, r.filename);
      opensOk = opens(kind, data);
      detail = `${kind}${hashOk ? "" : "; hash mismatch"}${opensOk ? "" : "; does not open as " + kind}`;
    }
    await c.query("insert into ws.integrity_check (workspace_id, version_id, hash_ok, opens_ok, detail) values (ws.cur_ws(), $1, $2, $3, $4)", [r.id, hashOk, opensOk, detail]);
    out.push({ versionId: r.id, hashOk, opensOk, detail });
  }
  return { checked: out.length, failed: out.filter(x => !x.hashOk || !x.opensOk) };
}
const formatOf = (mime = "", name = "") =>
  /pdf/.test(mime) || /\.pdf$/i.test(name) ? "pdf"
  : /wordprocessingml|zip/.test(mime) || /\.(docx|zip)$/i.test(name) ? "zip"
  : /png/.test(mime) || /\.png$/i.test(name) ? "png"
  : /jpe?g/.test(mime) || /\.jpe?g$/i.test(name) ? "jpeg"
  : /^text\//.test(mime) || /\.(txt|md|csv)$/i.test(name) ? "text" : "other";
function opens(kind: string, b: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  switch (kind) {
    case "pdf": return starts(0x25, 0x50, 0x44, 0x46, 0x2d);              // %PDF-
    case "zip": return starts(0x50, 0x4b, 0x03, 0x04);                    // PK..
    case "png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "jpeg": return starts(0xff, 0xd8, 0xff);
    case "text": try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
    default: return b.length > 0;                                          // unknown format: present, not parsed
  }
}

/** Litigation hold (db/015): blocks purge, even on the client's direction to destroy. Attorney-only. */
export async function placeHold(c: pg.PoolClient, reason: string): Promise<string> {
  return (await one(c, "insert into ws.legal_hold (workspace_id, reason) values (ws.cur_ws(), $1) returning id", [reason])).id;
}
export async function releaseHold(c: pg.PoolClient, holdId: string, reason: string) {
  await c.query("update ws.legal_hold set released_at = now(), released_by = ws.me(), release_reason = $2 where id = $1", [holdId, reason]);
}
