// Profile builder against a live Postgres with a scripted model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../../core/src/store.ts";
import { buildProfile } from "../src/engine/profile.ts";
import type { Model } from "../src/engine/model.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_pr_" + process.pid; let pool: pg.Pool; const id: Record<string, string> = {};
const script = { out: { values: [] as any[], conflicts: [] as any[], gaps: [] as string[] }, prompt: "" };
const fake: Model = { async json({ user }) { script.prompt = user; return { ok: true, value: script.out, model: "fake" } as any; } };
const deps = () => ({ pool, model: fake, enginePersonId: id.engine });
const run = (ws: string) => buildProfile(deps(), { personId: id.atty, workspaceId: ws });
const as = (p: string, ws: string, fn: (c: pg.PoolClient) => Promise<any>) => inSession(pool, { personId: id[p], workspaceId: ws }, fn);
const LEASE = "Lease of 4410 Industrial Blvd, Tampa. Term ends 2027-01-31. One 5-year renewal option, notice 180 days before expiration. Personal guaranty by Dana Ortiz for the full term, no cap.";
const profile = (ws: string) => as("atty", ws, c => c.query("select field, value, source, basis from ws.profile_view order by field").then(r => r.rows));

before(async () => {
  const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`create database ${db}`); await a.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql", "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql"]) await pool.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  for (const [k, n, r] of [["atty", "Josh", "attorney"], ["dana", "Dana", "client"], ["engine", "engine", "agent"]]) id[k] = await one("insert into ws.person(name, role) values ($1,$2)", [n, r]);
  const cl = await one("insert into ws.client(name) values ('Gulfside Mechanical, LLC')");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  id.own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
  for (const w of [id.ent, id.own]) for (const p of [id.dana, id.engine]) await pool.query("insert into ws.membership values ($1,$2,false)", [p, w]);
  await as("engine", id.ent, async c => {
    const s = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),'LEASE','DOC','Lease, 4410 Industrial Blvd',true) returning id")).rows[0].id;
    await c.query("insert into ws.document_text values ($1, ws.cur_ws(), 'LEASE', 'Lease', $2)", [s, LEASE]);
    await c.query("insert into ws.source(workspace_id,label,kind,name,citation) values (ws.cur_ws(),'ANS-1','CLIENT','Client answer','The lease runs to 2028 I think, and I signed a guaranty.')");
  });
  await as("engine", id.own, async c => {
    const s = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),'WILL','DOC','Last Will of Dana Ortiz, signed 2019-04-02, drafted by Smith & Co.',true) returning id")).rows[0].id;
    await c.query("insert into ws.document_text values ($1, ws.cur_ws(), 'WILL', 'Will', 'I leave my membership interest in Gulfside Mechanical to my daughter Ana.')", [s]);
  });
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

test("a value is written only with a verbatim quote from the cited source", async () => {
  script.out = { values: [
    { field: "Lease", value: "4410 Industrial Blvd; term ends 2027-01-31; uncapped personal guaranty by Dana Ortiz", support: [{ source: "LEASE", quotes: ["Term ends 2027-01-31."] }] },
    { field: "Loans and credit lines", value: "SBA 7(a) loan at Seacoast Bank", support: [{ source: "LEASE", quotes: ["SBA 7(a) loan, Seacoast Bank"] }] },
    { field: "Who holds authority: POA agent / PR / trustee", value: "Luis", support: [{ source: "LEASE", quotes: ["Term ends"] }] },
  ], conflicts: [], gaps: ["Bank accounts and signers", "Not a field"] };
  const r = await run(id.ent);
  assert.deepEqual(r.written, ["Lease"]);
  assert.deepEqual(r.dropped.map((x: any) => x.why), ["quote not found in the cited source", "not a field the agent may fill in this tier"]);
  assert.deepEqual(r.gaps, ["Bank accounts and signers"]);
  const p = await profile(id.ent);
  assert.deepEqual(p.map((x: any) => [x.field, x.source, x.basis]), [["Lease", "LEASE", "document"]]);
});

test("a client's description does not replace a document; the disagreement is listed, not resolved", async () => {
  script.out = { values: [{ field: "Lease", value: "Runs to 2028; guaranty signed", support: [{ source: "ANS-1", quotes: ["The lease runs to 2028"] }] }], conflicts: [], gaps: [] };
  const r = await run(id.ent);
  assert.deepEqual([r.written, r.conflicts], [[], ["Lease"]]);
  assert.match((await profile(id.ent))[0].value, /2027-01-31/);
  const conf = await as("dana", id.ent, c => c.query("select field, value_a, value_b from ws.conflict").then(r => r.rows));
  assert.equal(conf.length, 1); assert.match(conf[0].value_b, /2028/);
  await run(id.ent);   // the same conflict is not listed twice
  assert.equal(await as("atty", id.ent, c => c.query("select count(*)::int n from ws.conflict").then(r => r.rows[0].n)), 1);
});

