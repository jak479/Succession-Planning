// Profile builder (build item 3). Fills the profile fields of one workspace from that workspace's own sources.
// Every value must carry a quote that appears verbatim in the cited source; values without one are dropped.
// A weaker source never replaces a stronger one; disagreements are recorded as conflicts, never resolved.
// Owner tier: the model sees only source titles, kinds and dates, never document contents (decided 2026-11-02).
import type pg from "pg";
import { z } from "zod";
import { inSession, type Session } from "../../../core/src/store.ts";
import { PROFILE_FIELDS } from "../../../core/src/catalog.ts";
import type { Model } from "./model.ts";
import { HEALTH } from "./gate.ts";

export interface ProfileDeps { pool: pg.Pool; model: Model; enginePersonId: string }
const RANK: Record<string, number> = { CALL: 6, DOC: 5, PUB: 4, API: 3, CLIENT: 2, AGENT: 1 };
const MAX_SOURCE_CHARS = 60000;

export const ProfileSchema = z.object({
  values: z.array(z.object({ field: z.string(), value: z.string(), support: z.array(z.object({ source: z.string(), quotes: z.array(z.string()) })) })),
  conflicts: z.array(z.object({ field: z.string(), value_a: z.string(), source_a: z.string(), value_b: z.string(), source_b: z.string() })),
  gaps: z.array(z.string()),
});

const SYSTEM = `You build the factual profile of a business client for a Florida law firm, from the sources listed. Extract only what a source states; never infer, estimate, summarize opinions, or advise.
For each field you can fill: give a one-line "value" that covers everything the source states for that field (for example every policy, every guaranty), and in "support" every source it comes from: for each, the source label and one to four exact excerpts from that source (each copied character for character, at most 300 characters). Together the excerpts must state every part of the value. If you cannot quote it, do not fill the field.
Use only the field names listed, exactly as written. Never record anyone's health, medical or capacity information.
Where two sources state different things for the same field, list a conflict with both values and both source labels; do not choose between them.
"gaps": fields no source addresses.`;

// What each field means, where the name alone is ambiguous (live eval: "Name; role" was filled with the family liaison).
const FIELD_HELP: Record<string, string> = {
  "Name; role": "the business owner's (principal's) own name and role in the company; not anyone else's",
  "Target exit and preferred exit": "the owner's stated target exit date and preferred kind of exit",
  "Personal guaranties": "every personal guaranty the owner has given (lease, loans, lines, vendor accounts)",
  "Insurance in force": "every policy in force: carrier or type, insured, owner, beneficiary, amount, renewal",
  "Bank accounts and signers": "each business bank account and who can sign or administer it",
  "Key employees": "employees the business depends on, with roles",
  "Family and who is affected": "names and roles of family members and others affected; facts only",
};
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

