import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { citedSections, unconfirmedCitations } from "../src/statutes.ts";

test("citations: markers, lists and ranges count; section numbers of the instrument do not", () => {
  assert.deepEqual(citedSections("### 12.10 General per § 668.50(7); §§ 605.0701–605.0713 and 605.0405; section 709.2208(1), Florida Statutes"),
    ["605.0405", "605.0701", "605.0713", "668.50", "709.2208"]);
  assert.deepEqual(citedSections("under 12.6 and 12.5, Schedule 1"), []);
});
test("the templates cite only confirmed sections, apart from the ones their notes list as not yet read", () => {
  const read = (f: string) => readFileSync(new URL("../../docs/templates/" + f, import.meta.url), "utf8");
  assert.deepEqual(unconfirmedCitations(read("oa-amendment-continuity-template.md")), ["164.508", "605.0713"]);
  assert.deepEqual(unconfirmedCitations(read("dpoa-business-powers-rider.md")), ["709.2108", "744.3203"]);
});
