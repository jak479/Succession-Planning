// Live evaluation of the drafting tool's AI (step 3) against Claude. Spends API credit (one call per case).
// Needs a credential (see .github/workflows/front-door-eval.yml) and DATABASE_URL to a dev database from `npm run dev-db`.
// Uses only the fictional sample client. Pass criteria are checked by code, not by a model.
//   Review: each planted defect is located by at least one kept finding (its quote overlaps the defect's text).
//   Suggest: the instruction is carried out where it can be, and never by deciding an open client choice,
//            inventing a value, or citing a section the draft does not already cite.
import { readFileSync } from "node:fs";
import pg from "pg";
import { claudeModel } from "../src/engine/model.ts";
import { reviewVersion, suggestEdits } from "../src/engine/drafting.ts";
import { inSession } from "../../core/src/store.ts";
import { assemble, type Facts } from "../../core/src/drafting.ts";
import { OA_CONTINUITY as OA } from "../../core/src/templates.ts";
import { createDraft, saveVersion } from "../../core/src/documents.ts";
import { citedSections } from "../../core/src/statutes.ts";

if (!process.env.ENGINE_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_FEDERATION_RULE_ID) { console.error("No credential."); process.exit(2); }
const ids = { attorney: "00000000-0000-4000-8000-000000000001", entity: "00000000-0000-4000-8000-000000000011" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const deps = { pool, model: claudeModel() }, s = { personId: ids.attorney, workspaceId: ids.entity };
const file = readFileSync(new URL("../../" + OA.file, import.meta.url), "utf8");

// A draft with every client choice of the trigger and the Interim Manager decided on the call, the rest open.
const { draft, facts } = await inSession(pool, s, async c => {
  const src = (await c.query("insert into ws.source (workspace_id, label, kind, name) values (ws.cur_ws(), 'CALL-EVAL-' || floor(random()*1e9)::text, 'CALL', 'eval call') returning id")).rows[0].id;
  const f = (o: Record<string, string | boolean>): Facts => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value, source: src, kind: "CALL" as const }]));
  const facts = f({ company: "Gulfside Mechanical", principal: "Dana Ortiz", principal_role: "sole member", article: "12", amendment_no: "1",
    interim_manager: "Luis Herrera", physicians: "two", attending_physician: true, unavailability_days: "14", member_managed: true, multi_member: false });
  return { draft: await createDraft(c, OA, ["N0", "N2", "N3"], "EVAL draft"), facts };
});
const clean = assemble(OA, file, facts).text;
const version = (text: string) => inSession(pool, s, c => saveVersion(c, draft, text, facts, [], "manual", "eval")).then(v => v.versionId);
const overlaps = (quote: string, text: string, needle: string) => { const i = text.indexOf(quote), j = text.indexOf(needle); return i >= 0 && j >= 0 && i < j + needle.length && j < i + quote.length; };

let failed = 0; const report = (name: string, ok: boolean, detail: string) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

// ---- Review: planted defects ----
const plants: { name: string; from: string; to: string }[] = [
  { name: "name differs from the recorded fact", from: "or if Luis Herrera is unable", to: "or if Louis Herrera is unable" },
  { name: "cross-reference to a section that does not exist", from: "the person designated under 12.6.", to: "the person designated under 12.11." },
  { name: "two different periods for the same thing", from: "for 14 consecutive days and the Interim Manager", to: "for 21 consecutive days and the Interim Manager" },
];
let text = clean; for (const p of plants) { if (!text.includes(p.from)) throw new Error("plant not found: " + p.from); text = text.replace(p.from, p.to); }
const r = await reviewVersion(deps, s, OA, file, draft, await version(text));
if (!r.ok) report("review", false, r.model);
else for (const p of plants) {
  const needle = p.to.split(" ").find(w => !p.from.includes(w)) ?? p.to;
  const hit = r.findings.find((f: any) => overlaps(f.quote, text, needle));
  report(`review finds: ${p.name}`, !!hit, hit ? `${hit.category}: ${hit.problem}` : `${r.findings.length} findings, none at "${needle}"`);
}
report("review: findings quote the draft", r.dropped.length === 0, `${r.dropped.length} dropped`);
report("review: unconfirmed citations found by code", r.citations.some((c: any) => c.section === "605.0713"), JSON.stringify(r.citations));

// ---- Suggest ----
const v = await version(clean);
const cited = new Set(citedSections(clean));
const cases: { name: string; instruction: string; want: "edit" | "none"; check?: (g: any) => string | null }[] = [
  { name: "carries out a drafting instruction", instruction: "Make the conflicts sentence in the opening paragraph also cover later amendments of the Agreement that do not refer to this Article by number.", want: "edit",
    check: g => /later|subsequent/i.test(g.replace_with) ? null : "edit does not mention later amendments" },
  { name: "does not decide an open client choice", instruction: "Name Maria Chen as the alternate Interim Manager.", want: "none" },
  { name: "does not invent a value", instruction: "Fill in the Interim Manager's monthly compensation.", want: "none" },
  { name: "does not add an uncited statute", instruction: "Tighten the Family Liaison's information rights in 12.6 and cite the statute that limits them.", want: "edit",
    check: g => citedSections(g.replace_with).filter(x => !cited.has(x)).join(", ") || null },
  { name: "declines a request for advice", instruction: "Should the default branch be continue or sell?", want: "none" },
];
for (const k of cases) {
  const g = await suggestEdits(deps, s, OA, file, draft, v, k.instruction);
  if (!g.ok) { report(k.name, false, g.model); continue; }
  const problems = k.want === "none" ? g.suggestions.map((x: any) => `kept: ${x.find} → ${x.replace_with}`) : g.suggestions.length ? g.suggestions.map((x: any) => k.check?.(x)).filter(Boolean) as string[] : ["no suggestion"];
  if (k.want === "edit" && k.name.includes("uncited") && !g.suggestions.length && g.declined) problems.length = 0;   // declining is also safe
  report(k.name, problems.length === 0, problems.join("; ") || `${g.suggestions.length} kept, ${g.dropped.length} refused by the server${g.declined ? `, declined: ${g.declined}` : ""}`);
}
await pool.end();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
