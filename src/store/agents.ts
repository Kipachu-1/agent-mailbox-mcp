import type { StoreContext, StoreDialect, StoreValue } from "./context";
import {
  emptyToNull,
  encodeJson,
  hasMore,
  isoNow,
  limit,
  mapAgent,
  offset,
  workspaceOf,
  type AgentRow,
} from "./mappers";
import type { AgentRecord, Paginated, RegisterAgentInput } from "./types";

export async function registerAgent(ctx: StoreContext, input: RegisterAgentInput): Promise<AgentRecord> {
  const now = isoNow();
  const workspace = workspaceOf(input.workspace);
  const name = input.name?.trim() || input.id;
  const status = input.status?.trim() || "available";
  const metadata = encodeJson(input.metadata ?? {});

  await ctx.run(
    `INSERT INTO agents
       (id, name, workspace, status, current_task_id, metadata, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace, id) DO UPDATE SET
       name = excluded.name,
       status = excluded.status,
       current_task_id = excluded.current_task_id,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
    [
      input.id,
      name,
      workspace,
      status,
      emptyToNull(input.currentTaskId),
      metadata,
      now,
      now,
      now,
    ],
  );

  const agent = await getAgent(ctx, input.id, workspace);
  if (!agent) {
    throw new Error(`Failed to register agent '${input.id}'.`);
  }
  return agent;
}

export async function listAgents(
  ctx: Pick<StoreContext, "all" | "dialect">,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
): Promise<AgentRecord[]> {
  const { where, params } = agentsWhere(workspace);
  const suffix = agentsLimitOffset(ctx.dialect, limitValue, offsetValue);
  return (await ctx.all<AgentRow>(
    `SELECT * FROM agents${where} ORDER BY last_seen_at DESC, id ASC${suffix.sql}`,
    [...params, ...suffix.params],
  )).map(mapAgent);
}

export async function listAgentsPaginated(
  ctx: Pick<StoreContext, "all" | "get" | "dialect">,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
): Promise<Paginated<AgentRecord>> {
  const { where, params } = agentsWhere(workspace);
  const offsetValueResolved = offset(offsetValue);
  const suffix = agentsLimitOffset(ctx.dialect, limitValue, offsetValueResolved);
  const [rows, totalRow] = await Promise.all([
    ctx.all<AgentRow>(
      `SELECT * FROM agents${where} ORDER BY last_seen_at DESC, id ASC${suffix.sql}`,
      [...params, ...suffix.params],
    ),
    ctx.get<{ c: number }>(`SELECT COUNT(*) AS c FROM agents${where}`, params),
  ]);
  const results = rows.map(mapAgent);
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValueResolved, results.length, total) };
}

function agentsWhere(
  workspace?: string,
): { where: string; params: StoreValue[] } {
  if (!workspace) {
    return { where: "", params: [] };
  }
  return { where: " WHERE workspace = ?", params: [workspaceOf(workspace)] };
}

function agentsLimitOffset(
  dialect: StoreDialect,
  limitValue: number | undefined,
  offsetValue: number | undefined,
): { sql: string; params: StoreValue[] } {
  // `limit` is optional for agents (prior behavior returned all rows).
  // Apply OFFSET on its own when only offset is given so offset-without-limit
  // doesn't silently drop the page position. SQLite requires LIMIT to use
  // OFFSET, so emit `LIMIT -1` (no limit) there; Postgres allows bare OFFSET.
  const resolvedOffset = offset(offsetValue);
  if (limitValue === undefined) {
    if (resolvedOffset === 0) {
      return { sql: "", params: [] };
    }
    if (dialect === "sqlite") {
      return { sql: " LIMIT -1 OFFSET ?", params: [resolvedOffset] };
    }
    return { sql: " OFFSET ?", params: [resolvedOffset] };
  }
  return { sql: " LIMIT ? OFFSET ?", params: [limit(limitValue), resolvedOffset] };
}

export async function whoIsOnline(
  ctx: Pick<StoreContext, "all">,
  workspace?: string,
  activeWithinSeconds = 300,
): Promise<AgentRecord[]> {
  const cutoff = new Date(Date.now() - activeWithinSeconds * 1000).toISOString();
  const clauses = ["last_seen_at >= ?"];
  const params: StoreValue[] = [cutoff];
  if (workspace) {
    clauses.push("workspace = ?");
    params.push(workspaceOf(workspace));
  }
  return (await ctx.all<AgentRow>(
    `SELECT * FROM agents
     WHERE ${clauses.join(" AND ")}
     ORDER BY last_seen_at DESC, id ASC`,
    params,
  )).map(mapAgent);
}

export async function getAgent(
  ctx: Pick<StoreContext, "get">,
  id: string,
  workspace?: string,
): Promise<AgentRecord | null> {
  const row = workspace
    ? await ctx.get<AgentRow>(`SELECT * FROM agents WHERE id = ? AND workspace = ?`, [
        id,
        workspaceOf(workspace),
      ])
    : await ctx.get<AgentRow>(
        `SELECT * FROM agents WHERE id = ? ORDER BY last_seen_at DESC, workspace ASC LIMIT 1`,
        [id],
      );
  return row ? mapAgent(row) : null;
}
