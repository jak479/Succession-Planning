// Document assembly (drafting tool, build step 1; docs/design/drafting-tool.md). Pure and deterministic: no AI call.
// The template text in docs/templates/ stays the only source of the wording. A binding list names every top-level
// [bracket] of the instrument in order; assembly refuses to run if the brackets and the bindings drift apart.
import { PROFILE_FIELDS } from "./catalog.ts";

export type Tier = "entity" | "owner";
/** Every value used in a document carries the id of its source (rule 6). */
export type Fact = { value: string | boolean; source: string };
export type Facts = Record<string, Fact>;

export type Binding =
  | { kind: "var"; text: string; id: string; upper?: boolean }          // fill; unfilled stays as the bracket
  | { kind: "choice"; text: string; id: string }                          // one of the " / " options
  | { kind: "optional"; text: string; id: string; inner?: Binding[] }     // include the bracket's words if true
  | { kind: "variant"; text: string; id: string; negate?: boolean; inner?: Binding[] } // "[Label: words]": include words if true (false if negate)
  | { kind: "ifChoice"; text: string; id: string; equals: string }        // include words if the choice equals
  | { kind: "lineIf"; text: string; id: string }                          // drop the whole line if false
  | { kind: "check"; text: string }                                       // removed; listed for the attorney
  | { kind: "note"; text: string }                                        // drafter note; never exported
  | { kind: "sign"; text: string };                                       // completed at signing; kept

export type VarDef = { id: string; label: string; from?: string };      // from: profile field the value is taken from
export type SectionGate = { heading: string; id: string };              // drop heading through the next same-level heading

export type Template = {
  id: string; title: string; tier: Tier; file: string;
  start: string; end: string;                                           // instrument = text from start up to end
  vars: VarDef[]; bindings: Binding[]; sections?: SectionGate[];
};

export type Assembly = {
  text: string;
  used: { id: string; value: string; source: string }[];
  open: { id: string; label: string }[];                                // still bracketed: no value, or not decided
  checks: string[];
};

type Br = { start: number; end: number; text: string };
/** Top-level brackets, nesting respected. */
export function brackets(s: string): Br[] {
  const out: Br[] = []; let depth = 0, st = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") { if (depth++ === 0) st = i; }
    else if (s[i] === "]" && depth > 0 && --depth === 0) out.push({ start: st, end: i + 1, text: s.slice(st, i + 1) });
  }
  return out;
}

const options = (text: string) => text.slice(1, -1).split("/").map(x => x.trim());
const body = (text: string) => text.slice(1, -1);
const variantBody = (text: string) => body(text).replace(/^[^:]*:\s*/, "").replace(/^\*(.*)\*$/s, "$1");

/** A binding names its bracket exactly, or by its opening words ending in "…". */
const same = (have: string, want: string) => want.endsWith("…") ? have.startsWith(want.slice(0, -1)) : have === want;

/** Bindings must match the brackets one for one, in order. Returns the problems; empty means bound. */
export function checkBindings(src: string, bindings: Binding[]): string[] {
  const br = brackets(src), errs: string[] = [];
  if (br.length !== bindings.length) errs.push(`${br.length} brackets, ${bindings.length} bindings`);
  br.forEach((b, i) => { const want = bindings[i]?.text; if (want !== undefined && !same(b.text, want)) errs.push(`#${i}: template has ${JSON.stringify(b.text.slice(0, 60))}, binding expects ${JSON.stringify(want.slice(0, 60))}`); });
  return errs;
}

export function instrument(t: Template, file: string): string {
  const a = file.indexOf(t.start); if (a < 0) throw new Error(`${t.id}: start marker not found`);
  const b = file.indexOf(t.end, a); if (b < 0) throw new Error(`${t.id}: end marker not found`);
  return file.slice(a, b).replace(/\n+-{3,}\s*$/, "").trimEnd() + "\n";
}

