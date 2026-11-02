// Ask-last intake planning (rule 5). Pure functions over the catalog and the workspace's intake statuses.
// Sources: docs/design/intake-assessment.md (questions), docs/design/collection-map.md (pull order, public records),
// docs/design/intake-agent-spec.md (sequence: core items first, then what unlocks the earliest stage).
import { INTAKE, STAGES, type IntakeDef } from "./catalog.ts";

/** The wording the agent uses for each agent-askable item. Fixed text: never model-written. */
export const INTAKE_Q: Record<string, string> = {
  A1: "When do you expect to leave the business? A date, an age, or \"no plan to\" are all fine.",
  A2: "What does a good exit look like: selling to an outsider, transferring to family or an employee, keeping an income after you leave, closing it cleanly, or not sure yet?",
  A3: "What do you need from the business at exit: a lump sum, an income, or just that it stops being your responsibility? A rough number if you have one.",
  A4: "If you were out tomorrow, what do you want to happen to the business? Is it the same answer as your exit plan, or different?",
  A5: "Who is affected by what happens to the business: spouse, children, partners, key employees, anyone else? Names and roles only.",
  A6: "Has anyone asked you for a continuity or key-person plan, such as a lender, a customer, a regulator or a partner? Who, and what did they ask for?",
  B1: "the operating agreement or bylaws, with every amendment",
  B2: "What would stop on day one without you: sales, signing, payroll, a license, a relationship, a skill?",
  B3: "Who could run the business for 90 days? Their name and role, whether they would do it, and whether they know.",
  B4: "Who is your second choice if that person can't?",
  B5: "the bank signatory card (or the bank's signer confirmation) for each business account",
  B6: "What are monthly payroll and fixed costs, how much cash is on hand, and is any of it set aside as a reserve?",
  B7: "Who is your payroll provider, and who is an admin on it?",
  B8: "the insurance schedule or declarations pages (carrier, owner, beneficiary, renewal date)",
  B9: "Where are the passwords, MFA devices, domain and software admin accounts, and keys kept, and who else can get in?",
  B10: "the list of top customers and referral sources, and any contracts with renewal dates",
  B11: "the lease, with amendments, and any other personal guaranties (loans, lines, vendor accounts)",
  B12: "the loan documents: note, loan agreement, guaranty",
  B13: "the license certificates held by the business or by you, with any designee or administrator on file",
  B14: "Who are the key employees, what would they need to stay, and are any agreements in place with them?",
  B15: "What is a rough value for the business, and how would you know: a valuation, an offer, a revenue multiple, or a guess?",
  "C-1": "copies of any will, trust, durable power of attorney or health care surrogate designation (we record only that they exist, their dates and who drafted them)",
  "C-8": "Who are your CPA, financial advisor and any other attorney, and may we coordinate with them?",
};

/** Public records the agent checks before asking (collection-map.md § Pull order). Checklist mode: each pull is
 *  done by hand from the link and recorded as a cited PUB source. Automated pulls only after each site's terms are read. */
export const PUBLIC_RECORDS = [
  { id: "sunbiz", name: "Sunbiz entity record (Division of Corporations)", covers: "document number, status, formation date, registered agent, officers and managers, annual reports", feeds: ["B1"], url: "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName" },
  { id: "ucc", name: "Florida Secured Transaction Registry (UCC)", covers: "UCC-1 filings naming the company or the owner as debtor", feeds: ["B12", "B11"], url: "https://www.floridaucc.com/uccweb/" },
  { id: "clerk", name: "County clerk official records", covers: "judgments, liens, mortgages, lis pendens against the company or the owner", feeds: ["B12"], url: "https://www.myfloridacounty.com/" },
  { id: "appraiser", name: "County property appraiser", covers: "real property owned by the company or the owner; homestead", feeds: [], url: "https://floridarevenue.com/property/Pages/LocalOfficials.aspx" },
  { id: "dbpr", name: "DBPR license lookup", covers: "professional and business licenses, qualifiers, expirations", feeds: ["B13"], url: "https://www.myfloridalicense.com/wl11.asp" },
  { id: "ahca", name: "AHCA facility and provider lookup (healthcare only)", covers: "license, administrator of record, expiration", feeds: ["B13"], url: "https://quality.healthfinder.fl.gov/facilitylocator/facloc.aspx" },
  { id: "pacer", name: "Court dockets (PACER; county clerk)", covers: "pending suits naming the company or the owner", feeds: [], url: "https://pacer.uscourts.gov/" },
] as const;

const DONE = new Set(["stated", "received", "received_unread"]);   // in hand or answered: never asked again

/** Earliest stage an item helps reach: S1 gate nodes first, then S2, then S3. */
function stageRank(it: IntakeDef): number {
  for (let k = 1; k < STAGES.length; k++) if (STAGES[k].gate?.some(n => it.feeds.includes(n))) return k;
  return STAGES.length;
}
const order = (a: IntakeDef, b: IntakeDef) => Number(b.core) - Number(a.core) || stageRank(a) - stageRank(b) || INTAKE.indexOf(a) - INTAKE.indexOf(b);

export interface Plan { documents: IntakeDef[]; questions: IntakeDef[]; attorneyOnly: IntakeDef[]; done: IntakeDef[] }

/** What remains after every source has been applied. Documents are requested as one list; questions one at a time. */
export function planIntake(status: Record<string, string | undefined>, tier: "entity" | "owner" = "entity"): Plan {
  const items = INTAKE.filter(i => i.tier === tier);
  const open = items.filter(i => !DONE.has(status[i.id] ?? ""));
  return {
    documents: open.filter(i => i.kind === "doc" && i.askedBy === "agent").sort(order),
    questions: open.filter(i => i.kind === "fact" && i.askedBy === "agent").sort(order),
    attorneyOnly: open.filter(i => i.askedBy === "attorney"),
    done: items.filter(i => DONE.has(status[i.id] ?? "")),
  };
}

/** Session-end summary (intake-agent-spec § Sequence 5): fixed text only. */
export function sessionSummary(status: Record<string, string | undefined>, receivedThisSession: string[]): string[] {
  const p = planIntake(status);
  const lines: string[] = [];
  lines.push(receivedThisSession.length ? `Received this session: ${receivedThisSession.join(", ")}.` : "Nothing new was received this session.");
  const open = [...p.documents, ...p.questions];
  lines.push(open.length ? `Still open: ${open.map(i => `${i.id} (goes toward ${i.feeds.join(", ") || "the plan"})`).join("; ")}.` : "Everything on the intake list is in.");
  if (p.documents[0]) lines.push(`Next document to send: ${INTAKE_Q[p.documents[0].id]}.`);
  return lines;
}
