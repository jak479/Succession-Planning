// Intake agent, entity tier (build item 3). Spec: docs/design/intake-agent-spec.md.
// Permitted client-facing output only: a question from the intake list (fixed wording), a restatement for
// confirmation, a status line, a deferral, the session summary. Every turn with model-written text passes the gate.
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { inSession, type Session } from "../../../core/src/store.ts";
import { INTAKE_BY_ID } from "../../../core/src/catalog.ts";
import { INTAKE_Q, planIntake, sessionSummary } from "../../../core/src/intake.ts";
import type { Model } from "./model.ts";
import { ATTORNEY, CLASSIFY_SYSTEM, ClassifySchema, SCREEN_SYSTEM, ScreenSchema } from "./prompts.ts";
import { BANNED, FACT_HEALTH, FEE, HEALTH } from "./gate.ts";
import { extractText } from "./extract.ts";

export interface IntakeDeps { pool: pg.Pool; model: Model; enginePersonId: string }
const engineOf = (d: IntakeDeps, s: Session): Session => ({ personId: d.enginePersonId, workspaceId: s.workspaceId });

export const URGENT = `This is marked urgent; ${ATTORNEY} will contact you directly.`;
export const DEFERRAL = "That's a Thursday question; I've put it on the agenda.";

// ---------- Conflict check ----------
export async function requestConflictCheck(d: IntakeDeps, s: Session, names: { name: string; relation: string }[]) {
  return inSession(d.pool, engineOf(d, s), async c => (await c.query("select ws.request_conflict_check($1::jsonb) id", [JSON.stringify(names)])).rows[0].id as string);
}

// ---------- What to ask next (ask-last) ----------
async function statuses(c: pg.PoolClient) {
  return Object.fromEntries((await c.query("select item_id, status from ws.intake_status")).rows.map(r => [r.item_id, r.status]));
}
export function openingLines(status: Record<string, string>): { lines: string[]; askItem: string | null } {
  const p = planIntake(status);
  const lines: string[] = [];
  if (p.documents.length) lines.push(`To prepare for Thursday, please send: ${p.documents.map(i => INTAKE_Q[i.id]).join("; ")}.`);
  const q = p.questions[0];
  if (q) lines.push(INTAKE_Q[q.id]);
  return { lines, askItem: q?.id ?? null };
}

/** Session start: the document list (one request, grouped) and the first open question. Refused before clearance. */
export async function startSession(d: IntakeDeps, s: Session) {
  return inSession(d.pool, engineOf(d, s), async c => {
    const { lines, askItem } = openingLines(await statuses(c));
    if (lines.length) await c.query("insert into ws.intake_turn(workspace_id, speaker, body, item_id) values (ws.cur_ws(), 'agent', $1, $2)", [lines.join("\n"), askItem]);
    return { lines };
  });
}

// ---------- One client turn ----------
export const ExtractSchema = z.object({
  answers: z.array(z.object({ item_id: z.string(), restatement: z.string(), complete: z.boolean() })),
  asks_for_advice: z.boolean(),
});
const EXTRACT_SYSTEM = `You record a business owner's answers to a Florida law firm's intake questions. You are not a lawyer and you give no advice.
Map the client's message to the open intake items it answers. For each, write "restatement": one sentence that restates only the facts the client gave, in plain neutral words, starting with the subject (for example "Seacoast Bank; you are the only signer; Luis Herrera has view-only online access."). Do not infer, evaluate, or add anything the client did not say. Never include anyone's health, medical or capacity information. "complete" is true only if the message fully answers that item.
Use only item ids from the OPEN ITEMS list. asks_for_advice is true if the client asks what they should do, whether something is legal or wise, or for any legal opinion.`;

