# Owner Exit Practice — client workspace

Florida law practice (Josh, FL/NY attorney) selling a subscription to business owners: continuity planning that runs as a project to the owner's exit, with an AI workspace and a PM layer. This repo holds the design decisions, engagement documents, drafting templates, and a working single-file prototype. Read this file first; the docs are authoritative in the order listed under "Where things are."

## The product in one paragraph
Entity-paid monthly subscription (Phase 2) with an onboarding flat fee (Phase 1). Phase 1 delivers the emergency plan: trigger, interim-manager authority (OA amendment), cash rule, bank access, instruction letter, guaranty schedule, default-branch designation, continuity statement. Phase 2 is a weekly call, nominal in-house counsel work (Schedule A), plan maintenance, and the workspace; everything else is a change order (Schedule B) approved on the call before work starts. The project builds toward the owner's family office (decided 2026-11-03): at the exit event the entity engagement ends and Phase 3, managing that office, begins under its own letter. The family office is the advisor team the Firm coordinates, with a family entity added when the size justifies it; Phase 3's cadence and who the client is are set case by case. The owner's personal estate documents are a separate engagement with 4-1.7 consent, coordinated with the company plan at eight points (C1–C8). Positioning: "the quarterback for owners whose wealth is the business"; family-office coordination function, legal perimeter only.

## Non-negotiable rules (encode these; do not soften)
1. **Draft-not-advice.** Any AI output shown to a client may only: report what the client's documents say (with citation), ask for facts, schedule for Thursday's call, or defer. Never advise, recommend, evaluate an outside answer, predict, or quote a fee. Five permitted client-facing sentence forms are in docs/design/front-door-spec.md.
2. **Scope classification is attorney-only** until confirmed on the call. Schedule A of the engagement letter controls over any AI classification.
3. **Two tiers, isolated.** Entity workspace and owner-personal workspace never cross-read. The entity tier sees C-node *status* only, never personal document contents. No medical information in the workspace at all; capacity questions stop the line and flag the attorney.
4. **Owner-tier dispositive facts (intake C-2–C-7) are asked only by the attorney on the call.** The agent collects documents and existence, never intentions.
5. **Ask-last.** Pull every lawful source (public records, client documents, consented read-only APIs) before asking the client anything; ask only for what no source supplied.
6. **Verification:** an answer is *stated*; a document is *received* only when in hand and readable; unreadable is *received, unread*. Every profile value carries a source id.
7. **Fees:** subscription billed in arrears, earned when billed, no trust; onboarding flat fee earned on delivery; allowances are estimates, never collected; change orders approved in writing before work.
8. Documents remain the client's and valid if the subscription ends.

