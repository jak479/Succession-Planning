// Front door against a live Postgres with a scripted model. The scripted model stands in for Claude so the
// gate's own logic can be tested deterministically; live behavior is measured by eval/ (needs an API key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../../core/src/store.ts";
import { askFrontDoor } from "../src/engine/pipeline.ts";
import { SCREEN_SYSTEM, FRONT_DOOR_SYSTEM, CLASSIFY_SYSTEM, type Brief } from "../src/engine/prompts.ts";
import type { Model } from "../src/engine/model.ts";
import { SAMPLE_DOCS } from "../src/sample-docs.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_fd_" + process.pid; let pool: pg.Pool; const id: Record<string, string> = {};

const GOOD: Brief = { topic: "Lease renewal", tier: "entity", urgent: false, suggested_scope: "quoted", scope_reason: "Schedule B: negotiating a lease",
  documents_say: [{ doc: "LEASE", section: "Renewal option", says: "The lease provides one five-year renewal option, with notice due 180 days before the term ends on 2027-01-31." }],
  no_clause_for: [], facts_needed: ["Has the landlord sent the renewal terms in writing?"], check_this: [], anchor_proximity: "Lease expiration 2027-01-31",
  agenda_line: "Lease renewal and new guaranty", attorney_note: "Option lapsed; uncapped guaranty. N10, C5." };
const script = { screen: "none" as string, brief: GOOD as Brief | null, flags: {} as Record<string, boolean>, calls: [] as string[] };
const fakeFlags = () => ({ off_question_quotes: [] as number[] });
const fake: Model = {
  async json({ system, user }) {
    script.calls.push(system === SCREEN_SYSTEM ? "screen:" + user : system === FRONT_DOOR_SYSTEM ? "brief" : "classify");
    if (system === SCREEN_SYSTEM) return { ok: true, value: { category: script.screen, explanation: "scripted" }, model: "fake" } as any;
    if (system === FRONT_DOOR_SYSTEM) return script.brief ? { ok: true, value: script.brief, model: "fake" } as any : { ok: false, reason: "API error 529" };
    if (system === CLASSIFY_SYSTEM) return { ok: true, value: { ...fakeFlags(), advice: false, recommendation: false, evaluation_of_outside_answer: false, prediction: false, fee_or_time_estimate: false, medical_information: false, explanation: "", ...script.flags }, model: "fake" } as any;
    throw new Error("unexpected prompt");
  },
};
const reset = () => { script.screen = "none"; script.brief = GOOD; script.flags = {}; script.calls = []; };
const ask = (q: string, outside?: string) => askFrontDoor({ pool, model: fake, enginePersonId: id.engine }, { personId: id.dana, workspaceId: id.ent }, { question: q, outside });
const asWho = (p: string, fn: (c: pg.PoolClient) => Promise<any>) => inSession(pool, { personId: id[p], workspaceId: id.ent }, fn);

before(async () => {
  const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`create database ${db}`); await a.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql", "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql", "012_auto_green_retention.sql", "013_retention_directions.sql", "014_keep_unless_destroy.sql", "015_legal_hold.sql", "016_draft_questions.sql", "017_ai_drafting.sql", "018_ai_requests.sql"]) await pool.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  for (const [k, n, r] of [["atty", "Josh", "attorney"], ["dana", "Dana", "client"], ["luis", "Luis", "client"], ["engine", "engine", "agent"]]) id[k] = await one("insert into ws.person(name, role) values ($1,$2)", [n, r]);
  const cl = await one("insert into ws.client(name) values ('Gulfside Mechanical, LLC')");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  for (const p of [id.dana, id.luis, id.engine]) await pool.query("insert into ws.membership values ($1,$2,false)", [p, id.ent]);
  await inSession(pool, { personId: id.engine, workspaceId: id.ent }, c => c.query("select ws.request_conflict_check('[{\"name\":\"Gulfside Mechanical, LLC\"}]'::jsonb) id")).then(async (r: any) =>
    inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select ws.decide_conflict($1,'cleared')", [r.rows[0].id])));
  await inSession(pool, { personId: id.engine, workspaceId: id.ent }, async c => {
    for (const [key, title, body] of SAMPLE_DOCS) {
      const sid = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),$1,'DOC',$2,true) returning id", [key, title])).rows[0].id;
      await c.query("insert into ws.document_text values ($1, ws.cur_ws(), $2, $3, $4)", [sid, key, title, body]);
    }
  });
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

