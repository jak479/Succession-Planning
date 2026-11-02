// Intake agent against a live Postgres with a scripted model (the live eval covers real model behavior).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { zipSync, strToU8 } from "fflate";
import { inSession } from "../../core/src/store.ts";
import { requestConflictCheck, startSession, clientTurn, uploadDocument, summary, URGENT, DEFERRAL } from "../src/engine/intake.ts";
import { SCREEN_SYSTEM, CLASSIFY_SYSTEM } from "../src/engine/prompts.ts";
import type { Model } from "../src/engine/model.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_in_" + process.pid; let pool: pg.Pool; const id: Record<string, string> = {};
const script = { screen: "none", extract: { answers: [] as any[], asks_for_advice: false }, flags: {} as any, calls: [] as string[] };
const fake: Model = { async json({ system }) {
  script.calls.push(system === SCREEN_SYSTEM ? "screen" : system === CLASSIFY_SYSTEM ? "classify" : "extract");
  if (system === SCREEN_SYSTEM) return { ok: true, value: { category: script.screen, explanation: "" }, model: "fake" } as any;
  if (system === CLASSIFY_SYSTEM) return { ok: true, value: { off_question_quotes: [], advice: false, recommendation: false, evaluation_of_outside_answer: false, prediction: false, fee_or_time_estimate: false, medical_information: false, explanation: "", ...script.flags }, model: "fake" } as any;
  return { ok: true, value: script.extract, model: "fake" } as any;
} };
const reset = () => { script.screen = "none"; script.extract = { answers: [], asks_for_advice: false }; script.flags = {}; script.calls = []; };
const deps = () => ({ pool, model: fake, enginePersonId: id.engine });
const dana = () => ({ personId: id.dana, workspaceId: id.ent });
const as = (p: string, fn: (c: pg.PoolClient) => Promise<any>) => inSession(pool, { personId: id[p], workspaceId: id.ent }, fn);

