// Drafting tool step 2: document routes and Word export, against a live Postgres (PGURL).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { unzipSync, strFromU8 } from "fflate";
import { inSession } from "../../core/src/store.ts";
import { docRoutes, docDownload } from "../src/docs-api.ts";
import { docxClean, docxRedline, diff } from "../src/docx.ts";
import { planAgenda, callDates } from "../../core/src/agenda.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_docs2_" + process.pid; let pool: pg.Pool; const id: Record<string, string> = {};
const MIGRATIONS = ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql",
  "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql", "012_auto_green_retention.sql", "013_retention_directions.sql",
  "014_keep_unless_destroy.sql", "015_legal_hold.sql", "016_draft_questions.sql"];

before(async () => {
  const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`create database ${db}`); await a.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of MIGRATIONS) await pool.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  for (const [k, n, r] of [["atty", "Josh", "attorney"], ["dana", "Dana Ortiz", "client"], ["agent", "engine", "agent"]]) id[k] = await one("insert into ws.person(name, role) values ($1,$2)", [n, r]);
  const cl = await one("insert into ws.client(name) values ('Gulfside Mechanical, LLC')");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  id.own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
  for (const w of [id.ent, id.own]) for (const p of [id.dana, id.agent]) await pool.query("insert into ws.membership values ($1,$2,false)", [p, w]);
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

const call = async (who: string, ws: string, method: string, path: string, body: any = {}) => {
  const r = docRoutes.find(([m, re]) => m === method && re.test(path)); if (!r) throw new Error("no route " + path);
  return inSession(pool, { personId: id[who], workspaceId: ws }, async c => {
    const role = (await c.query("select ws.my_role() r")).rows[0].r;
    return r[2]({ c, body, role }, r[1].exec(path)!) as Promise<any>;
  });
};
const download = (who: string, ws: string, path: string, q: Record<string, string> = {}) => inSession(pool, { personId: id[who], workspaceId: ws }, async c => {
  const role = (await c.query("select ws.my_role() r")).rows[0].r; return docDownload(c, role, path, new URLSearchParams(q));
});
const docXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["word/document.xml"]);

let draft = "", callSrc = "", profileSrc = "";
test("open a draft from a template in its own tier; clients and the agent cannot", async () => {
  const list = await call("atty", id.ent, "GET", "/api/docs");
  assert.deepEqual(list.templates.map((t: any) => t.id), ["oa-continuity"], "entity tier offers only entity templates");
  draft = (await call("atty", id.ent, "POST", "/api/docs", { template: "oa-continuity" })).id;
  await assert.rejects(call("atty", id.ent, "POST", "/api/docs", { template: "dpoa-rider" }), /owner tier/);
  await assert.rejects(call("dana", id.ent, "POST", "/api/docs", { template: "oa-continuity" }), /not permitted/);
  await assert.rejects(call("agent", id.ent, "POST", "/api/docs", { template: "oa-continuity" }), /not permitted/);
  const d = await call("atty", id.ent, "GET", `/api/docs/${draft}`);
  assert.equal(d.versions.length, 1); assert.deepEqual(d.document.nodes, ["N0", "N2", "N3"]);
  assert.ok(d.current.choices.length > 30 && d.current.choices.every((x: any) => x.status === "open"));
  assert.ok(d.current.highlighted.includes("⟦choice:interim_manager⟧[Name]⟦/choice⟧"));
});

