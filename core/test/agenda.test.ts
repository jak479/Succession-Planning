import { test } from "node:test";
import assert from "node:assert/strict";
import { planAgenda, callDates, type AgendaSource } from "../src/agenda.ts";

// The sample client (Gulfside Mechanical) on Thursday, November 5, 2026.
const nodes = { N0: "green", N2: "green", N5: "green", N4: "red", N6: "amber", N10: "red", N12: "red" } as const;
const q = (key: string, node: string | null, at: string, extra: Partial<AgendaSource> = {}): AgendaSource => ({ key, kind: "question", title: key, node, at, ...extra });
const base = {
  nodes: { ...nodes }, callDate: "2026-11-05", nextCallDate: "2026-11-12", overrides: [],
  deadlines: [{ node: "N10", label: "the lease term ends", due: "2027-01-31" }],
  sources: [
    q("lease", "N10", "2026-11-02T10:00:00Z"),
    q("signers", "N4", "2026-11-03T10:00:00Z"),
    { key: "co-ret", kind: "change_order", title: "Retention terms for Luis", node: "N12", at: "2026-10-30T10:00:00Z" } as AgendaSource,
    q("valuation", "N15b", "2026-11-01T10:00:00Z"),
    q("indemnity", null, "2026-10-28T10:00:00Z"),
    q("default letter", "N5", "2026-11-03T09:00:00Z", { urgent: true }),
  ],
};

test("plan order: deadline first, then the path to the next stage, then other gaps; reasons are what the client sees", () => {
  const a = planAgenda(base);
  assert.deepEqual(a.plan.map(i => i.key), ["lease", "signers", "co-ret"]);
  assert.equal(a.plan[0].reason, "Taken up first: the lease term ends January 31, 2027, 87 days away");
  assert.equal(a.plan[1].reason, "On the path to Stage 1: Bank access");
  assert.equal(a.plan[2].reason, "Other plan gaps: Key staff, a Stage 3 step");
  assert.deepEqual(a.urgent.map(i => i.key), ["default letter"], "urgent items sit outside the agenda");
  assert.deepEqual(a.inHouse.map(i => i.key), ["indemnity"]);
  const held = a.held.find(h => h.key === "valuation")!;
  assert.equal(held.reason, "Taken up at Stage 3: it depends on bank access being in place");
});

test("a deadline more than 90 days out does not move an item first", () => {
  const a = planAgenda({ ...base, deadlines: [{ node: "N10", label: "the lease term ends", due: "2027-03-01" }] });
  assert.equal(a.plan[0].key, "signers");
  assert.equal(a.plan.find(i => i.key === "lease")!.tier, "other");
});

test("overflow goes to the next call with the date; the in-house slot has its own time", () => {
  const many = Array.from({ length: 5 }, (_, i) => q("bank" + i, "N4", `2026-11-0${i + 1}T10:00:00Z`));
  const a = planAgenda({ ...base, sources: many });
  assert.equal(a.plan.length, 3, "3 × 6 minutes fit in 20");
  assert.equal(a.held.length, 2);
  assert.match(a.held[0].reason, /^Next in line for Thursday, Nov 12: this call is full$/);
});

test("the attorney can move an item first, hold it, or mark it done, and the client sees the reason", () => {
  const a = planAgenda({ ...base, overrides: [
    { key: "co-ret", action: "first", reason: "Luis has another offer" },
    { key: "signers", action: "hold", reason: "waiting for the bank's form", until: "2026-11-19" },
    { key: "indemnity", action: "done", reason: "answered" },
  ] });
  assert.equal(a.plan[0].key, "co-ret"); assert.equal(a.plan[0].reason, "Moved up by Josh: Luis has another offer");
  const h = a.held.find(x => x.key === "signers")!; assert.equal(h.reason, "Moved by Josh: waiting for the bank's form"); assert.equal(h.until, "2026-11-19");
  assert.equal(a.inHouse.length, 0);
});

test("client reasons never advise, predict or quote a fee", () => {
  const a = planAgenda(base);
  const text = [...a.plan, ...a.inHouse, ...a.held].map(i => i.reason).join(" ");
  assert.doesNotMatch(text, /\b(should|recommend|advise|likely|probably|\$)/i);
});

test("call dates: the Thursday on or after today, and the next", () => {
  assert.deepEqual(callDates("2026-11-03"), { callDate: "2026-11-05", nextCallDate: "2026-11-12" });
  assert.deepEqual(callDates("2026-11-05"), { callDate: "2026-11-05", nextCallDate: "2026-11-12" });
});
