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
  const [messages, tasks, taskEvents, notes, locks] = await Promise.all([
    inbox(ctx, agentId, { workspace: scope, includeSent: true, limit: 200 }),
    listTasks(ctx, agentId, { workspace: scope, limit: 200 }),
    ctx.all<TaskEventRecord>(
      `SELECT e.* FROM task_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace = ? AND ${visibleTaskClause("t")} AND e.created_at > ?
       ORDER BY e.created_at DESC
       LIMIT 200`,
      [scope, agentId, agentId, sinceValue],
    ),
    readNotes(ctx, { workspace: scope, limit: 200 }),
    listLocks(ctx, { workspace: scope, includeExpired: true }),
  ]);
  return {
    since: sinceValue,
    checked_at: isoNow(),
    messages: messages.filter((message) => message.created_at > sinceValue),
    tasks: tasks.filter((task) => task.updated_at > sinceValue),
    task_events: taskEvents,
    notes: notes.filter((note) => note.updated_at > sinceValue),
    locks: locks.filter((lock) => lock.updated_at > sinceValue),
  };
}
