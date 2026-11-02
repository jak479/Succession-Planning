# Architecture (v1) — production build

Decided 2026-11-02 (proposal; Josh to confirm hosting). Preserves the data model in CLAUDE.md and enforces the non-negotiable rules in the database, so no surface (UI, agent, script) can bypass them.

## Stack
- **State file: Postgres with row-level security.** One `client`, two `workspace` rows (entity, owner). Every request runs in one person's session in one workspace; that is the tier-isolation primitive.
- **Server: Node / TypeScript.** Holds the engine prompts (moved from the prototype), the classifier gate, the intake agent, and scheduled scans. Model calls server-side only.
- **Web: TypeScript single-page app.** Ports the prototype's SVG path diagrams, board and budget. Client and attorney surfaces are separated by role, not by a view toggle.
- **Auth:** any OIDC provider; a login maps to `ws.person` (role: attorney / client / agent).
- **Hosting:** open. Needs a managed Postgres and a host whose terms satisfy Opinion 24-1 vetting (confidentiality, no training on data).

## Decisions 2026-11-02
- **Custom board**, not monday.com. Built (item 5, ahead of 2–4).
- **The agent never drafts or fills in a document.** Drafting is the attorney's, in WealthCounsel. In the owner tier the agent records a document's existence, date and drafter only. The fields for POA agent / PR / trustee and long-term care / asset protection are recorded by the attorney from the call (enforced: `ws.profile_field_def.agent_may`).
- **Zero data retention (ZDR)** on the Anthropic API organization. Source: platform.claude.com/docs/en/manage-claude/api-and-data-retention (read 2026-11-02).
  - Arranged through Anthropic sales, per organization; not a Console switch. Each new organization needs its own enablement.
  - ZDR-eligible and planned for use: Messages API, token counting, PDF input in the request, citations, prompt caching, adaptive thinking, structured outputs (qualified), web search/fetch.
  - Not ZDR-eligible; the API does not block them, so the server must: Files API, Message Batches, Managed Agents (transcripts persist), Agent Skills, MCP connector, code execution / programmatic tool calling. Documents go inline in each request, never uploaded to Anthropic.
  - Not available under ZDR: Fable 5.1 / Mythos (30-day retention required). Engine runs on `claude-opus-5-5`.
  - Carve-out: Anthropic may retain flagged content up to 2 years, and data required by law. Disclose this in the engagement letter's AI consent clause (§ 6(c)).
  - No browser calls to the API (CORS unsupported under ZDR); all calls from the server, which the design already requires.
- **Front-door quotes are limited to the question asked** (no neighbouring provisions, no pointing out gaps); enforced by the prompt; the classifier names any off-question quote and the server removes it (the rest of the answer stays). Entity-tier fact questions about plans (e.g., "does the Company plan to vacate?") are acceptable as is.
- **Client surfaces label every assistant message as automated, not from a lawyer** (Fla. Ethics Op. 24-1 on chatbots identifying themselves; docs/sources/fl-bar-ethics-op-24-1.pdf). Required before any client uses the front door.
- **Integrate with LEAP and WealthCounsel**: docs/design/integrations.md (design only; vendor terms not yet confirmed).

## Repo layout
```
core/        catalog, pure rules, migrations, store, tests   (items 1, 5 schema)
server/      board API, front door engine + gate (built); intake agent, scans (items 3–4)
web/         board.html (built); other surfaces (item 7)
prototype/   frozen reference; not deployed
docs/        the spec
```

## Item 1: what is enforced where (core/db/001_init.sql)
| Rule | Enforcement |
|---|---|
| 3 Tiers isolated | RLS: a row is visible only in the session's workspace. The attorney is also one-tier-per-session. Sources, profile values and conflicts must cite a source in the same workspace (composite FK). Node status lives in the entity tier only; C-node contents (`coordination_detail`) in the owner tier only. |
| 2 / attorney-written state | Only the attorney writes node status, coordination contents, and board cards. |
| 4 C-2–C-7 | Only the attorney may record them, and only from a `CALL` source. Only the attorney may create `CALL` sources. |
| 6 Verification | Answers are `stated`; documents are `received` only with a readable `DOC` source, else `received_unread`. Client uploads enter unread; only the agent (after OCR) or the attorney marks them readable. Every profile value has a non-null source; the profile view shows `described` for client descriptions. |
| 7 Change orders | A card cannot leave Identified without a price, a written-approval reference and an approval time. No hours column exists. |
| Loop | Done ⇒ cleared nodes green (trigger); Done is final. Every state change is written to an append-only audit log. |

Pure computations (core/src/rules.ts): stage reached, red propagation, core-item gate, change-order preview. The catalog (core/src/catalog.ts) generates the DB seed (`npm run seed`).

## Changes from the prototype (confirm)
1. Stage gates are **cumulative**: S2 requires S1's gate. The prototype took the highest gate met, so S2 could show without S1.
2. N2 depends on C2 and C3 (from "a red C2 or C3 makes N2 red").
3. Intake status adds `stated` and `received_unread`; the prototype had only missing / requested / received.
4. Scoped requires a written-approval reference, not only a typed price.

## Board (item 5): db/003_board_profile.sql, server/src/main.ts, web/board.html
- Cards start in Identified. The attorney proposes a change order: a price above zero plus a written scope.
- Only a member flagged `signer` in the entity tier can approve, by typed name and an authority checkbox. The approval row stores signer, price, scope and a SHA-256 digest, and cannot be changed.
- A card reaches Scoped only if the database holds a matching approval row, or it is Schedule A included work at $0. You cannot move it there by hand.
- Price and scope are frozen after approval. Withdrawing a card before work starts clears the approval.
- Attorney findings live in `board_note`, which clients cannot read.
- Budget view shows the onboarding fee, approved change orders, completed work and allowances. Allowances are labelled estimates. No hours anywhere.
- Identity tables (client, workspace, person, membership) are also row-limited, so no session can list other clients.
- Sign-in is a development stub (`Authorization: Dev <id>`). Replace it with OIDC before any client uses it.

