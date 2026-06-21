import { getAgent } from "./agents";
import { insertArtifacts, listArtifacts } from "./artifacts";
import { visibleTaskClause } from "./context";
import type { StoreContext, StoreValue } from "./context";
import {
  emptyToNull,
  encodeJson,
  hasMore,
  isoNow,
  limit,
  mapTask,
  offset,
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
  Paginated,
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
  const { clauses, params } = listTasksWhere(agentId, options);
  const rows = await ctx.all<TaskRow>(
    `SELECT * FROM tasks
     WHERE ${clauses.join(" AND ")}
     ORDER BY priority DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit(options.limit), offset(options.offset)],
  );
  return Promise.all(rows.map((row) => taskWithRelations(ctx, row)));
}

export async function listTasksPaginated(
  ctx: StoreContext,
  agentId: string,
  options: ListTasksOptions = {},
): Promise<Paginated<TaskRecord>> {
  const { clauses, params } = listTasksWhere(agentId, options);
  const offsetValue = offset(options.offset);
  const [rows, totalRow] = await Promise.all([
    ctx.all<TaskRow>(
      `SELECT * FROM tasks
       WHERE ${clauses.join(" AND ")}
       ORDER BY priority DESC, updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit(options.limit), offsetValue],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM tasks WHERE ${clauses.join(" AND ")}`,
      params,
    ),
  ]);
  const results = await Promise.all(rows.map((row) => taskWithRelations(ctx, row)));
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValue, results.length, total) };
}

function listTasksWhere(
  agentId: string,
  options: ListTasksOptions,
): { clauses: string[]; params: StoreValue[] } {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?", visibleTaskClause()];
  const params: StoreValue[] = [workspace, agentId, agentId];
  addTaskFilters(clauses, params, options);
  return { clauses, params };
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

    if (input.title !== undefined && !input.title.trim()) {
      throw new Error("Invalid title: title cannot be empty.");
    }

    // Validate references for editable fields. Omitted fields are left unchanged;
    // an explicit null clears the field. Unknown references are rejected with a
    // clear error rather than a silent no-op.
    if (input.assigneeId !== undefined && input.assigneeId !== null) {
      const assignee = await getAgent(tx, input.assigneeId, scope);
      if (!assignee) {
        throw new Error(
          `Invalid assignee_id '${input.assigneeId}': no agent with that id exists in workspace '${scope}'.`,
        );
      }
    }
    if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
      if (input.parentTaskId === input.taskId) {
        throw new Error("Invalid parent_task_id: a task cannot be its own parent.");
      }
      const parent = await getTask(tx, input.parentTaskId);
      if (!parent || parent.workspace !== scope) {
        throw new Error(
          `Invalid parent_task_id '${input.parentTaskId}': no task with that id exists in workspace '${scope}'.`,
        );
      }
    }

    const status = input.status ?? existing.status;
    const priority = input.priority ?? existing.priority;
    // Non-nullable fields use `??` (omit keeps existing); nullable-clearable
    // fields use `=== undefined ? : emptyToNull()` so an explicit null clears
    // the value while an omit leaves it unchanged.
    const dueAt = input.dueAt === undefined ? existing.due_at : emptyToNull(input.dueAt);
    const blockedReason =
      input.blockedReason === undefined ? existing.blocked_reason : emptyToNull(input.blockedReason);
    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const assigneeId =
      input.assigneeId === undefined ? existing.assignee_id : emptyToNull(input.assigneeId);
    const channel =
      input.channel === undefined ? existing.channel : emptyToNull(input.channel);
    const parentTaskId =
      input.parentTaskId === undefined ? existing.parent_task_id : emptyToNull(input.parentTaskId);

    shouldNotifyCreator =
      input.agentId !== existing.creator_id &&
      existing.status !== status &&
      shouldNotifyForStatus(status);

    await tx.run(
      `UPDATE tasks
       SET status = ?, priority = ?, due_at = ?, blocked_reason = ?, title = ?, description = ?, assignee_id = ?, channel = ?, parent_task_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        status,
        priority,
        dueAt,
        blockedReason,
        title,
        description,
        assigneeId,
        channel,
        parentTaskId,
        now,
        input.taskId,
      ],
    );
    await insertArtifacts(tx, "task", input.taskId, input.artifacts ?? []);

    // Emit task events for the fields that actually changed so subscribers and
    // audit logs stay accurate. Status changes emit `status_changed`; other
    // editable-field changes emit `updated`.
    const changedFields: string[] = [];
    if (input.title !== undefined && title !== existing.title) changedFields.push("title");
    if (input.description !== undefined && description !== existing.description) {
      changedFields.push("description");
    }
    if (input.assigneeId !== undefined && assigneeId !== existing.assignee_id) {
      changedFields.push("assignee_id");
    }
    if (input.channel !== undefined && channel !== existing.channel) changedFields.push("channel");
    if (input.parentTaskId !== undefined && parentTaskId !== existing.parent_task_id) {
      changedFields.push("parent_task_id");
    }
    if (input.priority !== undefined && priority !== existing.priority) {
      changedFields.push("priority");
    }
    if (input.dueAt !== undefined && dueAt !== existing.due_at) changedFields.push("due_at");
    if (input.blockedReason !== undefined && blockedReason !== existing.blocked_reason) {
      changedFields.push("blocked_reason");
    }
    if (input.dependencies !== undefined) {
      // Validate each dependency references an existing task in the same
      // workspace before replacing — no silent no-op on unknown ids.
      for (const depId of input.dependencies.filter(Boolean)) {
        if (depId === input.taskId) {
          throw new Error(`Invalid dependency '${depId}': a task cannot depend on itself.`);
        }
        const dep = await getTask(tx, depId);
        if (!dep || dep.workspace !== scope) {
          throw new Error(
            `Invalid dependency '${depId}': no task with that id exists in workspace '${scope}'.`,
          );
        }
      }
      const newDeps = input.dependencies.filter(Boolean).sort();
      const oldDeps = [...existing.dependencies].sort();
      await replaceTaskDependencies(tx, input.taskId, input.dependencies);
      if (JSON.stringify(newDeps) !== JSON.stringify(oldDeps)) {
        changedFields.push("dependencies");
      }
    }

    const statusChanged = existing.status !== status;
    if (statusChanged) {
      await insertTaskEvent(tx, input.taskId, input.agentId, "status_changed", status, input.note);
    }
    if (changedFields.length > 0) {
      const changeNote = [input.note, `Updated: ${changedFields.join(", ")}`]
        .filter(Boolean)
        .join(" | ");
      await insertTaskEvent(tx, input.taskId, input.agentId, "updated", status, changeNote);
    } else if (!statusChanged && input.note) {
      // No field changed, but the caller left a note — record it for the audit trail.
      await insertTaskEvent(tx, input.taskId, input.agentId, "updated", status, input.note);
    }
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
