// Every database call runs inside one person's session in one workspace (one tier).
// The app connects as a login role that is a member of ws_app; RLS does the rest.
import pg from "pg";

export type Session = { personId: string; workspaceId: string };

export async function inSession<T>(pool: pg.Pool, s: Session, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role ws_app");
    await c.query("select set_config('app.person_id', $1, true), set_config('app.workspace_id', $2, true)", [s.personId, s.workspaceId]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** The state file for the session's workspace, as the prototype held it in localStorage. */
export async function loadState(c: pg.PoolClient) {
  const q = async (sql: string) => (await c.query(sql)).rows;
  return {
    nodes: Object.fromEntries((await q("select node_id, status from ws.node_status")).map(r => [r.node_id, r.status])),
    intake: Object.fromEntries((await q("select item_id, status from ws.intake_status")).map(r => [r.item_id, r.status])),
    profile: await q("select field, value, source, basis from ws.profile_view order by field"),
    conflicts: await q("select field, value_a, value_b from ws.conflict"),
    items: await q("select id, co_id, title, clears, col, allowance, price from ws.board_item order by title"),
  };
}