test("a clean brief reaches the client only in the permitted forms; scope stays attorney-only", async () => {
  reset();
  const { id: q, reply } = await ask("The landlord sent renewal terms. What does my lease say?");
  assert.match(reply.lines[0], /^Here's what your Lease abstract.* says about this: The lease provides/);
  assert.match(reply.lines[1], /^To prepare this for Thursday, I need: /);
  assert.match(reply.lines[2], /^This is on Thursday's agenda, position \d+\.$/);
  const mine = await asWho("dana", c => c.query("select * from ws.question where id=$1", [q]).then(r => r.rows[0]));
  assert.equal(mine.confirmed_scope, null);
  assert.equal(await asWho("dana", c => c.query("select * from ws.brief").then(r => r.rowCount)), 0, "client cannot read briefs");
  assert.equal(await asWho("luis", c => c.query("select * from ws.question").then(r => r.rowCount)), 0, "other client users cannot read Dana's questions");
  const b = await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select * from ws.brief where question_id=$1", [q]).then(r => r.rows[0]));
  assert.equal(b.suggested_scope, "quoted"); assert.equal(b.gate.pass, true);
  await assert.rejects(inSession(pool, { personId: id.engine, workspaceId: id.ent }, c => c.query("update ws.question set confirmed_scope='quoted' where id=$1", [q])), /attorney only/);
  await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select ws.confirm_scope($1,'quoted')", [q]));
  assert.equal(await asWho("dana", c => c.query("select confirmed_scope from ws.question where id=$1", [q]).then(r => r.rows[0].confirmed_scope)), "quoted");
});

test("advice words in a model slot: gate fails, client gets only the agenda line", async () => {
  reset(); script.brief = { ...GOOD, documents_say: [{ doc: "LEASE", section: "Guaranty", says: "The guaranty is uncapped, so you should not sign a new one." }] };
  const { id: q, reply } = await ask("Can I sign the new guaranty?");
  assert.equal(reply.lines.length, 1); assert.match(reply.lines[0], /^This is on Thursday's agenda, position \d+\.$/);
  const b = await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select gate from ws.brief where question_id=$1", [q]).then(r => r.rows[0]));
  assert.equal(b.gate.pass, false); assert.ok(b.gate.checks.some((x: any) => x.name === "lexical: advice words" && !x.pass));
});

test("classifier flag (prediction) fails the gate even with clean words", async () => {
  reset(); script.flags = { prediction: true, explanation: "forecasts landlord" } as any;
  const { reply } = await ask("Will the landlord agree?");
  assert.deepEqual(reply.lines.length, 1);
});

test("off-question quotes are removed, the rest of the answer stays", async () => {
  reset(); const on = GOOD.documents_say[0], off = { doc: "INS", section: "Disability buy-out", says: "The insurance schedule lists no disability buy-out coverage." };
  script.brief = { ...GOOD, documents_say: [on, off] }; script.flags = { off_question_quotes: [2] } as any;
  const { id: q, reply } = await ask("What does the lease say about renewal?");
  assert.equal(reply.lines.filter(l => l.startsWith("Here's what your")).length, 1);
  assert.ok(!reply.lines.some(l => l.includes("(INS,")));
  const b = await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select gate, documents_say from ws.brief where question_id=$1", [q]).then(r => r.rows[0]));
  assert.ok(b.gate.checks.some((x: any) => x.name === "off-question quotes removed"));
  assert.equal(b.documents_say.length, 1);
});

test("citation to a document not in the file fails the gate", async () => {
  reset(); script.brief = { ...GOOD, documents_say: [{ doc: "WILL", section: "Art. 3", says: "The will leaves the interest to the trust." }] };
  assert.equal((await ask("Who gets my shares?")).reply.lines.length, 1);
});

test("fee words fail the gate", async () => {
  reset(); script.brief = { ...GOOD, facts_needed: ["Do you want a flat fee quote for the renewal?"] };
  assert.equal((await ask("How much to renegotiate?")).reply.lines.length, 1);
});

test("health: never stored, never sent to the brief model, urgent reply", async () => {
  reset();
  const { id: q, reply } = await ask("My doctor says my memory loss is getting worse. Can Luis take over now?");
  assert.deepEqual(reply.lines, ["This is marked urgent; Josh will contact you directly."]);
  assert.deepEqual(script.calls, [], "no model call at all on a lexical health match");
  const row = await asWho("dana", c => c.query("select body, withheld, status from ws.question where id=$1", [q]).then(r => r.rows[0]));
  assert.deepEqual([row.body, row.withheld, row.status], [null, true, "held"]);
});

test("screen category (court/regulator): urgent, no substance, no brief model call", async () => {
  reset(); script.screen = "court_or_regulator";
  const { reply } = await ask("We got a subpoena from the county today.");
  assert.deepEqual(reply.lines, ["This is marked urgent; Josh will contact you directly."]);
  assert.ok(!script.calls.includes("brief"));
});

test("engine failure fails closed to the agenda line", async () => {
  reset(); script.brief = null;
  const { id: q, reply } = await ask("What does my OA say about the alternate manager?");
  assert.equal(reply.lines.length, 1);
  const b = await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select topic, gate from ws.brief where question_id=$1", [q]).then(r => r.rows[0]));
  assert.equal(b.topic, "(engine unavailable)");
});

test("check-this: server writes the comparison sentence from a fixed category", async () => {
  reset(); script.brief = { ...GOOD, check_this: [
    { outside_says: "The manager can sign the renewal for you.", doc: "OA-Art9", section: "9.2(b)", your_documents_say: "The Interim Manager may renew leases during the Continuity Period.", relation: "document_not_cited_by_outside" },
    { outside_says: "The guaranty would transfer to the company.", doc: "", section: "", your_documents_say: "", relation: "no_document_addresses" }] };
  const { reply } = await ask("ChatGPT says Luis can sign it. Check this.", "The manager can sign the renewal for you.");
  assert.deepEqual(reply.check_this?.map(r => r.difference), ["The outside answer does not cite this provision.", "No document on file addresses this."]);
  assert.match(reply.check_this![0].your_documents_say, /\(OA-Art9, 9\.2\(b\)\)$/);
  assert.equal(reply.lines.at(-1), "Josh will review this on Thursday.");
});

test("advice words inside the quoted outside answer are not the engine's advice (live eval finding)", async () => {
  reset(); script.brief = { ...GOOD, check_this: [{ outside_says: "You should be fine signing it.", doc: "LEASE", section: "Personal guaranty", your_documents_say: "Dana Ortiz's guaranty covers the full term, with no cap.", relation: "document_not_cited_by_outside" }] };
  assert.equal((await ask("Check this.", "You should be fine signing it.")).reply.check_this?.length, 1);
  reset(); script.brief = { ...GOOD, check_this: [{ outside_says: "Sign it.", doc: "LEASE", section: "Guaranty", your_documents_say: "You should not sign.", relation: "different_terms" }] };
  assert.equal((await ask("Check this.", "Sign it.")).reply.lines.length, 1, "advice words in our own cell still fail");
});

test("a fact question about health or capacity fails the gate (live eval finding, 2026-11-02)", async () => {
  reset(); script.brief = { ...GOOD, facts_needed: ["Is this question prompted by a current health event or concern affecting Dana Ortiz?"] };
  const { id: q, reply } = await ask("How does my operating agreement define incapacity?");
  assert.equal(reply.lines.length, 1);
  const b = await inSession(pool, { personId: id.atty, workspaceId: id.ent }, c => c.query("select gate from ws.brief where question_id=$1", [q]).then(r => r.rows[0]));
  assert.ok(b.gate.checks.some((x: any) => x.name === "fact questions: no health or capacity" && !x.pass));
  reset(); script.brief = { ...GOOD, facts_needed: ["Has a HIPAA authorization been signed naming the Interim Manager?"] };
  assert.equal((await ask("Who certifies incapacity?")).reply.lines.length, 1);
  reset(); script.brief = { ...GOOD, facts_needed: ["Has anyone questioned whether Dana still has capacity to sign?"] };
  assert.equal((await ask("Can Luis sign instead?")).reply.lines.length, 1);
});

test("'Incapacity' as a defined term, or 'in what capacity', is not a health question (live eval finding)", async () => {
  reset(); script.brief = { ...GOOD, facts_needed: ["Does the full operating agreement define Incapacity anywhere besides Article 9.1(b)?", "In what capacity would Luis Herrera sign the renewal?"] };
  assert.equal((await ask("How is incapacity defined?")).reply.lines.length, 3);
});

test("quoting the engagement letter's 'advising on the call' is not an advice hit; quoting it elsewhere still is", async () => {
  reset(); script.brief = { ...GOOD, documents_say: [{ doc: "SCOPE", section: "Schedule A", says: "Schedule A includes reviewing a lease received and advising on the call." }] };
  assert.equal((await ask("Is a lease review included?")).reply.lines.length, 3);
  reset(); script.brief = { ...GOOD, documents_say: [{ doc: "LEASE", section: "Guaranty", says: "We are advising you to renegotiate." }] };
  assert.equal((await ask("What about the guaranty?")).reply.lines.length, 1);
});

test("at most three document quotes reach the client", async () => {
  reset(); const d = GOOD.documents_say[0]; script.brief = { ...GOOD, documents_say: [d, d, d, d, d] };
  const { reply } = await ask("Tell me everything about the lease.");
  assert.equal(reply.lines.filter(l => l.startsWith("Here's what your")).length, 3);
});