export async function clientTurn(d: IntakeDeps, s: Session, message: string): Promise<{ lines: string[] }> {
  const text = message.trim(); if (!text) throw new Error("empty message");

  // Stop rules first, before anything is stored (same screen as the front door).
  let stop: string | null = HEALTH.test(text) ? "health_or_capacity" : null;
  if (!stop) {
    const r = await d.model.json({ system: SCREEN_SYSTEM, user: text, schema: ScreenSchema, effort: "low", maxTokens: 1000 });
    stop = !r.ok ? "screen_unavailable" : r.value.category !== "none" ? r.value.category : null;
  }
  const withhold = stop === "health_or_capacity";
  await inSession(d.pool, s, c => c.query("insert into ws.intake_turn(workspace_id, speaker, body, withheld) values (ws.cur_ws(), 'client', $1, $2)", [withhold ? null : text, withhold]));

  return inSession(d.pool, engineOf(d, s), async c => {
    const status = await statuses(c);
    const recent = (await c.query("select item_id, deferred from ws.intake_turn where speaker = 'agent' order by id desc limit 20")).rows;
    const lastAsk = recent.find(r => r.item_id)?.item_id ?? null;
    const record = async (lines: string[], gate: unknown, flag: string | null, deferred = false, askItem: string | null = null) => {
      const t = (await c.query("insert into ws.intake_turn(workspace_id, speaker, body, item_id, deferred) values (ws.cur_ws(), 'agent', $1, $2, $3) returning id", [lines.join("\n"), askItem, deferred])).rows[0].id;
      await c.query("insert into ws.intake_turn_gate values ($1, ws.cur_ws(), $2, $3)", [t, JSON.stringify(gate), flag]);
      return { lines };
    };

    if (stop === "screen_unavailable") return record([DEFERRAL], { pass: false, checks: [{ name: "stop-rule screen", pass: false }] }, null, true);
    if (stop) return record([URGENT], { pass: true, checks: [{ name: "stop rule", pass: true, detail: stop }] }, stop);

    const open = [...planIntake(status).questions, ...planIntake(status).documents];
    const openList = open.map(i => `${i.id}: ${INTAKE_Q[i.id]}`).join("\n");
    const r = await d.model.json({ system: EXTRACT_SYSTEM, user: `QUESTION LAST ASKED: ${lastAsk ? `${lastAsk}: ${INTAKE_Q[lastAsk]}` : "(none)"}\n\nOPEN ITEMS\n${openList}\n\nCLIENT'S MESSAGE\n${text}`, schema: ExtractSchema, effort: "low", maxTokens: 4000 });
    if (!r.ok) return record([DEFERRAL], { pass: false, checks: [{ name: "extract", pass: false, detail: r.reason }] }, null, true);

    // Advice requested: defer; a second request after a deferral stops the line and flags the attorney.
    if (r.value.asks_for_advice) {
      const deferredBefore = recent.some(x => x.deferred);
      if (deferredBefore) return record([URGENT], { pass: true, checks: [{ name: "stop rule", pass: true, detail: "advice requested again after a deferral" }] }, "repeated_advice_request");
    }

    const openIds = new Set(open.map(i => i.id));
    const answers = r.value.answers.filter(a => openIds.has(a.item_id) && INTAKE_BY_ID.get(a.item_id)?.kind === "fact");
    // Gate the only model-written text, the restatements.
    const checks: { name: string; pass: boolean; detail?: string }[] = [];
    const bad = answers.flatMap(a => [a.restatement.match(BANNED)?.[0], a.restatement.match(FEE)?.[0], a.restatement.match(HEALTH)?.[0], a.restatement.match(FACT_HEALTH)?.[0]]).filter(Boolean);
    checks.push({ name: "lexical", pass: !bad.length, detail: bad.join(", ") || undefined });
    let restate = !bad.length;
    if (restate && answers.length) {
      const cl = await d.model.json({ system: CLASSIFY_SYSTEM, user: `CLIENT'S QUESTION\n(intake answer)\n\nMESSAGE TO AUDIT\n${answers.map(a => `I have: ${a.restatement} Correct?`).join("\n")}`, schema: ClassifySchema, effort: "low", maxTokens: 2000 });
      const flags = cl.ok ? (["advice", "recommendation", "evaluation_of_outside_answer", "prediction", "fee_or_time_estimate", "medical_information"] as const).filter(k => cl.value[k]) : ["classifier unavailable"];
      checks.push({ name: "classifier", pass: !flags.length, detail: flags.join(", ") || undefined });
      restate = !flags.length;
    }

    // Record answers as stated (rule 6), sourced to the client's own words (shown as "described").
    const lines: string[] = [];
    for (const a of answers) {
      if (a.complete) {
        const src = (await c.query("insert into ws.source(workspace_id, label, kind, name, citation) values (ws.cur_ws(), $1, 'CLIENT', $2, $3) returning id",
          [`I-${a.item_id}-${Date.now()}`, `Client answer to ${a.item_id}`, text.slice(0, 2000)])).rows[0].id;
        await c.query(`insert into ws.intake_status(workspace_id, item_id, status, source_id) values (ws.cur_ws(), $1, 'stated', $2)
                       on conflict (workspace_id, item_id) do update set status = 'stated', source_id = excluded.source_id, set_at = now()`, [a.item_id, src]);
        status[a.item_id] = "stated";
      }
      if (restate) lines.push(`I have: ${a.restatement.replace(/\s*$/, "")} Correct?`);
      lines.push(a.complete ? `Noted as stated. That goes toward ${INTAKE_BY_ID.get(a.item_id)!.feeds.join(", ") || "the plan"}.` : `Noted. To finish ${a.item_id}: ${INTAKE_Q[a.item_id]}`);
    }
    const deferred = r.value.asks_for_advice;
    if (deferred) lines.push(DEFERRAL);
    const next = planIntake(status).questions.find(q => !answers.some(a => a.item_id === q.id && !a.complete));
    if (next) lines.push(INTAKE_Q[next.id]);
    else if (!answers.length && !deferred) lines.push(...sessionSummary(status, []));
    return record(lines, { pass: checks.every(x => x.pass), checks }, null, deferred, next?.id ?? null);
  });
}

