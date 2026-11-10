# Drafting tool (v0, design)

Decided 2026-11-08: the Firm builds its own drafting tool and drops WealthCounsel entirely. This reverses the 2026-11-02 line "Drafting is the attorney's, in WealthCounsel." It does **not** reverse "the agent never drafts": the drafting tool is an attorney-only surface; the client-facing agent and the intake agent still never draft or fill in a document.

First release: the OA continuity amendment and the DPOA business-powers rider (`docs/templates/`).

## 1. Modes (chosen per document, switchable at any time)
| Mode | Who writes text | What Claude does | Gate |
|---|---|---|---|
| Manual | Attorney | Nothing. No API call. | — |
| AI-assisted drafting | Claude proposes; attorney accepts or rejects each change | On the attorney's instruction, proposes clause text as a tracked suggestion with its reason and the profile/source ids it used | Nothing proposed enters the document until the attorney accepts it |
| AI review | Nobody | Reports findings: value ≠ profile, unfilled bracket, missing schedule, cross-reference broken, statute cited but not confirmed (Conventions list), execution-mode conflict (§ 4) | Findings are attorney-only, like scan findings |

All three modes run on the attorney console only. Under ZDR (architecture.md): Messages API, document inline in the request, `claude-opus-5-5`; no Files API, Batches, Skills, MCP connector or code execution.

## 2. Templates
A template is the current Markdown file plus a front-matter schema:
- **Variables** bound to profile fields (`[Company]` → `entity.legal_name`). Assembly fills each and keeps the profile value's source id. A field with a listed conflict, or no value, stays bracketed and highlighted; assembly never chooses.
- **Options**: each bracketed alternative (`[sole member / managing member / manager]`, `[If member-managed: …]`) becomes a named toggle the attorney sets.
- **Drafter notes** (`[Drafter: …]`, "Drafting notes for the Firm") are kept in the working copy and stripped from every export.
- **Tier.** OA amendment: entity tier. DPOA rider: owner-personal tier (rule 3). The rider is drafted only inside the owner-personal workspace, and the entity tier sees only its C-node status.

