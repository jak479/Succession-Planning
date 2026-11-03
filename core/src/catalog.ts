// Catalog: the fixed data model. Sources: docs/design/contingency-sequence-nodes.md,
// docs/design/intake-assessment.md, prototype/front-door.html (CHANGE_ORDERS, INTAKE, COVERAGE).
// Edit the docs first; this file follows them.

export type NodeStatus = "green" | "amber" | "red" | "planned" | "unassessed";
export type Tier = "entity" | "owner";
export type Coverage = "phase1" | "sub" | "co" | "personal" | "advisor" | "none";

export interface NodeDef { id: string; name: string; satisfiedBy: string; dependsOn: string[]; redRule: string; }

export const NODES: NodeDef[] = [
  { id: "N0", name: "Trigger defined", satisfiedBy: "Trigger clause in OA amendment / plan", dependsOn: [], redRule: "Clause unsigned, or incapacity standard undefined" },
  { id: "N1", name: "Notice tree", satisfiedBy: "Instruction letter, contact tree", dependsOn: ["N0"], redRule: "Any contact unreachable at last test; tree older than 12 months" },
  { id: "N2", name: "Authority activates", satisfiedBy: "OA amendment or resolution naming manager and powers; DPOA with business powers (ch. 709)", dependsOn: ["N0", "C2", "C3"], redRule: "Manager resigned, left, or declined; document unsigned; manager consent not on file" },
  { id: "N3", name: "Successor manager", satisfiedBy: "Same instrument, alternate named", dependsOn: ["N2"], redRule: "No alternate; alternate left" },
  { id: "N4", name: "Bank access", satisfiedBy: "Signatory card; bank's POA acceptance letter", dependsOn: ["N2"], redRule: "Manager not on card; bank has not accepted POA; new account opened since last review" },
  { id: "N5", name: "Cash reserve", satisfiedBy: "Reserve account; cash rule in plan", dependsOn: [], redRule: "Balance below the short-term figure (days to the disability benefit start, or 90 if no policy); rule unsigned" },
  { id: "N6", name: "Payroll runs", satisfiedBy: "Provider admin assignment", dependsOn: ["N4", "N5", "N8"], redRule: "Owner is sole admin; provider changed" },
  { id: "N7", name: "Insurance in force", satisfiedBy: "Policy schedule incl. disability (benefit start day sets the S1/S2 boundary) and disability buy-out; beneficiary designations", dependsOn: [], redRule: "Any policy lapsed; beneficiary is the owner personally where entity should be" },
  { id: "N8", name: "Credentials and access", satisfiedBy: "Password manager with manager as emergency contact; access list", dependsOn: ["N2"], redRule: "List older than 12 months; MFA device is owner's phone only" },
  { id: "N9", name: "Customer and referral-source notice", satisfiedBy: "Customer list; stakeholder continuity statement", dependsOn: ["N2", "N8"], redRule: "List older than 12 months; statement expired" },
  { id: "N10", name: "Vendor, lease, and guaranty list", satisfiedBy: "Guaranty schedule; lease abstract; negotiator named", dependsOn: ["N2"], redRule: "Lease renewed or new guaranty signed since last review" },
  { id: "N11", name: "License and regulatory", satisfiedBy: "Designation on file; regulator's change-of-ownership rule abstract", dependsOn: ["N2"], redRule: "License renewal passed without review; designee changed" },
  { id: "N12", name: "Key staff", satisfiedBy: "Retention agreements; disclosure timing decision", dependsOn: ["N2"], redRule: "Key employee changed; no retention term for a person the plan names" },
  { id: "N14", name: "Day-30 checkpoint", satisfiedBy: "Decision authority clause; information list", dependsOn: ["N2", "N4", "N5", "N6"], redRule: "Decision-maker unnamed or same person as the incapacitated owner only" },
  { id: "N15a", name: "Continue branch", satisfiedBy: "Continue instruction", dependsOn: ["N14"], redRule: "Default branch is 'continue' and no instruction exists" },
  { id: "N15b", name: "Sell branch", satisfiedBy: "Sale authority clause; valuation method; buyer list", dependsOn: ["N14", "N9", "N12"], redRule: "Default branch is 'sell' and valuation method or buyer list missing" },
  { id: "N15c", name: "Wind-down branch", satisfiedBy: "Wind-down instruction (§ 605.0701 et seq.)", dependsOn: ["N14", "N5", "N10"], redRule: "Default branch is 'wind down' and sequence or funding undefined" },
  // Retirement (S3). R1 is advisor-owned; R2 is personal-engagement work. The entity tier stores their status only, never amounts or contents.
  { id: "R1", name: "Retirement income confirmed", satisfiedBy: "Owner's financial advisor confirms the retirement plan does not depend on business income past the exit date (status only)", dependsOn: [], redRule: "No advisor named; advisor has not confirmed; exit date moved since confirmation" },
  { id: "R2", name: "Your role after you step back", satisfiedBy: "Consulting or employment agreement; redemption or buy-sell terms; non-compete; step-down of authority; fairness record at authorization (§ 605.04092): attorney from market data, or the existing valuator's report", dependsOn: ["N2", "C4"], redRule: "No written role or redemption terms; terms conflict with the chosen branch; a payment fails § 605.0405(1), or consulting pay exceeds reasonable compensation (§ 605.0102(17))" },
  // Family office (S4 content, decided 2026-11-03). Drafted before the exit under the personal engagement; managed in Phase 3.
  { id: "F1", name: "Family governance", satisfiedBy: "Family governance document: who decides, how the family meets, how advisors report", dependsOn: ["C8"], redRule: "No governance document at the exit; decision-maker unnamed" },
  { id: "F2", name: "Advisor team", satisfiedBy: "Advisor roster with roles and the coordination consent (legal, tax, investment, insurance)", dependsOn: [], redRule: "A role unfilled; an advisor changed without notice; coordination consent withdrawn" },
  { id: "F3", name: "Holding structure for the proceeds", satisfiedBy: "Family entity or trust to receive the proceeds, or the attorney's written finding that none is needed at this size", dependsOn: ["C6", "C7"], redRule: "Proceeds have no designated recipient structure; finding older than the exit terms" },
  // Coordination rungs. Entity tier stores status only; contents live in the owner tier.
  { id: "C1", name: "Who receives the interest", satisfiedBy: "OA transfer restrictions vs. will/trust", dependsOn: [], redRule: "Different takers; OA bars the transfer; trust not admitted" },
  { id: "C2", name: "Who runs it on day one", satisfiedBy: "Interim manager vs. POA agent / PR / trustee", dependsOn: [], redRule: "Different persons, no coordination clause; conflicting duties" },
  { id: "C3", name: "Authority instruments", satisfiedBy: "OA grant vs. durable POA with business powers", dependsOn: [], redRule: "One amended or revoked without the other; bank accepted one only" },
  { id: "C4", name: "Buy-sell funding", satisfiedBy: "Entity's right to proceeds vs. policy owner/beneficiary", dependsOn: [], redRule: "Policy owned or payable inconsistently with structure" },
  { id: "C5", name: "Guaranties", satisfiedBy: "Guaranty schedule vs. estate exposure plan", dependsOn: [], redRule: "New guaranty since last review on either side" },
  { id: "C6", name: "Exit proceeds", satisfiedBy: "Sale structure vs. Medicaid / asset-protection / tax plan", dependsOn: [], redRule: "Sale form or timing defeats the personal plan" },
  { id: "C7", name: "Lifetime transfer to insider", satisfiedBy: "Transfer mechanics vs. gift/estate plan", dependsOn: [], redRule: "Transfer executed on one side only" },
  { id: "C8", name: "Family liaison", satisfiedBy: "Person manager takes direction from vs. person who speaks for family", dependsOn: [], redRule: "Unnamed; disputing heir; deceased or estranged" },
];
export const NODE_IDS = new Set(NODES.map(n => n.id));
export const isCoordination = (id: string) => /^C\d$/.test(id);

