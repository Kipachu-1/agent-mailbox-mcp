import { addDateRange, type StoreContext, type StoreDialect, type StoreValue } from "./context";
import {
  emptyToNull,
  hasMore,
  isoNow,
  limit,
  mapLock,
  offset,
  ttlSeconds,
  workspaceOf,
  type LockRow,
} from "./mappers";
import type { AcquireLockInput, ListLocksOptions, LockRecord, Paginated } from "./types";

export async function acquireLock(ctx: StoreContext, input: AcquireLockInput): Promise<LockRecord> {
  const workspace = workspaceOf(input.workspace);
  const now = isoNow();
  const expiresAt = new Date(Date.now() + ttlSeconds(input.ttlSeconds) * 1000).toISOString();

  await ctx.transaction(async (tx) => {
    if (tx.dialect === "postgres") {
      await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`${workspace}:${input.resource}`]);
    }
    const existing = await getLock(tx, input.resource, workspace);
    if (existing && !existing.expired && existing.owner_agent_id !== input.agentId) {
      throw new Error(
        `Resource '${input.resource}' is locked by '${existing.owner_agent_id}' until ${existing.expires_at}.`,
      );
    }

    await tx.run(
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
  });

  const lock = await getLock(ctx, input.resource, workspace);
  if (!lock) {
    throw new Error(`Failed to acquire lock '${input.resource}'.`);
  }
  return lock;
}

export async function releaseLock(
  ctx: StoreContext,
  agentId: string,
  resource: string,
  workspace?: string,
): Promise<LockRecord> {
  const scope = workspaceOf(workspace);
  const lock = await getLock(ctx, resource, scope);
  if (!lock) {
    throw new Error(`Lock '${resource}' does not exist.`);
  }
  if (lock.owner_agent_id !== agentId) {
    throw new Error(`Lock '${resource}' is owned by '${lock.owner_agent_id}'.`);
  }

  await ctx.run(`DELETE FROM locks WHERE workspace = ? AND resource = ?`, [scope, resource]);
  return lock;
}

export async function listLocks(
  ctx: StoreContext,
  options: ListLocksOptions = {},
): Promise<LockRecord[]> {
  const { clauses, params } = listLocksWhere(options);
  const suffix = locksLimitOffset(ctx.dialect, options.limit, options.offset);
  return (await ctx.all<LockRow>(
    `SELECT * FROM locks
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC${suffix.sql}`,
    [...params, ...suffix.params],
  )).map(mapLock);
}

export async function listLocksPaginated(
  ctx: StoreContext,
  options: ListLocksOptions = {},
): Promise<Paginated<LockRecord>> {
  const { clauses, params } = listLocksWhere(options);
  const offsetValue = offset(options.offset);
  const suffix = locksLimitOffset(ctx.dialect, options.limit, offsetValue);
  const [rows, totalRow] = await Promise.all([
    ctx.all<LockRow>(
      `SELECT * FROM locks
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC${suffix.sql}`,
      [...params, ...suffix.params],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM locks WHERE ${clauses.join(" AND ")}`,
      params,
    ),
  ]);
  const results = rows.map(mapLock);
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValue, results.length, total) };
}

function listLocksWhere(
  options: ListLocksOptions,
): { clauses: string[]; params: StoreValue[] } {
  const workspace = workspaceOf(options.workspace);
  const clauses = ["workspace = ?"];
  const params: StoreValue[] = [workspace];
  if (options.resource) {
    clauses.push("resource = ?");
    params.push(options.resource);
  }
  addExpiryFilter(clauses, params, options.includeExpired);
  addDateRange(clauses, params, "updated_at", options.since, options.until);
  return { clauses, params };
}

function locksLimitOffset(
  dialect: StoreDialect,
  limitValue: number | undefined,
  offsetValue: number | undefined,
): { sql: string; params: StoreValue[] } {
  // `limit` is optional for locks (prior behavior returned all rows).
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

export async function listAllLocks(
  ctx: StoreContext,
  options: Pick<ListLocksOptions, "includeExpired"> = {},
): Promise<LockRecord[]> {
  const clauses: string[] = [];
  const params: StoreValue[] = [];
  addExpiryFilter(clauses, params, options.includeExpired);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return (await ctx.all<LockRow>(
    `SELECT * FROM locks
     ${where}
     ORDER BY updated_at DESC`,
    params,
  )).map(mapLock);
}

async function getLock(ctx: StoreContext, resource: string, workspace: string): Promise<LockRecord | null> {
  const row = await ctx.get<LockRow>(
    `SELECT * FROM locks WHERE workspace = ? AND resource = ?`,
    [workspace, resource],
  );
  return row ? mapLock(row) : null;
}

function addExpiryFilter(
  clauses: string[],
  params: StoreValue[],
  includeExpired: boolean | undefined,
): void {
  if (!includeExpired) {
    clauses.push("expires_at > ?");
    params.push(isoNow());
  }
}
