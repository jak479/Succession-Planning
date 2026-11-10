// The container image must hold every file the server reads at run time. Tests read the repository, so a file left
// out of the image passes here and fails in production (2026-11-10: the templates were missing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "../../core/src/templates.ts";

const root = new URL("../../", import.meta.url);
const ignore = readFileSync(new URL(".dockerignore", root), "utf8").split("\n").map(l => l.trim()).filter(Boolean);
const copies = [...readFileSync(new URL("Dockerfile", root), "utf8").matchAll(/^COPY\s+(\S+)\s+\S+$/gm)].map(m => m[1]);
// .dockerignore: later lines win; "!" re-includes.
const ignored = (p: string) => ignore.reduce((out, rule) => {
  const neg = rule.startsWith("!"), r = (neg ? rule.slice(1) : rule).replace(/^\*\*\//, "");
  return p === r || p.startsWith(r + "/") || p.split("/").includes(r) && rule.startsWith("**/") ? !neg : out;
}, false);
const inImage = (p: string) => !ignored(p) && copies.some(c => p === c || p.startsWith(c.replace(/\/$/, "") + "/"));

test("every template the assembler reads is in the image", () => {
  for (const t of TEMPLATES) assert.ok(inImage(t.file), `${t.file} is not copied into the image`);
});
test("the web pages and server source are in the image; tests and evals are not", () => {
  for (const p of ["web/attorney.html", "server/src/main.ts", "core/src/drafting.ts", "core/db/017_ai_drafting.sql"]) assert.ok(inImage(p), p);
  for (const p of ["server/test/docs.test.ts", "server/eval/drafting.ts", "docs/design/drafting-tool.md"]) assert.ok(!inImage(p), p);
});
