// Runs against a live Postgres (PGURL, default local socket on 5433). Creates a throwaway database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession, loadState } from "../src/store.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_test_" + process.pid;
let pool: pg.Pool; const id: Record<string, string> = {};
const sql = (f: string) => readFileSync(new URL("../db/" + f, import.meta.url), "utf8");

before(async () => {
  const admin = new pg.Client({ connectionString: base + "/postgres" }); await admin.connect();
  await admin.query(`create database ${db}`); await admin.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "008_estimate_terms.sql", "009_estimate_costs.sql"]) await pool.query(sql(f));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  id.atty = await one("insert into ws.person(name, role) values ('Josh','attorney')");
  id.owner = await one("insert into ws.person(name, role) values ('Dana','client')");
  id.mgr = await one("insert into ws.person(name, role) values ('Luis','client')");
  id.agent = await one("insert into ws.person(name, role) values ('intake agent','agent')");
  const cl = await one("insert into ws.client(name, onboarding_fee) values ('Ortiz Fabrication LLC', 3500)");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  id.own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
  for (const [p, w] of [[id.owner, id.ent], [id.owner, id.own], [id.mgr, id.ent], [id.agent, id.ent], [id.agent, id.own]])
    await pool.query("insert into ws.membership values ($1,$2,$3)", [p, w, p === id.owner && w === id.ent]);
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

const as = (who: string, ws: string, fn: (c: pg.PoolClient) => Promise<unknown>) => inSession(pool, { personId: id[who], workspaceId: id[ws] }, fn as any);
const src = (c: pg.PoolClient, label: string, kind: string, readable: boolean | null = null) =>
  c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),$1,$2,$1,$3) returning id", [label, kind, readable]).then(r => r.rows[0].id);

