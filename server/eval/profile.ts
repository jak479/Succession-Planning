// Live check of the profile builder on the sample client (entity tier). Needs the dev database and the engine ids.
import pg from "pg";
import { claudeModel } from "../src/engine/model.ts";
import { buildProfile } from "../src/engine/profile.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const r = await buildProfile({ pool, model: claudeModel(), enginePersonId: process.env.ENGINE_PERSON_ID! }, { personId: process.env.ENGINE_PERSON_ID!, workspaceId: process.env.WORKSPACE_ID! });
const rows = (await pool.query("select p.field, p.value, s.label from ws.profile_value p join ws.source s on s.id = p.source_id where p.workspace_id = $1 order by field", [process.env.WORKSPACE_ID])).rows;
await pool.end();
if ("error" in r && r.error) { console.log("FAIL profile build:", r.error); process.exit(1); }
for (const x of rows) console.log(`   │ ${x.field}: ${x.value}  [${x.label}]`);
for (const x of r.dropped) console.log(`   ✗ dropped ${x.field}: ${x.why}`);
console.log(`   gaps: ${r.gaps.join("; ")}`);
const get = (f: string) => rows.find(x => x.field === f)?.value ?? "";
const checks: [string, boolean][] = [
  ["at least 6 fields filled", rows.length >= 6],
  ["Lease shows the 2027-01-31 term end", /2027-01-31|January 31, 2027/.test(get("Lease"))],
  ["Loans names Seacoast Bank", /Seacoast/i.test(get("Loans and credit lines"))],
  ["Insurance shows the $420,000 key-person policy", /420,000|420000/.test(get("Insurance in force"))],
  ["Personal guaranties include both the lease and the loan", /lease/i.test(get("Personal guaranties")) && /loan|Seacoast/i.test(get("Personal guaranties"))],
  ["Name; role is the owner, Dana Ortiz", /Dana Ortiz/.test(get("Name; role")) && !/Maria/.test(get("Name; role"))],
];
for (const [n, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${n}`);
process.exit(checks.every(c => c[1]) ? 0 : 1);