test("facts take their source kind from the database: a client choice needs a call source", async () => {
  callSrc = (await call("atty", id.ent, "POST", "/api/sources/call", { date: "2026-11-12" })).id;
  assert.equal((await call("atty", id.ent, "POST", "/api/sources/call", { date: "2026-11-12" })).id, callSrc, "one source per call date");
  profileSrc = await inSession(pool, { personId: id.agent, workspaceId: id.ent }, async c => (await c.query("insert into ws.source(workspace_id,label,kind,name) values (ws.cur_ws(),'SUNBIZ','PUB','Sunbiz record') returning id")).rows[0].id);
  const p = await call("atty", id.ent, "POST", `/api/docs/${draft}/preview`, { facts: {
    interim_manager: { value: "Luis Herrera", source_id: callSrc }, alternate_im: { value: "Maria Chen", source_id: profileSrc }, company: { value: "Gulfside Mechanical", source_id: profileSrc } } });
  const st = Object.fromEntries(p.choices.map((x: any) => [x.id, x.status]));
  assert.equal(st.interim_manager, "decided"); assert.equal(st.alternate_im, "unconfirmed", "a public record does not decide a client choice");
  assert.ok(p.highlighted.includes("⟦choice:interim_manager⟧Luis Herrera⟦/choice⟧"));
  await assert.rejects(call("atty", id.ent, "POST", `/api/docs/${draft}/preview`, { facts: { company: { value: "X", source_id: "00000000-0000-0000-0000-000000000000" } } }), /not in this workspace/);
  const ownSrc = await inSession(pool, { personId: id.atty, workspaceId: id.own }, async c => (await c.query("insert into ws.source(workspace_id,label,kind,name) values (ws.cur_ws(),'CALL-OWN','CALL','owner call') returning id")).rows[0].id);
  await assert.rejects(call("atty", id.ent, "POST", `/api/docs/${draft}/preview`, { facts: { interim_manager: { value: "X", source_id: ownSrc } } }), /not in this workspace/, "rule 3");
  assert.equal((await call("atty", id.ent, "GET", `/api/docs/${draft}`)).versions.length, 1, "preview saves nothing");
});

test("assemble saves a version; a hand edit keeps the base version's facts and blockers; open choices reach the agenda", async () => {
  const a = await call("atty", id.ent, "POST", `/api/docs/${draft}/assemble`, { facts: { interim_manager: { value: "Luis Herrera", source_id: callSrc }, company: { value: "Gulfside Mechanical", source_id: profileSrc } }, note: "after call" });
  assert.equal(a.n, 2);
  const v2 = await call("atty", id.ent, "GET", `/api/docs/${draft}/versions/${a.versionId}`);
  assert.ok(v2.text.includes("GULFSIDE MECHANICAL, LLC") && !v2.text.includes("⟦"), "saved text carries no highlight marks");
  const e = await call("atty", id.ent, "POST", `/api/docs/${draft}/edit`, { base: a.versionId, text: v2.text.replace("Capitalized terms not defined here", "Capitalized terms that are not defined here"), note: "style" });
  assert.equal(e.n, 3);
  const v3 = await call("atty", id.ent, "GET", `/api/docs/${draft}/versions/${e.versionId}`);
  assert.deepEqual(v3.facts, v2.facts); assert.deepEqual(v3.blockers, v2.blockers);
  await assert.rejects(call("atty", id.ent, "POST", `/api/docs/${draft}/send`, { version: e.versionId }), /not ready to send/);
  for (const who of ["dana", "atty"]) {
    const qs = await inSession(pool, { personId: id[who], workspaceId: id.ent }, async c => (await c.query("select key, title, node from ws.draft_questions()")).rows);
    assert.ok(qs.some(q => q.key === "draft:oa-continuity:alternate_im" && q.title === "Who will run the company if that person cannot or will not?"), who);
    assert.ok(!qs.some(q => q.key === "draft:oa-continuity:interim_manager"), "decided choices leave the agenda");
    const ag = planAgenda({ nodes: {}, sources: qs.map(q => ({ ...q, kind: "question" as const, at: new Date().toISOString() })), deadlines: [], overrides: [], ...callDates("2026-11-10") });
    assert.ok([...ag.plan, ...ag.inHouse, ...ag.held].length > 0);
  }
  await inSession(pool, { personId: id.dana, workspaceId: id.own }, async c => assert.equal((await c.query("select * from ws.draft_questions()")).rowCount, 0, "entity questions never reach the owner tier"));
  await inSession(pool, { personId: id.dana, workspaceId: id.ent }, async c => assert.equal((await c.query("select * from ws.document where kind = 'draft'")).rowCount, 0, "the client still cannot read the draft"));
});

