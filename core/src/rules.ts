// Pure computations over the state file. Storage-side rules (who may write what) live in db/001_init.sql.
import { NODES, STAGES, INTAKE, CHANGE_ORDERS, type NodeStatus } from "./catalog.ts";

export type NodeMap = Record<string, NodeStatus | undefined>;
const OK = new Set(["green", "amber"]);

/** Highest stage whose gate, and every earlier gate, is green/amber. S4 is never reached by gates. */
export function stageOf(nodes: NodeMap): number {
  let i = 0;
  for (let k = 1; k < STAGES.length; k++) {
    const g = STAGES[k].gate;
    if (!g || !g.every(id => OK.has(nodes[id] ?? ""))) break;
    i = k;
  }
  return i;
}

/** Red propagates downstream: a node whose (transitive) dependency is red cannot execute. */
export function blockedBy(nodes: NodeMap): Record<string, string[]> {
  const deps = new Map(NODES.map(n => [n.id, n.dependsOn]));
  const memo = new Map<string, string[]>();
  const walk = (id: string): string[] => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, []);
    const out = new Set<string>();
    for (const d of deps.get(id) ?? []) {
      if (nodes[d] === "red") out.add(d);
      for (const x of walk(d)) out.add(x);
    }
    const r = [...out]; memo.set(id, r); return r;
  };
  const res: Record<string, string[]> = {};
  for (const n of NODES) { const b = walk(n.id); if (b.length) res[n.id] = b; }
  return res;
}

export type IntakeMap = Record<string, string | undefined>;
const DONE = new Set(["stated", "received"]);
/** Path is assigned when every core item is stated (answer) or received (readable document). */
export function coreMissing(intake: IntakeMap): string[] {
  return INTAKE.filter(i => i.core && !DONE.has(intake[i.id] ?? "")).map(i => i.id);
}

/** Preview: which stage the plan would reach if a change order were done. */
export function previewChangeOrder(nodes: NodeMap, coId: string): { from: number; to: number } {
  const co = CHANGE_ORDERS.find(c => c.id === coId);
  if (!co) throw new Error("unknown change order " + coId);
  const after = { ...nodes }; for (const n of co.clears) after[n] = "green";
  return { from: stageOf(nodes), to: stageOf(after) };
}
