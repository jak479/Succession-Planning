import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assemble, blockers, brackets, callQuestions, checkBindings, executionModes, instrument, tierViolations, type Facts, type SourceKind } from "../src/drafting.ts";
import { TEMPLATES, OA_CONTINUITY as OA, DPOA_RIDER as RIDER } from "../src/templates.ts";

const file = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const S = "src:attorney-call-2026-11-05";                       // demo source id
const f = (o: Record<string, string | boolean>): Facts => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value, source: S }]));

test("every bracket in each template is bound, in order", () => {
  for (const t of TEMPLATES) assert.deepEqual(checkBindings(instrument(t, file(t.file)), t.bindings), [], t.id);
});
test("bindings drift is caught", () => {
  const src = instrument(OA, file(OA.file)).replace("[Owner name]", "[Owner]");
  assert.match(checkBindings(src, OA.bindings).join(), /#8/);
  assert.throws(() => assemble(OA, file(OA.file).replace("[Owner name]", "[Owner]"), {}), /differ/);
});
test("rule 3: owner-tier rider draws on no entity-tier profile field; vars named in bindings exist", () => {
  for (const t of TEMPLATES) {
    assert.deepEqual(tierViolations(t), [], t.id);
    const ids = new Set(t.vars.map(v => v.id));
    const walk = (bs: typeof t.bindings): void => bs.forEach(b => { if ("id" in b) assert.ok(ids.has(b.id), `${t.id}: ${b.id}`); if (b.kind === "optional" && b.inner) walk(b.inner); });
    walk(t.bindings); for (const s of t.sections ?? []) assert.ok(ids.has(s.id));
  }
  assert.deepEqual(tierViolations({ ...RIDER, vars: [{ id: "x", label: "x", from: "Bank accounts and signers" }] }).length, 1);
});
test("rule 6: a fact without a source is refused", () => {
  assert.throws(() => assemble(OA, file(OA.file), { company: { value: "Gulfside Mechanical", source: "" } }), /no source/);
});
test("nothing decided: text unchanged except notes; everything open", () => {
  const a = assemble(OA, file(OA.file), {});
  assert.ok(!a.text.includes("[Drafter:"), "drafter notes never exported");
  assert.ok(!/[ \t]$/m.test(a.text), "no trailing spaces where notes were");
  assert.ok(a.text.includes("[Owner name]") && a.text.includes("[one / two]"));
  assert.equal(a.used.length, 0);
  assert.ok(a.open.some(o => o.id === "interim_manager"));
  assert.deepEqual(a.checks, []);
});

const GULFSIDE = f({
  amendment_no: "1", company: "Gulfside Mechanical", effective_date: "December 1, 2026", oa_date: "March 4, 2019", article: "12",
  principal: "Dana Ortiz", principal_role: "sole member", physicians: "two", attending_physician: true, unavailability_days: "14",
  interim_manager: "Luis Herrera", alternate_im: "Maria Chen", return_certification: true, continuity_months: "12",
  member_managed: true, sunbiz_days: "10", multi_member: false, default_branch: "continue", controls: "this Article",
});
test("Gulfside OA: values filled with sources; choices and variants applied", () => {
  const a = assemble(OA, file(OA.file), GULFSIDE);
  assert.match(a.text, /^AMENDMENT NO\. 1 TO THE OPERATING AGREEMENT OF GULFSIDE MECHANICAL, LLC/);
  assert.match(a.text, /\*\*"Principal"\*\* means Dana Ortiz, the sole member of the Company/);
  assert.match(a.text, /certification by two licensed physicians, one of whom is the Principal's attending physician, if any, that/);
  assert.match(a.text, /means Luis Herrera, or if Luis Herrera is unable or unwilling to serve, Maria Chen, or if neither, the person designated under 12\.6\./);
  assert.match(a.text, /### 12\.2 Authority/);
  assert.match(a.text, /decided by the Interim Manager alone \(varying § 605\.04073\(2\)\(b\)\)\. Effective on an Unavailability Event, the Company is a manager-managed/);
  assert.ok(!a.text.includes("[Drafter:") && !a.text.includes("[Multi-member"));
  assert.ok(!a.text.includes("Multi-member") && !a.text.includes("remaining members' rights"));
  assert.match(a.text, /and \(c\) the Company consents to admit as a member \(§ 605\.0401\(3\)\(a\)\), effective on the Principal's death or, if later, on the person's signed acceptance of this Agreement, the trustee of \[trust\] if/);
  assert.match(a.text, /______________________ Dana Ortiz, individually\n/);
  const mm = assemble(OA, file(OA.file), { ...GULFSIDE, ...f({ multi_member: true }) }).text;
  assert.match(mm, /continues under this Article; and \(c\) the remaining members' rights under the Agreement and any buy-sell agreement are unaffected\./);
  assert.ok(!mm.includes("the Company consents to admit"));
  assert.match(a.text, /default branch is \*\*continue\*\*/);
  assert.ok(a.used.every(u => u.source === S));
  assert.ok(a.open.some(o => o.id === "family_liaison"), "undecided stays open");
  assert.ok(a.text.includes("[Name], or if unable, [Alternate]"), "and stays bracketed");
  assert.throws(() => assemble(OA, file(OA.file), { ...GULFSIDE, ...f({ default_branch: "merge" }) }), /not one of/);
});
test("one physician: no plural", () => {
  assert.match(assemble(OA, file(OA.file), f({ physicians: "one", attending_physician: false })).text, /by one licensed physician that the Principal/);
});

test("rider: Part C and D gates, A(2) line, nested buy-sell date", () => {
  const base = { company: "Gulfside Mechanical", principal: "Dana Ortiz", business_agent: "Luis Herrera", agent_is_im: true };
  const keep = assemble(RIDER, file(RIDER.file), f({ ...base, part_c: true, agent_not_family: true, agent_may_buy: true, buysell_date: "June 1, 2026", separate_business_agent: false }));
  assert.ok(keep.text.includes("### Part C") && keep.text.includes("### Part D"));
  assert.match(keep.text, /provides, and \(ii\) participate as buyer under the Company's buy-sell agreement dated June 1, 2026 on its stated terms, but may not/);
  assert.ok(!keep.text.includes("(2) The authority in this Rider"), "A(2) dropped");
  assert.ok(!keep.text.includes("[Include only if"));
  const noBuy = assemble(RIDER, file(RIDER.file), f({ ...base, agent_not_family: true, agent_may_buy: false }));
  assert.match(noBuy.text, /the Operating Agreement provides but may not otherwise/);
  assert.match(noBuy.text, /^Notwithstanding/m);
  const drop = assemble(RIDER, file(RIDER.file), f({ ...base, part_c: false, agent_not_family: false, separate_business_agent: true }));
  assert.ok(!drop.text.includes("### Part C") && !drop.text.includes("### Part D") && drop.text.includes("### Part E"));
  assert.match(drop.text, /\(2\) The authority in this Rider is exercised by the Business Agent alone/);
  assert.ok(drop.text.includes("Witness 1: ______________________ [print name]"), "signature blanks kept");
  assert.match(drop.text, /Acknowledged before me by means of ☐ physical presence ☐ online notarization/);
});

test("execution modes follow § 709.2105, § 117.285 and § 668.50", () => {
  const m = (t: string, o: Facts) => Object.fromEntries(executionModes(t, o).map(r => [r.mode, r.allowed]));
  assert.deepEqual(m("oa-continuity", {}), { in_person: true, esign_only: true, ron_witnesses_present: true, ron_remote_witnesses: true });
  assert.equal(m("dpoa-rider", {}).ron_remote_witnesses, false, "undecided Part C blocks remote witnesses");
  assert.equal(m("dpoa-rider", f({ part_c: true })).ron_remote_witnesses, false);
  assert.equal(m("dpoa-rider", f({ part_c: false })).esign_only, false);
  const r = executionModes("dpoa-rider", f({ part_c: false })).find(x => x.mode === "ron_remote_witnesses")!;
  assert.ok(r.allowed && r.requires!.some(x => x.includes("never in the workspace")));
});
test("bracket scanner respects nesting", () => {
  assert.deepEqual(brackets("a [b [c] d] e [f]").map(b => b.text), ["[b [c] d]", "[f]"]);
});

test("v2 review: statutory words survive assembly verbatim", () => {
  const r = assemble(RIDER, file(RIDER.file), {}).text;
  assert.ok(r.includes("This durable power of attorney is not terminated by subsequent incapacity of the principal except as provided in chapter 709, Florida Statutes."), "§ 709.2104");
  assert.ok(r.includes("authority to conduct banking transactions as provided in section 709.2208(1), Florida Statutes."), "§ 709.2208(1) / § 709.2120(1)(a)");
  assert.ok(!r.includes("and manager]"), "no manager authority through the POA (§ 709.2201(3)(a))");
  const o = assemble(OA, file(OA.file), {}).text;
  assert.ok(o.includes("becomes the sole manager of the Company for the Continuity Period") && o.includes("§ 605.04072(4) does not apply"));
  assert.ok(o.includes("varies a member's right to approve a merger, interest exchange, or conversion (§ 605.0105(3)(m))"));
});

const k = (value: string | boolean, kind: SourceKind) => ({ value, source: "src:" + kind, kind });
test("client choices: listed before any value is chosen; the template's bracketed value is never a default", () => {
  const a = assemble(OA, file(OA.file), {});
  const c = Object.fromEntries(a.choices.map(x => [x.id, x]));
  assert.equal(c.unavailability_days.status, "open");
  assert.equal(c.unavailability_days.template, "[14]", "shown to the attorney as the template's text");
  assert.ok(a.text.includes("for [14] consecutive days"), "and left bracketed, not filled");
  for (const x of a.choices) {
    assert.doesNotMatch(x.ask, /\b(recommend|suggest|should consider|best|typical|usually|we advise)\b/i, x.id);
    const v = x.template.slice(1, -1);                                 // a value the template proposes: a number or a phrase
    if (/\d/.test(v) || (v.length > 8 && !v.includes("/"))) assert.ok(!x.ask.toLowerCase().includes(v.toLowerCase()), `${x.id}: ask repeats the template value`);
  }
  assert.ok(!a.choices.some(x => x.id === "company" || x.id === "article"), "facts and drafting choices are not client choices");
});
test("client choices: only a call record (or, entity tier, a signed document) decides one", () => {
  const st = (t: typeof OA, facts: Facts, id: string) => assemble(t, file(t.file), facts).choices.find(x => x.id === id)!.status;
  assert.equal(st(OA, { interim_manager: k("Luis Herrera", "CALL") }, "interim_manager"), "decided");
  assert.equal(st(OA, { interim_manager: k("Luis Herrera", "DOC") }, "interim_manager"), "decided");
  assert.equal(st(OA, { interim_manager: k("Luis Herrera", "CLIENT") }, "interim_manager"), "unconfirmed", "described in the workspace is not decided");
  assert.equal(st(OA, { interim_manager: { value: "Luis Herrera", source: "s" } }, "interim_manager"), "unconfirmed");
  assert.equal(st(RIDER, { business_agent: k("Luis Herrera", "DOC") }, "business_agent"), "unconfirmed", "owner tier: the call only (rule 4)");
  assert.equal(st(RIDER, { business_agent: k("Luis Herrera", "CALL") }, "business_agent"), "decided");
});
test("client choices: section gates count, and choices inside a dropped section drop out", () => {
  const on = assemble(RIDER, file(RIDER.file), {}).choices.map(x => x.id);
  assert.ok(on.includes("part_c") && on.includes("gift_donees"));
  const off = assemble(RIDER, file(RIDER.file), { part_c: k(false, "CALL") }).choices.map(x => x.id);
  assert.ok(off.includes("part_c") && !off.includes("gift_donees"));
});
test("highlight marks client-choice spots; a dropped clause leaves no empty mark", () => {
  const a = assemble(OA, file(OA.file), { interim_manager: k("Luis Herrera", "CALL"), attending_physician: k(false, "CALL") }, { highlight: true });
  assert.ok(a.text.includes("means ⟦choice:interim_manager⟧Luis Herrera⟦/choice⟧, or if"));
  assert.ok(a.text.includes("⟦choice:unavailability_days⟧[14]⟦/choice⟧"), "open choices are marked too");
  assert.ok(!a.text.includes("⟦choice:attending_physician⟧⟦/choice⟧"));
  assert.ok(!assemble(OA, file(OA.file), {}).text.includes("⟦"), "no marks unless asked");
});
test("blockers and call questions", () => {
  const a = assemble(RIDER, file(RIDER.file), { business_agent: k("Luis Herrera", "CALL"), alternate_agent: k("Maria Chen", "CLIENT") });
  const b = blockers(a);
  assert.ok(b.includes("Confirm with the client: Alternate Business Agent"));
  assert.ok(!b.includes("Put to the client: Business Agent") && !b.includes("Confirm with the client: Business Agent"));
  const q = callQuestions(RIDER, a, "2026-11-12");
  assert.ok(q.every(x => x.tier === "owner" && x.kind === "question" && x.key.startsWith("draft:dpoa-rider:")));
  assert.ok(!q.some(x => x.key.endsWith(":business_agent")));
});
