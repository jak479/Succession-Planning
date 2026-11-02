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
- **Integrate with LEAP and WealthCounsel**: docs/design/integrations.md (design only; vendor terms not yet confirmed).

## Repo layout
```
core/        catalog, pure rules, migrations, store, tests   (items 1, 5 schema)
server/      board API (built); engine prompts, classifier gate, agent, scans (items 2–4)
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

## Not yet built in item 1
Scan findings, front-door briefs, and scope classification (attorney-only until confirmed) are item 2–4 tables.
