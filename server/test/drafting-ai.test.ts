// Drafting tool step 3 with a scripted model: what the server enforces regardless of what the model returns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../../core/src/store.ts";
import { docRoutes, docAi } from "../src/docs-api.ts";
import { REVIEW_SYSTEM, SUGGEST_SYSTEM } from "../src/engine/drafting.ts";
import type { Model } from "../src/engine/model.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_ai_" + process.pid; let pool: pg.Pool; const id: Record<string, string> = {};
const MIGRATIONS = ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql",
  "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql", "012_auto_green_retention.sql", "013_retention_directions.sql",
  "014_keep_unless_destroy.sql", "015_legal_hold.sql", "016_draft_questions.sql", "017_ai_drafting.sql"];
const script: { out: any; system: string; user: string; calls: number } = { out: null, system: "", user: "", calls: 0 };
const fake: Model = { async json({ system, user }) { script.system = system; script.user = user; script.calls++; return { ok: true, value: script.out, model: "scripted" } as any; } };
const deps = () => ({ pool, model: fake });

before(async () => {
  const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`create database ${db}`); await a.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of MIGRATIONS) await pool.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  for (const [k, n, r] of [["atty", "Josh", "attorney"], ["dana", "Dana Ortiz", "client"]]) id[k] = await one("insert into ws.person(name, role) values ($1,$2)", [n, r]);
  const cl = await one("insert into ws.client(name) values ('Gulfside Mechanical, LLC')");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  id.own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
  for (const w of [id.ent, id.own]) await pool.query("insert into ws.membership values ($1,$2,false)", [id.dana, w]);
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

const call = (who: string, ws: string, method: string, path: string, body: any = {}) => {
  const r = docRoutes.find(([m, re]) => m === method && re.test(path))!;
  return inSession(pool, { personId: id[who], workspaceId: ws }, async c => r[2]({ c, body, role: (await c.query("select ws.my_role() r")).rows[0].r }, r[1].exec(path)!) as Promise<any>);
};
const ai = (who: string, ws: string, path: string, body: any = {}) => docAi(deps(), { personId: id[who], workspaceId: ws }, path, body) as Promise<any>;

let draft = "", callSrc = "";
test("setup: a draft with three recorded facts", async () => {
  draft = (await call("atty", id.ent, "POST", "/api/docs", { template: "oa-continuity" })).id;
  callSrc = (await call("atty", id.ent, "POST", "/api/sources/call", { date: "2026-11-12" })).id;
  await call("atty", id.ent, "POST", `/api/docs/${draft}/assemble`, { facts: {
    company: { value: "Gulfside Mechanical", source_id: callSrc }, interim_manager: { value: "Luis Herrera", source_id: callSrc }, article: { value: "12", source_id: callSrc } } });
});

test("review: findings must quote the draft; citations are checked by code, not the model; nothing is written to the draft", async () => {
  script.out = { findings: [
    { category: "cross_reference", quote: "the person designated under 12.6", problem: "12.6 names the Family Liaison, who designates; the reference is right but the Family Liaison is unnamed.", fix_hint: "Fill 12.6." },
    { category: "value_mismatch", quote: "Luis Herrara", problem: "misspelled", fix_hint: "" },
  ] };
  const before = (await call("atty", id.ent, "GET", `/api/docs/${draft}`)).versions.length;
  const r = await ai("atty", id.ent, `/api/docs/${draft}/review`);
  assert.equal(r.findings.length, 1); assert.equal(r.dropped[0].why, "quote not found in the draft");
  assert.deepEqual(r.citations.map((c: any) => c.section), ["605.0713"], "§ 605.0713 is cited in Schedule 2 and not yet read");
  assert.equal(script.system, REVIEW_SYSTEM);
  assert.ok(script.user.includes("<draft>") && script.user.includes("interim_manager = \"Luis Herrera\" [CALL]") && script.user.includes("<drafter_notes>"));
  assert.ok(script.user.includes("alternate_im (Alternate Interim Manager): open"), "the model is told which choices are open");
  assert.equal((await call("atty", id.ent, "GET", `/api/docs/${draft}`)).versions.length, before, "review saves no version");
  const stored = await call("atty", id.ent, "GET", `/api/docs/${draft}/ai`);
  assert.equal(stored.reviews.length, 1); assert.equal(stored.reviews[0].prompt_version.startsWith("drafting-"), true);
});

test("review and suggestions are the attorney's alone", async () => {
  await assert.rejects(ai("dana", id.ent, `/api/docs/${draft}/review`), /no such document/);
  await assert.rejects(call("dana", id.ent, "GET", `/api/docs/${draft}/ai`), /not permitted/);
  await inSession(pool, { personId: id.dana, workspaceId: id.ent }, async c => {
    assert.equal((await c.query("select * from ws.doc_review")).rowCount, 0);
    assert.equal((await c.query("select * from ws.doc_suggestion")).rowCount, 0);
  });
});

