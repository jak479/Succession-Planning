// Sample client for development and the hosted proof of concept: Gulfside Mechanical, LLC (fictional), from the
// prototype. Fixed ids so links survive a reset. seedDemo() drops the ws schema and rebuilds it: never point it at
// a database that holds real client data.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { SAMPLE_DOCS } from "./sample-docs.ts";

export const MIGRATIONS = ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql", "006_profile.sql", "007_threads.sql", "008_estimate_terms.sql", "009_estimate_costs.sql", "010_agenda.sql", "011_documents.sql"];
export const DEMO = {
  attorney: "00000000-0000-4000-8000-000000000001", dana: "00000000-0000-4000-8000-000000000002",
  luis: "00000000-0000-4000-8000-000000000003", engine: "00000000-0000-4000-8000-000000000004",
  client: "00000000-0000-4000-8000-000000000010", entity: "00000000-0000-4000-8000-000000000011", owner: "00000000-0000-4000-8000-000000000012",
};

type Q = { query: (q: string, p?: unknown[]) => Promise<pg.QueryResult> };
export async function seedDemo(c: Q) {
  await c.query("drop schema if exists ws cascade");
  for (const f of MIGRATIONS) await c.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
  await c.query(`insert into ws.person(id, name, role) values ($1,'Josh','attorney'),($2,'Dana Ortiz','client'),($3,'Luis Herrera','client'),($4,'Front door engine','agent')`,
    [DEMO.attorney, DEMO.dana, DEMO.luis, DEMO.engine]);
  await c.query("insert into ws.client(id, name, onboarding_fee) values ($1, 'Gulfside Mechanical, LLC', 3500)", [DEMO.client]);
  await c.query("insert into ws.workspace(id, client_id, tier) values ($1,$3,'entity'),($2,$3,'owner')", [DEMO.entity, DEMO.owner, DEMO.client]);
  await c.query("insert into ws.membership values ($1,$2,true),($1,$3,false),($4,$2,false),($5,$2,false),($5,$3,false)", [DEMO.dana, DEMO.entity, DEMO.owner, DEMO.luis, DEMO.engine]);
  const as = async (person: string, ws: string, fn: () => Promise<unknown>) => {
    await c.query("begin"); await c.query("set local role ws_app");
    await c.query("select set_config('app.person_id',$1,true), set_config('app.workspace_id',$2,true)", [person, ws]);
    await fn(); await c.query("commit");
  };
  // Conflict check run and cleared, so intake and the front door are open for the sample client.
  let chk = "";
  await as(DEMO.engine, DEMO.entity, async () => { chk = (await c.query("select ws.request_conflict_check($1::jsonb) id", [JSON.stringify([{ name: "Gulfside Mechanical, LLC", relation: "client_entity" }, { name: "Dana Ortiz", relation: "owner" }, { name: "Luis Herrera", relation: "successor" }])])).rows[0].id; });
  await as(DEMO.attorney, DEMO.entity, () => c.query("select ws.decide_conflict($1,'cleared')", [chk]));
  // Sample documents, entered as the engine after reading them.
  await as(DEMO.engine, DEMO.entity, async () => {
    for (const [key, title, body] of SAMPLE_DOCS) {
      const sid = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),$1,'DOC',$2,true) returning id", [key, title])).rows[0].id;
      await c.query("insert into ws.document_text values ($1, ws.cur_ws(), $2, $3, $4)", [sid, key, title, body]);
    }
  });
  // Node statuses and board cards, as the attorney, through the same rules the app uses.
  await as(DEMO.attorney, DEMO.entity, async () => {
    for (const [s, n] of [["N0","green"],["N2","green"],["N4","red"],["N5","green"],["N6","amber"],["N10","red"],["N12","red"]])
      await c.query("insert into ws.node_status(workspace_id,node_id,status) values (ws.cur_ws(),$1,$2)", [s, n]);
    for (const [co, f] of [["CO-BANK","Seacoast signatory card lists Dana only; Luis view-only."],["CO-RET","OA Art. 9 names Luis as Interim Manager; no retention term."],["CO-GUAR","Landlord renewal asks for new guaranties from Dana and Luis."]]) {
      const d = (await c.query("select * from ws.change_order_def where id=$1", [co])).rows[0];
      const id = (await c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance,estimate_costs) values (ws.cur_ws(),$1,$2,$3,$4,$5) returning id", [co, d.name, d.clears, d.low, d.low > 0 ? "None" : null])).rows[0].id;
      await c.query("insert into ws.board_note values ($1, ws.cur_ws(), $2, null)", [id, f]);
    }
    // Deadline read from the lease abstract (cited source), for the Thursday agenda.
    await c.query("insert into ws.deadline(workspace_id,node_id,label,due,source_id) select ws.cur_ws(),'N10','the lease term ends','2027-01-31',id from ws.source where label='LEASE'");
  });
  return DEMO;
}
