# Integrations — LEAP and WealthCounsel (v0, design only)

Decided 2026-11-02: integrate with LEAP (practice management) and WealthCounsel (drafting). **2026-11-08: WealthCounsel dropped; drafting moves to the Firm's own tool (docs/design/drafting-tool.md). The WealthCounsel lines below are kept as history only.** No code until the vendor terms below are read at the source.

## What is known, and how well
Search-result summaries only. The vendor sites were not reachable from the build environment, so none of this has been read at the primary source. Confirm each line before relying on it.
- WealthCounsel is part of LEAP. LEAP runs WealthCounsel drafting inside LEAP, and drafted documents are saved to the LEAP matter. (Search summary of leap.us/integrations/wealthcounsel and the LawNext 2023 announcement.)
- LEAP has a developer console. Approved developers build REST integrations, and the API reference sits behind registration and app review. (Search summary; one review-site report says LEAP refused a developer account for a custom integration.)
- WealthCounsel announced an "open API" for Wealth Docx online in 2018, alongside its Clio integration. Current status is unknown.

## Division of labor
| System | Owns | The workspace's relation to it |
|---|---|---|
| WealthCounsel (inside LEAP) | Drafting. The attorney drafts; the agent never drafts or fills in a document. | The workspace receives the executed document as a `DOC` source in the right tier. |
| LEAP | Contacts, matters, documents, time, invoices (firm side) | One LEAP matter per workspace: the entity engagement and the personal engagement. These map to the two letters and the 4-1.7 consent, so the tiers stay separate in LEAP too. |
| Workspace | Client-facing state file, board, signed change orders, intake, agent | System of record for node status and change-order approval. |

## Flows (once the API is confirmed)
1. **Matter link.** Attorney links each workspace to its LEAP matter (`ws.external_ref`, kind `matter`).
2. **Executed documents in.** A document filed to the LEAP matter is pulled into that workspace only, as a `DOC` source. Owner-matter documents never enter the entity workspace.
3. **Signed change order out.** On client approval, the approval record (scope, price, signer, time, digest) is filed to the LEAP entity matter as a document, and a fixed-fee invoice line is created on Done.
4. **Subscription.** Billed monthly in arrears from LEAP. The workspace never shows time entries; LEAP may keep them internally.

## Questions for LEAP / WealthCounsel (attorney to ask)
1. Is API access available to a US firm for a custom client portal? On what terms, at what fee, and with what app review?
2. Which objects can be read and written: matters, contacts, documents, fixed-fee invoice lines? Are there webhooks for "document filed to matter"?
3. Can an API client be limited to one matter, so the entity workspace's link cannot read the personal matter?
4. Does WealthCounsel expose drafted or executed documents outside LEAP, or only through the LEAP matter?
5. What are the data-processing and confidentiality terms for API access (Opinion 24-1 vetting)?
