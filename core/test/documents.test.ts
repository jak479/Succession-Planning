// Document management against a live Postgres (PGURL). Creates a throwaway database with every migration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { inSession } from "../src/store.ts";
import { addFile, closeFile, createDraft, exportPackage, fileExecuted, listDocuments, markClosure, markOriginal, purgeFile, recordDirection, recordUnreachable, saveAssembled, verifyIntegrity, placeHold, releaseHold, saveVersion, sendVersion, supersede } from "../src/documents.ts";
import { OA_CONTINUITY as OA, DPOA_RIDER as RIDER, TEMPLATES } from "../src/templates.ts";

const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433";
const db = "oew_docs_" + process.pid;
const MIGRATIONS = ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql",
  "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql", "012_auto_green_retention.sql", "013_retention_directions.sql", "014_keep_unless_destroy.sql", "015_legal_hold.sql", "016_draft_questions.sql"];
let pool: pg.Pool; const id: Record<string, string> = {};
const tpl = (t: typeof OA) => readFileSync(new URL("../../" + t.file, import.meta.url), "utf8");
const PDF = { filename: "signed.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 signed") };

before(async () => {
  const admin = new pg.Client({ connectionString: base + "/postgres" }); await admin.connect();
  await admin.query(`create database ${db}`); await admin.end();
  pool = new pg.Pool({ connectionString: `${base}/${db}` });
  for (const f of MIGRATIONS) await pool.query(readFileSync(new URL("../db/" + f, import.meta.url), "utf8"));
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q + " returning id", p)).rows[0].id;
  id.atty = await one("insert into ws.person(name, role) values ('Josh','attorney')");
  id.owner = await one("insert into ws.person(name, role) values ('Dana','client')");
  id.agent = await one("insert into ws.person(name, role) values ('intake agent','agent')");
  const cl = await one("insert into ws.client(name, onboarding_fee) values ('Gulfside Mechanical, LLC', 3500)");
  id.ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
  id.own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
  for (const [p, w] of [[id.owner, id.ent], [id.owner, id.own], [id.agent, id.ent], [id.agent, id.own]]) await pool.query("insert into ws.membership values ($1,$2,false)", [p, w]);
});
after(async () => { await pool.end(); const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect(); await a.query(`drop database ${db}`); await a.end(); });

const as = <T>(who: string, ws: string, fn: (c: pg.PoolClient) => Promise<T>) => inSession(pool, { personId: id[who], workspaceId: id[ws] }, fn);
const callSource = (c: pg.PoolClient, label: string) =>
  c.query("insert into ws.source(workspace_id,label,kind,name) values (ws.cur_ws(),$1,'CALL',$1) returning id", [label]).then(r => r.rows[0].id as string);

test("templates in the database match core/src/templates.ts", async () => {
  const rows = (await pool.query("select id, tier from ws.doc_template order by id")).rows;
  assert.deepEqual(rows, TEMPLATES.map(t => ({ id: t.id, tier: t.tier })).sort((a, b) => a.id.localeCompare(b.id)));
});

test("a draft lives in its template's tier and cites only its own workspace's sources", async () => {
  await assert.rejects(as("atty", "own", c => createDraft(c, OA, ["N0", "N2"])), /kept in the entity tier/);
  await assert.rejects(as("atty", "ent", c => createDraft(c, RIDER, ["N2"])), /kept in the owner tier/);
  const ownCall = await as("atty", "own", c => callSource(c, "CALL-OWN-1"));
  await assert.rejects(as("atty", "ent", async c => {
    const d = await createDraft(c, OA, ["N2"]);
    await saveAssembled(c, d, OA, tpl(OA), { interim_manager: { value: "Luis Herrera", source: ownCall, kind: "CALL" } });
  }), /not in this workspace/, "an owner-tier source cannot be cited in an entity draft (rule 3)");
  await assert.rejects(as("owner", "ent", c => createDraft(c, OA, ["N2"])), /row-level security/, "clients do not draft");
  await assert.rejects(as("agent", "ent", c => createDraft(c, OA, ["N2"])), /row-level security/, "the agent never drafts");
});