## Core data model
- **Nodes** N0–N15c (contingency path), R1–R2 (retirement), F1–F3 (family office) and C1–C8 (coordination rungs): docs/design/contingency-sequence-nodes.md. Each has a satisfying document, dependencies, a red rule. Status: green / amber / red / planned / unassessed.
- **Stages** S0–S4 (decided 2026-11-03; names follow Bridges' transition model): where you stand today → short-term disability covered → long-term disability covered → ready to retire → your family office is in place (exit). The S1/S2 boundary is the day the owner's disability benefit starts (N7), 90 days if no policy. Each stage is a two-lane diagram (business above, owner below) with rungs. Gates: S1 when N0,N2,N4,N5,N6 ∈ {green,amber}; S2 when N7,N14,C1,C2,C3,C8; S3 when N15a–c,R1,R2; S4 is reached at the exit event, not by gates; its content is F1–F3, C6, C7. R1 (retirement income) is advisor-owned and R2 (role after stepping back) is personal-engagement work; the entity tier sees status only.
- **Intake items** A1–A6, B1–B15, C-1–C-8: docs/design/intake-assessment.md. Each feeds nodes; 12 are *core* and gate path assignment.
- **Change-order catalog**: id, name, price range, Schedule, nodes it clears. Done ⇒ cleared nodes green.
- **Contract coverage** per node: phase1 / sub / co / personal / advisor / none.
- **Profile**: 27 fields in two sections, each {value, source}; conflicts listed, not resolved.
- **State file**: node statuses, items (board cards), intake statuses, profile, conflicts. Prototype keeps it in localStorage; production needs it shared, attorney-written, per client.

## The loop
import → profile → intake gate → path assigned → scan (findings, attorney-only) → confirm → Open Items card → client approves change order on call (Scoped) → In progress → Done ⇒ node green ⇒ stage advances. Front-door questions carry node context into the brief and the agenda.

## Where things are
- `web/workspace.html` (client), `web/attorney.html` (attorney console), `web/board.html` — served by `server/` at /workspace, /attorney, /board (`npm run dev-db`, optional `node --experimental-strip-types src/dev-demo.ts <ids file>`, then `npm start`). Screenshots: `docs/design/screens/`.
- `core/` — build item 1: catalog (`src/catalog.ts`, generates `db/002_catalog.sql`), pure rules, Postgres schema with RLS (`db/001_init.sql`), tests (`npm test`, needs Postgres on PGURL). Design: `docs/design/architecture.md`.
- `prototype/front-door.html` — single-file working prototype (vanilla JS, SVG diagrams, `claude.use("sample")` for the engine, `claude.use("mcp")` for Google Drive import, pdf.js from cdnjs, in-browser .docx unzip). Published as a claude.ai artifact; the prompts in it are the current engine prompts and should move server-side.
- `docs/design/front-door-spec.md` — intake flow, permitted outputs, hard constraints
- `docs/design/intake-agent-spec.md` — the agent: tier split, sequence, stop rules, verification
- `docs/design/collection-map.md` — every profile field → sources, access route, consent, pull order
- `docs/design/contingency-sequence-nodes.md` — nodes, rungs, critical path, review cadence, calculator hooks
- `docs/design/intake-assessment.md` — the 29 questions and what each feeds
- `docs/design/pro-forma.md` — locked prices, capacity, year 1–2 model, positioning
- `docs/engagement/` — entity subscription letter (v3) and owner personal letter (v1), both with Schedules
- `docs/templates/` — OA continuity amendment (ch. 605, § 605.0602 confirmed 2026-11-01) and DPOA business-powers rider (ch. 709, § 709.2202 confirmed 2026-11-01). Other cited sections are listed in each file as "walk to before first execution."

## Build order (from the decisions)
1. Shared state file + per-client workspace with two tiers and attorney/client roles
2. Engine prompts server-side; classifier gate on every client-facing turn — built (core/db/004, server/src/engine/); live eval 12/12 on 2026-11-02 via GitHub Actions + identity federation
3. Intake agent (entity tier) with conflict check first and ask-last pulls: Sunbiz, FL UCC, county clerk, property appraiser, DBPR/AHCA, PACER (scrape or checklist); file drop with server OCR; Google Drive; then Plaid + payroll API — first increment built (conflict check, planner, agent turns, file drop without OCR, records checklist); see architecture.md
4. Scan on schedule (after each call's state update; anchor cadence), new findings only
5. Client-facing board with change-order signature step; budget page — built (core/db/003, server/, web/board.html)
6. Onboarding Gantt: custom (decided 2026-11-02; monday.com not used)
7. Owner-tier call sheet generator; two-track journey page with rungs

## Open decisions
- Agent never drafts or fills in documents; owner-tier documents: existence, date, drafter only (decided 2026-11-02).
- Anthropic API on zero data retention (decided 2026-11-02): no Files API, Batches, Managed Agents, Skills, MCP connector or code execution; engine on claude-opus-5-5. See docs/design/architecture.md.
- Phase 3 (family office management): engagement letter outline in docs/engagement/family-office-engagement-outline.md; SEC family office rule read 2026-11-03 (the office is always the client's, never the Firm's); Rule 4-5.4 read and applied 2026-11-03 (no fee sharing or joint practice with advisors; payer may not direct judgment); Rule 4-5.7 read 2026-11-03 (all Firm work is legal services; non-client workspace users and meeting attendees get a written notice first). Rule 4-1.8 read 2026-11-03 (third-party payment consent; no fiduciary role by default). Rule 4-4.3 read 2026-11-03 (notice to non-clients names the client, warns of differing interests, suggests own counsel; applied to the interim manager consent). Rule 4-7.13 read 2026-11-03: copy rules in docs/design/marketing-copy.md. Rule 4-7.14 read 2026-11-03 (family-office clarifier with the term; no specialist claims; full fee disclosure and 90-day honor in ads). Rule 4-7.11 read 2026-11-03 (front door, referral-source materials and change-order offers count as advertising). Not yet read: 4-7.20 (exemptions) (floridabar.org blocks automated access; paste the text). F1–F3 coverage set to personal before the exit; confirm.
- LEAP + WealthCounsel integration: confirm API terms with the vendors (docs/design/integrations.md).
- Non-client front door: conflict names + one question only. (Current: yes.)
- First-release API links: Plaid + payroll first; QuickBooks and mailbox search second.
- C-node checks are subscription; C-node drafting is change order; C6 is personal-engagement only. Confirm.

## Conventions
- Florida statutes cited by section; confirm against the current Online Sunshine text before relying. Statutes already confirmed: § 605.0602, § 709.2202 (2026-11-01), § 605.0405, § 605.0102(17), § 605.0406, § 605.04091, § 605.04092 (2026-11-03).
- Vocabulary on client surfaces: scope, budget, change order, inspection, as-built, maintenance. Avoid: retainer, hours, matter, billing.
- Never put hours anywhere a client can see them.
