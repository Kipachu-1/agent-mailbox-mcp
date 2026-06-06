import type { SQLQueryBindings } from "bun:sqlite";

export interface StoreRunResult {
  changes: number;
}

export interface StoreContext {
  all<T>(sql: string, params: SQLQueryBindings[]): T[];
  exec(sql: string): void;
  get<T>(sql: string, params: SQLQueryBindings[]): T | null;
  run(sql: string, params: SQLQueryBindings[]): StoreRunResult;
}

export function visibleMessageClause(includeSent: boolean): string {
  const senderClause = includeSent ? " OR m.sender_id = ?" : "";
  return `(m.workspace = ? AND (m.recipient_id = ? OR m.channel IS NOT NULL${senderClause}))`;
}

export function visibleTaskClause(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `(${prefix}creator_id = ? OR ${prefix}assignee_id = ? OR ${prefix}assignee_id IS NULL OR ${prefix}channel IS NOT NULL)`;
}