test("tiers never cross-read, even for the attorney", async () => {
  await as("atty", "own", async c => { const s = await src(c, "OWN-WILL", "DOC", true);
    await c.query("insert into ws.coordination_detail values (ws.cur_ws(),'C1','Will leaves interest to trust',$1)", [s]); });
  await as("atty", "ent", async c => {
    assert.equal((await c.query("select * from ws.coordination_detail")).rowCount, 0);
    assert.equal((await c.query("select * from ws.source where label='OWN-WILL'")).rowCount, 0);
  });
});
test("a person with no owner-tier membership sees nothing there and cannot write", async () => {
  await as("mgr", "own", async c => assert.equal((await c.query("select * from ws.source")).rowCount, 0));
  await assert.rejects(as("mgr", "own", c => src(c, "X", "CLIENT")), /row-level security/);
  await as("mgr", "own", async c => {
    for (const t of ["workspace", "client", "membership"]) assert.equal((await c.query(`select * from ws.${t}`)).rowCount, 0, t);
    assert.equal((await c.query("select * from ws.person")).rowCount, 1, "only themself");
  });
});
test("entity tier holds C-node status only; contents only in owner tier", async () => {
  await as("atty", "ent", c => c.query("insert into ws.node_status(workspace_id,node_id,status) values (ws.cur_ws(),'C1','red')"));
  await assert.rejects(as("atty", "own", c => c.query("insert into ws.node_status(workspace_id,node_id,status) values (ws.cur_ws(),'C1','red')")), /entity tier only/);
  await assert.rejects(as("atty", "ent", async c => c.query("insert into ws.coordination_detail values (ws.cur_ws(),'C1','x',$1)", [await src(c, "E1", "DOC", true)])), /owner tier only/);
});
test("only the attorney sets node status", async () => {
  for (const who of ["owner", "agent"])
    await assert.rejects(as(who, "ent", c => c.query("insert into ws.node_status(workspace_id,node_id,status) values (ws.cur_ws(),'N2','green')")), /row-level security/);
});
test("rule 4: C-2–C-7 only by the attorney, only from the call", async () => {
  const put = (c: pg.PoolClient, s: string) => c.query("insert into ws.intake_status(workspace_id,item_id,status,source_id) values (ws.cur_ws(),'C-2','stated',$1)", [s]);
  await assert.rejects(as("agent", "own", async c => put(c, await src(c, "A1", "AGENT"))), /attorney on the call/);
  await assert.rejects(as("owner", "own", async c => put(c, await src(c, "D1", "CLIENT"))), /attorney on the call/);
  await assert.rejects(as("atty", "own", async c => put(c, await src(c, "M1", "DOC", true))), /from the call/);
  await as("atty", "own", async c => put(c, await src(c, "CALL-1", "CALL")));
  await assert.rejects(as("agent", "own", c => src(c, "CALL-2", "CALL")), /attorney/);
});
test("rule 6: stated vs received vs received-unread", async () => {
  const put = (c: pg.PoolClient, item: string, st: string, s: string) => c.query("insert into ws.intake_status(workspace_id,item_id,status,source_id) values (ws.cur_ws(),$1,$2,$3) on conflict (workspace_id,item_id) do update set status=excluded.status, source_id=excluded.source_id", [item, st, s]);
  await assert.rejects(as("owner", "ent", async c => put(c, "B6", "received", await src(c, "D2", "CLIENT"))), /stated, not received/);
  await assert.rejects(as("owner", "ent", c => src(c, "UP1", "DOC", true)), /row-level security/, "client cannot self-certify readable");
  await as("owner", "ent", async c => put(c, "B1", "received_unread", await src(c, "OA-UPLOAD", "DOC", false)));
  await assert.rejects(as("owner", "ent", async c => put(c, "B1", "received", (await c.query("select id from ws.source where label='OA-UPLOAD'")).rows[0].id)), /readable document/);
  await as("agent", "ent", async c => { const s = (await c.query("update ws.source set readable=true where label='OA-UPLOAD' returning id")).rows[0].id; await put(c, "B1", "received", s); });
  await assert.rejects(as("owner", "ent", async c => put(c, "C-1", "received", await src(c, "W", "DOC", false))), /owner tier/);
});
test("every profile value carries a source from its own tier", async () => {
  await assert.rejects(as("agent", "ent", c => c.query("insert into ws.profile_value(workspace_id,field,value,source_id) values (ws.cur_ws(),'Lease','x',null)")), /null value/);
  const ownSrc = await as("atty", "own", c => c.query("select id from ws.source where label='OWN-WILL'").then(r => r.rows[0].id)) as string;
  await assert.rejects(as("agent", "ent", c => c.query("insert into ws.profile_value(workspace_id,field,value,source_id) values (ws.cur_ws(),'Lease','x',$1)", [ownSrc])), /foreign key/);
  await as("agent", "ent", async c => c.query("insert into ws.profile_value(workspace_id,field,value,source_id) values (ws.cur_ws(),'Payroll provider and admin','Gusto; Dana sole admin',$1)", [await src(c, "S-DESC", "CLIENT")]));
  const st: any = await as("owner", "ent", loadState);
  assert.equal(st.profile[0].basis, "described");
  await assert.rejects(as("owner", "ent", c => c.query("insert into ws.profile_value(workspace_id,field,value,source_id) values (ws.cur_ws(),'Lease','x',(select id from ws.source where label='S-DESC'))")), /row-level security/);
});
test("board: Scoped only by signed approval or Schedule A; Done ⇒ nodes green; Done is final", async () => {
  const ins = (co: string, clears: string) => `insert into ws.board_item(workspace_id,co_id,title,clears,allowance,estimate_costs) values (ws.cur_ws(),'${co}','${co}','${clears}',1200,'None') returning id`;
  await assert.rejects(as("owner", "ent", c => c.query(ins("CO-RET", "{N12}"))), /row-level security/);
  await assert.rejects(as("atty", "ent", c => c.query("insert into ws.board_item(workspace_id,title,clears,col,price,approval_ref,approved_at) values (ws.cur_ws(),'x','{N12}','Done',1,'x',now())")), /start in Identified/);
  // Schedule A: included, no change order
  const bank = await as("atty", "ent", c => c.query(ins("CO-BANK", "{N4,C3}")).then(r => r.rows[0].id)) as string;
  await as("atty", "ent", c => c.query("select ws.scope_included($1)", [bank]));
  // Schedule B: attorney cannot self-scope, even with a made-up approval reference
  const ret = await as("atty", "ent", c => c.query(ins("CO-RET", "{N12}")).then(r => r.rows[0].id)) as string;
  await assert.rejects(as("atty", "ent", c => c.query("select ws.scope_included($1)", [ret])), /Schedule A/);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set col='Scoped', price=1200, approval_ref='signed on call', approved_at=now() where id=$1", [ret])), /signed approval/);
  await assert.rejects(as("owner", "ent", c => c.query("select ws.approve_change_order($1,'Dana Ortiz')", [ret])), /no proposed change order/);
  await as("atty", "ent", c => c.query("select ws.propose_change_order($1, 1200, 'Retention agreement for Luis Herrera, 12-month stay bonus terms', 'None')", [ret]));
  await assert.rejects(as("mgr", "ent", c => c.query("select ws.approve_change_order($1,'Luis Herrera')", [ret])), /authorized signer/);
  await assert.rejects(as("owner", "own", c => c.query("select ws.approve_change_order($1,'Dana Ortiz')", [ret])), /card not found/);
  await as("owner", "ent", c => c.query("select ws.approve_change_order($1,'Dana Ortiz')", [ret]));
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set price=5000 where id=$1", [ret])), /fixed once approved/);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set col='Done' where id=$1", [ret])), /not allowed/);
  for (const b of [bank, ret]) for (const col of ["In progress", "Done"]) await as("atty", "ent", c => c.query("update ws.board_item set col=$2 where id=$1", [b, col]));
  const st: any = await as("owner", "ent", loadState);
  assert.equal(st.nodes.N4, "green"); assert.equal(st.nodes.C3, "green"); assert.equal(st.nodes.N12, "green");
  const ap = await as("owner", "ent", c => c.query("select typed_name, price, digest from ws.change_order_approval").then(r => r.rows)) as any[];
  assert.equal(ap.length, 1); assert.equal(ap[0].price, 1200); assert.equal(ap[0].digest.length, 64);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set col='Scoped' where id=$1", [ret])), /Done → Scoped is not allowed/);
  const bud = await as("owner", "ent", c => c.query("select * from ws.budget").then(r => r.rows[0])) as any;
  assert.deepEqual([bud.onboarding_fee, Number(bud.approved), Number(bud.completed)], [3500, 1200, 1200]);
});
test("estimates and offers: good through at least 90 days; lowered, never raised, before then; expired offers cannot be approved", async () => {
  await assert.rejects(as("atty", "ent", c => c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance) values (ws.cur_ws(),'CO-RET','No costs stated','{N12}',1200)")), /filing or third-party costs/);
  const id = await as("atty", "ent", c => c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance,estimate_costs) values (ws.cur_ws(),'CO-RET','Retention, second person','{N12}',1200,'None') returning id, estimate_good_through, current_date + 90 as min").then(r => r.rows[0])) as any;
  assert.equal(String(id.estimate_good_through), String(id.min));
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set allowance = 1500 where id = $1", [id.id])), /lowered, not raised/);
  await as("atty", "ent", c => c.query("update ws.board_item set allowance = 1000 where id = $1", [id.id]));
  await assert.rejects(as("atty", "ent", c => c.query("update ws.board_item set estimate_costs = 'Recording fee' where id = $1", [id.id])), /fixed through/);
  await assert.rejects(as("atty", "ent", c => c.query("select ws.propose_change_order($1, 1200, 'Retention agreement, second key person', '')", [id.id])), /third-party costs/);
  await as("atty", "ent", c => c.query("select ws.propose_change_order($1, 1200, 'Retention agreement, second key person', 'None', current_date + 10)", [id.id]));
  const o = await as("atty", "ent", c => c.query("select offer_good_through, current_date + 90 as min from ws.board_item where id = $1", [id.id]).then(r => r.rows[0])) as any;
  assert.equal(String(o.offer_good_through), String(o.min), "a shorter date is raised to 90 days");
  await assert.rejects(as("atty", "ent", c => c.query("select ws.propose_change_order($1, 1400, 'Retention agreement, second key person', 'None')", [id.id])), /lowered, not raised/);
  await as("atty", "ent", c => c.query("select ws.propose_change_order($1, 1100, 'Retention agreement, second key person', 'None')", [id.id]));
  // An expired offer cannot be approved: simulate expiry with superuser access to the column.
  await pool.query("update ws.board_item set offer_good_through = current_date - 1 where id = $1", [id.id]);
  await assert.rejects(as("owner", "ent", c => c.query("select ws.approve_change_order($1,'Dana Ortiz')", [id.id])), /offered again/);
});
test("attorney notes on cards are invisible to clients", async () => {
  const bid = await as("atty", "ent", async c => { const b = (await c.query("insert into ws.board_item(workspace_id,co_id,title,clears) values (ws.cur_ws(),'CO-GUAR','Guaranty schedule','{N10,C5}') returning id")).rows[0].id;
    await c.query("insert into ws.board_note values ($1, ws.cur_ws(), 'New guaranty in lease renewal', 'Raise C5 with Dana')", [b]); return b; });
  await as("owner", "ent", async c => assert.equal((await c.query("select * from ws.board_note where item_id=$1", [bid])).rowCount, 0));
});
test("profile fields: tier and who may fill (agent never fills C-2 / C-6 fields)", async () => {
  const put = (c: pg.PoolClient, f: string, s: string) => c.query("insert into ws.profile_value(workspace_id,field,value,source_id) values (ws.cur_ws(),$1,'x',$2)", [f, s]);
  const will = await as("agent", "own", c => src(c, "WILL-COPY", "DOC", true)) as string;
  await assert.rejects(as("agent", "own", c => put(c, "Who holds authority: POA agent / PR / trustee", will)), /attorney from the call/);
  await assert.rejects(as("agent", "own", async c => put(c, "Long-term care / asset-protection planning", await src(c, "N1", "AGENT"))), /attorney from the call/);
  await assert.rejects(as("agent", "ent", async c => put(c, "Real property and homestead", await src(c, "PA-1", "PUB"))), /owner tier/);
  await as("agent", "own", async c => put(c, "Personal documents in place (will, trust, DPOA, surrogate)", will));
  await as("atty", "own", async c => put(c, "Who holds authority: POA agent / PR / trustee", (await c.query("select id from ws.source where label='CALL-1'")).rows[0].id));
});
test("audit log is written by triggers and closed to direct writes", async () => {
  await as("atty", "ent", async c => assert.ok((await c.query("select count(*)::int n from ws.event_log")).rows[0].n > 0));
  await assert.rejects(as("atty", "ent", c => c.query("insert into ws.event_log(workspace_id,tbl,op,row_data) values (ws.cur_ws(),'x','x','{}')")), /permission denied/);
});
