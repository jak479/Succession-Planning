// DEV ONLY: builds a fresh database with the sample client from the prototype and prints sign-in links.
import { readFileSync } from "node:fs";
import pg from "pg";
import { SAMPLE_DOCS } from "./sample-docs.ts";
const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433", name = process.env.DB ?? "oew_dev";
const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect();
await a.query(`drop database if exists ${name}`); await a.query(`create database ${name}`); await a.end();
const c = new pg.Client({ connectionString: `${base}/${name}` }); await c.connect();
for (const f of ["001_init.sql", "002_catalog.sql", "003_board_profile.sql", "004_frontdoor.sql", "005_intake.sql"]) await c.query(readFileSync(new URL("../../core/db/" + f, import.meta.url), "utf8"));
const one = async (q: string, p: unknown[] = []) => (await c.query(q + " returning id", p)).rows[0].id;
const atty = await one("insert into ws.person(name, role) values ('Josh','attorney')");
const dana = await one("insert into ws.person(name, role) values ('Dana Ortiz','client')");
const luis = await one("insert into ws.person(name, role) values ('Luis Herrera','client')");
const engine = await one("insert into ws.person(name, role) values ('Front door engine','agent')");
const cl = await one("insert into ws.client(name, onboarding_fee) values ('Gulfside Mechanical, LLC', 3500)");
const ent = await one("insert into ws.workspace(client_id, tier) values ($1,'entity')", [cl]);
const own = await one("insert into ws.workspace(client_id, tier) values ($1,'owner')", [cl]);
await c.query("insert into ws.membership values ($1,$2,true),($1,$3,false),($4,$2,false),($5,$2,false),($5,$3,false)", [dana, ent, own, luis, engine]);
// Conflict check run and cleared, so the sample client can be used for intake and the front door.
const asIn = async (person: string, ws: string, q: string, p: unknown[] = []) => {
  await c.query("begin"); await c.query("set local role ws_app");
  await c.query("select set_config('app.person_id',$1,true), set_config('app.workspace_id',$2,true)", [person, ws]);
  const r = await c.query(q, p); await c.query("commit"); return r;
};
const chk = (await asIn(engine, ent, "select ws.request_conflict_check($1::jsonb) id", [JSON.stringify([{ name: "Gulfside Mechanical, LLC", relation: "client_entity" }, { name: "Dana Ortiz", relation: "owner" }, { name: "Luis Herrera", relation: "successor" }])])).rows[0].id;
await asIn(atty, ent, "select ws.decide_conflict($1,'cleared')", [chk]);
// Sample documents from the prototype's client file (entity tier), entered as the engine after "OCR".
await c.query("begin"); await c.query("set local role ws_app");
await c.query("select set_config('app.person_id',$1,true), set_config('app.workspace_id',$2,true)", [engine, ent]);
for (const [key, title, body] of SAMPLE_DOCS) {
  const sid = (await c.query("insert into ws.source(workspace_id,label,kind,name,readable) values (ws.cur_ws(),$1,'DOC',$2,true) returning id", [key, title])).rows[0].id;
  await c.query("insert into ws.document_text values ($1, ws.cur_ws(), $2, $3, $4)", [sid, key, title, body]);
}
await c.query("commit");
// Sample cards, as the attorney, through the same rules the app uses.
await c.query("begin"); await c.query("set local role ws_app");
await c.query("select set_config('app.person_id',$1,true), set_config('app.workspace_id',$2,true)", [atty, ent]);
for (const [s, n] of [["N0","green"],["N2","green"],["N4","red"],["N5","green"],["N6","amber"],["N10","red"],["N12","red"]])
  await c.query("insert into ws.node_status(workspace_id,node_id,status) values (ws.cur_ws(),$1,$2)", [s, n]);
for (const [co, f] of [["CO-BANK","Seacoast signatory card lists Dana only; Luis view-only."],["CO-RET","OA Art. 9 names Luis as Interim Manager; no retention term."],["CO-GUAR","Landlord renewal asks for new guaranties from Dana and Luis."]]) {
  const d = (await c.query("select * from ws.change_order_def where id=$1", [co])).rows[0];
  const id = (await c.query("insert into ws.board_item(workspace_id,co_id,title,clears,allowance) values (ws.cur_ws(),$1,$2,$3,$4) returning id", [co, d.name, d.clears, d.low])).rows[0].id;
  await c.query("insert into ws.board_note values ($1, ws.cur_ws(), $2, null)", [id, f]);
}
await c.query("commit"); await c.end();
const port = process.env.PORT ?? 8787;
console.log(JSON.stringify({ attorney: atty, dana, luis, engine, entity: ent, owner: own }, null, 2));
console.log(`\nStart the server with ENGINE_PERSON_ID=${engine}`);
console.log(`\nOpen http://localhost:${port}/?as=<person-id>&ws=<workspace-id>`);