test("several quotes may support one value; every one must be in the source", async () => {
  script.out = { values: [{ field: "Personal guaranties", value: "Lease guaranty, full term, no cap", support: [{ source: "LEASE", quotes: ["Personal guaranty by Dana Ortiz for the full term, no cap.", "Term ends 2027-01-31."] }] }], conflicts: [], gaps: [] };
  assert.deepEqual((await run(id.ent)).written, ["Personal guaranties"]);
  script.out = { values: [{ field: "Key employees", value: "Luis", support: [{ source: "LEASE", quotes: ["Term ends 2027-01-31.", "Luis Herrera is the operations manager."] }] }], conflicts: [], gaps: [] };
  assert.equal((await run(id.ent)).dropped[0].why, "quote not found in the cited source");
});

test("a value may rest on several sources; each quote is checked against its own source", async () => {
  await as("engine", id.ent, async c => {
    const s = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),'LOAN','DOC','SBA loan',true) returning id")).rows[0].id;
    await c.query("insert into ws.document_text values ($1, ws.cur_ws(), 'LOAN', 'SBA loan', 'SBA 7(a) loan, Seacoast Bank. Personal guaranty by Dana Ortiz.')", [s]);
  });
  script.out = { values: [{ field: "Personal guaranties", value: "Lease (full term, no cap) and Seacoast SBA loan", support: [
    { source: "LEASE", quotes: ["Personal guaranty by Dana Ortiz for the full term, no cap."] }, { source: "LOAN", quotes: ["Personal guaranty by Dana Ortiz."] }] }], conflicts: [], gaps: [] };
  assert.deepEqual((await run(id.ent)).written, ["Personal guaranties"]);
  const n = await as("dana", id.ent, c => c.query("select count(*)::int n from ws.profile_value_source where field = 'Personal guaranties'").then(r => r.rows[0].n));
  assert.equal(n, 2);
  script.out = { values: [{ field: "Personal guaranties", value: "x", support: [{ source: "LEASE", quotes: ["SBA 7(a) loan, Seacoast Bank."] }] }], conflicts: [], gaps: [] };
  assert.equal((await run(id.ent)).dropped[0].why, "quote not found in the cited source", "a quote from the loan attributed to the lease fails");
});

test("a field echoed back with its description is still recognized (live eval finding)", async () => {
  script.out = { values: [{ field: "Key employees — employees the business depends on, with roles", value: "None stated in lease", support: [{ source: "LEASE", quotes: ["Term ends 2027-01-31."] }] }], conflicts: [], gaps: ["Insurance in force — every policy in force: carrier or type, insured, owner, beneficiary, amount, renewal"] };
  const r = await run(id.ent);
  assert.deepEqual([r.written, r.gaps], [["Key employees"], ["Insurance in force"]]);
});

test("ambiguous fields are described to the model", async () => {
  assert.match(script.prompt, /Name; role — the business owner's \(principal's\) own name/);
});

test("health information is never written to the profile", async () => {
  script.out = { values: [{ field: "Key employees", value: "Luis Herrera, recovering from surgery", support: [{ source: "LEASE", quotes: ["Term ends 2027-01-31."] }] }], conflicts: [], gaps: [] };
  const r = await run(id.ent);
  assert.deepEqual(r.dropped.map((x: any) => x.why), ["health information"]);
});

test("owner tier: the model sees titles and dates only, never the contents of personal documents", async () => {
  script.out = { values: [
    { field: "Personal documents in place (will, trust, DPOA, surrogate)", value: "Will signed 2019-04-02, drafted by Smith & Co.", support: [{ source: "WILL", quotes: ["Last Will of Dana Ortiz, signed 2019-04-02, drafted by Smith & Co."] }] },
    { field: "Personal documents in place (will, trust, DPOA, surrogate)", value: "Leaves the interest to Ana", support: [{ source: "WILL", quotes: ["I leave my membership interest"] }] },
  ], conflicts: [], gaps: [] };
  const r = await run(id.own);
  assert.ok(!script.prompt.includes("I leave my membership interest"), "will contents must not reach the model");
  assert.ok(script.prompt.includes("Last Will of Dana Ortiz, signed 2019-04-02"));
  assert.deepEqual(r.written, ["Personal documents in place (will, trust, DPOA, surrogate)"]);
  assert.equal(r.dropped[0].why, "quote not found in the cited source");
  assert.ok(!script.prompt.includes("Lease of 4410"), "entity documents never reach an owner-tier build");
});

test("the run is recorded for the attorney only", async () => {
  assert.ok(await as("atty", id.ent, c => c.query("select count(*)::int n from ws.profile_run").then(r => r.rows[0].n)) >= 3);
  assert.equal(await as("dana", id.ent, c => c.query("select * from ws.profile_run").then(r => r.rowCount)), 0);
});
