import { visibleTaskClause } from "./context";
import type { StoreContext } from "./context";
import { isoNow, workspaceOf } from "./mappers";
import { listLocks } from "./locks";
import { inbox } from "./messages";
import { readNotes } from "./notes";
import { listTasks } from "./tasks";
import type { TaskEventRecord, UpdatesRecord } from "./types";

export function updatesSince(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  since?: string,
): UpdatesRecord {
  const scope = workspaceOf(workspace);
  const sinceValue = since?.trim() || "1970-01-01T00:00:00.000Z";
  return {
    since: sinceValue,
    checked_at: isoNow(),
    messages: inbox(ctx, agentId, { workspace: scope, includeSent: true, limit: 200 }).filter(
      (message) => message.created_at > sinceValue,
    ),
    tasks: listTasks(ctx, agentId, { workspace: scope, limit: 200 }).filter(
      (task) => task.updated_at > sinceValue,
    ),
    task_events: ctx.all<TaskEventRecord>(
      `SELECT e.* FROM task_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace = ? AND ${visibleTaskClause("t")} AND e.created_at > ?
       ORDER BY e.created_at DESC
       LIMIT 200`,
      [scope, agentId, agentId, sinceValue],
    ),
    notes: readNotes(ctx, { workspace: scope, limit: 200 }).filter(
      (note) => note.updated_at > sinceValue,
    ),
    locks: listLocks(ctx, { workspace: scope, includeExpired: true }).filter(
      (lock) => lock.updated_at > sinceValue,
    ),
  };
}
