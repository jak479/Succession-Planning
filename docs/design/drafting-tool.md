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
1. Template schema + assembler for the two templates (deterministic; tests against the demo profile). **Built 2026-11-08:** `core/src/drafting.ts` (assembler, tier check, execution-mode gate), `core/src/templates.ts` (one binding per bracket, in order), `core/test/drafting.test.ts`. The wording stays in `docs/templates/`; if a template is edited, the tests fail until its bindings match. Classifications to confirm: OA `[If the Principal dies: …]` is treated as a drafter note (never exported); OA `[if single-member]` is removed and listed as a check, because the clause it governs has no closing bracket. In the rider, ", and (ii)" was moved inside the buy-sell bracket so that dropping the clause leaves no orphan "(ii)"; the text is unchanged when the clause is kept.
2. Console editor with versions; .docx export, clean and redline.
3. AI review mode, then AI-assisted drafting mode (server-side prompts; eval set like the classifier's).
4. E-signature with UETA audit trail, or a vendor (open question 1).
5. RON package export and execution-mode gate (§ 4 table).

## 7. Open questions
1. E-signature: build it in-house (signer authentication, audit trail, tamper-evident PDF) or use a vendor (DocuSign etc.)?
2. RON: which provider does your online notary use? The package format follows it.
3. Owner estate documents (wills, trusts) now also have no drafting home. Wills are outside § 668.50 (§ 668.50(3)(b)1), so electronic wills need ch. 732 read before any template is built. Should they be in the second release?

## Not yet read at the source
§ 709.2202 (rate-limited today; relying on the 2026-11-01 reading), § 117.295 rules (Fla. Admin. Code ch. 1N-7), § 415.102, ch. 732 electronic-will provisions.