test("draft → versions → send: only a version with no blockers is sent, and the client sees only what was sent", async () => {
  const { d, v1 } = await as("atty", "ent", async c => {
    const s = await callSource(c, "CALL-2026-11-12");
    const d = await createDraft(c, OA, ["N0", "N2"]);
    const r = await saveAssembled(c, d, OA, tpl(OA), { interim_manager: { value: "Luis Herrera", source: s, kind: "CALL" } });
    assert.ok(r.assembly.choices.some(x => x.status === "open"));
    return { d, v1: r.versionId };
  });
  await as("owner", "ent", async c => assert.equal((await c.query("select * from ws.document where id = $1", [d])).rowCount, 0, "unsent draft is the attorney's"));
  await assert.rejects(as("atty", "ent", c => sendVersion(c, d, v1)), /not ready to send/);
  const v2 = await as("atty", "ent", async c => (await saveVersion(c, d, "AMENDMENT NO. 1 … (all choices decided)", {}, [], "manual", "after the call")).versionId);
  await as("atty", "ent", c => sendVersion(c, d, v2));
  await as("atty", "ent", c => saveVersion(c, d, "AMENDMENT NO. 1 … (attorney's later edit)", {}, [], "manual"));
  await as("owner", "ent", async c => {
    assert.equal((await c.query("select status from ws.document where id = $1", [d])).rows[0].status, "sent");
    assert.deepEqual((await c.query("select n from ws.doc_version where document_id = $1 order by n", [d])).rows.map(r => r.n), [2], "only the sent version");
  });
  await assert.rejects(as("atty", "ent", c => c.query("update ws.doc_version set content_md = 'changed' where id = $1", [v2])), /immutable/);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.doc_version set sent_at = now() where id = $1", [v1])), /not ready to send/);
  await assert.rejects(pool.query("delete from ws.doc_version where id = $1", [v2]), /never deleted/);
});

test("executed original: allowed mode only, against a sent version; becomes a DOC source; the draft is marked executed", async () => {
  const { d, v } = await as("atty", "ent", async c => {
    const d = await createDraft(c, OA, ["N0", "N2"]);
    const { versionId } = await saveVersion(c, d, "final text", {}, [], "manual");
    await sendVersion(c, d, versionId); return { d, v: versionId };
  });
  const unsent = await as("atty", "ent", async c => (await saveVersion(c, d, "later", {}, [], "manual")).versionId);
  await assert.rejects(as("atty", "ent", c => fileExecuted(c, OA, d, unsent, PDF, { mode: "esign_only", executedOn: "2026-11-20" })), /sent version/);
  await assert.rejects(as("atty", "ent", c => fileExecuted(c, OA, d, v, PDF, { mode: "ron_witnesses_present", executedOn: "2026-11-20" })), /check/, "RON needs provider and journal (§ 709.2120(4)(d))");
  const ex = await as("atty", "ent", c => fileExecuted(c, OA, d, v, PDF, { mode: "esign_only", executedOn: "2026-11-20" }));
  await as("owner", "ent", async c => {
    assert.equal((await c.query("select status from ws.document where id = $1", [d])).rows[0].status, "executed");
    const e = (await c.query("select d.source_id, s.kind, s.readable from ws.document d join ws.source s on s.id = d.source_id where d.id = $1", [ex.documentId])).rows[0];
    assert.equal(e.kind, "DOC"); assert.equal(e.readable, true);
  });
  await assert.rejects(as("atty", "ent", c => c.query("update ws.doc_execution set mode = 'in_person' where document_id = $1", [ex.documentId])), /final|permission denied/);
  await assert.rejects(pool.query("update ws.doc_execution set mode = 'in_person' where document_id = $1", [ex.documentId]), /final/, "even for the owner role");
});

test("rider: remote witnesses refused while Part C is undecided or included (§ 709.2202(6))", async () => {
  await as("atty", "own", async c => {
    const s = await callSource(c, "CALL-OWN-2");
    const d = await createDraft(c, RIDER, ["N2"]);
    const { versionId } = await saveVersion(c, d, "rider text", { part_c: { value: true, source: s, kind: "CALL" } }, [], "manual");
    await sendVersion(c, d, versionId);
    await assert.rejects(fileExecuted(c, RIDER, d, versionId, PDF, { mode: "ron_remote_witnesses", executedOn: "2026-11-20", ronProvider: "X", journalRef: "J1" }), /not allowed/);
    await assert.rejects(fileExecuted(c, RIDER, d, versionId, PDF, { mode: "esign_only", executedOn: "2026-11-20" }), /not allowed/);
  });
});

