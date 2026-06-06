import type { SQLQueryBindings } from "bun:sqlite";
import type { StoreContext } from "./context";
import { durationSeconds, emptyToNull, isoNow } from "./mappers";
import { sendMessage } from "./messages";
import type { ListTasksOptions, TaskEventRecord, TaskRecord, TaskStatus } from "./types";

export function addTaskFilters(
  clauses: string[],
  params: SQLQueryBindings[],
  options: ListTasksOptions,
): void {
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.assigneeId) {
    clauses.push("assignee_id = ?");
    params.push(options.assigneeId);
  }
  if (options.creatorId) {
    clauses.push("creator_id = ?");
    params.push(options.creatorId);
  }
  if (options.channel) {
    clauses.push("channel = ?");
    params.push(options.channel);
  }
  if (options.parentTaskId) {
    clauses.push("parent_task_id = ?");
    params.push(options.parentTaskId);
  }
  if (options.staleAfterSeconds !== undefined) {
    clauses.push("status = 'claimed'");
    clauses.push("updated_at <= ?");
    params.push(new Date(Date.now() - durationSeconds(options.staleAfterSeconds) * 1000).toISOString());
  }
}

export function insertTaskEvent(
  ctx: Pick<StoreContext, "run">,
  taskId: string,
  agentId: string,
  eventType: string,
  status: TaskStatus,
  note?: string,
): void {
  ctx.run(
    `INSERT INTO task_events (id, task_id, agent_id, event_type, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), taskId, agentId, eventType, status, emptyToNull(note), isoNow()],
  );
}

export function replaceTaskDependencies(
  ctx: Pick<StoreContext, "run">,
  taskId: string,
  dependencies: string[],
): void {
  ctx.run(`DELETE FROM task_dependencies WHERE task_id = ?`, [taskId]);
  for (const dependency of dependencies.filter(Boolean)) {
    ctx.run(
      `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
       VALUES (?, ?)`,
      [taskId, dependency],
    );
  }
}

export function taskDependencies(ctx: Pick<StoreContext, "all">, taskId: string): string[] {
  return ctx.all<{ depends_on_task_id: string }>(
    `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id`,
    [taskId],
  ).map((row) => row.depends_on_task_id);
}

export function listTaskEvents(
  ctx: Pick<StoreContext, "all">,
  taskId: string,
): TaskEventRecord[] {
  return ctx.all<TaskEventRecord>(
    `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`,
    [taskId],
  );
}

export function sendTaskStatusNotification(
  ctx: StoreContext,
  agentId: string,
  task: TaskRecord,
  note?: string,
): void {
  if (agentId === task.creator_id) {
    return;
  }

  const statusLabel = task.status === "done" ? "completed" : task.status;
  const noteText = note?.trim() ? `\n\nNote: ${note.trim()}` : "";
  sendMessage(ctx, {
    senderId: agentId,
    workspace: task.workspace,
    recipientId: task.creator_id,
    body: `Task ${statusLabel}: ${task.title}${noteText}`,
    metadata: {
      system_generated: true,
      event_type: "task_status_notification",
      task_id: task.id,
      task_status: task.status,
    },
    artifacts: task.artifacts.map((artifact) => ({
      type: artifact.type,
      label: artifact.label ?? undefined,
      path: artifact.path ?? undefined,
      url: artifact.url ?? undefined,
      line: artifact.line ?? undefined,
      metadata: artifact.metadata,
    })),
  });
}
