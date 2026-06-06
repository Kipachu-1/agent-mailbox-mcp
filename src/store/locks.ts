import type { SQLQueryBindings } from "bun:sqlite";
import type { StoreContext } from "./context";
import { emptyToNull, isoNow, mapLock, ttlSeconds, workspaceOf, type LockRow } from "./mappers";
import type { AcquireLockInput, ListLocksOptions, LockRecord } from "./types";

export function acquireLock(ctx: StoreContext, input: AcquireLockInput): LockRecord {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const expiresAt = new Date(Date.now() + ttlSeconds(input.ttlSeconds) * 1000).toISOString();

  ctx.exec("BEGIN IMMEDIATE");
  try {
    const existing = getLock(ctx, input.resource, workspace);
    if (existing && !existing.expired && existing.owner_agent_id !== input.agentId) {
      throw new Error(
        `Resource '${input.resource}' is locked by '${existing.owner_agent_id}' until ${existing.expires_at}.`,
      );
    }

    ctx.run(
      `INSERT INTO locks
         (id, workspace, resource, owner_agent_id, purpose, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace, resource) DO UPDATE SET
         owner_agent_id = excluded.owner_agent_id,
         purpose = excluded.purpose,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [
        existing?.id ?? crypto.randomUUID(),
        workspace,
        input.resource,
        input.agentId,
        emptyToNull(input.purpose),
        expiresAt,
        existing?.created_at ?? now,
        now,
      ],
    );
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const lock = getLock(ctx, input.resource, workspace);
  if (!lock) {
    throw new Error(`Failed to acquire lock '${input.resource}'.`);
  }
  return lock;
}

export function releaseLock(
  ctx: StoreContext,
  agentId: string,
  resource: string,
  workspace?: string,
): LockRecord {
  const scope = workspaceOf(workspace);
  const lock = getLock(ctx, resource, scope);
  if (!lock) {
    throw new Error(`Lock '${resource}' does not exist.`);
  }
  if (lock.owner_agent_id !== agentId) {
    throw new Error(`Lock '${resource}' is owned by '${lock.owner_agent_id}'.`);
  }

  ctx.run(`DELETE FROM locks WHERE workspace = ? AND resource = ?`, [scope, resource]);
  return lock;
}

export function listLocks(ctx: StoreContext, options: ListLocksOptions = {}): LockRecord[] {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?"];
  const params: SQLQueryBindings[] = [workspace];
  if (options.resource) {
    clauses.push("resource = ?");
    params.push(options.resource);
  }
  addExpiryFilter(clauses, params, options.includeExpired);

  return ctx.all<LockRow>(
    `SELECT * FROM locks
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC`,
    params,
  ).map(mapLock);
}

export function listAllLocks(
  ctx: StoreContext,
  options: Pick<ListLocksOptions, "includeExpired"> = {},
): LockRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  addExpiryFilter(clauses, params, options.includeExpired);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return ctx.all<LockRow>(
    `SELECT * FROM locks
     ${where}
     ORDER BY updated_at DESC`,
    params,
  ).map(mapLock);
}

function getLock(ctx: StoreContext, resource: string, workspace: string): LockRecord | null {
  const row = ctx.get<LockRow>(
    `SELECT * FROM locks WHERE workspace = ? AND resource = ?`,
    [workspace, resource],
  );
  return row ? mapLock(row) : null;
}

function addExpiryFilter(
  clauses: string[],
  params: SQLQueryBindings[],
  includeExpired: boolean | undefined,
): void {
  if (!includeExpired) {
    clauses.push("expires_at > ?");
    params.push(isoNow());
  }
}