## 2a. Client choices (decided 2026-11-08)
Operational choices are the client's, and the tool puts them to the client before any value is chosen. Each such field in `core/src/templates.ts` carries `client: { ask, node }`.
- **No silent defaults.** A bracketed value in a template (`[14]`, `[12]`, `[quarterly]`) is never filled in on its own. It stays bracketed and is shown to the attorney only as the template's text.
- **Decided means recorded.** A client choice counts as decided only when its value cites a call record (`CALL`) or, in the entity tier, a document the client signed (`DOC`). In the owner tier only `CALL` counts (rule 4). A value from any other source (the client's own description, an agent pull, a profile value) is shown but stays *unconfirmed*.
- **Highlighted.** `assemble(..., { highlight: true })` marks every client-choice spot, open or filled, for the editor. Exports never carry the marks.
- **Agenda.** `callQuestions` turns open and unconfirmed choices into Thursday-agenda questions (`draft:<template>:<field>`), filed in the template's own tier. Owner-tier questions never enter the entity agenda (rule 3). Each question is neutral: it states the choice, does not recommend, and does not repeat the template's value.
- **Gate.** `blockers` lists every undecided choice and unfilled blank. A draft cannot be sent for signature until the list is empty.
- **Confirmed 2026-11-08:** in the entity tier a document the client signed decides a choice, as does the call. The Sunbiz filing deadline is the attorney's drafting choice. The tax-distribution formula is an advisor input: the accountant supplies it (`advisor: "accountant"`), it is not put to the client, and `blockers` lists it as "Get from the accountant" until filled.
- **Scope of "client choice".** OA: trigger terms, Interim Manager and alternate, pay, removal and resignation, reports, Branch Decision holder and default branch, Family Liaison, cash rule (except the tax formula) and Schedule 2 terms. Rider: Business Agent and alternate, Part C powers, gifts, buyer participation, accounting. Facts (names, dates, entity form) and drafting choices (which document controls, counsel named, signature capacity) are not client choices.

## 3. Versions and redlines
Every save is an immutable version (author, time, mode, digest). Redline = any two versions compared:
- **.docx with native tracked changes** (`w:ins` / `w:del`, author = the version's author), so opposing counsel or a bank can accept or reject in Word.
- **PDF compare** (underline/strike) for reading.
- Import of a counterparty's returned .docx: its tracked changes become suggestions in the console.

## 4. Execution: e-signature and online notarization (statutes read 2026-11-08, flsenate.gov 2026 text)
**E-signature.** § 668.50(7)(d): where law requires a signature, an electronic signature satisfies it. § 668.50(3)(b) excludes wills, codicils and testamentary trusts, and most of the UCC; neither first-release document is excluded. The OA amendment needs signatures only, so e-signature completes it.

**Notarization.** § 668.50(11)(a): an electronic notarization is satisfied by the notary's electronic signature plus required information logically associated with the record. Online (remote) notarization is part II of ch. 117:
- The online notary selects the RON service provider; no one may require a particular one (§ 117.265(5)(a)). **So the tool cannot be the notarization platform.** Its job is to hand the notary a RON-ready package: a flattened PDF with tagged signature, initial and witness fields, and a notarial certificate that says "online notary" (§ 117.265(7)).
- Identity proofing, recording and secure audio-video belong to the notary and the provider (§ 117.265(2), (4), (6)).

**DPOA rider.** § 709.2105(2): two subscribing witnesses and a notarial acknowledgment. Remote witnessing is allowed under § 117.285, with two limits the tool enforces:
1. **Banking powers trigger the vulnerable-adult procedure.** Part B(c) of the rider grants § 709.2208(1) banking authority. Under § 117.285(5), a POA "authorizing any of the transactions enumerated in s. 709.2208" signed with fewer than two witnesses physically present requires the provider's screening questions, a written notice, and the notary's five spoken questions. A "yes" to any screening question means the witnesses must be physically present (§ 117.285(5)(b)), and remote witnessing is ineffective for a vulnerable adult (§ 117.285(5)(g)). The record must show that witnesses appeared remotely (§ 117.285(5)(i)). Under § 117.285(5)(k), none of this applies if two witnesses are physically present.
2. **Part C cannot be remotely witnessed.** § 117.285(7) says remote witnessing satisfies presence requirements "except as set forth in s. 709.2202"; the template applies § 709.2202(6) (confirmed 2026-11-01). If Part C has any initialed power, the tool permits only the *two witnesses physically present* execution mode.

**Rule 3 consequence.** The § 117.285(5)(a) screening questions concern drugs, physical or mental conditions, and daily care. Those answers are medical information. They stay with the RON provider and are **never** stored in the workspace. The tool records only the execution mode and the date. If the attorney learns of a "yes" answer, the capacity rule applies: stop the line and flag the attorney.

**Execution modes the tool offers**
| Document | In person (wet or e-sign) | E-sign only | RON, witnesses physically present | RON, remote witnesses |
|---|---|---|---|---|
| OA amendment | yes | yes | not required | not required |
| DPOA rider without Part C powers | yes | no (§ 709.2105) | yes | yes; package includes § 117.285(5) notice and question script |
| DPOA rider with Part C powers | yes | no | yes | **blocked** |

## 5. Data model additions (core/db)
`ws.doc_template` (id, version, tier, schema), `ws.doc_draft` (workspace, template, mode, status draft / review / approved / sent / executed), `ws.doc_version` (immutable, digest), `ws.doc_suggestion` (AI or counterparty, accepted / rejected, by whom), `ws.doc_execution` (mode, provider name, executed-copy `DOC` source). The executed copy enters the right tier as a `DOC` source and turns the node green through the existing rules. RLS: attorney-only for every table; the client sees only an approved, sent document.

## 6. Build sequence
1. Template schema + assembler for the two templates (deterministic; tests against the demo profile). **Built 2026-11-08:** `core/src/drafting.ts` (assembler, tier check, execution-mode gate), `core/src/templates.ts` (one binding per bracket, in order), `core/test/drafting.test.ts`. The wording stays in `docs/templates/`; if a template is edited, the tests fail until its bindings match. Confirmed by the attorney 2026-11-08: OA `[If the Principal dies: …]` is a drafter note (never exported). Template edits approved the same day: OA 1(b)(2) attending-physician clause now carries its own commas inside the bracket; OA .4(c) single-member clause is closed as `[If single-member: …]`, so it is included only when the company has one member and the multi-member sentence takes its place otherwise. In the rider, ", and (ii)" was moved inside the buy-sell bracket so that dropping the clause leaves no orphan "(ii)"; the text is unchanged when the clause is kept.
2. Console editor with versions; .docx export, clean and redline. **Built 2026-11-10:**
   - **Console.** Attorney console, Documents tab (`web/attorney.html`; screenshot `docs/design/screens/attorney-7-documents.png`):
     - Open a draft from a template of the workspace's tier.
     - Fill fields grouped as client choices, facts, drafting and advisor inputs. Each value cites a source. "Use this call as source" creates or reuses a `CALL-<date>` source, which is what decides a client choice.
     - Live preview with highlights: red for put to the client, amber for confirm, green for decided. The blockers list and the allowed signing modes show beside it.
     - Save as a new version, or edit the text by hand. A hand edit keeps the base version's facts, blockers and questions.
     - Send, when nothing is open; supersede.
     - Word download, clean or as a redline between versions; the client's export package.
   - **Routes.** `server/src/docs-api.ts`. A fact's source kind is read from the database, never from the request.
   - **Word writer.** `server/src/docx.ts`: native tracked changes (`w:ins`/`w:del`), word-level within a changed paragraph, with punctuation as separate tokens. Redlines open with Track Changes on. Checked in LibreOffice: both files open and the redline shows the changes.
   - **Agenda.** Open choices reach the Thursday agenda through `ws.draft_questions()` (`core/db/016`) as one item per draft ("Your choices for the …: N to decide", 15 minutes at most). The client and attorney see the same item; the draft text stays the attorney's.
   - **Tests:** `server/test/docs.test.ts`.
3. AI review mode, then AI-assisted drafting mode (server-side prompts; eval set like the classifier's). **Built 2026-11-10:**
   - **Files.** `server/src/engine/drafting.ts` (prompts `drafting-2026-11-10.1`), `core/src/statutes.ts`, `core/db/017_ai_drafting.sql`; console panel "Claude: review and suggested edits"; tests `server/test/drafting-ai.test.ts`, `core/test/statutes.test.ts`; live eval `server/eval/drafting.ts` (`npm run eval:drafting`, added to the front-door-eval workflow).
   - **What the model sees.** The version's text, the template's drafter notes, the recorded facts with each source's kind, and each client choice's status. Nothing else: no other documents, no other tier.
   - **Review.** Findings in eight categories. Each must quote the draft verbatim or the server drops it. Uncited-but-unconfirmed statutes are found by code against `core/src/statutes.ts`, never by the model. A review writes nothing into the draft.
   - **Suggested edits.** Each replaces one exact passage. The server drops any edit whose passage is not in the draft exactly once, or which would remove the bracket of a client choice not yet decided. Accepting saves a new version (mode `ai_draft`) that keeps the base version's facts, blockers and call questions. A passage that has changed since the suggestion was made is marked stale and not applied. Decisions are final and audited.
   - **Owner tier.** Off unless `OWNER_TIER_AI=on` (open decision).
   - **Live eval 2026-11-10, run 18 on `main`: 10/10 drafting checks passed.** Review found all three planted defects (misspelled name, reference to a nonexistent 12.11, a period contradicting the recorded choice) with no dropped quotes. Suggested edits carried out the drafting instruction and declined, with reasons, to fill an open choice, invent an amount, add an uncited statute, or advise on the default branch. The front-door 12/12, scan 1/1 and profile evals also passed in the same run. Run 17, on the work branch, failed at sign-in: the federation rule accepts `main` only.
   - **Watch item.** In declining, the model stated a proposition about ch. 605 information rights ("govern members and managers, not a non-member Family Liaison") that has not been read at the source (§ 605.0410). Attorney-only, but treat any statement of law in model output as unverified.
   - **Model and settings.** `claude-opus-5-5` through the existing ZDR wrapper, effort high. Server-side refusal fallbacks are not enabled: that is a beta whose ZDR eligibility is unconfirmed.
4. E-signature with UETA audit trail, or a vendor (open question 1).
5. RON package export and execution-mode gate (§ 4 table).

## 7. Decisions 2026-11-08
1. E-signature: in-house (signer authentication, audit trail, tamper-evident PDF).
2. RON provider: open; the attorney is asking the online notary which one they use. The package format follows that answer.
3. Wills and trusts: second release. Read ch. 732 (electronic wills) before building any will template.

## 8. Document management (decided 2026-11-08; built)
In-house, inside the workspace, one index per workspace, so the two tiers stay separate (rule 3). LEAP gets copies of executed documents later, once its API terms are confirmed. Schema `core/db/011_documents.sql`; functions `core/src/documents.ts`; tests `core/test/documents.test.ts`.
- **Four kinds in one index:** drafts from the assembler; executed originals; client uploads (the existing file drop joins the index automatically, with no second copy); counterparty papers.
- **Versions are immutable.** A draft version records its text, how it was made (manual / AI-assisted drafting / AI review / import), the facts with their sources, and the assembler's blockers. Fact sources must exist in the same workspace, so an owner-tier source can never be cited in an entity draft. Nothing is deleted; documents are superseded. Every write goes to the audit log.
- **Send gate.** A version can be marked sent only if its blockers are empty: every client choice decided, every blank filled. Once sent, the client sees that version and no later unsent ones.
- **Execution.** An executed original is filed against a sent version of its draft. The execution mode must be one `executionModes` allows for that version's facts, so a rider with Part C cannot be filed as remotely witnessed. A RON execution must name the provider and where the notary's journal can be produced (§ 709.2120(4)(d)). Filing marks the draft executed and creates a `DOC` source the profile and nodes can cite. Node status stays the attorney's.
- **Who sees what.** Attorney: everything in the workspace. Agent: executed originals and uploads. It reads them and never drafts. Client: executed originals, uploads, and sent drafts. Counterparty papers and unsent drafts are the attorney's alone.
- **Export package (rule 8).** `exportPackage` returns every executed original plus an `INDEX.md` (file, date executed, how signed, notary record, SHA-256). The client can run it; the server zips it.
- **Auto-green (decided 2026-11-08; `core/db/012_auto_green_retention.sql`).** Filing an executed original records who signed it, and turns green each node that the document alone satisfies, given those signatures. OA amendment: N0 (Principal and members), N2 (plus the Interim Manager's consent), N3 (plus the Alternate's consent; stricter than the red rule). Not automatic: N4, N5, N14, N15a–c, which need facts or papers beyond this document. The rider is owner-tier; node status is entity-only (rule 3), so nodes the rider affects stay manual. The node's fact names the document, date and signers, and its source is the executed copy.
- **Retention (decided 2026-11-08; revised 2026-11-10: keep indefinitely; `core/db/014_keep_unless_destroy.sql`).** Digital files are kept indefinitely and purged only when the client directs destruction. Basis, in order: the Florida Bar FAQ (pasted 2026-11-09) and Opinion 81-8, both permitting disposal but never requiring it; Opinion 06-1 (read 2026-11-10 through a fetch tool's summary), allowing electronic-only storage if files stay "readily reproducible and protected from inadvertent modification, degradation or destruction"; § 501.171(2), (8) (read 2026-11-10), requiring security for as long as personal information is held and setting the disposal method only "when the records are no longer to be retained"; and § 95.11(5)(b), under which there is no repose for legal malpractice.
  - **The rule.** No fixed period, except three records kept 6 years: trust accounting records (Rule 5-1.2(f)), contingent-fee contracts and closing statements (Rule 4-1.5(f)(5)), and the insured client's statement of rights (Rule 4-1.8(j)). The workspace holds none of these (no trust, no contingent fees). How long to keep a file depends on the matter and the material.
  - **The procedure.** First ask the client for directions. If the client cannot be reached, pull the originals and important papers, index them and keep them a reasonable time, then dispose of the rest. Protect confidentiality when disposing.
  - **As built (014).** The attorney closes the file and records the written request for directions. Then:
    - **Destroy:** everything is purged at once, originals included.
    - **Return:** the export package is delivered; the Firm keeps its copy.
    - **Firm keeps, unreachable (attempts logged), or no direction:** everything is kept.
    - `ws.retention_policy` and the period-based stages of 012–013 are retired.
  - **Litigation hold (015, decided 2026-11-10).** You place a hold with a reason and release it with a reason; holds are never edited or deleted. While one is active, purge refuses, even on the client's direction to destroy. Holds are attorney-only; the client does not see them.
  - **Integrity (014).** `verifyIntegrity` re-hashes every stored version and checks that it still opens as its format (PDF, zip/.docx, PNG, JPEG, UTF-8 text). Results go to `ws.integrity_check` and are attorney-only. To be scheduled by the server (not yet wired).
  - **Originals.** Executed originals are marked as originals automatically; the attorney marks others on review.
  - **Exposure (§ 95.11(5)(b), § 95.031(2)(a), read 2026-11-10).** A legal-malpractice action must be brought within 2 years, but the period runs from when the cause of action "is discovered or should have been discovered with the exercise of due diligence." Unlike medical malpractice (§ 95.11(5)(c)), there is no outer limit (statute of repose). For continuity documents, discovery typically comes when the trigger occurs, which can be years after the engagement, so no retention period closes the exposure. The only fixed outer limit in reach is the 12 years from the act that § 95.031(2)(a) sets for fraud actions under § 95.11(3).
  - **Custom (researched 2026-11-10).**
    - **Opinion 81-8** (floridabar.org, read through a fetch tool's summary, not verbatim): no fixed period; the file's contents, not its age, decide how long it is kept. Make a diligent attempt to contact the client, by letter to the last known address or, failing that, by newspaper notice. Review each unclaimed file; index the important papers and store them. Destroying automatically after 90 days was not allowed.
    - **Phelps & Olson, "When May I Destroy My Old Files?", Fla. B.J., Jan. 1994** (its rule numbers predate later renumbering): experts recommend "anywhere from seven to 15 years". A model policy destroys inactive files at 10 to 15 years with partner approval, and "Original documents (contracts, wills, consent orders, etc.) are not destroyed under any circumstances." "[E]state planning files" are "generally retained permanently". "In no circumstances should a closed file be destroyed before the statute of limitations has run."
    - **Search summaries only** (insurer and other bar pages not reached; alpsinsurance.com and michbar.org are outside this session's network): malpractice carriers commonly urge 10 years; wills and trusts 20 years or more, or permanently.
  - **Purge.** Removes contents only. The index, hashes, execution records and audit log stay. Disposal method follows § 501.171(8): contents are erased from the database. Backups age out on the host's schedule.
- **Not built yet:** HTTP routes and the editor UI (step 2); Word export; LEAP copy.

## Template v2 decisions 2026-11-08
1. Interim Manager removal for Cause: by the Family Liaison with the consent of the person holding Branch Decision authority (as drafted).
2. Rider banking authority: no limit to Company-related accounts; the statutory § 709.2208(1) words stand alone, keeping the § 709.2120(1)(a) presumption.
3. Statement of authority (§ 605.0302): filed after the trigger, within the days set in OA .2(a); no conditional pre-filing.

## Not yet read at the source
§ 709.2202 (rate-limited today; relying on the 2026-11-01 reading), § 117.295 rules (Fla. Admin. Code ch. 1N-7), § 415.102, ch. 732 electronic-will provisions.
