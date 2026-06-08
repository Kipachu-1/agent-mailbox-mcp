export interface StoreRunResult {
  changes: number;
}

export type StoreDialect = "sqlite" | "postgres";
export type StoreValue = string | number | bigint | boolean | null | Uint8Array;

export interface StoreContext {
  readonly dialect: StoreDialect;
  all<T>(sql: string, params: StoreValue[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  get<T>(sql: string, params: StoreValue[]): Promise<T | null>;
  run(sql: string, params: StoreValue[]): Promise<StoreRunResult>;
  transaction<T>(fn: (ctx: StoreContext) => Promise<T>): Promise<T>;
}

export function visibleMessageClause(includeSent: boolean): string {
  const senderClause = includeSent ? " OR m.sender_id = ?" : "";
  return `(m.workspace = ? AND (m.recipient_id = ? OR m.channel IS NOT NULL${senderClause}))`;
}

export function visibleTaskClause(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `(${prefix}creator_id = ? OR ${prefix}assignee_id = ? OR ${prefix}assignee_id IS NULL OR ${prefix}channel IS NOT NULL)`;
}

export function insertOrIgnore(ctx: Pick<StoreContext, "dialect">): string {
  return ctx.dialect === "postgres" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
}

export function doNothingOnConflict(ctx: Pick<StoreContext, "dialect">): string {
  return ctx.dialect === "postgres" ? "ON CONFLICT DO NOTHING" : "";
}

export function caseInsensitiveLike(
  ctx: Pick<StoreContext, "dialect">,
  column: string,
): string {
  return ctx.dialect === "postgres" ? `${column} ILIKE ?` : `${column} LIKE ? COLLATE NOCASE`;
}