export function assemble(t: Template, file: string, facts: Facts): Assembly {
  for (const [id, f] of Object.entries(facts)) if (!f.source?.trim()) throw new Error(`fact ${id} has no source id`);
  let src = instrument(t, file);
  const errs = checkBindings(src, t.bindings);
  if (errs.length) throw new Error(`${t.id}: template and bindings differ — ${errs.join("; ")}`);

  const label = (id: string) => t.vars.find(v => v.id === id)?.label ?? id;
  const used = new Map<string, { id: string; value: string; source: string }>();
  const open = new Map<string, { id: string; label: string }>();
  const checks: string[] = [];
  const DROP_LINE = "\u0000DROP\u0000";
  const take = (id: string) => { const f = facts[id]; if (f) used.set(id, { id, value: String(f.value), source: f.source }); return f; };
  const miss = (id: string) => { open.set(id, { id, label: label(id) }); };
  const flag = (id: string) => { const f = take(id); if (!f) { miss(id); return undefined; } if (typeof f.value !== "boolean") throw new Error(`${id} must be true or false`); return f.value; };

  const fill = (s: string, bs: Binding[]): string => {
    const br = brackets(s); let out = "", at = 0;
    br.forEach((b, i) => {
      const bd = bs[i]; out += s.slice(at, b.start); at = b.end;
      switch (bd.kind) {
        case "var": { const f = take(bd.id); if (!f) { miss(bd.id); out += b.text; } else out += bd.upper ? String(f.value).toUpperCase() : String(f.value); break; }
        case "choice": {
          const f = take(bd.id), opts = options(b.text);
          if (!f) { miss(bd.id); out += b.text; break; }
          if (!opts.includes(String(f.value))) throw new Error(`${bd.id}: "${f.value}" is not one of ${opts.join(" | ")}`);
          out += f.value; break;
        }
        case "optional": { const v = flag(bd.id); out += v === undefined ? b.text : v ? (bd.inner ? fill(body(b.text), bd.inner) : body(b.text)) : ""; break; }
        case "variant": { const v = flag(bd.id); out += v === undefined ? b.text : v !== !!bd.negate ? (bd.inner ? fill(variantBody(b.text), bd.inner) : variantBody(b.text)) : ""; break; }
        case "ifChoice": { const f = facts[bd.id]; out += f === undefined ? b.text : String(f.value) === bd.equals ? body(b.text) : ""; break; }
        case "lineIf": { const v = flag(bd.id); out += v === undefined ? b.text : v ? "" : DROP_LINE; break; }
        case "check": checks.push(body(b.text)); break;
        case "note": break;
        case "sign": out += b.text; break;
      }
    });
    return out + s.slice(at);
  };

  for (const g of t.sections ?? []) {                                   // section gates first: brackets inside a dropped section go too
    const v = flag(g.id); if (v !== false) continue;
    const a = src.indexOf(g.heading); if (a < 0) throw new Error(`${t.id}: section ${g.heading} not found`);
    const level = g.heading.match(/^#+/)![0];
    const next = src.slice(a + g.heading.length).search(new RegExp(`\\n${level} `));
    const b = next < 0 ? src.length : a + g.heading.length + next + 1;
    const keep = brackets(src.slice(0, a)).length, gone = brackets(src.slice(a, b)).length;
    t = { ...t, bindings: [...t.bindings.slice(0, keep), ...t.bindings.slice(keep + gone)] };
    src = src.slice(0, a) + src.slice(b);
  }

  let text = fill(src, t.bindings);
  text = text.split("\n").filter(l => !l.includes(DROP_LINE)).join("\n")
    .replace(/(\S)[ \t]+([.,;:)])/g, "$1$2").replace(/(\S)[ \t]{2,}/g, "$1 ").replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "").replace(/\n{3,}/g, "\n\n");
  return { text, used: [...used.values()], open: [...open.values()], checks };
}

/** Rule 3: a template may draw only on profile fields of its own tier. Returns the violations. */
export function tierViolations(t: Template): string[] {
  return t.vars.filter(v => v.from).flatMap(v => {
    const f = PROFILE_FIELDS.find(p => p.field === v.from);
    if (!f) return [`${v.id}: no profile field "${v.from}"`];
    return f.tier === t.tier ? [] : [`${v.id}: "${v.from}" is ${f.tier}-tier; ${t.id} is ${t.tier}-tier`];
  });
}

// ---- Execution modes (docs/design/drafting-tool.md § 4; statutes read 2026-11-08) ----
export type ExecMode = "in_person" | "esign_only" | "ron_witnesses_present" | "ron_remote_witnesses";
export type ExecRule = { mode: ExecMode; allowed: boolean; why: string; requires?: string[] };

export function executionModes(templateId: string, facts: Facts): ExecRule[] {
  if (templateId === "oa-continuity") return [
    { mode: "in_person", allowed: true, why: "Signatures only." },
    { mode: "esign_only", allowed: true, why: "An electronic signature satisfies a signature requirement (§ 668.50(7)(d))." },
    { mode: "ron_witnesses_present", allowed: true, why: "Permitted; no notarization is required." },
    { mode: "ron_remote_witnesses", allowed: true, why: "Permitted; no notarization is required." },
  ];
  if (templateId === "dpoa-rider") {
    const partC = facts.part_c?.value !== false;                        // undecided counts as included
    const remote: ExecRule = partC
      ? { mode: "ron_remote_witnesses", allowed: false, why: "Part C (§ 709.2202) powers cannot be granted in a remotely witnessed power; § 117.285(7) excepts § 709.2202." }
      : { mode: "ron_remote_witnesses", allowed: true, why: "Part B(c) grants § 709.2208(1) banking authority, so § 117.285(5) applies with fewer than two witnesses physically present.",
          requires: ["provider screening questions (§ 117.285(5)(a)); any yes → witnesses physically present (5)(b)", "written vulnerable-adult notice (5)(c)", "notary asks the five questions (5)(d)", "record shows remote witnesses (5)(i)", "screening answers stay with the provider, never in the workspace (rule 3)"] };
    return [
      { mode: "in_person", allowed: true, why: "Two subscribing witnesses and a notary (§ 709.2105(2))." },
      { mode: "esign_only", allowed: false, why: "Needs two witnesses and an acknowledgment (§ 709.2105(2)); a signature alone is not enough." },
      { mode: "ron_witnesses_present", allowed: true, why: "With two witnesses physically present, § 117.285(5) does not apply ((5)(k)).", requires: ["certificate notes \"online notary\" (§ 117.265(7))"] },
      remote,
    ];
  }
  throw new Error(`no execution rules for ${templateId}`);
}
