// Board API. Every request runs in one person's session in one workspace (core/src/store.ts);
// the database decides what that person may see and do.
import http from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../../core/src/store.ts";
import { stageOf } from "../../core/src/rules.ts";
import { STAGES } from "../../core/src/catalog.ts";
import { askFrontDoor } from "./engine/pipeline.ts";
import { claudeModel } from "./engine/model.ts";

const ENGINE = process.env.ENGINE_PERSON_ID ?? "";   // the agent identity the engine writes briefs as
const model = claudeModel();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PAGE = new URL("../../web/board.html", import.meta.url);

// DEV-ONLY identity: "Authorization: Dev <person-id>". Replace with OIDC before any client uses it.
function who(req: http.IncomingMessage) {
  const m = /^Dev ([0-9a-f-]{36})$/.exec(req.headers.authorization ?? "");
  return m ? m[1] : null;
}

type Ctx = { c: pg.PoolClient; body: any; role: string };
const routes: [string, RegExp, (x: Ctx, m: RegExpExecArray) => Promise<unknown>][] = [
  ["GET", /^\/api\/board$/, async ({ c, role }) => {
    const me = (await c.query("select p.name, p.role, w.tier, cl.name client, coalesce(m.signer,false) signer from ws.person p, ws.workspace w join ws.client cl on cl.id=w.client_id left join ws.membership m on m.workspace_id=w.id and m.person_id=ws.me() where p.id=ws.me() and w.id=ws.cur_ws()")).rows[0];
    if (!me) throw new Error("not in scope");
    const items = (await c.query(`select b.id, b.co_id, b.title, b.clears, b.col, b.allowance, b.price, b.proposed_price, b.scope_text, b.proposed_at, b.approved_at,
        d.schedule, a.typed_name signed_by, a.signed_at, n.finding, n.attorney_note
      from ws.board_item b left join ws.change_order_def d on d.id=b.co_id
      left join ws.change_order_approval a on a.id::text=b.approval_ref
      left join ws.board_note n on n.item_id=b.id order by b.title`)).rows;
    const budget = (await c.query("select * from ws.budget")).rows[0] ?? null;
    const nodes = Object.fromEntries((await c.query("select node_id, status from ws.node_status")).rows.map(r => [r.node_id, r.status]));
    const st = stageOf(nodes);
    const catalog = role === "attorney" ? (await c.query("select * from ws.change_order_def order by id")).rows : [];
    return { me, items, budget, stage: { index: st, name: STAGES[st].name }, catalog };
  }],
  ["GET", /^\/api\/frontdoor$/, async ({ c, role }) => {
    const qs = (await c.query("select id, asked_at, body, withheld, outside_text, context_node, status, reply, agenda_position, confirmed_scope from ws.question order by asked_at desc")).rows;
    if (role !== "attorney") return { questions: qs };
    const briefs = (await c.query("select * from ws.brief")).rows;
    return { questions: qs.map(q => ({ ...q, brief: briefs.find(b => b.question_id === q.id) ?? null })) };
  }],
  ["POST", /^\/api\/frontdoor\/([0-9a-f-]{36})\/scope$/, ({ c, body }, m) => c.query("select ws.confirm_scope($1,$2)", [m[1], String(body.scope)])],
  ["POST", /^\/api\/board$/, async ({ c, body }) => {
    const d = (await c.query("select * from ws.change_order_def where id=$1", [body.co_id])).rows[0];
    if (!d) throw new Error("unknown change order");
    const r = (await c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance) values (ws.cur_ws(),$1,$2,$3,$4) returning id",
      [d.id, d.name, d.clears, Number(body.allowance ?? d.low) || 0])).rows[0];
    if (body.finding || body.attorney_note) await c.query("insert into ws.board_note values ($1, ws.cur_ws(), $2, $3)", [r.id, body.finding ?? null, body.attorney_note ?? null]);
    return r;
  }],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/propose$/, ({ c, body }, m) => c.query("select ws.propose_change_order($1,$2,$3)", [m[1], Number(body.price), String(body.scope ?? "")])],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/approve$/, ({ c, body }, m) => c.query("select ws.approve_change_order($1,$2) id", [m[1], String(body.typed_name ?? "")]).then(r => r.rows[0])],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/included$/, ({ c }, m) => c.query("select ws.scope_included($1)", [m[1]])],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/move$/, ({ c, body }, m) => c.query("update ws.board_item set col=$2 where id=$1", [m[1], String(body.col)])
    .then(r => { if (!r.rowCount) throw new Error("not permitted"); })],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/allowance$/, ({ c, body }, m) => c.query("update ws.board_item set allowance=$2 where id=$1 and col='Identified'", [m[1], Number(body.allowance) || 0])
    .then(r => { if (!r.rowCount) throw new Error("not permitted"); })],
];

// Database messages are written for the attorney; clients get a plain line.
function clientSafe(msg: string, role: string) {
  if (role === "attorney" && !/not in scope/.test(msg)) return msg;
  if (/not in scope/.test(msg)) return "This workspace isn't available to you.";
  if (/authorized signer/.test(msg)) return "Only an authorized signer for the company can approve a change order.";
  if (/no proposed change order/.test(msg)) return "This item has no change order to approve yet. Josh will propose one on Thursday's call.";
  return "That action isn't available to you. It's on Thursday's agenda.";
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/board")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(readFileSync(PAGE)); return;
  }
  if (req.method === "POST" && url.pathname === "/api/frontdoor") {
    const personId = who(req), workspaceId = url.searchParams.get("ws");
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!personId || !workspaceId) return send(401, { error: "sign in" });
    if (!ENGINE) return send(503, { error: "The workspace assistant isn't configured yet. Your question can go on Thursday's call." });
    let raw = ""; for await (const ch of req) raw += ch;
    try {
      const b = raw ? JSON.parse(raw) : {};
      return send(200, await askFrontDoor({ pool, model, enginePersonId: ENGINE }, { personId, workspaceId }, { question: String(b.question ?? ""), outside: b.outside ?? null, contextNode: b.context_node ?? null }));
    } catch { return send(400, { error: "That question couldn't be received. Please try again." }); }
  }
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj ?? {})); };
  if (!route) return send(404, { error: "not found" });
  const personId = who(req), workspaceId = url.searchParams.get("ws");
  if (!personId || !workspaceId) return send(401, { error: "sign in" });
  let raw = ""; for await (const ch of req) raw += ch;
  let role = "client";
  try {
    const out = await inSession(pool, { personId, workspaceId }, async c => {
      role = (await c.query("select ws.my_role() r")).rows[0].r ?? "client";
      return route[2]({ c, body: raw ? JSON.parse(raw) : {}, role }, route[1].exec(url.pathname)!);
    });
    send(200, (out as any)?.rows ? {} : out);
  } catch (e: any) {
    send(400, { error: clientSafe(String(e.message ?? e), role) });
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log("board on http://localhost:" + (process.env.PORT ?? 8787)));