export async function buildProfile(d: ProfileDeps, s: Session) {
  return inSession(d.pool, { personId: d.enginePersonId, workspaceId: s.workspaceId }, async c => {
    const tier = (await c.query("select ws.cur_tier() t")).rows[0].t as "entity" | "owner";
    const fields = PROFILE_FIELDS.filter(f => f.tier === tier && f.agentMay).map(f => f.field);
    const srcs = (await c.query(`select s.id, s.label, s.kind, s.name, s.citation, s.pulled_at, t.body
      from ws.source s left join ws.document_text t on t.source_id = s.id
      where s.kind <> 'DOC' or s.readable order by s.pulled_at`)).rows;
    // What the model may read. Owner tier: titles only. Entity tier: document text, record citations, client answers.
    const text = (r: any): string => tier === "owner" ? "" : (r.kind === "DOC" ? r.body ?? "" : r.citation ?? "");
    const block = srcs.map(r => `[${r.label}] (${r.kind}${r.kind === "CLIENT" ? ": the client's own words" : ""}) ${r.name}, ${String(r.pulled_at).slice(0, 10)}\n${text(r).slice(0, MAX_SOURCE_CHARS)}`).join("\n\n=====\n\n");
    const current = (await c.query("select p.field, p.value, s.label, s.kind from ws.profile_value p join ws.source s on s.id = p.source_id")).rows;
    const currentSources = (await c.query("select field, source_id from ws.profile_value_source")).rows;

    const r = await d.model.json({ system: SYSTEM, user: `FIELDS\n${fields.map(f => FIELD_HELP[f] ? `${f} — ${FIELD_HELP[f]}` : f).join("\n")}\n\nCURRENT PROFILE\n${current.map(x => `${x.field}: ${x.value} [${x.label}]`).join("\n") || "(empty)"}\n\nSOURCES\n${block || "(none)"}`,
      schema: ProfileSchema, effort: "medium", maxTokens: 16000 });
    if (!r.ok) {
      await c.query("insert into ws.profile_run(workspace_id, model, result) values (ws.cur_ws(), null, $1)", [JSON.stringify({ error: r.reason })]);
      return { written: [], dropped: [], conflicts: [], gaps: [], error: r.reason };
    }

    const byLabel = new Map(srcs.map(x => [x.label, x]));
    const written: string[] = [], dropped: { field: string; why: string }[] = [], conflicts: string[] = [];
    const addConflict = async (field: string, a: string, sa: string, b: string, sb: string) => {
      const A = byLabel.get(sa), B = byLabel.get(sb); if (!A || !B || norm(a) === norm(b)) return;
      await c.query("insert into ws.conflict(workspace_id, field, value_a, source_a, value_b, source_b) values (ws.cur_ws(), $1, $2, $3, $4, $5) on conflict do nothing", [field, a, A.id, b, B.id]);
      conflicts.push(field);
    };
    // The model sometimes echoes a field with its description ("Field — help text"); keep the field name only.
    const fieldOf = (f: string) => { const t = f.trim(); return fields.includes(t) ? t : t.split(" — ")[0].trim(); };
    for (const v0 of r.value.values) {
      const v = { ...v0, field: fieldOf(v0.field) };
      if (!fields.includes(v.field)) { dropped.push({ field: v.field, why: "not a field the agent may fill in this tier" }); continue; }
      if (!v.support.length || v.support.some(x => !byLabel.get(x.source))) { dropped.push({ field: v.field, why: "unknown or missing source" }); continue; }
      if (HEALTH.test(v.value) || v.support.some(x => x.quotes.some(q => HEALTH.test(q)))) { dropped.push({ field: v.field, why: "health information" }); continue; }
      // Every quote must be in the source it is attributed to. Owner tier has no contents to quote: only titles and dates.
      const quoted = v.support.every(x => {
        const src = byLabel.get(x.source)!;
        const haystack = norm(`${src.name} ${tier === "owner" ? String(src.pulled_at).slice(0, 10) : text(src)}`);
        return x.quotes.length >= 1 && x.quotes.length <= 4 && x.quotes.every(q => q.trim() && haystack.includes(norm(q)));
      });
      if (!quoted) { dropped.push({ field: v.field, why: "quote not found in the cited source" }); continue; }
      const sources = v.support.map(x => byLabel.get(x.source)!);
      const src = sources.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));   // strongest source decides precedence
      const cur = current.find(x => x.field === v.field);
      // A rebuild that rests on the same sources as the shown value (plus any new ones) restates it: replace it.
      // Only a value from different sources is a disagreement between sources.
      const curSources = new Set(currentSources.filter(x => x.field === v.field).map(x => x.source_id));
      const restates = cur && curSources.size > 0 && [...curSources].every(id => sources.some(y => y.id === id));
      if (cur && !restates && norm(cur.value) !== norm(v.value)) {
        await addConflict(v.field, cur.value, cur.label, v.value, src.label);
        // Only a stronger source replaces the shown value; an equal or weaker one stays a listed conflict.
        if (RANK[src.kind] <= RANK[cur.kind]) continue;
      }
      await c.query(`insert into ws.profile_value(workspace_id, field, value, source_id) values (ws.cur_ws(), $1, $2, $3)
        on conflict (workspace_id, field) do update set value = excluded.value, source_id = excluded.source_id, set_at = now()`, [v.field, v.value, src.id]);
      await c.query("delete from ws.profile_value_source where workspace_id = ws.cur_ws() and field = $1", [v.field]);
      for (const x of new Set(sources.map(y => y.id))) await c.query("insert into ws.profile_value_source values (ws.cur_ws(), $1, $2)", [v.field, x]);
      written.push(v.field);
    }
    for (const k0 of r.value.conflicts) { const k = { ...k0, field: fieldOf(k0.field) }; if (fields.includes(k.field)) await addConflict(k.field, k.value_a, k.source_a, k.value_b, k.source_b); }
    const gaps = r.value.gaps.map(fieldOf).filter(g => fields.includes(g));
    await c.query("insert into ws.profile_run(workspace_id, model, result) values (ws.cur_ws(), $1, $2)", [r.model, JSON.stringify({ written, dropped, conflicts, gaps })]);
    return { written, dropped, conflicts, gaps };
  });
}
