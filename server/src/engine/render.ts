// The client reply is built here, from the five permitted forms (docs/design/front-door-spec.md).
// The model supplies only slot values; the sentence frames are fixed.
import { ATTORNEY, type Brief } from "./prompts.ts";

export interface CheckRow { outside_says: string; your_documents_say: string; difference: string }
export interface Reply { lines: string[]; check_this?: CheckRow[] }
export const MAX_QUOTES = 3;
const RELATION: Record<Brief["check_this"][number]["relation"], string> = {
  same_terms: "The outside answer and the document state the same terms.",
  different_terms: "The outside answer and the document state different terms.",
  document_not_cited_by_outside: "The outside answer does not cite this provision.",
  no_document_addresses: "No document on file addresses this.",
};

export const urgentReply = (): Reply => ({ lines: [`This is marked urgent; ${ATTORNEY} will contact you directly.`] });
export const agendaReply = (position: number): Reply => ({ lines: [`This is on Thursday's agenda, position ${position}.`] });

export function renderReply(b: Brief, titles: Map<string, string>, position: number): Reply {
  if (b.urgent) return urgentReply();
  const lines: string[] = [];
  for (const d of b.documents_say.slice(0, MAX_QUOTES)) lines.push(`Here's what your ${titles.get(d.doc) ?? d.doc} says about this: ${d.says} (${d.doc}, ${d.section})`);
  if (b.facts_needed.length) lines.push(`To prepare this for Thursday, I need: ${b.facts_needed.join("; ")}`);
  lines.push(`This is on Thursday's agenda, position ${position}.`);
  const reply: Reply = { lines };
  if (b.check_this.length) {
    reply.check_this = b.check_this.map(r => ({ outside_says: r.outside_says,
      your_documents_say: r.relation === "no_document_addresses" ? "—" : `${r.your_documents_say} (${r.doc}, ${r.section})`, difference: RELATION[r.relation] }));
    lines.push(`${ATTORNEY} will review this on Thursday.`);
  }
  return reply;
}

/** Every string a client would read that came from the model (the gate screens these). */
export function modelSlots(b: Brief): string[] {
  return [...b.documents_say.slice(0, MAX_QUOTES).flatMap(d => [d.says, d.section]), ...b.facts_needed, ...b.check_this.flatMap(r => [r.outside_says, r.your_documents_say, r.section])];
}
export const replyText = (r: Reply) => [...r.lines, ...(r.check_this ?? []).map(c => `${c.outside_says} | ${c.your_documents_say} | ${c.difference}`)].join("\n");
