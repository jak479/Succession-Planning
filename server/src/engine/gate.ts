// Classifier gate (rule 1). Fail-closed: anything that does not pass — a lexical hit, a bad citation,
// a classifier flag, a classifier that could not run — replaces the reply with the agenda line.
import type { Model } from "./model.ts";
import { ClassifySchema, CLASSIFY_SYSTEM, type Brief } from "./prompts.ts";
import { modelSlots, replyText, type Reply } from "./render.ts";

// Words that signal advice, evaluation or prediction in a model-filled slot.
const BANNED = /\b(should(n't)?|recommend\w*|advis\w*|advice|suggest\w*|i think|i believe|in my (view|opinion)|likely|unlikely|probably|will be fine|safe to|(un)?enforceable|correct(ly)?|incorrect|wrong|ought|better off|best option)\b/i;
// The firm's fees and time never appear on a client surface.
const FEE = /\b(fees?|retainer|hourly|billable|billing|invoice|flat fee|change[- ]order (price|cost|fee))\b/i;
// Health information never enters the workspace.
// Fact questions may not touch health or capacity at all, even in words a document itself uses (rules 3 and 4).
// "Incapacity" as a document's defined term, or "in what capacity would Luis sign", is not a capacity question;
// a question about whether a person has or lacks capacity is.
export const FACT_HEALTH = /\b(health\w*|medical\w*|hipaa|physicians?|doctors?|illness|sick\w*|memory|mental\w*|cognitive|diagnos\w*|treatment|caregiver|incapacitated|(lacks?|lacking|loses?|losing|lost|has|have|had|still has|retains?) (the )?capacity|capacity to (make|sign|manage|decide|understand)|decision[- ]making capacity)\b/i;
// The engagement letter itself says "advising on the call"; quoting it is not advice.
const ENGAGEMENT = /engagement letter/i;
export const HEALTH = /\b(diagnos\w*|dementia|alzheimer\w*|cancer|chemo\w*|stroke|surgery|hospitali[sz]ed|hospital|medication|prescri\w*|terminal(ly)? ill|memory loss|mental health|depress\w*|seizure|heart attack|hospice|parkinson\w*)\b/i;

export interface GateResult { pass: boolean; checks: { name: string; pass: boolean; detail?: string }[] }

export async function gate(b: Brief, reply: Reply, titles: Map<string, string>, model: Model): Promise<GateResult> {
  const docKeys = new Set(titles.keys());
  const checks: GateResult["checks"] = [];
  const slots = modelSlots(b);
  const hit = (re: RegExp) => slots.map(s => s.match(re)?.[0]).filter(Boolean) as string[];
  const banned = slots.filter(x => !b.documents_say.some(d => d.says === x && ENGAGEMENT.test(titles.get(d.doc) ?? ""))).map(x => x.match(BANNED)?.[0])
    .concat(b.documents_say.filter(d => ENGAGEMENT.test(titles.get(d.doc) ?? "")).map(d => d.says.replace(/\badvis\w*/gi, "").match(BANNED)?.[0]))
    .filter(Boolean) as string[];
  const fee = hit(FEE), health = hit(HEALTH);
  const factHealth = b.facts_needed.map(f => f.match(FACT_HEALTH)?.[0]).filter(Boolean) as string[];
  checks.push({ name: "lexical: advice words", pass: !banned.length, detail: banned.join(", ") || undefined });
  checks.push({ name: "lexical: fee words", pass: !fee.length, detail: fee.join(", ") || undefined });
  checks.push({ name: "lexical: health words", pass: !health.length, detail: health.join(", ") || undefined });
  checks.push({ name: "fact questions: no health or capacity", pass: !factHealth.length, detail: factHealth.join(", ") || undefined });
  const badCites = [...b.documents_say.map(d => d.doc), ...b.check_this.filter(r => r.relation !== "no_document_addresses").map(r => r.doc)].filter(k => !docKeys.has(k));
  checks.push({ name: "citations exist in the file", pass: !badCites.length, detail: badCites.join(", ") || undefined });
  checks.push({ name: "at most five fact questions", pass: b.facts_needed.length <= 5 });
  if (b.urgent) checks.push({ name: "urgent: no substance", pass: !slots.length });

  const c = await model.json({ system: CLASSIFY_SYSTEM, user: replyText(reply), schema: ClassifySchema, effort: "low", maxTokens: 2000 });
  if (!c.ok) checks.push({ name: "classifier", pass: false, detail: c.reason });
  else {
    const flags = (["advice", "recommendation", "evaluation_of_outside_answer", "prediction", "fee_or_time_estimate", "medical_information"] as const).filter(k => c.value[k]);
    checks.push({ name: "classifier", pass: !flags.length, detail: flags.length ? `${flags.join(", ")}: ${c.value.explanation}` : undefined });
  }
  return { pass: checks.every(x => x.pass), checks };
}
