import type { SQLQueryBindings } from "bun:sqlite";
import type { StoreContext } from "./context";
import { emptyToNull, encodeJson, isoNow, mapAgent, workspaceOf, type AgentRow } from "./mappers";
import type { AgentRecord, RegisterAgentInput } from "./types";

export function registerAgent(ctx: StoreContext, input: RegisterAgentInput): AgentRecord {
  const now = isoNow();
  const workspace = workspaceOf(input.workspace);
  const name = input.name?.trim() || input.id;
  const status = input.status?.trim() || "available";
  const metadata = encodeJson(input.metadata ?? {});

  ctx.run(
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

  const agent = getAgent(ctx, input.id, workspace);
  if (!agent) {
    throw new Error(`Failed to register agent '${input.id}'.`);
  }
  return agent;
}

export function listAgents(ctx: Pick<StoreContext, "all">, workspace?: string): AgentRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (workspace) {
    clauses.push("workspace = ?");
    params.push(workspaceOf(workspace));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return ctx.all<AgentRow>(
    `SELECT * FROM agents ${where} ORDER BY last_seen_at DESC, id ASC`,
    params,
  ).map(mapAgent);
}

export function whoIsOnline(
  ctx: Pick<StoreContext, "all">,
  workspace?: string,
  activeWithinSeconds = 300,
): AgentRecord[] {
  const cutoff = new Date(Date.now() - activeWithinSeconds * 1000).toISOString();
  const clauses = ["last_seen_at >= ?"];
  const params: SQLQueryBindings[] = [cutoff];
  if (workspace) {
    clauses.push("workspace = ?");
    params.push(workspaceOf(workspace));
  }
  return ctx.all<AgentRow>(
    `SELECT * FROM agents
     WHERE ${clauses.join(" AND ")}
     ORDER BY last_seen_at DESC, id ASC`,
    params,
  ).map(mapAgent);
}

export function getAgent(
  ctx: Pick<StoreContext, "get">,
  id: string,
  workspace?: string,
): AgentRecord | null {
  const row = workspace
    ? ctx.get<AgentRow>(`SELECT * FROM agents WHERE id = ? AND workspace = ?`, [
        id,
        workspaceOf(workspace),
      ])
    : ctx.get<AgentRow>(
        `SELECT * FROM agents WHERE id = ? ORDER BY last_seen_at DESC, workspace ASC LIMIT 1`,
        [id],
      );
  return row ? mapAgent(row) : null;
}