test("counterparty papers are the attorney's alone; client uploads join the index for client and agent", async () => {
  const cp = await as("atty", "ent", c => addFile(c, "counterparty", "Seacoast Bank POA acceptance letter", PDF));
  for (const who of ["owner", "agent"]) await as(who, "ent", async c => assert.equal((await c.query("select * from ws.document where id = $1", [cp.documentId])).rowCount, 0, who));
  await as("owner", "ent", async c => {
    const s = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),'UP-1','DOC','lease.pdf',false) returning id")).rows[0].id;
    await c.query("insert into ws.file_blob (source_id, workspace_id, filename, mime, bytes, sha256) values ($1, ws.cur_ws(), 'lease.pdf', 'application/pdf', $2, 'x')", [s, Buffer.from("lease")]);
  });
  for (const who of ["owner", "agent", "atty"]) await as(who, "ent", async c => assert.ok((await listDocuments(c)).some(r => r.kind === "client_upload" && r.title === "lease.pdf"), who));
  await as("atty", "own", async c => assert.ok(!(await listDocuments(c)).some(r => r.title === "lease.pdf"), "the owner tier does not see entity uploads"));
});

test("supersede is final; nothing is deleted; every write is audited", async () => {
  const d = await as("atty", "ent", c => createDraft(c, OA, ["N2"], "Old draft"));
  await as("atty", "ent", c => supersede(c, d));
  await assert.rejects(as("atty", "ent", c => saveVersion(c, d, "x", {}, [], "manual")), /superseded/);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.document set status = 'active' where id = $1", [d])), /final/);
  await assert.rejects(pool.query("delete from ws.document where id = $1", [d]), /never deleted/);
  await as("atty", "ent", async c => assert.ok((await c.query("select count(*)::int n from ws.event_log where tbl = 'document'")).rows[0].n >= 2));
});

test("export package (rule 8): executed originals with an index; the client can take it", async () => {
  const files = await as("owner", "ent", c => exportPackage(c));
  assert.equal(files[0].path, "INDEX.md");
  const index = new TextDecoder().decode(files[0].bytes);
  assert.match(index, /\| esign_only \|/);
  assert.ok(files.slice(1).every(f => f.path.endsWith(".pdf") && f.bytes.length > 0));
  assert.ok(!files.some(f => /Seacoast|lease/.test(f.path)), "only executed originals");
});

test("auto-green: executing the OA turns green the nodes its signatures satisfy, and no others", async () => {
  const r = await as("atty", "ent", async c => {
    const d = await createDraft(c, OA, ["N0", "N2", "N3", "N5"]);
    const { versionId } = await saveVersion(c, d, "final", {}, [], "manual"); await sendVersion(c, d, versionId);
    return fileExecuted(c, OA, d, versionId, PDF, { mode: "esign_only", executedOn: "2026-11-21", signatures: ["principal", "members", "interim_manager"] });
  });
  assert.deepEqual(r.green, ["N0", "N2"], "N3 waits for the alternate's consent; N5 needs a reserve balance");
  await as("owner", "ent", async c => {
    const n = (await c.query("select node_id, status, fact from ws.node_status where node_id in ('N0','N2','N3','N5') order by node_id")).rows;
    assert.deepEqual(n.map(x => x.node_id), ["N0", "N2"]);
    assert.match(n[1].fact, /signed by principal, members, interim_manager/);
  });
  await as("atty", "own", async c => {
    const s = await callSource(c, "CALL-OWN-3");
    const d = await createDraft(c, RIDER, ["N2"]);
    const { versionId } = await saveVersion(c, d, "rider", { part_c: { value: false, source: s, kind: "CALL" } }, [], "manual"); await sendVersion(c, d, versionId);
    const x = await fileExecuted(c, RIDER, d, versionId, PDF, { mode: "in_person", executedOn: "2026-11-21", signatures: ["principal", "witnesses", "notary"] });
    assert.deepEqual(x.green, [], "owner tier never writes node status (rule 3)");
  });
  await assert.rejects(as("atty", "ent", async c => {
    const d = await createDraft(c, OA, ["N0"]); const { versionId } = await saveVersion(c, d, "f", {}, [], "manual"); await sendVersion(c, d, versionId);
    await fileExecuted(c, OA, d, versionId, PDF, { mode: "esign_only", executedOn: "2026-11-21", signatures: ["landlord" as any] });
  }), /check/);
});