// A minimal valid one-page PDF with real text, built by hand so the test needs no PDF library.
function pdfWith(text: string): Uint8Array {
  // One line per ~80 characters: pdf.js drops text that runs past the page edge, as a real PDF would not.
  const lines = text.match(/.{1,80}(\s|$)/g) ?? [];
  const stream = `BT /F1 10 Tf 12 TL 40 760 Td ${lines.map(l => `(${l.trim()}) Tj T*`).join(" ")} ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const OA_TEXT = "Operating Agreement of Gulfside Mechanical LLC. Article 9 Continuity. The Interim Manager is Luis Herrera, with Maria Ortiz as alternate. During the Continuity Period the Interim Manager may sign on all accounts and run payroll. The Interim Manager may hire and dismiss employees and deal with the landlord and lenders.";

before(async () => {
  const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`create database ${db}`); await a.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql"]) await pool.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  for (const [k, n, r] of [["atty", "Josh", "attorney"], ["dana", "Dana", "client"], ["engine", "engine", "agent"]]) id[k] = await one("insert into ws.person(name, role) values ($1,$2)", [n, r]);
  const other = await one("insert into ws.client(name) values ('Ortiz Holdings')");
  await pool.query("insert into ws.firm_party(client_id, name, relation) values ($1, 'Dana M. Ortiz', 'owner'), ($1, 'Ortiz Holdings, LLC', 'client_entity')", [other]);
  const cl = await one("insert into ws.client(name) values ('Gulfside Mechanical, LLC')");
  id.cl = cl;
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  for (const p of [id.dana, id.engine]) await pool.query("insert into ws.membership values ($1,$2,false)", [p, id.ent]);
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

test("conflict check first: hits are attorney-only; nothing substantive until the attorney clears it", async () => {
  await assert.rejects(as("dana", c => c.query("select ws.request_conflict_check('[{\"name\":\"x\"}]'::jsonb)")), /agent or the attorney/);
  const chk = await requestConflictCheck(deps(), dana(), [{ name: "Gulfside Mechanical, LLC", relation: "client_entity" }, { name: "Dana Ortiz", relation: "owner" }, { name: "Luis Herrera", relation: "successor" }]);
  assert.equal(await as("dana", c => c.query("select status from ws.conflict_check").then(r => r.rows[0].status)), "pending");
  assert.equal(await as("dana", c => c.query("select * from ws.conflict_hit").then(r => r.rowCount)), 0);
  const hits = await as("atty", c => c.query("select h.queried_name, f.name from ws.conflict_hit h join ws.firm_party f on f.id = h.party_id").then(r => r.rows));
  assert.ok(hits.some((h: any) => h.queried_name === "Dana Ortiz" && h.name === "Dana M. Ortiz"), JSON.stringify(hits));
  await assert.rejects(clientTurn(deps(), dana(), "We bank at Seacoast."), /conflict check not cleared/);
  await assert.rejects(uploadDocument(deps(), dana(), { item: "B1", filename: "oa.pdf", mime: "application/pdf", bytes: pdfWith(OA_TEXT) }), /not cleared/);
  await assert.rejects(inSession(pool, { personId: id.engine, workspaceId: id.ent }, c => c.query("select ws.decide_conflict($1,'cleared')", [chk])), /only the attorney/);
  await as("atty", c => c.query("select ws.decide_conflict($1,'cleared')", [chk]));
  assert.equal(await as("atty", c => c.query("select count(*)::int n from ws.firm_party where client_id = $1", [id.cl]).then(r => r.rows[0].n)), 3);
});

test("session start: one document list, then the first open question (core, earliest stage)", async () => {
  const { lines } = await startSession(deps(), dana());
  assert.match(lines[0], /^To prepare for Thursday, please send: the operating agreement or bylaws/);
  assert.match(lines[1], /^What would stop on day one without you/);
});

test("an answer is recorded as stated, restated for confirmation, and the next question follows", async () => {
  reset(); script.extract = { answers: [{ item_id: "B2", restatement: "Payroll, signing on the bank account, and the DBPR license qualifier stop without you.", complete: true }], asks_for_advice: false };
  const { lines } = await clientTurn(deps(), dana(), "Payroll stops, nobody else can sign at the bank, and I'm the license qualifier.");
  assert.deepEqual(lines.slice(0, 2), ["I have: Payroll, signing on the bank account, and the DBPR license qualifier stop without you. Correct?", "Noted as stated. That goes toward N2, N4, N6, N8, N11."]);
  assert.match(lines[2], /^Who could run the business for 90 days/);
  const st = await as("atty", c => c.query("select i.status, s.kind from ws.intake_status i join ws.source s on s.id = i.source_id where item_id='B2'").then(r => r.rows[0]));
  assert.deepEqual([st.status, st.kind], ["stated", "CLIENT"]);
});

test("a restatement with advice words is not shown, but the answer is still recorded", async () => {
  reset(); script.extract = { answers: [{ item_id: "B3", restatement: "Luis Herrera should run it; he probably would.", complete: true }], asks_for_advice: false };
  const { lines } = await clientTurn(deps(), dana(), "Luis could run it, I think he'd do it.");
  assert.ok(!lines.some(l => l.startsWith("I have:")));
  assert.equal(lines[0], "Noted as stated. That goes toward N2, N12.");
});

test("advice: deferred once; asked again, the line stops and the attorney is flagged", async () => {
  reset(); script.extract = { answers: [], asks_for_advice: true };
  assert.ok((await clientTurn(deps(), dana(), "Should I put Luis on the bank account now?")).lines.includes(DEFERRAL));
  assert.deepEqual((await clientTurn(deps(), dana(), "Just tell me, should I?")).lines, [URGENT]);
  const flag = await as("atty", c => c.query("select flag from ws.intake_turn_gate order by turn_id desc limit 1").then(r => r.rows[0].flag));
  assert.equal(flag, "repeated_advice_request");
});

test("health: never stored, no model call, urgent", async () => {
  reset();
  assert.deepEqual((await clientTurn(deps(), dana(), "My memory loss is getting worse, so Maria should take over.")).lines, [URGENT]);
  assert.deepEqual(script.calls, []);
  const t = await as("dana", c => c.query("select body, withheld from ws.intake_turn where speaker='client' order by id desc limit 1").then(r => r.rows[0]));
  assert.deepEqual([t.body, t.withheld], [null, true]);
});

test("file drop: readable PDF and DOCX are received; a scan is received, unread", async () => {
  const pdf = await uploadDocument(deps(), dana(), { item: "B1", filename: "oa.pdf", mime: "application/pdf", bytes: pdfWith(OA_TEXT) });
  assert.equal(pdf.status, "received", pdf.reason);
  const docx = zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${"Lease of 4410 Industrial Blvd. Tenant: Gulfside Mechanical LLC. Term ends January 31, 2027. Personal guaranty by Dana Ortiz. ".repeat(3)}</w:t></w:r></w:p></w:body></w:document>`) });
  const dx = await uploadDocument(deps(), dana(), { item: "B11", filename: "lease.docx", mime: "", bytes: docx }); assert.equal(dx.status, "received", "docx: " + dx.reason);
  const scan = await uploadDocument(deps(), dana(), { item: "B8", filename: "dec-page.pdf", mime: "application/pdf", bytes: pdfWith("") });
  assert.equal(scan.status, "received_unread");
  const rows = await as("atty", c => c.query("select i.item_id, i.status, s.readable from ws.intake_status i join ws.source s on s.id = i.source_id where item_id in ('B1','B8') order by item_id").then(r => r.rows));
  assert.deepEqual(rows.map((r: any) => [r.item_id, r.status, r.readable]), [["B1", "received", true], ["B8", "received_unread", false]]);
  assert.match(await as("atty", c => c.query("select body from ws.document_text where doc_key like 'B1-%'").then(r => r.rows[0].body)), /Interim Manager is Luis Herrera/);
  await assert.rejects(uploadDocument(deps(), dana(), { item: "C-1", filename: "will.pdf", mime: "application/pdf", bytes: pdfWith(OA_TEXT) }), /owner tier/);
  const s = (await summary(deps(), dana())).lines;
  assert.match(s[0], /Received this session: .*B1/);
});
