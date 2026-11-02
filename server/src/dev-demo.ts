// DEV ONLY: fills the sample client (from `npm run dev-db`) with activity so the screens can be seen without an API key.
// Runs the real engine code paths with a scripted model whose answers are taken from the live eval runs of 2026-11-02.
// Every brief and profile run it creates records model "scripted-demo".
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Model } from "./engine/model.ts";
import { SCREEN_SYSTEM, FRONT_DOOR_SYSTEM, CLASSIFY_SYSTEM } from "./engine/prompts.ts";
import { askFrontDoor } from "./engine/pipeline.ts";
import { startSession, clientTurn, uploadDocument } from "./engine/intake.ts";
import { buildProfile } from "./engine/profile.ts";

const ids = JSON.parse(readFileSync(process.argv[2], "utf8").split("\n\n")[0]);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let next: any = null;
const clean = { off_question_quotes: [], advice: false, recommendation: false, evaluation_of_outside_answer: false, prediction: false, fee_or_time_estimate: false, medical_information: false, explanation: "" };
const model: Model = { async json({ system }) {
  if (system === SCREEN_SYSTEM) return { ok: true, value: { category: next?.screen ?? "none", explanation: "" }, model: "scripted-demo" } as any;
  if (system === CLASSIFY_SYSTEM) return { ok: true, value: clean, model: "scripted-demo" } as any;
  return { ok: true, value: next.out, model: "scripted-demo" } as any;
} };
const deps = { pool, model, enginePersonId: ids.engine }, dana = { personId: ids.dana, workspaceId: ids.entity };

// Front door: a lease question, a check-this, an urgent one.
next = { out: { topic: "Landlord's emailed renewal terms for 4410 Industrial Blvd", tier: "entity", urgent: false, suggested_scope: "mixed",
  scope_reason: "Reviewing a lease received and advising on the call is Schedule A; negotiating the renewal is Schedule B.",
  documents_say: [{ doc: "LEASE", section: "Renewal option", says: "The lease abstract provides one 5-year renewal option, with notice required 180 days before expiration. It lists that deadline as 2026-08-04 and marks it as passed." },
    { doc: "LEASE", section: "Personal guaranty", says: "The lease abstract records a personal guaranty by Dana Ortiz for the full term, with no cap and no release on assignment." }],
  no_clause_for: ["Whether the landlord will offer new terms after the option lapsed"], facts_needed: ["Please upload the landlord's email and any attached renewal terms.", "Was any renewal notice sent to the landlord before 2026-08-04?", "Do the proposed terms include a new or extended personal guaranty, and from whom?"],
  check_this: [], anchor_proximity: "Lease expiration 2027-01-31", agenda_line: "Lease renewal and guaranty", attorney_note: "Renewal option lapsed 2026-08-04; guaranty uncapped and survives assignment. Touches N10 and C5. Any new guaranty is a change in exposure on both tiers." } };
await askFrontDoor(deps, dana, { question: "The landlord emailed renewal terms for 4410 Industrial. What does my lease say about renewal?" });
next = { out: { topic: "Check-this: interim manager signing the renewal", tier: "entity", urgent: false, suggested_scope: "mixed", scope_reason: "Comparison is Schedule A; any drafting is Schedule B.",
  documents_say: [{ doc: "OA-Art9", section: "9.2(b)", says: "Article 9.2(b) provides that during the Continuity Period the Interim Manager may perform, renew and terminate contracts and leases in the ordinary course." }],
  no_clause_for: [], facts_needed: ["Has the landlord sent a renewal, extension or new lease document? What term and rent does it state?"],
  check_this: [{ outside_says: "Since your LLC has an interim manager, the manager can sign the renewal for you.", doc: "OA-Art9", section: "9.1(b), 9.2(b)", your_documents_say: "Article 9.2(b) gives the Interim Manager authority over leases only during the Continuity Period, which Article 9.1(b) ties to an Unavailability Event.", relation: "different_terms" },
    { outside_says: "The guaranty would transfer to the company.", doc: "LEASE", section: "Personal guaranty", your_documents_say: "Dana Ortiz's personal guaranty covers the full term, has no cap, and is not released on assignment.", relation: "different_terms" }],
  anchor_proximity: "", agenda_line: "Check-this on ChatGPT answer about renewal authority", attorney_note: "Outside answer conflates continuity authority with present authority, and assumes the guaranty transfers. Both differ from the documents." } };
