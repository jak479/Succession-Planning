# Intake Agent — Build Spec (v1)

Decided 2026-11-02. The intake agent runs entity-tier intake with the client; owner-tier intake is conducted by the attorney on the call, and the agent prepares it. Supersedes the "intake assistant" lines of the Front Door spec.

## Scope split

| Tier | Agent | Attorney |
|---|---|---|
| Entity (A1–A6, B1–B15) | Asks, collects, classifies, verifies documents | Confirms node facts on the call |
| Owner — documents (C-1, C-8) | Collects the documents and advisor names; does not discuss contents | Reviews |
| Owner — dispositive answers (C-2 through C-7) | Never asks. Prepares a one-page call sheet: what the documents show, what the attorney needs to ask | Asks on the call; records the answers |

## Collection principle
Ask-last. The agent pulls every lawful source first (see collection-map.md: public records, client documents, consented API links, counterparty-limited mailbox search), builds the profile, lists conflicts and gaps, and only then asks the client for what no source supplied. Owner-tier dispositive facts are excluded from this principle: they come from the attorney's call alone.

## Sequence
1. **Conflict check first.** Names of owner, entity, co-owners, spouse, named successor. No substantive question until cleared. (Rule 4-1.18 prospective-client duty attaches to what follows.)
2. **Prospective-client notice** (non-client mode) shown and acknowledged: no engagement exists; information is held in confidence; the firm may decline.
3. **Import before asking.** Profile builder runs on whatever is already in hand; items the imports satisfy are skipped.
4. **Core items first** (the 12 required); then the rest by what unlocks the earliest stage.
5. **Each session ends** with: items received, items still open, what each unlocks, the next document to send.

## Permitted agent output (client-facing)
- A question from the intake list, or a follow-up that narrows it ("Gusto — who else is an admin?")
- A restatement for confirmation ("I have: Seacoast, you are the only signer. Correct?")
- A status line ("Received. That unlocks N6." / "Noted as described; the signatory card itself is still needed.")
- A deferral ("That's a Thursday question; I've put it on the agenda.")
- The session summary
No other form. Every client-facing turn passes a classifier for advice, recommendation, evaluation, or prediction before display; a failed turn is replaced with the deferral.

## Verification rules
- An **answer** is recorded as *stated*; a **document** is recorded as *received* only when the file is in hand and readable.
- A document the agent cannot read (scan without OCR, password, truncated) is *received, unread* and goes to the attorney's queue.
- Profile fields carry a source id; a field resting only on a client description is flagged `described` in the profile view.
- Three-way check at close of intake: client description vs. document vs. public record, with conflicts listed.

## Stop rules (agent halts the line and flags the attorney)
- Any indication a third party is answering for the owner
- Confusion, contradiction within a session, or a question about the owner's own capacity or health
- A court deadline, a regulator, a demand letter, a safety issue
- A request for advice repeated after one deferral

## Documents the agent must read
Operating agreement / bylaws (locate: management, transfer restrictions, dissociation, amendment); lease (term, renewal notice, guaranty, assignment); loan documents (guaranty, covenants, default triggers); insurance schedule (owner, beneficiary, assignment, renewal); bank confirmations; payroll provider roster; license certificates. Each clause located is cited by page and section in the state file.

## Infrastructure
- Server-side OCR and clause locator; browser extraction is prototype-only
- Imports: file drop; Google Drive (viewer's connector); email threads with lender/landlord (attorney's consent); Gusto and Plaid for N5/N6 facts (client's consent, read-only)
- Public records: Sunbiz, FL UCC registry, county clerk, property appraiser, DBPR/AHCA, PACER — pulled server-side where scrapable, otherwise a checklist with links
- Model tiers: quick for classification and restatement; default for document reading and profile build
- Transcripts retained in the client file; attorney reviews each session's summary before the call

## Open questions for the attorney
- Whether C-1 contents (who the will names) may be *read* by the agent for the call sheet, or only the existence of the document recorded. Current rule: existence only, until the personal engagement letter is signed.
- Whether the non-client front door collects anything beyond the conflict-check names and the one question. Current rule: nothing more.
