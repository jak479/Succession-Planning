// Front door: one client question → stop-rule screen → brief → gate → client reply.
// The question is stored in the client's own session; the brief is written in the engine's session,
// in the same workspace. Nothing crosses tiers: the engine reads only that workspace's documents.
import type pg from "pg";
import { inSession, type Session } from "../../../core/src/store.ts";
import type { Model } from "./model.ts";
import { BriefSchema, FRONT_DOOR_SYSTEM, PROMPT_VERSION, SCREEN_SYSTEM, ScreenSchema, frontDoorUser, type Brief, type ClientFile } from "./prompts.ts";
import { HEALTH, gate } from "./gate.ts";
import { agendaReply, renderReply, urgentReply, type Reply } from "./render.ts";
import { NODES } from "../../../core/src/catalog.ts";

export interface Ask { question: string; outside?: string | null; contextNode?: string | null }
export interface Deps { pool: pg.Pool; model: Model; enginePersonId: string; company?: string; today?: () => string }
const EMPTY: Omit<Brief, "topic" | "urgent" | "tier"> = { suggested_scope: "mixed", scope_reason: "", documents_say: [], no_clause_for: [], facts_needed: [], check_this: [], anchor_proximity: "", agenda_line: "", attorney_note: "" };

export async function askFrontDoor(d: Deps, client: Session, ask: Ask): Promise<{ id: string; reply: Reply }> {
  const text = ask.question.trim(); if (!text) throw new Error("empty question");
  const ctx = ask.contextNode && NODES.some(n => n.id === ask.contextNode) ? ask.contextNode : null;

  // 1. Stop rules, before anything is stored. Health or capacity: the text is never stored.
  let stop: string | null = HEALTH.test(text) || HEALTH.test(ask.outside ?? "") ? "health_or_capacity" : null;
  let screenNote = stop ? "lexical health match" : "";
  if (!stop) {
    const s = await d.model.json({ system: SCREEN_SYSTEM, user: text + (ask.outside ? "\n\n" + ask.outside : ""), schema: ScreenSchema, effort: "low", maxTokens: 1000 });
    if (!s.ok) { stop = "screen_unavailable"; screenNote = s.reason; }
    else if (s.value.category !== "none") { stop = s.value.category; screenNote = s.value.explanation; }
  }
  const withhold = stop === "health_or_capacity";

  // 2. Store the question as the client.
  const id = await inSession(d.pool, client, async c => (await c.query(
    "insert into ws.question(workspace_id, body, withheld, outside_text, context_node) values (ws.cur_ws(), $1, $2, $3, $4) returning id",
    [withhold ? null : text, withhold, withhold ? null : ask.outside ?? null, ctx])).rows[0].id as string);

  // 3. Brief, gate and reply in the engine's session.
  const engine: Session = { personId: d.enginePersonId, workspaceId: client.workspaceId };
  const reply = await inSession(d.pool, engine, async c => {
    const position = 1 + Number((await c.query("select count(*) n from ws.question where agenda_position is not null and asked_at > now() - interval '7 days'")).rows[0].n);
    let brief: Brief, reply: Reply, gateResult: unknown, model: string | null = null, urgent = false;

    if (stop && stop !== "screen_unavailable") {
      urgent = true;
      brief = { ...EMPTY, topic: withhold ? "(withheld: health or capacity)" : stop, tier: "entity", urgent: true, attorney_note: `Line stopped: ${stop}. ${withhold ? "Question text not stored." : screenNote}` };
      reply = urgentReply(); gateResult = { pass: true, checks: [{ name: "stop rule", pass: true, detail: stop }] };
    } else if (stop === "screen_unavailable") {
      brief = { ...EMPTY, topic: "(screen unavailable)", tier: "entity", urgent: false, attorney_note: `Stop-rule screen could not run: ${screenNote}. Review the question before the call.` };
      reply = agendaReply(position); gateResult = { pass: false, checks: [{ name: "stop-rule screen", pass: false, detail: screenNote }] };
    } else {
      const file = await loadFile(c, d);
      const node = ctx ? NODES.find(n => n.id === ctx)! : null;
      const r = await d.model.json({ system: FRONT_DOOR_SYSTEM, user: frontDoorUser(file, text, ask.outside ?? null, node && { id: node.id, name: node.name }), schema: BriefSchema, effort: "medium", maxTokens: 16000 });
      if (!r.ok) {
        brief = { ...EMPTY, topic: "(engine unavailable)", tier: "entity", urgent: false, attorney_note: `Brief could not be produced: ${r.reason}` };
        reply = agendaReply(position); gateResult = { pass: false, checks: [{ name: "engine", pass: false, detail: r.reason }] };
      } else {
        brief = r.value; model = r.model; urgent = brief.urgent;
        const titles = new Map(file.documents.map(x => [x.key, x.title]));
        const candidate = renderReply(brief, titles, position);
        const g = await gate(brief, candidate, titles, d.model);
        reply = g.pass ? candidate : agendaReply(position); gateResult = g;
      }
    }
    await c.query(`insert into ws.brief(question_id, workspace_id, topic, urgent, stop_reason, suggested_scope, scope_reason, documents_say, no_clause_for,
        facts_needed, check_this, anchor_proximity, agenda_line, attorney_note, gate, model, prompt_version)
      values ($1, ws.cur_ws(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, brief.topic, urgent, stop, model ? brief.suggested_scope : null, model ? brief.scope_reason : null, JSON.stringify(brief.documents_say), JSON.stringify(brief.no_clause_for),
       JSON.stringify(brief.facts_needed), JSON.stringify(brief.check_this), brief.anchor_proximity, brief.agenda_line || brief.topic, brief.attorney_note,
       JSON.stringify(gateResult), model, PROMPT_VERSION]);
    await c.query("update ws.question set reply = $2, status = $3, agenda_position = $4 where id = $1", [id, JSON.stringify(reply), urgent ? "held" : "answered", urgent ? null : position]);
    return reply;
  });
  return { id, reply };
}

async function loadFile(c: pg.PoolClient, d: Deps): Promise<ClientFile> {
  const docs = (await c.query("select doc_key, title, body from ws.document_text order by doc_key")).rows;
  const nodes = (await c.query("select node_id, status from ws.node_status")).rows;
  const client = (await c.query("select c.name from ws.client c")).rows[0];
  return {
    company: client?.name ?? d.company ?? "", today: d.today?.() ?? new Date().toISOString().slice(0, 10), anchors: [],
    documents: docs.map(r => ({ key: r.doc_key, title: r.title, body: r.body })),
    nodeStatus: Object.fromEntries(nodes.map(r => [r.node_id, r.status])),
  };
}
