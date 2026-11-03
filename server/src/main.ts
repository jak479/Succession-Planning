// Board API. Every request runs in one person's session in one workspace (core/src/store.ts);
// the database decides what that person may see and do.
import http from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../../core/src/store.ts";
import { stageOf } from "../../core/src/rules.ts";
import { STAGES, NODES } from "../../core/src/catalog.ts";
import { blockedBy } from "../../core/src/rules.ts";
import { askFrontDoor } from "./engine/pipeline.ts";
import { claudeModel } from "./engine/model.ts";
import { clientTurn, requestConflictCheck, startSession, summary, uploadDocument } from "./engine/intake.ts";
import { PUBLIC_RECORDS } from "../../core/src/intake.ts";
import { buildProfile } from "./engine/profile.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { DEMO, seedDemo } from "./demo-seed.ts";

// Demo mode (hosted proof of concept): a site password, a persona page, fictional client only, resettable.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const DEMO_MODE = DEMO_PASSWORD.length > 0;
const DEMO_COOKIE = DEMO_MODE ? createHash("sha256").update("oew-demo|" + DEMO_PASSWORD).digest("hex") : "";
const ENGINE = process.env.ENGINE_PERSON_ID ?? (DEMO_MODE ? DEMO.engine : "");   // the agent identity the engine writes as
const model = claudeModel();

// Cloud SQL from Cloud Run connects over a Unix socket; locally, DATABASE_URL.
const pool = process.env.CLOUD_SQL_INSTANCE
  ? new pg.Pool({ host: `/cloudsql/${process.env.CLOUD_SQL_INSTANCE}`, user: process.env.DB_USER ?? "postgres", password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? "oew", max: 5 })
  : new pg.Pool({ connectionString: process.env.DATABASE_URL });
