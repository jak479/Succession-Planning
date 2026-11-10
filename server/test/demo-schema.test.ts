// The hosted demo re-seeds when its schema predates the newest migration; this keeps the marker current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/demo-seed.ts";

test("demo re-seed marker names a table the newest migration creates", async () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const marker = /const NEWEST_TABLE = "ws\.(\w+)"/.exec(main)![1];
  const newest = readFileSync(new URL("../../core/db/" + MIGRATIONS[MIGRATIONS.length - 1], import.meta.url), "utf8");
  assert.match(newest, new RegExp(`create table ws\\.${marker}\\b`), `${MIGRATIONS.at(-1)} does not create ws.${marker}`);
  const all = (await import("node:fs")).readdirSync(new URL("../../core/db/", import.meta.url)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  assert.deepEqual(MIGRATIONS, all, "the demo seeds every migration, in order");
});
