import type {
  AccessKeyRecord,
  AgentRecord,
  ArtifactRecord,
  LockRecord,
  MessageRecord,
  NoteRecord,
  TaskRecord,
} from "./types";

export interface AgentRow extends Omit<AgentRecord, "metadata"> {
  metadata: string | null;
}

export interface ArtifactRow extends Omit<ArtifactRecord, "metadata"> {
  metadata: string | null;
}

export interface MessageRow extends Omit<MessageRecord, "metadata" | "artifacts" | "unread"> {
  metadata: string | null;
}

export interface ThreadRow {
  thread_id: string;
  workspace: string;
  channel: string | null;
  message_count: number;
  last_message_at: string;
  last_message_body: string;
}

export interface TaskRow extends Omit<TaskRecord, "metadata" | "artifacts" | "dependencies"> {
  metadata: string | null;
}

export interface NoteRow extends Omit<NoteRecord, "metadata" | "artifacts" | "pinned"> {
  metadata: string | null;
  pinned: number;
}

export interface LockRow extends Omit<LockRecord, "expired"> {}

export interface AccessKeyRow extends Omit<AccessKeyRecord, "enabled"> {
  token_hash: string;
  enabled: number;
}

export function mapAgent(row: AgentRow): AgentRecord {
  return {
    ...row,
    workspace: row.workspace || "default",
    status: row.status || "available",
    current_task_id: row.current_task_id ?? null,
    metadata: decodeJson(row.metadata),
  };
}

export function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    ...row,
    metadata: decodeJson(row.metadata),
  };
}

export function mapMessage(
  row: MessageRow,
  agentId: string,
): Omit<MessageRecord, "artifacts"> {
  const readAt = row.read_at ?? null;
  return {
    ...row,
    workspace: row.workspace || "default",
    thread_id: row.thread_id || row.id,
    reply_to_message_id: row.reply_to_message_id ?? null,
    metadata: decodeJson(row.metadata),
    read_at: readAt,
    unread: row.sender_id !== agentId && readAt === null,
  };
}

export function mapTask(row: TaskRow): Omit<TaskRecord, "artifacts" | "dependencies"> {
  return {
    ...row,
    workspace: row.workspace || "default",
    priority: Number(row.priority ?? 0),
    due_at: row.due_at ?? null,
    parent_task_id: row.parent_task_id ?? null,
    blocked_reason: row.blocked_reason ?? null,
    metadata: decodeJson(row.metadata),
  };
}

export function mapNote(row: NoteRow): Omit<NoteRecord, "artifacts"> {
  return {
    ...row,
    workspace: row.workspace || "default",
    pinned: Boolean(row.pinned),
    metadata: decodeJson(row.metadata),
  };
}

export function mapLock(row: LockRow): LockRecord {
  return {
    ...row,
    workspace: row.workspace || "default",
    expired: row.expires_at <= isoNow(),
  };
}

export function mapAccessKey(row: AccessKeyRow): AccessKeyRecord {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    workspace: row.workspace || "default",
    enabled: Boolean(row.enabled),
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function decodeJson(value: string | null): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { invalid_json_metadata: true };
  }
}

export function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function workspaceOf(value: string | undefined | null): string {
  return value?.trim() || "default";
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function limit(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 1000);
}

export function offset(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(Math.trunc(value), 0);
}

export function hasMore(offsetValue: number, resultCount: number, total: number): boolean {
  return offsetValue + resultCount < total;
}

export function ttlSeconds(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 900;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 86_400);
}

export function durationSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 3_600;
  }
  return Math.min(Math.trunc(value), 2_592_000);
}

export function shouldNotifyForStatus(status: TaskRecord["status"]): boolean {
  return status === "done" || status === "blocked" || status === "cancelled";
}

export function generateAccessToken(): string {
  return `amb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function tokenPrefix(token: string): string {
  if (token.length <= 8) {
    return `${token.slice(0, 2)}...${token.slice(-2)}`;
  }
  if (token.length <= 12) {
    return `${token.slice(0, 4)}...${token.slice(-2)}`;
  }
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
