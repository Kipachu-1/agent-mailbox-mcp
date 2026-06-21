import { insertArtifacts, listArtifacts } from "./artifacts";
import { visibleTaskClause } from "./context";
import type { StoreContext, StoreValue } from "./context";
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

export async function createTask(ctx: StoreContext, input: CreateTaskInput): Promise<TaskRecord> {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const id = crypto.randomUUID();
  await ctx.transaction(async (tx) => {
    await tx.run(
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
    await replaceTaskDependencies(tx, id, input.dependencies ?? []);
    await insertArtifacts(tx, "task", id, input.artifacts ?? []);
    await insertTaskEvent(tx, id, input.creatorId, "created", "open", "Task created.");
  });

  const task = await getTask(ctx, id);
  if (!task) {
    throw new Error(`Failed to create task '${id}'.`);
  }
  return task;
}

export async function listTasks(
  ctx: StoreContext,
  agentId: string,
  options: ListTasksOptions = {},
): Promise<TaskRecord[]> {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?", visibleTaskClause()];
  const params: StoreValue[] = [workspace, agentId, agentId];

  addTaskFilters(clauses, params, options);
  params.push(limit(options.limit));
  const rows = await ctx.all<TaskRow>(
    `SELECT * FROM tasks
     WHERE ${clauses.join(" AND ")}
     ORDER BY priority DESC, updated_at DESC
     LIMIT ?`,
    params,
  );
  return Promise.all(rows.map((row) => taskWithRelations(ctx, row)));
}

export async function listAllTasks(
  ctx: StoreContext,
  options: Omit<ListTasksOptions, "assigneeId" | "creatorId"> = {},
): Promise<TaskRecord[]> {
  const clauses: string[] = [];
  const params: StoreValue[] = [];

  if (options.workspace) {
    clauses.push("workspace = ?");
    params.push(workspaceOf(options.workspace));
  }
  addTaskFilters(clauses, params, options);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit(options.limit));
  const rows = await ctx.all<TaskRow>(
    `SELECT * FROM tasks
     ${where}
     ORDER BY priority DESC, updated_at DESC
     LIMIT ?`,
    params,
  );
  return Promise.all(rows.map((row) => taskWithRelations(ctx, row)));
}

export async function claimTask(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  note?: string,
  workspace?: string,
): Promise<TaskRecord> {
  const now = isoNow();
  const scope = workspace ? workspaceOf(workspace) : undefined;
  const workspaceClause = scope ? "AND workspace = ?" : "";
  const params: StoreValue[] = [agentId, now, taskId];
  if (scope) {
    params.push(scope);
  }
  params.push(agentId);

  await ctx.transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE tasks
       SET assignee_id = ?, status = 'claimed', updated_at = ?
       WHERE id = ?
         ${workspaceClause}
         AND status = 'open'
         AND (assignee_id IS NULL OR assignee_id = ?)`,
      params,
    );

    if (result.changes === 0) {
      const existing = await getTask(tx, taskId);
      if (!existing) {
        throw new Error(`Task '${taskId}' does not exist.`);
      }
      if (scope && existing.workspace !== scope) {
        throw new Error(`Task '${taskId}' is not in workspace '${scope}'.`);
      }
      throw new Error(`Task '${taskId}' cannot be claimed from status '${existing.status}'.`);
    }

    await insertTaskEvent(tx, taskId, agentId, "claimed", "claimed", note ?? "Task claimed.");
  });

  const task = await getTask(ctx, taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' disappeared after claiming.`);
  }
  return task;
}

export async function updateTask(ctx: StoreContext, input: UpdateTaskInput): Promise<TaskRecord> {
  const now = isoNow();
  let shouldNotifyCreator = false;
  await ctx.transaction(async (tx) => {
    const scope = workspaceOf(input.workspace);
    const existing = await getVisibleTaskForAgent(tx, input.agentId, input.taskId, scope);
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

    await tx.run(
      `UPDATE tasks
       SET status = ?, priority = ?, due_at = ?, blocked_reason = ?, updated_at = ?
       WHERE id = ?`,
      [input.status, priority, dueAt, blockedReason, now, input.taskId],
    );
    await insertArtifacts(tx, "task", input.taskId, input.artifacts ?? []);
    await insertTaskEvent(tx, input.taskId, input.agentId, "status_changed", input.status, input.note);
  });

  const task = await getTask(ctx, input.taskId);
  if (!task) {
    throw new Error(`Task '${input.taskId}' disappeared after updating.`);
  }
  if (shouldNotifyCreator) {
    await sendTaskStatusNotification(ctx, input.agentId, task, input.note);
  }
  return task;
}

export async function listVisibleTaskEvents(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  workspace?: string,
): Promise<TaskEventRecord[]> {
  const scope = workspaceOf(workspace);
  const task = await getVisibleTaskForAgent(ctx, agentId, taskId, scope);
  if (!task) {
    throw new Error(`Task '${taskId}' is not visible to agent '${agentId}'.`);
  }
  return listTaskEvents(ctx, taskId);
}

export async function getTask(ctx: StoreContext, taskId: string): Promise<TaskRecord | null> {
  const row = await ctx.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  return row ? taskWithRelations(ctx, row) : null;
}

export async function getVisibleTaskForAgent(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  workspace: string,
): Promise<TaskRecord | null> {
  const row = await ctx.get<TaskRow>(
    `SELECT * FROM tasks
     WHERE id = ? AND workspace = ? AND ${visibleTaskClause()}`,
    [taskId, workspace, agentId, agentId],
  );
  return row ? taskWithRelations(ctx, row) : null;
}

export async function getVisibleTask(
  ctx: StoreContext,
  agentId: string,
  taskId: string,
  workspace?: string,
): Promise<TaskRecord | null> {
  const scope = workspaceOf(workspace);
  return getVisibleTaskForAgent(ctx, agentId, taskId, scope);
}

export async function taskWithRelations(ctx: StoreContext, row: TaskRow): Promise<TaskRecord> {
  return {
    ...mapTask(row),
    dependencies: await taskDependencies(ctx, row.id),
    artifacts: await listArtifacts(ctx, "task", row.id),
  };
}
