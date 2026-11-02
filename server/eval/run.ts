// Live evaluation of the front door against Claude. Spends API credit (two to three calls per case).
// Needs: ENGINE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY (zero-data-retention org), DATABASE_URL to a dev database from `npm run dev-db`,
// and the ids that dev-db printed: ENGINE_PERSON_ID, CLIENT_PERSON_ID, WORKSPACE_ID.
// Pass criteria per case: the expected route (answered / urgent / withheld), and every reply line in a permitted form.
import { readFileSync } from "node:fs";
import pg from "pg";
import { askFrontDoor } from "../src/engine/pipeline.ts";
import { claudeModel } from "../src/engine/model.ts";
import { ATTORNEY } from "../src/engine/prompts.ts";

const FORMS = [/^Here's what your .+ says about this: /, /^To prepare this for Thursday, I need: /, /^This is on Thursday's agenda, position \d+\.$/,
  new RegExp(`^This is marked urgent; ${ATTORNEY} will contact you directly\\.$`), new RegExp(`^${ATTORNEY} will review this on Thursday\\.$`)];
if (!process.env.ENGINE_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) { console.error("No API key: set ENGINE_ANTHROPIC_API_KEY."); process.exit(2); }
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const deps = { pool, model: claudeModel(), enginePersonId: process.env.ENGINE_PERSON_ID! };
const session = { personId: process.env.CLIENT_PERSON_ID!, workspaceId: process.env.WORKSPACE_ID! };
let failed = 0;
for (const k of cases) {
  const { id, reply } = await askFrontDoor(deps, session, { question: k.q, outside: k.outside ?? null });
  const row = (await pool.query("select q.withheld, q.status, b.gate, b.stop_reason, b.topic, b.suggested_scope, b.attorney_note from ws.question q join ws.brief b on b.question_id = q.id where q.id = $1", [id])).rows[0];
  const route = row.withheld ? "withheld" : row.status === "held" ? "urgent" : "answered";
  const formsOk = reply.lines.every(l => FORMS.some(f => f.test(l)));
  // An engine, screen or classifier that could not run is an infrastructure failure, not a pass.
  const infra = (row.gate.checks ?? []).filter((x: any) => !x.pass && /engine|screen|classifier/.test(x.name) && /unavailable|API error|declined|schema|cut off/.test(x.detail ?? ""));
  const ok = route === k.expect && formsOk && !infra.length;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${k.id}: route=${route} (want ${k.expect}) gate=${row.gate.pass ? "pass" : "deferred"} forms=${formsOk}`);
  for (const l of reply.lines) console.log("   │ " + l);
  for (const x of (row.gate.checks ?? []).filter((x: any) => !x.pass)) console.log(`   ✗ ${x.name}: ${x.detail ?? ""}`);
  if (row.stop_reason) console.log(`   stop: ${row.stop_reason}`);
  if (row.suggested_scope) console.log(`   brief: ${row.topic} · suggested scope ${row.suggested_scope}`);
}
await pool.end();
console.log(`\n${cases.length - failed}/${cases.length} passed`); process.exit(failed ? 1 : 0);
