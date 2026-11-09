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
2. Console editor with versions; .docx export, clean and redline.
3. AI review mode, then AI-assisted drafting mode (server-side prompts; eval set like the classifier's).
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
- **Retention (decided 2026-11-08; rule read 2026-11-09; periods open; `core/db/013_retention_directions.sql`).** Source: the Florida Bar's "Answers to Frequently Asked Ethics Questions" (pasted 2026-11-09), summarizing Opinions 81-8 and 63-3. The opinions themselves have not been read at the source.
  - **The rule.** No fixed period, except three records kept 6 years: trust accounting records (Rule 5-1.2(f)), contingent-fee contracts and closing statements (Rule 4-1.5(f)(5)), and the insured client's statement of rights (Rule 4-1.8(j)). The workspace holds none of these (no trust, no contingent fees). How long to keep a file depends on the matter and the material.
  - **The procedure.** First ask the client for directions. If the client cannot be reached, pull the originals and important papers, index them and keep them a reasonable time, then dispose of the rest. Protect confidentiality when disposing.
  - **As built.** The attorney closes the file and records the written request for directions. Then one of four paths:
    - **Return:** the export package must be delivered first; then everything is purged.
    - **Destroy:** everything is purged.
    - **Firm keeps:** purge refuses.
    - **Unreachable** (the contact attempts must be logged): everything except marked originals is purged. The originals go only after a second, longer period.
  - **Originals.** Executed originals are marked as originals automatically; the attorney marks others on review.
  - **Purge.** Removes contents only. The index, hashes, execution records and audit log stay. Purge refuses until `ws.retention_policy` holds both periods, the rule cite and the date read. Backups age out on the host's schedule.
- **Not built yet:** HTTP routes and the editor UI (step 2); Word export; LEAP copy.

## Template v2 decisions 2026-11-08
1. Interim Manager removal for Cause: by the Family Liaison with the consent of the person holding Branch Decision authority (as drafted).
2. Rider banking authority: no limit to Company-related accounts; the statutory § 709.2208(1) words stand alone, keeping the § 709.2120(1)(a) presumption.
3. Statement of authority (§ 605.0302): filed after the trigger, within the days set in OA .2(a); no conditional pre-filing.

## Not yet read at the source
§ 709.2202 (rate-limited today; relying on the 2026-11-01 reading), § 117.295 rules (Fla. Admin. Code ch. 1N-7), § 415.102, ch. 732 electronic-will provisions.