test("integrity: every stored version is checked for its hash and that it still opens", async () => {
  const r = await as("atty", "ent", c => verifyIntegrity(c));
  assert.ok(r.checked > 0);
  assert.deepEqual(r.failed.map(f => f.detail), ["pdf; hash mismatch; does not open as pdf"], "the test upload (fake hash, not a PDF) is caught");
  await as("owner", "ent", async c => assert.equal((await c.query("select * from ws.integrity_check")).rowCount, 0, "results are attorney-only"));
});

test("retention: files are kept unless the client directs destruction; then everything goes at once", async () => {
  await as("atty", "ent", c => closeFile(c, "2026-11-01"));
  await assert.rejects(as("atty", "ent", c => purgeFile(c)), /kept unless the client directs destruction \(current: no direction\)/);
  await assert.rejects(as("atty", "ent", c => recordUnreachable(c, "called twice")), /request the client's directions before/);
  await as("atty", "ent", async c => { await markClosure(c, "directions_requested"); await recordDirection(c, "return"); await markClosure(c, "export_delivered"); });
  await assert.rejects(as("atty", "ent", c => purgeFile(c)), /current: return/, "return: the Firm keeps its copy");
  await as("atty", "ent", c => recordDirection(c, "firm_keep"));
  await assert.rejects(as("atty", "ent", c => purgeFile(c)), /current: firm_keep/);
  await as("atty", "ent", c => recordDirection(c, "destroy"));
  await assert.rejects(as("owner", "ent", c => purgeFile(c)), /attorney only/);
  await assert.rejects(as("owner", "ent", c => placeHold(c, "x")), /row-level security/, "holds are the attorney's");
  const hold = await as("atty", "ent", c => placeHold(c, "demand letter received 2026-11-09"));
  await as("owner", "ent", async c => assert.equal((await c.query("select * from ws.legal_hold")).rowCount, 0, "clients do not see holds"));
  await assert.rejects(as("atty", "ent", c => purgeFile(c)), /litigation hold in place/);
  await as("atty", "ent", async c => assert.ok((await c.query("select count(*)::int n from ws.doc_version where purged_at is null")).rows[0].n > 0, "nothing purged under hold"));
  await assert.rejects(as("atty", "ent", c => c.query("update ws.legal_hold set reason = 'edited' where id = $1", [hold])), /can only be released/);
  await assert.rejects(pool.query("delete from ws.legal_hold where id = $1", [hold]), /never deleted/);
  await as("atty", "ent", c => releaseHold(c, hold, "claim resolved; release signed 2026-11-10"));
  await assert.rejects(as("atty", "ent", c => releaseHold(c, hold, "again")), /released hold is final/);
  await assert.rejects(as("atty", "ent", c => c.query("update ws.file_closure set purged_at = now()")), /purge_documents\(\) only/);
  const n = await as("atty", "ent", c => purgeFile(c));
  assert.ok(n > 0, "no waiting period");
  await as("atty", "ent", async c => {
    assert.equal((await c.query("select count(*)::int n from ws.doc_version where purged_at is null")).rows[0].n, 0, "originals too: the client directed it");
    assert.ok((await c.query("select count(*)::int n from ws.doc_execution")).rows[0].n > 0, "execution records stay");
    assert.equal((await c.query("select row_data->>'stage' s from ws.event_log where tbl = 'purge'")).rows[0].s, "client directed destruction");
  });
  await assert.rejects(as("atty", "ent", async c => saveVersion(c, (await listDocuments(c)).find(d => d.kind === "draft" && d.status !== "superseded")!.id, "x", {}, [], "manual")), /purged file is closed/);
  await assert.rejects(as("atty", "ent", c => purgeFile(c)), /already purged/);
});

test("retention: an unreachable client's file is kept", async () => {
  await as("atty", "own", async c => {
    await closeFile(c, "2000-01-01"); await markClosure(c, "directions_requested");
    await recordUnreachable(c, "letter 2026-10-01 to last address; email 2026-10-15; phone 2026-10-20");
  });
  await assert.rejects(as("atty", "own", c => purgeFile(c)), /current: unreachable/);
  await as("atty", "own", async c => assert.ok((await c.query("select count(*)::int n from ws.doc_version where purged_at is null")).rows[0].n > 0));
});