test("Word export: clean copy and a redline with native tracked changes", async () => {
  const d = await call("atty", id.ent, "GET", `/api/docs/${draft}`);
  const [v3, v2, v1] = d.versions;
  const clean = await download("atty", id.ent, `/api/docs/${draft}/docx`, { v: v3.id });
  assert.match(clean!.filename, /v3\.docx$/);
  const x = docXml(clean!.bytes);
  assert.ok(x.includes('<w:pStyle w:val="Heading2"/>') && x.includes("GULFSIDE MECHANICAL, LLC") && !x.includes("w:ins"));
  assert.ok(!x.includes("[Drafter:") && !x.includes("⟦"));
  const red = await download("atty", id.ent, `/api/docs/${draft}/docx`, { v: v3.id, against: v2.id });
  const r = docXml(red!.bytes);
  assert.match(r, /<w:ins w:id="\d+" w:author="Josh" w:date="[^"]+Z"><w:r><w:t xml:space="preserve">that are /);
  assert.ok(!r.includes("<w:del "), "a pure insertion deletes nothing");
  assert.ok(strFromU8(unzipSync(red!.bytes)["word/settings.xml"]).includes("<w:trackRevisions/>"));
  const big = docXml((await download("atty", id.ent, `/api/docs/${draft}/docx`, { v: v2.id, against: v1.id }))!.bytes);
  assert.match(big, /<w:del [^>]+><w:r><w:delText xml:space="preserve">\[COMPANY\]<\/w:delText><\/w:r><\/w:del><w:ins [^>]+><w:r><w:t xml:space="preserve">GULFSIDE MECHANICAL<\/w:t>/);
  assert.match(big, /<w:del [^>]+><w:r><w:delText xml:space="preserve">\[Name\]<\/w:delText><\/w:r><\/w:del><w:ins [^>]+><w:r><w:t xml:space="preserve">Luis Herrera<\/w:t><\/w:r><\/w:ins><w:r><w:t xml:space="preserve">, or if /);
  await assert.rejects(download("dana", id.ent, `/api/docs/${draft}/docx`, { v: v3.id }), /no such document/, "unsent drafts stay the attorney's");
});

test("docx writer: escaping, bold and italic runs, whole-paragraph changes, and diff", () => {
  const x = docXml(docxClean("# T\n\nA **bold** & *it* <x>\n---", "T"));
  assert.ok(x.includes("<w:b/>") && x.includes("<w:i/>") && x.includes("&amp;") && x.includes("&lt;x&gt;") && x.includes("<w:pBdr>"));
  const r = docXml(docxRedline("one\ntwo\nthree", "one\nthree\nfour", "T", "Josh", "2026-11-10T12:00:00.000Z"));
  assert.match(r, /<w:rPr><w:del [^/]+\/><\/w:rPr><\/w:pPr><w:del [^>]+><w:r><w:delText xml:space="preserve">two/);
  assert.match(r, /<w:rPr><w:ins [^/]+\/><\/w:rPr><\/w:pPr><w:ins [^>]+><w:r><w:t xml:space="preserve">four/);
  assert.match(r, /w:date="2026-11-10T12:00:00Z"/);
  assert.deepEqual(diff([1, 2, 3], [1, 3, 4], (a, b) => a === b).map(o => o.op), ["=", "-", "=", "+"]);
});

test("export package downloads as a zip for the client", async () => {
  const z = await download("dana", id.ent, "/api/export.zip");
  assert.equal(z!.mime, "application/zip");
  assert.ok(Object.keys(unzipSync(z!.bytes)).includes("INDEX.md"));
});