// ---------- File drop ----------
/** The client uploads a document for an intake item. It enters unread; the engine reads it server-side and records
 *  "received" only when readable text came out (rule 6); otherwise "received, unread" for the attorney's queue. */
export async function uploadDocument(d: IntakeDeps, s: Session, f: { item: string; filename: string; mime: string; bytes: Uint8Array }) {
  const def = INTAKE_BY_ID.get(f.item);
  if (!def || def.kind !== "doc") throw new Error("not a document item");
  const cleared = await inSession(d.pool, s, async c => (await c.query("select ws.client_cleared(ws.cur_ws()) ok")).rows[0].ok);
  if (!cleared) throw new Error("conflict check not cleared: no substantive intake yet");
  const sha = createHash("sha256").update(f.bytes).digest("hex");
  const sourceId = await inSession(d.pool, s, async c => {
    const id = (await c.query("insert into ws.source(workspace_id, label, kind, name, readable, intake_item) values (ws.cur_ws(), $1, 'DOC', $2, false, $3) returning id",
      [`U-${f.item}-${sha.slice(0, 8)}`, f.filename, f.item])).rows[0].id;
    await c.query("insert into ws.file_blob values ($1, ws.cur_ws(), $2, $3, $4, $5)", [id, f.filename, f.mime, Buffer.from(f.bytes), sha]);
    return id as string;
  });
  const x = await extractText(f.bytes, f.filename, f.mime);
  return inSession(d.pool, engineOf(d, s), async c => {
    if (x.readable) {
      await c.query("update ws.source set readable = true where id = $1", [sourceId]);
      await c.query("insert into ws.document_text values ($1, ws.cur_ws(), $2, $3, $4)", [sourceId, `${f.item}-${sha.slice(0, 6)}`, f.filename, x.text]);
    }
    const status = x.readable ? "received" : "received_unread";
    await c.query(`insert into ws.intake_status(workspace_id, item_id, status, source_id) values (ws.cur_ws(), $1, $2, $3)
                   on conflict (workspace_id, item_id) do update set status = excluded.status, source_id = excluded.source_id, set_at = now()`, [f.item, status, sourceId]);
    const line = x.readable ? `Received. That goes toward ${def.feeds.join(", ") || "the plan"}.` : "Received. It couldn't be read here, so Josh will review it directly.".replace("Josh", ATTORNEY);
    return { status, lines: [line], reason: x.reason };
  });
}

export async function summary(d: IntakeDeps, s: Session) {
  return inSession(d.pool, engineOf(d, s), async c => {
    const today = (await c.query("select item_id from ws.intake_status where set_at > now() - interval '12 hours' and status in ('stated','received','received_unread')")).rows.map(r => r.item_id);
    return { lines: sessionSummary(await statuses(c), today) };
  });
}
