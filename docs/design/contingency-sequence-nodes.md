# Contingency Sequence — Node List (v1)

The dependency graph the state file, PM board, path diagram and calculator read from. Each node: what must be true, what satisfies it, what depends on it, and the rule that turns it red. "Owner out" = death, incapacity, or unavailability as defined in N0.

Status values: GREEN (satisfied, in date) · AMBER (satisfied, review due) · RED (broken — a dependent node cannot execute). Red propagates downstream.

| # | Node | Satisfied by | Depends on | Red rule |
|---|---|---|---|---|
| N0 | **Trigger defined** — what counts as "owner out," who declares it, and the evidence (death certificate; physician certification standard for incapacity; unreachable-for-X-days for unavailability) | Trigger clause in operating agreement amendment / plan | — | Clause unsigned, or incapacity standard undefined |
| N1 | **Notice tree** — who is told, by whom, in what order (manager, family liaison, attorney, bank) | Instruction letter, contact tree | N0 | Any contact unreachable at last test; tree older than 12 months |
| N2 | **Authority activates** — interim manager has express power to operate, sign, hire/fire, spend to the cash rule | OA amendment or resolution naming manager and powers (§ 605 default rules do not supply this); durable POA with business powers (ch. 709) for the owner's personal side | N0 | Manager resigned, left, or declined; document unsigned; manager consent not on file |
| N3 | **Successor manager** — second name if N2's manager is unavailable | Same instrument, alternate named | N2 | No alternate; alternate left |
| N4 | **Bank access** — manager is on the signatory card; online banking admin exists other than owner | Signatory card; bank's POA acceptance letter | N2 | Manager not on card; bank has not accepted POA; new account opened since last review |
| N5 | **Cash reserve** — funds for 90 days' payroll and fixed costs, with the spending rule | Reserve account; cash rule in plan | — | Balance below 90-day figure; rule unsigned |
| N6 | **Payroll runs** — payroll provider admin credentials held by manager; funding path from N4/N5 | Provider admin assignment | N4, N5, N8 | Owner is sole admin; provider changed |
| N7 | **Insurance in force** — key-person, disability, GL/professional, with correct beneficiary/loss payee | Policy schedule; beneficiary designations | — | Any policy lapsed; beneficiary is the owner personally where entity should be |
| N8 | **Credentials and access** — passwords, MFA devices, domain, software admin, physical keys | Password manager with manager as emergency contact; access list | N2 | List older than 12 months; MFA device is owner's phone only |
| N9 | **Customer and referral-source notice** — list and script; continuity statement on file | Customer list; stakeholder continuity statement | N2, N8 | List older than 12 months; statement expired |
| N10 | **Vendor, lease, and guaranty list** — what follows the owner personally; who negotiates | Guaranty schedule; lease abstract; negotiator named | N2 | Lease renewed or new guaranty signed since last review |
| N11 | **License and regulatory** (licensed businesses only) — designee/administrator rules met; transfer notice path known | Designation on file; regulator's change-of-ownership rule abstract (e.g. AHCA § 408.807) | N2 | License renewal passed without review; designee changed |
| N12 | **Key staff** — retention terms in place; staff know who the manager is | Retention agreements; disclosure timing decision | N2 | Key employee changed; no retention term for a person the plan names |
| N13 | *(moved to C8)* | | | |
| N14 | **Day-30 checkpoint** — who decides continue / sell / wind down, and on what information | Decision authority clause; information list (financials, pipeline, staff status) | N2, N4, N5, N6 | Decision-maker unnamed or same person as the incapacitated owner only |
| N15a | **Continue branch** — operating plan for 12 months under the manager | Continue instruction | N14 | Default branch is "continue" and no instruction exists |
| N15b | **Sell branch** — authority to sell, valuation reference, buyer list | Sale authority clause; valuation method; buyer list | N14, N9, N12 | Default branch is "sell" and valuation method or buyer list missing |
| N15c | **Wind-down branch** — authority to close, sequence, funding | Wind-down instruction (§ 605.0701 et seq.) | N14, N5, N10 | Default branch is "wind down" and sequence or funding undefined |

## Retirement nodes (S3, added 2026-11-03)

| # | Node | Satisfying document | Depends on | Red rule |
|---|---|---|---|---|
| R1 | **Retirement income confirmed** — advisor-owned; the entity tier stores status only, never amounts or contents | Owner's financial advisor confirms the retirement plan does not depend on business income past the exit date | — | No advisor named; advisor has not confirmed; exit date moved since confirmation |
| R2 | **Your role after you step back** — personal-engagement work (owner letter § 2(C)); the entity tier stores status only | Consulting or employment agreement; redemption or buy-sell terms; non-compete; step-down of authority | N2, C4 | No written role or redemption terms; terms conflict with the chosen branch; a payment fails § 605.0405(1), or consulting pay exceeds reasonable compensation (§ 605.0102(17)) |

## Family office nodes (S4, added 2026-11-03)

| # | Node | Satisfying document | Depends on | Red rule |
|---|---|---|---|---|
| F1 | **Family governance** | Family governance document: who decides, how the family meets, how advisors report | C8 | No governance document at the exit; decision-maker unnamed |
| F2 | **Advisor team** | Advisor roster with roles and the coordination consent (legal, tax, investment, insurance) | — | A role unfilled; an advisor changed without notice; coordination consent withdrawn |
| F3 | **Holding structure for the proceeds** | Family entity or trust to receive the proceeds, or the attorney's written finding that none is needed at this size | C6, C7 | Proceeds have no designated recipient structure; finding older than the exit terms |

