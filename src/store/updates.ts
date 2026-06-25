import { visibleTaskClause } from "./context";
import type { StoreContext } from "./context";
import { isoNow, workspaceOf } from "./mappers";
import { listLocks } from "./locks";
import { inbox } from "./messages";
import { readNotes } from "./notes";
import { listTasks } from "./tasks";
import type { TaskEventRecord, UpdatesRecord } from "./types";

export async function updatesSince(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  since?: string,
): Promise<UpdatesRecord> {
  const scope = workspaceOf(workspace);
  const sinceValue = since?.trim() || "1970-01-01T00:00:00.000Z";
  // Push the `since` predicate into the SQL WHERE clauses (exactly as the
  // `task_events` query already does) instead of fetching a hard-capped 200
  // rows then filtering in JS. The `since` filter lives in each store's WHERE
  // builder (inboxWhere, listTasksWhere, readNotesWhere, listLocksWhere); the
  // high limit ensures busy workspaces return every matching row in one pass.
  const UPDATES_LIMIT = 1000;
  const [messages, tasks, taskEvents, notes, locks] = await Promise.all([
    inbox(ctx, agentId, { workspace: scope, includeSent: true, since: sinceValue, limit: UPDATES_LIMIT }),
    listTasks(ctx, agentId, { workspace: scope, since: sinceValue, limit: UPDATES_LIMIT }),
    ctx.all<TaskEventRecord>(
      `SELECT e.* FROM task_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace = ? AND ${visibleTaskClause("t")} AND e.created_at > ?
       ORDER BY e.created_at DESC
       LIMIT 200`,
      [scope, agentId, agentId, sinceValue],
    ),
    readNotes(ctx, { workspace: scope, since: sinceValue, limit: UPDATES_LIMIT }),
    listLocks(ctx, { workspace: scope, includeExpired: true, since: sinceValue }),
  ]);
  return {
    since: sinceValue,
    checked_at: isoNow(),
    messages,
    tasks,
    task_events: taskEvents,
    notes,
    locks,
  };
}