// Stage gates (CLAUDE.md). Stages are cumulative: S2 requires S1's gate too.
export const STAGES = [
  // Names follow Bridges' transition model (decided 2026-11-03). S1/S2 boundary: the day the owner's
  // disability benefit starts (N7), 90 days if there is no policy.
  { key: "S0", name: "Where you stand today", gate: [] as string[] },
  { key: "S1", name: "Short-term disability covered", gate: ["N0", "N2", "N4", "N5", "N6"] },
  { key: "S2", name: "Long-term disability covered", gate: ["N7", "N14", "C1", "C2", "C3", "C8"] },
  { key: "S3", name: "Ready to retire", gate: ["N15a", "N15b", "N15c", "R1", "R2"] },
  { key: "S4", name: "Your family office is in place", gate: null }, // reached at the exit event, never by gates; content F1–F3, C6, C7. Phase 3 follows.
];

// Which stage each step belongs to, and its name on client surfaces (docs/design/architecture.md glossary;
// lanes as on the client home). Used by the agenda planner and the client pages.
export const NODE_STAGE: Record<string, number> = {
  N0: 1, N1: 1, N2: 1, N3: 1, N4: 1, N5: 1, N6: 1, N8: 1, C2: 1, C3: 1,
  N7: 2, N9: 2, N11: 2, N14: 2, C1: 2, C5: 2, C8: 2,
  N10: 3, N12: 3, N15a: 3, N15b: 3, N15c: 3, C4: 3, R1: 3, R2: 3,
  C6: 4, C7: 4, F1: 4, F2: 4, F3: 4,
};
export const CLIENT_LABEL: Record<string, string> = {
  N0: "When the plan starts", N1: "Who is told, in what order", N2: "Who is in charge", N3: "Alternate manager", N4: "Bank access", N5: "Cash reserve", N6: "Payroll",
  N7: "Disability insurance", N8: "Passwords and access", N9: "Customers and referral sources", N10: "Lease and guaranties", N11: "Licenses", N12: "Key staff",
  N14: "30-day decision", N15a: "Continue option", N15b: "Sale option", N15c: "Wind-down option",
  R1: "Retirement income", R2: "Your role after you step back", F1: "Family governance", F2: "Advisor team", F3: "Holding structure for the proceeds",
  C1: "Who receives the business", C2: "Who runs it on day one", C3: "Authority documents", C4: "Buy-sell funding", C5: "Guaranties", C6: "Exit proceeds", C7: "Lifetime transfers", C8: "Family contact",
};

