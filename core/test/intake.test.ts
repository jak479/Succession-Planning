import { test } from "node:test";
import assert from "node:assert/strict";
import { planIntake, sessionSummary, INTAKE_Q } from "../src/intake.ts";
import { INTAKE } from "../src/catalog.ts";

test("every agent-askable item has fixed wording; attorney-only items have none", () => {
  for (const i of INTAKE) assert.equal(i.askedBy === "agent" ? !!INTAKE_Q[i.id] : !INTAKE_Q[i.id], true, i.id);
});
test("ask-last: answered, received and received-unread items are never asked again", () => {
  const p = planIntake({ B3: "stated", B1: "received", B5: "received_unread", B6: "requested" });
  const ids = [...p.documents, ...p.questions].map(i => i.id);
  for (const x of ["B3", "B1", "B5"]) assert.ok(!ids.includes(x), x);
  assert.ok(ids.includes("B6"), "requested is still open");
});
test("core first, then what unlocks the earliest stage", () => {
  const q = planIntake({}).questions.map(i => i.id);
  const firstNonCore = q.findIndex(id => !INTAKE.find(i => i.id === id)!.core);
  assert.ok(q.slice(0, firstNonCore).every(id => INTAKE.find(i => i.id === id)!.core));
  assert.equal(q[0], "B2", "B2 feeds N2/N4/N6 (S1 gate) and is core");
});
test("entity plan never contains owner-tier or attorney-only items", () => {
  const p = planIntake({});
  assert.ok([...p.documents, ...p.questions].every(i => i.tier === "entity" && i.askedBy === "agent"));
});
test("session summary is fixed text and names the next document", () => {
  const s = sessionSummary({ B1: "received" }, ["B1"]);
  assert.match(s[0], /Received this session: B1/); assert.match(s.at(-1)!, /^Next document to send: /);
});
