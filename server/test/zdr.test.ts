// Zero data retention: these API surfaces are not ZDR-eligible and Anthropic does not block them.
// Source: platform.claude.com/docs/en/manage-claude/api-and-data-retention (read 2026-11-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN: [string, RegExp][] = [
  ["Files API", /\.files\.|\/v1\/files/], ["Message Batches", /\.batches\.|\/v1\/messages\/batches/],
  ["Managed Agents", /beta\.(agents|sessions|environments|deployments|memory_stores)/], ["Agent Skills", /\.skills\.|container:\s*\{/],
  ["MCP connector", /mcp_servers|mcp_toolset/], ["code execution", /code_execution/], ["Claude Fable / Mythos (needs 30-day retention)", /claude-(fable|mythos)/],
];
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });

test("server source uses no ZDR-ineligible API surface", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of walk(src)) { const t = readFileSync(f, "utf8"); for (const [name, re] of FORBIDDEN) assert.ok(!re.test(t), `${name} found in ${f}`); }
});
test("exactly one file talks to the model", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const users = walk(src).filter(f => /from "@anthropic-ai\/sdk/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map(f => f.split("/src/")[1]), ["engine/model.ts"]);
});