if (DEMO_MODE) {
  // Demo data only: (re)seed when the schema is missing or older than the newest migration (008 adds board_item.offer_good_through).
  const current = (await pool.query("select exists (select 1 from information_schema.columns where table_schema = 'ws' and table_name = 'board_item' and column_name = 'offer_good_through') ok")).rows[0].ok;
  if (!current) { const c = await pool.connect(); try { await seedDemo(c); } finally { c.release(); } console.log("demo data seeded"); }
}
const hasDemoCookie = (req: http.IncomingMessage) => {
  const m = /(?:^|;\s*)oew_demo=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
  return !!m && timingSafeEqual(Buffer.from(m[1]), Buffer.from(DEMO_COOKIE));
};
const DEMO_BANNER = `<div style="background:#7a1f1f;color:#fff;font:13px system-ui,sans-serif;padding:6px 16px">Demo: fictional client (Gulfside Mechanical, LLC). Do not enter real client information. <a href="/demo" style="color:#fff">Switch person</a></div>`;
function demoPage(): string {
  const link = (who: string, ws: string, page: string, label: string, note: string) => `<li><a href="/${page}?as=${who}&ws=${ws}">${label}</a> <span>${note}</span></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner Exit Demo</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f6f2;color:#1d2321}main{max-width:720px;margin:0 auto;padding:24px 16px}li{margin:10px 0}span{color:#5d6763;font-size:13px;display:block}a{color:#2d5b8a}
@media (prefers-color-scheme: dark){body{background:#141716;color:#e8ebe9}span{color:#9aa5a0}a{color:#7fb0e0}}</style></head><body>${DEMO_BANNER}<main>
<h1 style="font-size:20px">Owner exit workspace: proof of concept</h1>
<p>One fictional client, Gulfside Mechanical, LLC, owned by Dana Ortiz. Choose whose view to open.</p><ul>
${link(DEMO.dana, DEMO.entity, "workspace", "Dana Ortiz: client workspace", "Owner and authorized signer. Ask questions, intake, plan, profile.")}
${link(DEMO.dana, DEMO.entity, "board", "Dana Ortiz: board and budget", "Approve proposed change orders.")}
${link(DEMO.luis, DEMO.entity, "workspace", "Luis Herrera: client workspace", "Operations manager. Same company, cannot see Dana's intake or sign change orders.")}
${link(DEMO.attorney, DEMO.entity, "attorney", "Josh: attorney console", "Conflicts, briefs and scope, intake agenda, profile.")}
${link(DEMO.attorney, DEMO.entity, "board", "Josh: board", "Propose change orders, scope included work, mark done.")}
</ul><form method="post" action="/demo/reset" onsubmit="return confirm('Reset all demo data to the starting point?')"><button type="submit">Reset demo data</button></form></main></body></html>`;
}
const loginPage = (bad: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner Exit Demo</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f6f2;color:#1d2321}main{max-width:420px;margin:12vh auto;padding:16px}input,button{font:inherit;padding:8px;width:100%;margin-top:8px}
@media (prefers-color-scheme: dark){body{background:#141716;color:#e8ebe9}}</style></head><body><main><h1 style="font-size:20px">Demo sign-in</h1>
<form method="post" action="/demo/login"><label for="p">Demo password</label><input id="p" name="p" type="password" autocomplete="current-password" required><button type="submit">Enter</button></form>${bad ? '<p style="color:#b23a3a">That password is not right.</p>' : ""}</main></body></html>`;
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
    const items = (await c.query(`select b.id, b.co_id, b.title, b.clears, b.col, b.allowance, b.estimate_good_through, b.price, b.proposed_price, b.other_costs, b.offer_good_through, b.scope_text, b.proposed_at, b.approved_at,
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
  // ---- Shared by the client workspace and the attorney console ----
  ["GET", /^\/api\/me$/, async ({ c }) => {
    const me = (await c.query("select p.name, p.role, w.tier, cl.name client, coalesce(m.signer,false) signer from ws.person p, ws.workspace w join ws.client cl on cl.id=w.client_id left join ws.membership m on m.workspace_id=w.id and m.person_id=ws.me() where p.id=ws.me() and w.id=ws.cur_ws()")).rows[0];
    if (!me) throw new Error("not in scope");
    return me;
  }],
  ["GET", /^\/api\/plan$/, async ({ c }) => {
    const nodes = Object.fromEntries((await c.query("select node_id, status from ws.node_status")).rows.map(r => [r.node_id, r.status]));
    const st = stageOf(nodes);
    return { stage: { index: st, name: STAGES[st].name }, stages: STAGES.map(s => s.name), nodes, blocked: blockedBy(nodes),
      defs: NODES.map(n => ({ id: n.id, name: n.name, satisfiedBy: n.satisfiedBy })) };
  }],
  ["GET", /^\/api\/intake\/turns$/, ({ c }) => c.query(`select t.id, t.speaker, t.body, t.withheld, t.at, p.name for_name
     from ws.intake_turn t left join ws.person p on p.id = t.for_person order by t.id`).then(r => ({ turns: r.rows }))],
  // ---- Profile (item 3) ----
  ["GET", /^\/api\/profile$/, async ({ c, role }) => ({
    profile: (await c.query(`select v.field, v.value, v.basis,
        coalesce((select string_agg(s.label, ', ' order by s.label) from ws.profile_value_source x join ws.source s on s.id = x.source_id
                   where x.workspace_id = v.workspace_id and x.field = v.field), v.source) source
      from ws.profile_view v order by v.field`)).rows,
    conflicts: (await c.query("select c.field, c.value_a, sa.label source_a, c.value_b, sb.label source_b from ws.conflict c join ws.source sa on sa.id = c.source_a join ws.source sb on sb.id = c.source_b")).rows,
    lastRun: role === "attorney" ? (await c.query("select at, model, result from ws.profile_run order by at desc limit 1")).rows[0] ?? null : undefined,
  })],
  // ---- Intake (item 3) ----
  ["GET", /^\/api\/intake\/conflict$/, async ({ c, role }) => {
    const checks = (await c.query("select id, names, status, requested_at, decided_at from ws.conflict_check order by requested_at desc")).rows;
    if (role !== "attorney") return { checks: checks.map(x => ({ id: x.id, status: x.status })) };
    const hits = (await c.query("select h.check_id, h.queried_name, h.similarity, f.name, f.relation from ws.conflict_hit h join ws.firm_party f on f.id = h.party_id")).rows;
    return { checks: checks.map(x => ({ ...x, hits: hits.filter(h => h.check_id === x.id) })) };
  }],
  ["POST", /^\/api\/intake\/conflict\/([0-9a-f-]{36})\/decide$/, ({ c, body }, m) => c.query("select ws.decide_conflict($1,$2)", [m[1], String(body.decision)])],
  ["GET", /^\/api\/intake\/records$/, async ({ c }) => {
    const pulls = (await c.query("select record_id, query, status, done_at from ws.record_pull")).rows;
    return { records: PUBLIC_RECORDS.map(r => ({ ...r, pulls: pulls.filter(p => p.record_id === r.id) })) };
  }],
  // Record a public-record pull done from the checklist: the result becomes a cited PUB source (rule 6).
  ["POST", /^\/api\/intake\/records$/, async ({ c, body }) => {
    const rec = PUBLIC_RECORDS.find(r => r.id === body.record_id); if (!rec) throw new Error("unknown record");
    let sid: string | null = null;
    if (body.status === "found") sid = (await c.query("insert into ws.source(workspace_id,label,kind,name,citation) values (ws.cur_ws(),$1,'PUB',$2,$3) returning id",
      [`P-${rec.id}-${Date.now()}`, `${rec.name}: ${String(body.query)}`, String(body.citation ?? "")])).rows[0].id;
    await c.query(`insert into ws.record_pull(workspace_id, record_id, query, status, source_id, done_by, done_at) values (ws.cur_ws(),$1,$2,$3,$4,ws.me(),now())
      on conflict (workspace_id, record_id, query) do update set status = excluded.status, source_id = excluded.source_id, done_by = excluded.done_by, done_at = now()`,
      [rec.id, String(body.query), String(body.status), sid]);
    return { ok: true };
  }],
  // Thursday agenda from intake: every deferred or flagged agent turn, with the client message before it (attorney only).
  ["GET", /^\/api\/intake\/agenda$/, async ({ c, role }) => {
    if (role !== "attorney") throw new Error("not permitted");
    return { items: (await c.query(`select a.id, a.at, a.body reply, g.flag, g.gate,
        (select coalesce(t.body, '(withheld: health or capacity)') from ws.intake_turn t where t.speaker = 'client' and t.id < a.id order by t.id desc limit 1) client_message
      from ws.intake_turn a join ws.intake_turn_gate g on g.turn_id = a.id where a.deferred or g.flag is not null order by a.id`)).rows };
  }],
  // Attorney's queue: documents received but unreadable.
  ["GET", /^\/api\/intake\/queue$/, ({ c }) => c.query("select i.item_id, s.name filename, i.set_at from ws.intake_status i join ws.source s on s.id = i.source_id where i.status = 'received_unread' order by i.set_at").then(r => ({ unread: r.rows }))],
  ["POST", /^\/api\/board$/, async ({ c, body }) => {
    const d = (await c.query("select * from ws.change_order_def where id=$1", [body.co_id])).rows[0];
    if (!d) throw new Error("unknown change order");
    const r = (await c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance) values (ws.cur_ws(),$1,$2,$3,$4) returning id",
      [d.id, d.name, d.clears, Number(body.allowance ?? d.low) || 0])).rows[0];
    if (body.finding || body.attorney_note) await c.query("insert into ws.board_note values ($1, ws.cur_ws(), $2, $3)", [r.id, body.finding ?? null, body.attorney_note ?? null]);
    return r;
  }],
  ["POST", /^\/api\/board\/([0-9a-f-]{36})\/propose$/, ({ c, body }, m) => c.query("select ws.propose_change_order($1,$2,$3,$4,$5)", [m[1], Number(body.price), String(body.scope ?? ""), String(body.other_costs ?? ""), body.good_through ? String(body.good_through) : null])],
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
  const html = (code: number, body: string) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (DEMO_MODE) {
    if (req.method === "POST" && url.pathname === "/demo/login") {
      let raw = ""; for await (const ch of req) raw += ch;
      const p = new URLSearchParams(raw).get("p") ?? "";
      const ok = p.length === DEMO_PASSWORD.length && timingSafeEqual(Buffer.from(p), Buffer.from(DEMO_PASSWORD));
      if (!ok) return html(401, loginPage(true));
      res.writeHead(303, { location: "/demo", "set-cookie": `oew_demo=${DEMO_COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` }); res.end(); return;
    }
    if (!hasDemoCookie(req)) {
      if (url.pathname.startsWith("/api/")) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Sign in to the demo." })); return; }
      return html(200, loginPage(false));
    }
    if (req.method === "GET" && (url.pathname === "/demo" || url.pathname === "/")) return html(200, demoPage());
    if (req.method === "POST" && url.pathname === "/demo/reset") {
      const c = await pool.connect(); try { await seedDemo(c); } finally { c.release(); }
      res.writeHead(303, { location: "/demo" }); res.end(); return;
    }
  }
  const pages: Record<string, string> = { "/": "board.html", "/board": "board.html", "/workspace": "workspace.html", "/attorney": "attorney.html" };
  if (req.method === "GET" && pages[url.pathname]) {
    const page = readFileSync(new URL("../../web/" + pages[url.pathname], import.meta.url), "utf8");
    return html(200, DEMO_MODE ? page.replace(/<body>/, "<body>" + DEMO_BANNER) : page);
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
  const engineRoute = req.method === "POST" && /^\/api\/(?:intake\/(conflict|start|message|upload|summary)|profile\/(build))$/.exec(url.pathname);
  if (engineRoute) {
    const personId = who(req), workspaceId = url.searchParams.get("ws");
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!personId || !workspaceId) return send(401, { error: "sign in" });
    if (!ENGINE) return send(503, { error: "The workspace assistant isn't configured yet." });
    const chunks: Buffer[] = []; for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks);
    const deps = { pool, model, enginePersonId: ENGINE }, sess = { personId, workspaceId };
    try {
      const kind = engineRoute[1] ?? engineRoute[2];
      if (kind === "conflict" || kind === "build") {
        const role = await inSession(pool, sess, async c => (await c.query("select ws.my_role() r, ws.in_scope(ws.cur_ws()) ok")).rows[0]);
        if (role.r !== "attorney" || !role.ok) return send(403, { error: "That action isn't available to you." });
      }
      switch (engineRoute[1] ?? engineRoute[2]) {
        case "build": return send(200, await buildProfile(deps, sess));
        case "conflict": return send(200, { id: await requestConflictCheck(deps, sess, JSON.parse(raw.toString() || "{}").names ?? []) });
        case "start": return send(200, await startSession(deps, sess));
        case "message": return send(200, await clientTurn(deps, sess, String(JSON.parse(raw.toString() || "{}").text ?? "")));
        case "upload": return send(200, await uploadDocument(deps, sess, { item: url.searchParams.get("item") ?? "", filename: url.searchParams.get("name") ?? "upload",
          mime: String(req.headers["content-type"] ?? ""), bytes: new Uint8Array(raw) }));
        case "summary": return send(200, await summary(deps, sess));
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      return send(400, { error: /conflict check not cleared/.test(msg) ? "Josh needs to finish a routine check before intake begins. You'll hear when it's done." : /not a document item/.test(msg) ? "That item isn't a document." : "That couldn't be received. Please try again." });
    }
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
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`listening on ${process.env.PORT ?? 8787}${DEMO_MODE ? " (demo mode)" : ""}`));
