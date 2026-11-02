# Front Door — Build Spec (v1)

Client-facing intake layer of the AI workspace. Every client question enters here. Output is a brief on the weekly-call agenda, never an answer.

## Governing rule
Draft-not-advice. The front door answers three questions only: *what do your documents say*, *what facts does Josh need*, *when will this be addressed*. It never answers "what should I do" and never adjudicates whether an outside answer is right.

## Inputs
- Client question (text, voice-to-text, or uploaded document)
- **Check-this lane:** pasted output from an outside AI tool, with the client's original prompt if available
- Client file: plan, operating agreement, leases, key contracts, state file, open-items list, anchor dates
- Engagement scope list (in-scope / quotable task types)
- Tier flag: entity workspace vs. owner-personal workspace (never cross-read)

## Flow
1. **Classify.** Tag the question: topic, entity-or-personal tier, in-scope / quotable (suggestive only — attorney confirms on call), emergency flag.
2. **Clarify.** Ask the fact questions the attorney would ask for that topic. Max five; stop when the brief is complete.
3. **Locate.** Pull the governing clause(s) from the client's own documents. Cite by document and section. If nothing governs, say so.
4. **Check-this (if lane used).** Compare the outside answer to the client's documents and to Florida law as recorded in the firm's clause library. Produce a three-column table: outside answer / what your documents say / difference. No verdict column.
5. **Brief.** One page: question, facts, governing clause, check-this table if any, suggested classification, recommended agenda position.
6. **Schedule.** Place on next weekly call. Emergency flag → immediate notification to attorney; client told a human will respond, no AI response to the substance.
7. **Log.** Topic, lane, classification, anchor-date proximity. Feeds pattern capture.

## Client-visible responses (only these)
- "Here's what your [document] says about this: …"
- "To prepare this for Thursday, I need: …"
- "This is on Thursday's agenda, position N."
- "This is marked urgent; Josh will contact you directly."
- Check-this: the table, plus "Josh will review this on Thursday."

## Hard constraints
- No legal conclusion, recommendation, or evaluation of the outside answer
- No fee quoted; classification shown to attorney only until confirmed
- Entity and personal tiers isolated; capacity/medical tier not readable
- Every output stored with the brief; nothing sent to client without attorney release except the five response types above
- Opinion 24-1: consent clause in engagement letter; provider vetting on file; AI cost in overhead

## Pattern capture (back office)
Weekly report: questions by topic, outside-AI topics by frequency, questions with no governing clause (candidate standard clauses), questions near an anchor date. Three occurrences of a topic → flag for clause library or roadmap-page section.

## Non-client mode (lead product)
Same flow, no client file. Step 3 reads the firm's generic Florida clause library instead. Output: check-this table + offer of one call. Converts to onboarding on acceptance.

## Build order
Steps 1–3 and 5–6 first (basic intake). Check-this lane and non-client mode in the same release. Pattern capture report after the first five clients.
