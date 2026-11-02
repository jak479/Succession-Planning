// DEV ONLY: builds a fresh local database with the sample client and prints the ids.
import pg from "pg";
import { seedDemo } from "./demo-seed.ts";
const base = process.env.PGURL ?? "postgresql://postgres@%2Fvar%2Ftmp:5433", name = process.env.DB ?? "oew_dev";
const a = new pg.Client({ connectionString: base + "/postgres" }); await a.connect();
await a.query(`drop database if exists ${name}`); await a.query(`create database ${name}`); await a.end();
const c = new pg.Client({ connectionString: `${base}/${name}` }); await c.connect();
const ids = await seedDemo(c); await c.end();
console.log(JSON.stringify(ids, null, 2));
console.log(`\nStart the server with ENGINE_PERSON_ID=${ids.engine} (the default in demo mode)`);
