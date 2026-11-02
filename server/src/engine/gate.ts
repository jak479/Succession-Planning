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
export const HEALTH = /\b(diagnos\w*|dementia|alzheimer\w*|cancer|chemo\w*|stroke|surgery|hospitali[sz]ed|hospital|medication|prescri\w*|terminal(ly)? ill|memory loss|mental health|depress\w*|seizure|heart attack|hospice|parkinson\w*)\b/i;

export interface GateResult { pass: boolean; checks: { name: string; pass: boolean; detail?: string }[] }

export async function gate(b: Brief, reply: Reply, docKeys: Set<string>, model: Model): Promise<GateResult> {
  const checks: GateResult["checks"] = [];
  const slots = modelSlots(b);
  const hit = (re: RegExp) => slots.map(s => s.match(re)?.[0]).filter(Boolean) as string[];
  const banned = hit(BANNED), fee = hit(FEE), health = hit(HEALTH);
  checks.push({ name: "lexical: advice words", pass: !banned.length, detail: banned.join(", ") || undefined });
  checks.push({ name: "lexical: fee words", pass: !fee.length, detail: fee.join(", ") || undefined });
  checks.push({ name: "lexical: health words", pass: !health.length, detail: health.join(", ") || undefined });
  const badCites = b.documents_say.map(d => d.doc).filter(k => !docKeys.has(k));
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
