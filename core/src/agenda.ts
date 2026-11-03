// Thursday agenda planner. Pure: the server gathers the inputs, this orders them and writes the reason the client sees.
// Rule (docs/design/architecture.md, "Thursday's agenda is set by the plan"):
//  1 urgent (stop-rule) items go outside the agenda; 2 deadlines within 90 days, earliest first;
//  3 steps on the path to the next stage, upstream first; 4 other plan gaps, by stage;
//  5 reserved in-house slot (Schedule A), oldest first; 6 overflow goes to the next call, and items whose step
//  waits on an open earlier step are held until then; 7 the attorney may move any item, with a reason the client sees.
// Client-visible text uses CLIENT_LABEL and states order only: no advice, no prediction, no fee (CLAUDE.md rule 1).
import { NODES, NODE_STAGE, CLIENT_LABEL } from "./catalog.ts";
import { stageOf, blockedBy, type NodeMap } from "./rules.ts";

export type AgendaSource = { key: string; kind: "question" | "change_order"; title: string; node: string | null; at: string; urgent?: boolean; minutes?: number };
export type Deadline = { node: string; label: string; due: string };          // due: YYYY-MM-DD
export type Override = { key: string; action: "first" | "hold" | "done"; reason: string; until?: string | null };
export type AgendaInput = { nodes: NodeMap; sources: AgendaSource[]; deadlines: Deadline[]; overrides: Override[]; callDate: string; nextCallDate: string;
  planMinutes?: number; inHouseMinutes?: number };
export type Tier = "moved" | "deadline" | "path" | "other" | "inhouse";
export type AgendaItem = AgendaSource & { tier: Tier; reason: string; minutes: number };
export type HeldItem = AgendaSource & { reason: string; until: string | null };
export type Agenda = { callDate: string; nextCallDate: string; stage: number; urgent: AgendaSource[]; plan: AgendaItem[]; inHouse: AgendaItem[]; held: HeldItem[];
  planMinutes: number; inHouseMinutes: number };

export const DEADLINE_WINDOW_DAYS = 90;
export const MINUTES = { question: 6, change_order: 5 } as const;

const DEPTH = (() => {
  const deps = new Map(NODES.map(n => [n.id, n.dependsOn]));
  const memo = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0; seen.add(id);
    const v = Math.max(0, ...(deps.get(id) ?? []).map(x => 1 + d(x, seen)));
    memo.set(id, v); return v;
  };
  return (id: string) => d(id);
})();
const days = (from: string, to: string) => Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86400000);
export const longDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const label = (id: string) => CLIENT_LABEL[id] ?? id;

export function planAgenda(inp: AgendaInput): Agenda {
  const planMinutes = inp.planMinutes ?? 20, inHouseMinutes = inp.inHouseMinutes ?? 10;
  const stage = stageOf(inp.nodes), next = Math.min(stage + 1, 4);
  const blocked = blockedBy(inp.nodes);
  const ov = new Map(inp.overrides.map(o => [o.key, o]));
  const out: Agenda = { callDate: inp.callDate, nextCallDate: inp.nextCallDate, stage, urgent: [], plan: [], inHouse: [], held: [], planMinutes, inHouseMinutes };
  type Ranked = AgendaItem & { sort: (string | number)[] };
  const plan: Ranked[] = [], inHouse: Ranked[] = [];

  for (const s of inp.sources) {
    const o = ov.get(s.key);
    if (o?.action === "done") continue;
    if (s.urgent) { out.urgent.push(s); continue; }
    const minutes = s.minutes ?? MINUTES[s.kind];
    if (o?.action === "hold") { out.held.push({ ...s, reason: `Moved by Josh: ${o.reason}`, until: o.until ?? inp.nextCallDate }); continue; }
    if (o?.action === "first") { plan.push({ ...s, tier: "moved", minutes, reason: `Moved up by Josh: ${o.reason}`, sort: [0, s.at] }); continue; }
    if (!s.node) { inHouse.push({ ...s, tier: "inhouse", minutes, reason: "Everyday business question, taken up oldest first", sort: [s.at] }); continue; }
    const st = NODE_STAGE[s.node] ?? 4;
    const dl = inp.deadlines.filter(d => d.node === s.node && days(inp.callDate, d.due) >= 0 && days(inp.callDate, d.due) <= DEADLINE_WINDOW_DAYS)
      .sort((a, b) => a.due.localeCompare(b.due))[0];
    if (dl) { const n = days(inp.callDate, dl.due);
      plan.push({ ...s, tier: "deadline", minutes, reason: `Taken up first: ${dl.label} ${longDate(dl.due)}, ${n} day${n === 1 ? "" : "s"} away`, sort: [1, dl.due, s.at] }); continue; }
    const waits = (blocked[s.node] ?? []).filter(x => x !== s.node);
    if (waits.length && st > next) {
      const first = waits.sort((a, b) => DEPTH(a) - DEPTH(b))[0];
      out.held.push({ ...s, reason: `Taken up at Stage ${st}: it depends on ${label(first).toLowerCase()} being in place`, until: null }); continue;
    }
    if (st === next) { plan.push({ ...s, tier: "path", minutes, reason: `On the path to Stage ${next}: ${label(s.node)}`, sort: [2, DEPTH(s.node), s.at] }); continue; }
    plan.push({ ...s, tier: "other", minutes, reason: `Other plan gaps: ${label(s.node)}, a Stage ${st} step`, sort: [3, st, DEPTH(s.node), s.at] });
  }

  const cmp = (a: Ranked, b: Ranked) => { for (let i = 0; i < Math.max(a.sort.length, b.sort.length); i++) { const x = a.sort[i] ?? "", y = b.sort[i] ?? ""; if (x < y) return -1; if (x > y) return 1; } return 0; };
  const fill = (list: Ranked[], budget: number, into: AgendaItem[]) => {
    let used = 0;
    for (const r of list.sort(cmp)) {
      const { sort, ...item } = r;
      if (used + item.minutes <= budget || (into.length === 0 && item.tier === "moved")) { into.push(item); used += item.minutes; }
      else out.held.push({ ...item, reason: `Next in line for ${shortDate(inp.nextCallDate)}: this call is full`, until: inp.nextCallDate });
    }
  };
  fill(plan, planMinutes, out.plan);
  fill(inHouse, inHouseMinutes, out.inHouse);
  return out;
}

/** The Thursday on or after the given date (YYYY-MM-DD), and the one after it. */
export function callDates(today: string): { callDate: string; nextCallDate: string } {
  const d = new Date(today + "T12:00:00Z"); const add = (4 - d.getUTCDay() + 7) % 7; d.setUTCDate(d.getUTCDate() + add);
  const call = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 7);
  return { callDate: call, nextCallDate: d.toISOString().slice(0, 10) };
}