## Front door (item 2): core/db/004_frontdoor.sql, server/src/engine/
Flow for each client question:
1. **Stop rules first, before anything is stored.** A health word (fixed list) stops the line with no model call at all. Otherwise a screen call sorts the question into health/capacity, someone answering for the owner, court/regulator, demand, safety, or none.
   - Health or capacity: the question text is never stored.
   - Any stop: the reply is "This is marked urgent; Josh will contact you directly." and nothing else.
2. **Brief.** The engine reads only the session's workspace documents and node statuses and returns structured fields. The attorney-only fields (suggested scope, scope reason, attorney note, gaps, anchors) go to `ws.brief`, which only the attorney can read.
3. **Reply built from fixed frames.** The server writes the client reply from the five permitted sentence forms. The model fills only the slots (what a document says, fact questions, check-this cells).
4. **Gate, fail-closed.** Every slot is checked for advice words, fee words and health words; every citation must name a document in the file; at most five fact questions. Then a classifier call reads the whole reply for advice, recommendation, evaluation of an outside answer, prediction, fee or time estimate, or medical information. Any failure, and any engine or classifier error, replaces the reply with "This is on Thursday's agenda, position N." The brief records every check.
5. **Scope** shows to the client only after the attorney confirms it (`ws.confirm_scope`).

Zero data retention is enforced by construction: `engine/model.ts` is the only file that imports the SDK and exposes only the Messages API with inline documents; `test/zdr.test.ts` fails if any ineligible API surface appears. Model: `claude-opus-5-5`, effort low for screen and classifier, medium for the brief. Refusal fallbacks are not enabled: the default fallback can route to another model, and its retention terms would need checking first.

Tests: `server/test/` (scripted model, live Postgres). Live behavior: `npm run eval` runs 12 cases against Claude; on GitHub, Actions → front-door-eval → Run workflow. Authentication is Workload Identity Federation (Console rule `gha-succession-main`, service account `front-door-eval-ci`, Default workspace); no API key exists. GitHub's subject claim uses the immutable form `repo:jak479@278461393/Succession-Planning@1443078919:ref:refs/heads/main`.

Live eval history: first run found a health fact question reaching the client ("Is this question prompted by a current health event…"); fixed by a prompt rule plus a gate check. Check-this rows now use four fixed relation sentences written by the server. 12/12 on 2026-11-02 (run 41532654191). The classifier still occasionally holds back a plain restatement as "advice" (e.g., "the deadline has passed"); the client then gets only the agenda line.

Known gaps: anchor dates are not yet stored, so the brief sees none; "repeated advice request after one deferral" (stop rule) is not yet detected; the agenda position counts the last 7 days, not Thursday's actual agenda.

## Intake agent (item 3, first increment): core/db/005_intake.sql, core/src/intake.ts, server/src/engine/intake.ts
- **Conflict check first.** The agent or the attorney submits the names (`ws.request_conflict_check`).
  - Hits are computed against every other client in the firm-wide name index (`ws.firm_party`): exact or trigram-similar after removing LLC/Inc and punctuation.
  - Only the attorney sees hits; clients see pending / cleared / declined.
  - Only the attorney decides (`ws.decide_conflict`). Clearing adds the client's names to the index.
  - Until cleared, the database refuses intake answers, intake conversation turns, uploads and front-door questions from anyone but the attorney.
- **Ask-last planner** (`core/src/intake.ts`):
  - Items already stated, received or received-unread are never asked again.
  - Documents are requested as one list; questions go one at a time.
  - Core items first, then whatever feeds the earliest stage gate.
  - Owner-tier and attorney-only items (C-2 to C-7) never appear.
  - Question wording is fixed text (`INTAKE_Q`), never written by the model.
- **Agent turn:**
  - Stop-rule screen first; health text is never stored.
  - The model maps the message to open items and writes a one-sentence restatement. The restatement is the only model-written client text, and it passes the lexical checks and the classifier or is not shown.
  - Complete answers are recorded as `stated`, sourced to the client's own words.
  - Status line and next question are fixed text.
  - An advice request is deferred; asked again after a deferral, the line stops and the attorney is flagged.
  - Deferred and flagged turns are the attorney's intake agenda (`GET /api/intake/agenda`).
- **File drop:**
  - Uploads enter unread.
  - The server extracts text from PDF (pdf.js), DOCX and text.
  - "Received" only with at least 200 letters of readable text; otherwise "received, unread" and on the attorney's queue (`GET /api/intake/queue`).
  - Scans and photos (PDF without a text layer, PNG, JPEG, GIF, WebP) are read by Claude (decided 2026-11-02). The file goes inline in the request (ZDR-eligible), never to the Files API. The transcript is labelled "transcribed from scan by AI; check against the original." A transcript with 5% or more illegible words, or one too long to finish, stays received, unread.
- **Public records, checklist mode.** Each source (Sunbiz, UCC, clerk, appraiser, DBPR, AHCA, PACER) is listed with its link. A pull done by hand is recorded with `POST /api/intake/records` as a cited PUB source. Automated pulls come site by site, after each site's terms are read.

Not yet in item 3: automated record pulls; Google Drive import; Plaid and payroll links; the profile builder (sources → 27 fields, conflicts); the three-way check (description vs document vs record); live eval cases for the intake agent; a client intake page.

## Not yet built in item 1
Scan findings, front-door briefs, and scope classification (attorney-only until confirmed) are item 2–4 tables.
