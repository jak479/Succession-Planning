import { test } from "node:test";
import assert from "node:assert/strict";
import { stageOf, blockedBy, coreMissing, previewChangeOrder } from "../src/rules.ts";

const S1 = { N0: "green", N2: "green", N4: "amber", N5: "green", N6: "green" } as const;
test("stage gates are cumulative", () => {
  assert.equal(stageOf({}), 0);
  assert.equal(stageOf({ ...S1 }), 1);
  assert.equal(stageOf({ N7: "green", N14: "green", C1: "green", C2: "green", C3: "green", C8: "green" }), 0, "S2 gate without S1 does not count");
  assert.equal(stageOf({ ...S1, N7: "green", N14: "green", C1: "green", C2: "green", C3: "green", C8: "green", N15a: "green", N15b: "green", N15c: "green", R1: "green", R2: "green" }), 3, "S4 never by gates");
});
test("red propagates downstream, including C2/C3 into N2", () => {
  const b = blockedBy({ C3: "red" });
  assert.deepEqual(b.N2, ["C3"]);
  assert.ok(b.N6.includes("C3") && b.N15c.includes("C3"));
});
test("path assignment needs stated/received core items", () => {
  assert.equal(coreMissing({}).length, 12);
  assert.ok(coreMissing({ B1: "received_unread" }).includes("B1"));
});
test("change-order preview", () => {
  assert.deepEqual(previewChangeOrder({ ...S1, N4: "red" }, "CO-BANK"), { from: 0, to: 1 });
});
