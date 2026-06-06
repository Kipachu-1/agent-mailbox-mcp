import type { SQLQueryBindings } from "bun:sqlite";
import { insertArtifacts, listArtifacts } from "./artifacts";
import { visibleTaskClause } from "./context";
import type { StoreContext } from "./context";
import {
  emptyToNull,
  encodeJson,
  isoNow,
  limit,
  mapTask,
  shouldNotifyForStatus,
  workspaceOf,
  type TaskRow,
} from "./mappers";
import {
  addTaskFilters,
  insertTaskEvent,
  listTaskEvents,
  replaceTaskDependencies,
  sendTaskStatusNotification,
  taskDependencies,
} from "./task-support";
import type {
  CreateTaskInput,
  ListTasksOptions,
  TaskEventRecord,
  TaskRecord,
  UpdateTaskInput,
} from "./types";

export function createTask(ctx: StoreContext, input: CreateTaskInput): TaskRecord {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const id = crypto.randomUUID();
  ctx.exec("BEGIN IMMEDIATE");
  try {
    ctx.run(
      `INSERT INTO tasks
         (id, workspace, title, description, creator_id, assignee_id, channel, status,
          priority, due_at, parent_task_id, blocked_reason, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspace,
        input.title,
        input.description ?? "",
        input.creatorId,
        emptyToNull(input.assigneeId),
        emptyToNull(input.channel),
        input.priority ?? 0,
        emptyToNull(input.dueAt),
        emptyToNull(input.parentTaskId),
        emptyToNull(input.blockedReason),
        encodeJson(input.metadata ?? {}),
        now,
        now,
      ],
    );
    replaceTaskDependencies(ctx, id, input.dependencies ?? []);
    insertArtifacts(ctx, "task", id, input.artifacts ?? []);
    insertTaskEvent(ctx, id, input.creatorId, "created", "open", "Task created.");
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const task = getTask(ctx, id);
  if (!task) {
    throw new Error(`Failed to create task '${id}'.`);
  }
  return task;
}

export function listTasks(
  ctx: StoreContext,
  agentId: string,
  options: ListTasksOptions = {},
): TaskRecord[] {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?", visibleTaskClause()];
  const params: SQLQueryBindings[] = [workspace, agentId, agentId];

  addTaskFilters(clauses, params, options);
  params.push(limit(options.limit));
  return ctx.all<TaskRow>(
    `SELECT * FROM tasks
     WHERE ${clauses.join(" AND ")}
     ORDER BY priority DESC, updated_at DESC
     LIMIT ?`,
    params,
  ).map((row) => taskWithRelations(ctx, row));
}

export function listAllTasks(
  ctx: StoreContext,
  options: Omit<ListTasksOptions, "assigneeId" | "creatorId"> = {},
): TaskRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (options.workspace) {
    clauses.push("workspace = ?");
    params.push(workspaceOf(options.workspace));
  }
  addTaskFilters(clauses, params, options);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit(options.limit));
  return ctx.all<TaskRow>(
    `SELECT * FROM tasks
     ${where}
     ORDER BY priority DESC, updated_at DESC
     LIMIT ?`,
    params,
  ).map((row) => taskWithRelations(ctx, row));
}

export function claimTask(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  note?: string,
  workspace?: string,
): TaskRecord {
  const now = isoNow();
  const scope = workspace ? workspaceOf(workspace) : undefined;
  const workspaceClause = scope ? "AND workspace = ?" : "";
  const params: SQLQueryBindings[] = [agentId, now, taskId];
  if (scope) {
    params.push(scope);
  }
  params.push(agentId);

  ctx.exec("BEGIN IMMEDIATE");
  try {
    const result = ctx.run(
      `UPDATE tasks
       SET assignee_id = ?, status = 'claimed', updated_at = ?
       WHERE id = ?
         ${workspaceClause}
         AND status = 'open'
         AND (assignee_id IS NULL OR assignee_id = ?)`,
      params,
    );

    if (result.changes === 0) {
      const existing = getTask(ctx, taskId);
      if (!existing) {
        throw new Error(`Task '${taskId}' does not exist.`);
      }
      if (scope && existing.workspace !== scope) {
        throw new Error(`Task '${taskId}' is not in workspace '${scope}'.`);
      }
      throw new Error(`Task '${taskId}' cannot be claimed from status '${existing.status}'.`);
    }

    insertTaskEvent(ctx, taskId, agentId, "claimed", "claimed", note ?? "Task claimed.");
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const task = getTask(ctx, taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' disappeared after claiming.`);
  }
  return task;
}

export function updateTask(ctx: StoreContext, input: UpdateTaskInput): TaskRecord {
  const now = isoNow();
  let shouldNotifyCreator = false;
  ctx.exec("BEGIN IMMEDIATE");
  try {
    const scope = workspaceOf(input.workspace);
    const existing = getVisibleTaskForAgent(ctx, input.agentId, input.taskId, scope);
    if (!existing) {
      throw new Error(`Task '${input.taskId}' is not visible to agent '${input.agentId}'.`);
    }

    const priority = input.priority ?? existing.priority;
    const dueAt = input.dueAt === undefined ? existing.due_at : emptyToNull(input.dueAt);
    const blockedReason =
      input.blockedReason === undefined ? existing.blocked_reason : emptyToNull(input.blockedReason);
    shouldNotifyCreator =
      input.agentId !== existing.creator_id &&
      existing.status !== input.status &&
      shouldNotifyForStatus(input.status);

    ctx.run(
      `UPDATE tasks
       SET status = ?, priority = ?, due_at = ?, blocked_reason = ?, updated_at = ?
       WHERE id = ?`,
      [input.status, priority, dueAt, blockedReason, now, input.taskId],
    );
    insertArtifacts(ctx, "task", input.taskId, input.artifacts ?? []);
    insertTaskEvent(ctx, input.taskId, input.agentId, "status_changed", input.status, input.note);
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const task = getTask(ctx, input.taskId);
  if (!task) {
    throw new Error(`Task '${input.taskId}' disappeared after updating.`);
  }
  if (shouldNotifyCreator) {
    sendTaskStatusNotification(ctx, input.agentId, task, input.note);
  }
  return task;
}

export function listVisibleTaskEvents(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  workspace?: string,
): TaskEventRecord[] {
  const scope = workspaceOf(workspace);
  const task = getVisibleTaskForAgent(ctx, agentId, taskId, scope);
  if (!task) {
    throw new Error(`Task '${taskId}' is not visible to agent '${agentId}'.`);
  }
  return listTaskEvents(ctx, taskId);
}

export function getTask(ctx: StoreContext, taskId: string): TaskRecord | null {
  const row = ctx.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  return row ? taskWithRelations(ctx, row) : null;
}

export function getVisibleTaskForAgent(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  workspace: string,
): TaskRecord | null {
  const row = ctx.get<TaskRow>(
    `SELECT * FROM tasks
     WHERE id = ? AND workspace = ? AND ${visibleTaskClause()}`,
    [taskId, workspace, agentId, agentId],
  );
  return row ? taskWithRelations(ctx, row) : null;
}

export function taskWithRelations(ctx: StoreContext, row: TaskRow): TaskRecord {
  return {
    ...mapTask(row),
    dependencies: taskDependencies(ctx, row.id),
    artifacts: listArtifacts(ctx, "task", row.id),
  };
}