// Intake. askedBy: "agent" = agent may ask (entity tier); "attorney" = asked only on the call (rule 4).
export type AskedBy = "agent" | "attorney";
export interface IntakeDef { id: string; kind: "doc" | "fact"; tier: Tier; core: boolean; askedBy: AskedBy; feeds: string[]; }
const I = (id: string, kind: "doc" | "fact", tier: Tier, core: boolean, feeds: string[], askedBy: AskedBy = "agent"): IntakeDef => ({ id, kind, tier, core, askedBy, feeds });
export const INTAKE: IntakeDef[] = [
  I("A1", "fact", "entity", true, ["N14"]), I("A2", "fact", "entity", true, ["N15a", "N15b", "N15c"]),
  I("A3", "fact", "entity", false, []), I("A4", "fact", "entity", true, ["N14"]),
  I("A5", "fact", "entity", true, ["C8", "C1", "N12"]), I("A6", "fact", "entity", false, ["N9"]),
  I("B1", "doc", "entity", true, ["N0", "N2", "N3", "N14", "C1"]), I("B2", "fact", "entity", true, ["N2", "N4", "N6", "N8", "N11"]),
  I("B3", "fact", "entity", true, ["N2", "N12"]), I("B4", "fact", "entity", false, ["N3"]),
  I("B5", "doc", "entity", true, ["N4", "C3"]), I("B6", "fact", "entity", true, ["N5", "N6"]),
  I("B7", "fact", "entity", true, ["N6"]), I("B8", "doc", "entity", false, ["N7", "C4"]),
  I("B9", "fact", "entity", false, ["N8"]), I("B10", "doc", "entity", false, ["N9"]),
  I("B11", "doc", "entity", false, ["N10", "C5"]), I("B12", "doc", "entity", false, ["N10", "C5", "N7"]),
  I("B13", "doc", "entity", false, ["N11"]), I("B14", "fact", "entity", false, ["N12"]),
  I("B15", "fact", "entity", false, ["N15b"]),
  I("C-1", "doc", "owner", true, ["C1", "C2", "C3", "C8"]),
  I("C-2", "fact", "owner", true, ["C2"], "attorney"), I("C-3", "fact", "owner", false, ["C1"], "attorney"),
  I("C-4", "fact", "owner", false, ["C8"], "attorney"), I("C-5", "fact", "owner", false, ["C1"], "attorney"),
  I("C-6", "fact", "owner", false, ["C6"], "attorney"), I("C-7", "fact", "owner", false, ["C7"], "attorney"),
  I("C-8", "fact", "owner", false, []),
];
export const INTAKE_BY_ID = new Map(INTAKE.map(i => [i.id, i]));

