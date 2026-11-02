# Intake Assessment (v1)

Run at the discovery call, continued in the workspace by the intake assistant. Every question feeds one of: a node status (N/C), a calculator input (CALC), an anchor date (DATE), or the open-items list (OPEN). Questions that feed nothing are not asked.

Two tiers: **E** = entity file; **P** = owner personal file. The assistant asks E questions in the entity tier and P questions in the owner tier.

---

## Part A — The exit (ask first)

| # | Question | Feeds |
|---|---|---|
| A1 | When do you expect to leave the business? Date, age, or "no plan to." | DATE (target exit), N14 |
| A2 | What does a good exit look like? Pick all: sell to outsider / transfer to family or employee / keep income after leaving (rent, installment, royalty) / close it cleanly / don't know. | N15 default branch, CALC (exit) |
| A3 | What do you need from the business at exit — a lump sum, an income, or just that it stops being your problem? Rough number if you have one. | CALC (exit target) |
| A4 | If you were out tomorrow — accident, illness — what do you want to happen to the business? Same answer as A2, or different? | N15 default branch (emergency), OPEN |
| A5 | Who in your life is affected by that answer? Spouse, children, partners, key employees, anyone else. | C8, C1, N12 |
| A6 | Has anyone asked you for a continuity or key-person plan — a lender, a customer, a regulator, a partner? Who, and what did they ask for? | OPEN (continuity statement), DATE, sub-segment |

## Part B — The business (E)

| # | Question | Feeds |
|---|---|---|
| B1 | Entity type and state; all owners and percentages; is there an operating agreement or bylaws, and when last amended? | N2, N15b, C1 |
| B2 | What would stop on day one without you? (Sales, signing, payroll, a license, a relationship, a skill.) | N2, N4, N6, N8, N11; transferability |
| B3 | Who could run it for 90 days? Name, role, would they do it, do they know? | N2, N3, N12 |
| B4 | Second choice if that person can't? | N3 |
| B5 | Banks and accounts; who is on the signatory card; who has online admin? | N4 |
| B6 | Monthly payroll and fixed costs; cash on hand; any reserve? | N5, CALC (value at risk) |
| B7 | Payroll provider; who is admin? | N6 |
| B8 | Insurance: key-person, disability, buy-sell funding, GL/professional; carrier, owner, beneficiary, renewal date. | N7, C4, DATE |
| B9 | Where are the passwords, MFA devices, domain, software admin, keys? Who else can get in? | N8 |
| B10 | Top customers and referral sources; any contracts with renewal dates; any that require supplier continuity? | N9, DATE, CALC (operating) |
| B11 | Lease: term, renewal, personal guaranty? Other guaranties — loans, lines, vendor accounts? | N10, C5, DATE |
| B12 | Loans: lender, balance, maturity, personal guaranty, key-person or life-insurance covenant? | N10, C5, DATE (loan anniversary), CALC (operating) |
| B13 | Licenses held by the business or by you personally; renewal dates; is there a designee/administrator on file? | N11, DATE |
| B14 | Key employees: who, what they'd need to stay, any agreements in place? | N12 |
| B15 | Rough business value, and how you'd know: a valuation, an offer, revenue multiple, or a guess. | CALC (all three returns) |

## Part C — The personal side (P)

| # | Question | Feeds |
|---|---|---|
| C-1 | Do you have a will, trust, durable POA, health care surrogate? Who drafted them, when, and do they mention the business? | C1, C2, C3, C8 |
| C-2 | Who is named as POA agent, personal representative, trustee? Same person as B3? | C2 |
| C-3 | Who do you want your interest in the business to go to? Is that what the documents say? | C1 |
| C-4 | Who speaks for your family if you can't — and is that the person the manager should take direction from? | C8 |
| C-5 | Is any of the business owned through a trust, or should it be? | C1 |
| C-6 | Are you planning for long-term care costs or Medicaid? Working with anyone on asset protection? | C6 (status only; details stay in P tier) |
| C-7 | Do you intend to transfer any part of the business to a family member or employee during your lifetime? | C7, N15b |
| C-8 | Who is your CPA, financial advisor, other attorney? May we coordinate with them? | Owner letter § 4(d), advisor rotation |

## Part D — Anchor dates (compiled)

Loan anniversary · lease renewal · license renewals · insurance renewals · major contract renewals · target exit date · owner's birthday if an age-based trigger is used. The earliest recurring one becomes the annual review date; the continuity statement expires on it.

## Part E — Outputs (produced by the assistant, confirmed by attorney on call 2)

1. **Sub-segment:** lender-required / customer-required / licensed / partner-required / self-required (from A6).
2. **Transferability:** owner-is-the-business / owner-dependent with staff / transferable (from B2, B3, B15).
3. **Default branch, scheduled and emergency** (from A2, A4): may differ.
4. **Node status table:** N0–N15, C1–C8, each GREEN/AMBER/RED with the fact that set it.
5. **Open-items list:** every RED node → one line, satisfying document named, allowance estimated.
6. **Calculator inputs loaded:** B6, B8, B10, B12, B15, A3; two pro forma figures computed (exit on target date; exit tomorrow).
7. **Onboarding critical path:** client-owned nodes (documents due, manager consent) dated.
8. **Engagement letters populated:** entity letter with Schedule A/B defaults; personal letter scope A or B (from C-1).

## Rules

- A3, A4, C-6 and B15 are answered by the owner, never estimated by the assistant; a blank is a blank.
- Nothing from Part C is displayed in the E tier except the C-node status.
- If any answer suggests a capacity question, the assistant stops that line and flags the attorney; nothing further is collected in the workspace.
- Target: the whole assessment in one 60-minute call plus one workspace session; if it runs longer, the client is too complex for the standard onboarding and the onboarding fee is re-quoted before drafting starts.