The family office is the advisor team the Firm coordinates; a family entity is added when the size justifies it (F3). Investment, tax, accounting and bill pay stay with the other advisors (pro-forma positioning).

## Stage mapping (decided 2026-11-03)
S0 where you stand today · S1 short-term disability covered (N0, N2, N4, N5, N6) · S2 long-term disability covered (N7, N14, C1, C2, C3, C8) · S3 ready to retire (N15a–c, R1, R2) · S4 your family office is in place (reached at the exit event; content F1–F3, C6, C7). Phase 3, managing the office, follows S4 under its own engagement; cadence and client set case by case. The S1/S2 boundary is the day the owner's disability benefit starts, read from the policy (N7); 90 days if there is no policy. N5's reserve is sized to that boundary. Client surfaces say "disability"; no medical information is stored, and each stage page carries the line "Your plan covers being out, not the reason."
R2 change orders need two written consents (the owner personally, and the Company through its sole member signing in that capacity or a manager/officer other than the owner, Rule 4-1.13(e)), a written client-identity notice (4-1.13(d)), a fairness record made at authorization, prepared by the attorney from market data unless a valuator is already retained (then that valuation; decided 2026-11-03; kept dated with the R2 documents while the terms are in force, since the preparer is a likely witness under Rule 4-3.7) (valuation for a redemption, comparable-pay data for consulting; § 605.04092(1)(c), (3); the single-member company cannot use the burden-shifting approval of (4)(a)), and the attorney's 4-1.7 check before work starts; the board's signature step must collect both. Open: no R2 price set yet (pro-forma prices are locked). N10 and N12 are Stage 3 steps (critical path: float, gate N15b/N15c); the client surfaces show them as open Stage 3 steps when a date or person forces them early.

## Coordination nodes (estate plan ↔ exit plan)

Status is computed from *consistency between the two documents*, not from either alone. Each depends on one entity node and one personal-tier node. The entity tier displays status only ("personal document in place and consistent: yes/no"); content is visible in the owner tier.

| # | Coordination item | Entity-side document | Personal-side document | Red rule |
|---|---|---|---|---|
| C1 | **Who receives the interest** | OA transfer restrictions; buy-sell; trust-as-member admission (N15b) | Will / trust beneficiary designation of the interest | Different takers; OA bars the transfer the will or trust makes; trust not admitted |
| C2 | **Who runs it on day one** | Interim manager (N2) | POA agent; later PR or trustee | Different persons with no coordination clause; same person with conflicting duties (PR to liquidate vs. manager to continue) |
| C3 | **Authority instruments** | OA grant / resolution (N2) | Durable POA with business powers (ch. 709) | Either amended or revoked without the other; bank has accepted one but not the other (N4) |
| C4 | **Buy-sell funding** | Entity's right to proceeds; redemption vs. cross-purchase (N7, N15b) | Policy ownership and beneficiary (owner, ILIT, trust) | Policy owned or payable inconsistently with the structure; premium payer inconsistent with tax treatment |
| C5 | **Guaranties** | Guaranty schedule; negotiator (N10) | Estate exposure; exempt-asset plan | New guaranty since last review on either side |
| C6 | **Exit proceeds** | Sale structure and timing; installment vs. lump sum (N15b/N15c) | Medicaid / long-term-care plan; asset protection; basis and estate tax | Proposed sale form or timing defeats the personal plan (countable assets; lost step-up) |
| C7 | **Lifetime transfer to insider** | Transfer mechanics; valuation; control retention (N15b) | Gift/estate tax; equalization among heirs | Transfer executed on one side only |
| C8 | **Family liaison** | Person the manager takes direction from (N1, N2) | Person who speaks for the family; health directive | Unnamed; liaison is also a disputing heir; liaison deceased or estranged per owner |

Review: C1–C4 at onboarding and at every annual review; C5 on event; C6–C7 when a branch moves to Scoped; C8 at onboarding.

## Critical path (default client: owner-dependent, wind-down default)
N0 → N2 → N4 → N6 → N14 → N15c, with N5 and N8 as parallel inputs to N6. Nodes N7, N9, N10, N12 have float but gate N15b/N15c. C2 and C3 sit on the critical path: a red C2 or C3 makes N2 red.

## Review cadence
- Every weekly call: any node changed by this week's events
- Quarterly: N4, N5, N8 (the three that drift silently)
- Annual review (anchor date): all nodes; N9 statement reissued
- On event (new lease, new account, staff change, policy renewal): the affected node only

## Calculator hooks
Protection return attaches at N2, N4, N5, N6 (value at risk if authority gap exists). Operating return attaches at N9 (continuity statement) and N7. Exit return attaches at N15b.

## Journey page mapping
Coordination nodes are drawn as rungs between the owner track and the business track at the station where each matters; a red rung is visible from both tracks.

## PM board mapping
Each node is a card in the Plan Status view; a RED node auto-creates a card in Open Items (Identified column) with the node's satisfying document as the task. Coordination items are a separate line group on the budget page, priced as change orders under whichever engagement does the drafting, with the invoice allocated accordingly.