export interface ChangeOrderDef { id: string; name: string; low: number; high: number; clears: string[]; schedule: "A" | "B"; }
export const CHANGE_ORDERS: ChangeOrderDef[] = [
  { id: "CO-RET", name: "Retention agreement (per key person)", low: 1200, high: 1200, clears: ["N12"], schedule: "B" },
  { id: "CO-BANK", name: "Bank acceptance package", low: 0, high: 0, clears: ["N4", "C3"], schedule: "A" },
  { id: "CO-ACCESS", name: "Credentials and access refresh", low: 0, high: 0, clears: ["N8"], schedule: "A" },
  { id: "CO-GUAR", name: "Guaranty schedule and lease abstract update, both tiers", low: 1500, high: 3000, clears: ["N10", "C5"], schedule: "B" },
  { id: "CO-WIND", name: "Wind-down branch drafted", low: 2500, high: 6000, clears: ["N15c"], schedule: "B" },
  { id: "CO-SELL", name: "Sell branch drafted", low: 3000, high: 6000, clears: ["N15b"], schedule: "B" },
  { id: "CO-CONT", name: "Continue branch drafted", low: 2500, high: 4000, clears: ["N15a"], schedule: "B" },
  { id: "CO-TRUST", name: "Trust admission amendment and transfer provisions", low: 1500, high: 3000, clears: ["C1"], schedule: "B" },
  { id: "CO-BUYSELL", name: "Buy-sell agreement and funding alignment", low: 4000, high: 8000, clears: ["C4", "N7"], schedule: "B" },
  { id: "CO-FAM", name: "Family governance module", low: 4000, high: 7500, clears: ["C7", "C8"], schedule: "B" },
];

export const COVERAGE: Record<string, Coverage> = {
  N0: "phase1", N1: "phase1", N2: "phase1", N3: "phase1", N5: "phase1", N9: "phase1", N10: "phase1", N14: "phase1",
  N4: "sub", N6: "sub", N7: "sub", N8: "sub", N11: "sub",
  N12: "co", N15a: "co", N15b: "co", N15c: "co",
  C1: "co", C2: "sub", C3: "sub", C4: "co", C5: "sub", C6: "personal", C7: "co", C8: "sub",
  R1: "advisor", R2: "personal", F1: "personal", F2: "personal", F3: "personal",
};

// Profile fields (27). section = where it displays; tier = where it is stored.
// agentMay: the agent may fill it from a source. false = attorney records it from the call.
// No field is ever filled by drafting: the agent never prepares or completes a document.
export interface ProfileFieldDef { field: string; section: "Business" | "Owner"; tier: Tier; agentMay: boolean; note?: string; }
const B = (field: string): ProfileFieldDef => ({ field, section: "Business", tier: "entity", agentMay: true });
export const PROFILE_FIELDS: ProfileFieldDef[] = [
  ...["Legal name and entity type", "Florida document number; status; formation date", "Registered agent; principal address", "Owners and percentages",
    "Managers / officers of record", "Annual report last filed", "Licenses and regulator", "Revenue, payroll and fixed costs", "Bank accounts and signers",
    "Payroll provider and admin", "Insurance in force", "Lease", "Loans and credit lines", "UCC filings against the company", "Judgments or liens",
    "Top customers / referral sources", "Key employees", "Estimated value and basis"].map(B),
  { field: "Name; role", section: "Owner", tier: "entity", agentMay: true },
  { field: "Target exit and preferred exit", section: "Owner", tier: "entity", agentMay: true, note: "A1/A2; owner's own answer, never estimated" },
  { field: "Personal guaranties", section: "Owner", tier: "entity", agentMay: true, note: "from loan, lease and credit documents; UCC" },
  { field: "Family and who is affected", section: "Owner", tier: "owner", agentMay: true, note: "facts only: names, roles, marital status; never intentions" },
  { field: "Personal documents in place (will, trust, DPOA, surrogate)", section: "Owner", tier: "owner", agentMay: true, note: "existence, date and drafter only; never contents" },
  { field: "Real property and homestead", section: "Owner", tier: "owner", agentMay: true, note: "property appraiser; clerk" },
  { field: "Advisors (CPA, planner, other counsel)", section: "Owner", tier: "owner", agentMay: true, note: "C-8" },
  { field: "Who holds authority: POA agent / PR / trustee", section: "Owner", tier: "owner", agentMay: false, note: "C-2; attorney on the call" },
  { field: "Long-term care / asset-protection planning", section: "Owner", tier: "owner", agentMay: false, note: "C-6; attorney on the call" },
];