await askFrontDoor(deps, dana, { question: "ChatGPT says Luis can sign the renewal and the guaranty moves to the company. Is that right?", outside: "Since your LLC has an interim manager, the manager can sign the renewal for you, and the guaranty would transfer to the company." });
next = { screen: "demand_letter" };
await askFrontDoor(deps, dana, { question: "Seacoast sent a letter saying we're in default on the insurance covenant." });

// Intake: start, one answer, two uploads (one readable, one not).
await startSession(deps, dana);
next = { out: { answers: [{ item_id: "B2", restatement: "Payroll, signing at the bank, and the DBPR license qualifier stop without you.", complete: true }], asks_for_advice: false } };
await clientTurn(deps, dana, "Payroll stops, nobody else can sign at Seacoast, and I'm the license qualifier.");
await uploadDocument(deps, dana, { item: "B12", filename: "sba-loan-summary.txt", mime: "text/plain", bytes: new TextEncoder().encode("SBA 7(a) loan, Seacoast Bank (2024). Original $420,000, balance about $362,000, 10-year term, matures 2034-02-15. Personal guaranty by Dana Ortiz. Covenant: borrower maintains key-person life insurance of $420,000 assigned to lender while the loan is outstanding. Change of ownership or management without lender consent is an event of default.") });
await uploadDocument(deps, dana, { item: "B8", filename: "insurance-dec-page-scan.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n") });

// Profile: values from the live run of 2026-11-02 (run 41544539913), each with a quote from the sample documents.
next = { out: { values: [
  { field: "Lease", value: "4410 Industrial Blvd, Tampa; term ends 2027-01-31; renewal option deadline 2026-08-04 (passed); rent $6,200/month, 3% escalation", support: [{ source: "LEASE", quotes: ["Term ends 2027-01-31.", "Rent $6,200/month, 3% annual escalation."] }] },
  { field: "Personal guaranties", value: "Lease, full term, no cap, no release on assignment; Seacoast SBA 7(a) loan", support: [{ source: "LEASE", quotes: ["Personal guaranty by Dana Ortiz for the full term, no cap, no release on assignment."] }, { source: "LOAN", quotes: ["Personal guaranty by Dana Ortiz."] }] },
  { field: "Loans and credit lines", value: "SBA 7(a), Seacoast Bank (2024): $420,000 original, about $362,000 balance, matures 2034-02-15", support: [{ source: "LOAN", quotes: ["Original $420,000, balance about $362,000, 10-year term, matures 2034-02-15."] }] },
  { field: "Insurance in force", value: "Key-person term life $420,000 on Dana Ortiz, owner and beneficiary the Company, assigned to Seacoast Bank, renews 2027-03-01; GL and workers comp to 2027-05-01", support: [{ source: "INS", quotes: ["Key-person term life $420,000 on Dana Ortiz, owner: Company, beneficiary: Company, collaterally assigned to Seacoast Bank; renews 2027-03-01.", "GL and workers comp: in force, renew 2027-05-01."] }] },
  { field: "Key employees", value: "Luis Herrera, operations manager (Interim Manager)", support: [{ source: "OA-Art9", quotes: ["Interim Manager: Luis Herrera (operations manager)"] }] },
], conflicts: [], gaps: ["Legal name and entity type", "Owners and percentages", "Payroll provider and admin", "UCC filings against the company"] } };
await buildProfile(deps, dana);
await pool.end();
console.log("demo data added");