test("suggest: exact passage once; never decides an open client choice; accept saves an ai_draft version with the same open choices", async () => {
  const d0 = await call("atty", id.ent, "GET", `/api/docs/${draft}`);
  const text: string = d0.current.text;
  script.out = { declined: "", suggestions: [
    { find: "If this Article conflicts with any other provision of the Agreement, this Article controls.", replace_with: "If this Article conflicts with any other provision of the Agreement, including any later amendment that does not refer to this Article by number, this Article controls.", reason: "Protects the Article against an implied repeal.", uses: [] },
    { find: "Maria Chen", replace_with: "Ana Ortiz", reason: "x", uses: [] },
    { find: "Luis Herrera, or if Luis Herrera is unable or unwilling to serve, [Alternate name]", replace_with: "Luis Herrera, or if Luis Herrera is unable or unwilling to serve, Maria Chen", reason: "fills the alternate", uses: ["alternate_im"] },
    { find: "Article", replace_with: "Section", reason: "x", uses: [] },
  ] };
  const r = await ai("atty", id.ent, `/api/docs/${draft}/suggest`, { instruction: "Make the conflicts clause survive later amendments; fill in the alternate." });
  assert.equal(r.suggestions.length, 1);
  assert.deepEqual(r.dropped.map((x: any) => x.why), ["passage not found exactly once in the draft", "would decide a client choice not yet decided: Alternate Interim Manager", "passage not found exactly once in the draft"]);
  assert.ok(script.user.includes("<instruction>") && script.system === SUGGEST_SYSTEM);
  const acc = await call("atty", id.ent, "POST", `/api/docs/${draft}/suggestions/${r.suggestions[0].id}`, { accept: true });
  assert.equal(acc.status, "accepted");
  const d1 = await call("atty", id.ent, "GET", `/api/docs/${draft}`);
  assert.equal(d1.versions[0].mode, "ai_draft"); assert.match(d1.versions[0].note, /^accepted: /);
  assert.ok(d1.current.text.includes("including any later amendment that does not refer to this Article by number") && text !== d1.current.text);
  const v1 = await call("atty", id.ent, "GET", `/api/docs/${draft}/versions/${d0.current.versionId}`), v2 = await call("atty", id.ent, "GET", `/api/docs/${draft}/versions/${d1.current.versionId}`);
  assert.deepEqual(v2.facts, v1.facts); assert.deepEqual(v2.blockers, v1.blockers);
  await assert.rejects(call("atty", id.ent, "POST", `/api/docs/${draft}/suggestions/${r.suggestions[0].id}`, { accept: false }), /final/);
});

test("a suggestion whose passage changed is marked stale, not applied; reject records only", async () => {
  script.out = { declined: "", suggestions: [
    { find: "Except as amended here, the Agreement remains in full force.", replace_with: "Except as amended here, the Agreement remains in full force and effect.", reason: "Conventional phrasing.", uses: [] },
    { find: "The Company shall review this Article, Schedule 1, and Schedule 2 at least annually", replace_with: "The Company shall review this Article, Schedule 1, and Schedule 2 at least once each calendar year", reason: "Clearer period.", uses: [] },
  ] };
  const r = await ai("atty", id.ent, `/api/docs/${draft}/suggest`, { instruction: "Tidy the closing words." });
  const d = await call("atty", id.ent, "GET", `/api/docs/${draft}`);
  await call("atty", id.ent, "POST", `/api/docs/${draft}/edit`, { base: d.current.versionId, text: d.current.text.replace("Except as amended here, the Agreement remains in full force.", "Except as amended by this Amendment, the Agreement remains in full force.") });
  assert.equal((await call("atty", id.ent, "POST", `/api/docs/${draft}/suggestions/${r.suggestions[0].id}`, { accept: true })).status, "stale");
  const n = (await call("atty", id.ent, "GET", `/api/docs/${draft}`)).versions.length;
  assert.equal((await call("atty", id.ent, "POST", `/api/docs/${draft}/suggestions/${r.suggestions[1].id}`, { accept: false })).status, "rejected");
  assert.equal((await call("atty", id.ent, "GET", `/api/docs/${draft}`)).versions.length, n, "reject saves nothing");
});

test("a declined instruction returns no suggestions; owner-tier AI is off unless the Firm turns it on", async () => {
  script.out = { declined: "That asks for advice on who should serve, which is the client's choice.", suggestions: [] };
  const r = await ai("atty", id.ent, `/api/docs/${draft}/suggest`, { instruction: "Who should be the alternate?" });
  assert.equal(r.suggestions.length, 0); assert.match(r.declined, /client's choice/);
  const rider = (await call("atty", id.own, "POST", "/api/docs", { template: "dpoa-rider" })).id;
  const calls = script.calls;
  await assert.rejects(ai("atty", id.own, `/api/docs/${rider}/review`), /off for owner-tier documents/);
  assert.equal(script.calls, calls, "no model call");
  assert.equal((await call("atty", id.own, "GET", `/api/docs/${rider}/ai`)).aiAllowed, false);
});
