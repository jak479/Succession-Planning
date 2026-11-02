# Collection Map (v1)

Principle, adopted 2026-11-02: the agent collects everything it lawfully can before it asks the client anything, and asks only for what no source supplies. Ask-last, not ask-first. Within the tier split: entity-tier sources are pulled by the agent; owner-tier dispositive facts come only from the attorney's call.

Legend — Access: PUB public record · DOC client-supplied document · API connected system (consent) · CALL attorney asks · AGENT agent asks (entity tier only). Unlocks: nodes / intake items.

## 1. Entity identity and governance

| Field | Sources, best first | Access | Unlocks |
|---|---|---|---|
| Legal name, entity type, document number, status, formation date | Sunbiz entity detail; IRS SS-4 / EIN letter; operating agreement | PUB → DOC | B1, N0 |
| Registered agent, principal and mailing address | Sunbiz | PUB | N1 |
| Managers/officers of record; annual report history | Sunbiz annual reports (each year's filing lists them; changes between years are a finding) | PUB | N2, N3, N14 |
| Owners and percentages | Operating agreement; Sunbiz (members not always listed); K-1s / Form 1065 or 1120-S Schedule K-1 (from CPA with consent) | DOC → API | B1, C1 |
| Operating agreement: management, transfer restrictions, dissociation, amendment procedure | The agreement itself and every amendment; Sunbiz filings do not hold it | DOC | N0, N2, N14, C1 |
| Fictitious names | Sunbiz fictitious name registry | PUB | N9 |
| Foreign qualifications / other states | Other states' SOS sites if the business operates there | PUB | N11 |

## 2. Licenses and regulators

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Professional / contractor licenses, qualifiers, expirations | DBPR license lookup; license certificates | PUB → DOC | N11, B13 |
| Healthcare licenses, administrator of record | AHCA facility locator; license | PUB → DOC | N11 |
| Local business tax receipt; certificate of use | County tax collector; city | PUB | N11 |
| Federal registrations (DEA, FMCSA, FDA, etc. by trade) | Agency lookups | PUB | N11 |
| Pending complaints or discipline | DBPR complaint search; agency final orders | PUB | N11, scan |

## 3. Money

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Bank accounts, balances, signers, online admins | Bank signatory card and resolution (DOC); Plaid read-only link (API) for balances; the bank's confirmation letter | DOC / API | N4, N5, B5 |
| Reserve balance vs. 90-day target | Plaid; bank statements | API / DOC | N5 |
| Payroll provider, admins, pay schedule, headcount | Gusto / ADP / Paychex API (admin roster, pay runs); payroll register | API / DOC | N6, N12, B7 |
| Revenue, fixed costs, margins | QuickBooks / Xero API (P&L, balance sheet); tax returns from CPA | API / DOC | B6, B15, calculator |
| Loans: lender, balance, maturity, covenants, guaranty | Loan agreement and note (DOC); UCC-1 (PUB, names secured party and collateral); SBA authorization | DOC → PUB | N10, C5, B12 |
| Lines of credit, equipment financing, merchant cash advances | UCC search (every filing against the debtor); bank statements (daily ACH debits reveal MCAs) | PUB → API | N10, C5 |
| Personal guaranties (all) | Each loan, lease, vendor credit application, equipment lease; UCC filings against the owner personally | DOC → PUB | N10, C5 |
| Tax compliance | IRS transcripts via Form 8821 (consent); FL DOR account status | API (consent) / PUB | scan |
| Judgments, liens, lis pendens | County clerk official records (every county of residence and operation); FL DOR tax lien registry; federal tax lien index at clerk | PUB | scan, C5 |

## 4. Property and premises

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Real property owned by company or owner; homestead | County property appraiser (owner name search); recorded deeds and mortgages at clerk | PUB | Owner profile, C5, C6 |
| Lease: term, renewal notice, guaranty, assignment, default | The lease and amendments (DOC); landlord entity on Sunbiz (who the counterparty is) | DOC → PUB | N10, B11 |
| Equipment and vehicles | Fixed-asset schedule (CPA); FLHSMV title records for vehicles; UCC for financed equipment | DOC / PUB | N15c wind-down sequence |
| Insurance: policies, owner, beneficiary, assignment, renewals | Declarations pages; agent's schedule of insurance; lender's collateral-assignment acknowledgment | DOC | N7, C4, B8 |

## 5. People and relationships

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Key employees, roles, tenure, pay | Payroll API; org chart; employment agreements | API / DOC | N12, B14 |
| Interim manager candidates, their consent | Agent asks (entity tier); consent form | AGENT → DOC | N2, N3, B3, B4 |
| Top customers, contracts, renewal dates, continuity clauses | QuickBooks AR aging (API); customer contracts (DOC); vendor-portal registrations | API / DOC | N9, B10 |
| Vendors with personal credit guaranties | AP aging; credit applications | API / DOC | N10 |
| Referral sources | CRM export; agent asks | API / AGENT | N9 |
| Lender and landlord correspondence (demands, renewal notices, covenant letters) | Email threads, attorney-consented search of the client's mailbox for named counterparties | API (consent) | N10, anchors, scan |
| Advisors: CPA, planner, insurance agent, other counsel | Agent asks (C-8 is collection, not dispositive); engagement letters | AGENT | advisor rotation |

## 6. Litigation and exposure

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Pending suits by or against company or owner | County clerk civil dockets (each relevant county); PACER; FL DOAH for agency cases | PUB | scan, urgent flag |
| Prior bankruptcies | PACER | PUB | C5 |
| Workers' comp claims | FL Division of Workers' Compensation claims lookup; carrier loss runs | PUB / DOC | N7 |
| Code enforcement, OSHA | City/county portals; OSHA establishment search | PUB | scan |

## 7. Owner — collected by the agent (documents and existence only)

| Field | Sources | Access | Unlocks |
|---|---|---|---|
| Existence and date of will, trust, DPOA, surrogate; who drafted | Copies (DOC); agent asks whether they exist and who drafted | DOC / AGENT | C-1 |
| DPOA recognized by the bank | Bank acceptance letter | DOC | N4, C3 |
| Marital status, prior marriages, minor children (as facts, not intentions) | Clerk marriage/dissolution records; agent asks | PUB / AGENT | C1, C8 scoping |
| Residence, homestead, other states | Property appraiser; voter registration (public in FL) | PUB | C6 scoping |

## 8. Owner — attorney only (dispositive)

C-2 through C-7: who holds authority, who takes the interest, who speaks for the family, trust ownership, Medicaid/asset-protection intent, lifetime transfers. The agent prepares a call sheet from sections 1–7 showing what the documents and records already say; the attorney asks and records. Health is never collected in the workspace.

## Pull order (what the agent does before the first question)

1. Conflict check names → Sunbiz, clerk, UCC, PACER on all names (10 minutes, all public)
2. Property appraiser and clerk official records on owner and entity
3. DBPR / AHCA / local licenses
4. Request the document set in one list, grouped by what each unlocks (operating agreement, lease, loan docs, insurance dec pages, signatory card, payroll roster)
5. Offer API links: QuickBooks, payroll, Plaid, Form 8821 (each a separate, read-only consent)
6. Offer mailbox search limited to named counterparties (lender, landlord, carriers), attorney-consented
7. Build the profile; list conflicts and gaps
8. Only then: the agent asks the entity-tier items the sources didn't reach, fewest first

## Consent and retention rules
- Public records: no consent; cite the record and date pulled
- Client documents: engagement letter covers them; unread documents are "received, unread"
- API links: separate written consent each, read-only scopes, revocable; credentials never in the workspace
- Mailbox search: attorney-held consent, counterparty-limited queries, results reviewed by the attorney before entering the file
- Tax transcripts: Form 8821, not 2848, so the firm receives information without becoming the representative
- Everything pulled is sourced in the profile; nothing pulled is shown to the client as advice

## What is deliberately not collected
Health information; the owner's intentions on disposition (C-2–C-7) by any means other than the attorney's call; anything about other family members beyond names and roles; credit reports (FCRA permissible-purpose problem); social media.
