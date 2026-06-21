export type MessageKind = "direct" | "channel";
export type TaskStatus = "open" | "claimed" | "done" | "blocked" | "cancelled";
export type ArtifactType = "file" | "url" | "diff" | "screenshot" | "log" | "command" | "other";
export type ArtifactOwnerType = "message" | "task" | "note";

/**
 * Paginated result envelope returned by list tools.
 * - `results`: the page of rows (already mapped to records).
 * - `total`: count of all rows matching the filter, ignoring offset/limit.
 * - `has_more`: true iff `offset + results.length < total`.
 */
export interface Paginated<T> {
  results: T[];
  total: number;
  has_more: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  workspace: string;
  status: string;
  current_task_id: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface ArtifactInput {
  type: ArtifactType;
  label?: string;
  path?: string;
  url?: string;
  line?: number;
  metadata?: unknown;
}

export interface ArtifactRecord {
  id: string;
  owner_type: string;
  owner_id: string;
  type: ArtifactType;
  label: string | null;
  path: string | null;
  url: string | null;
  line: number | null;
  metadata: unknown;
  created_at: string;
}

export interface MessageRecord {
  id: string;
  workspace: string;
  kind: MessageKind;
  thread_id: string;
  reply_to_message_id: string | null;
  sender_id: string;
  recipient_id: string | null;
  channel: string | null;
  body: string;
  metadata: unknown;
  artifacts: ArtifactRecord[];
  created_at: string;
  read_at?: string | null;
  unread?: boolean;
}

export interface ThreadRecord {
  thread_id: string;
  workspace: string;
  channel: string | null;
  message_count: number;
  last_message_at: string;
  last_message_body: string;
}

export interface TaskRecord {
  id: string;
  workspace: string;
  title: string;
  description: string;
  creator_id: string;
  assignee_id: string | null;
  channel: string | null;
  status: TaskStatus;
  priority: number;
  due_at: string | null;
  parent_task_id: string | null;
  blocked_reason: string | null;
  dependencies: string[];
  metadata: unknown;
  artifacts: ArtifactRecord[];
  created_at: string;
  updated_at: string;
}

export interface TaskEventRecord {
  id: string;
  task_id: string;
  agent_id: string;
  event_type: string;
  status: TaskStatus;
  note: string | null;
  created_at: string;
}

export interface NoteRecord {
  id: string;
  workspace: string;
  channel: string | null;
  title: string;
  body: string;
  pinned: boolean;
  creator_id: string;
  metadata: unknown;
  artifacts: ArtifactRecord[];
  created_at: string;
  updated_at: string;
}

export interface LockRecord {
  id: string;
  workspace: string;
  resource: string;
  owner_agent_id: string;
  purpose: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  expired: boolean;
}

export interface AccessKeyRecord {
  id: string;
  name: string;
  token_prefix: string;
  agent_id: string;
  agent_name: string;
  workspace: string;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatedAccessKeyRecord {
  key: AccessKeyRecord;
  token: string;
}

export interface UpdatesRecord {
  since: string;
  checked_at: string;
  messages: MessageRecord[];
  tasks: TaskRecord[];
  task_events: TaskEventRecord[];
  notes: NoteRecord[];
  locks: LockRecord[];
}

export interface RegisterAgentInput {
  id: string;
  name?: string;
  workspace?: string;
  status?: string;
  currentTaskId?: string;
  metadata?: unknown;
}

export interface SendMessageInput {
  senderId: string;
  workspace?: string;
  recipientId?: string;
  channel?: string;
  body: string;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: unknown;
  artifacts?: ArtifactInput[];
}

export interface ReplyMessageInput {
  senderId: string;
  workspace?: string;
  messageId: string;
  body: string;
  metadata?: unknown;
  artifacts?: ArtifactInput[];
}

export interface InboxOptions {
  workspace?: string;
  unreadOnly?: boolean;
  includeSent?: boolean;
  channel?: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}

export interface SearchMessagesOptions {
  workspace?: string;
  query: string;
  channel?: string;
  limit?: number;
  offset?: number;
}

export interface CreateTaskInput {
  creatorId: string;
  workspace?: string;
  title: string;
  description?: string;
  assigneeId?: string;
  channel?: string;
  priority?: number;
  dueAt?: string;
  parentTaskId?: string;
  blockedReason?: string;
  dependencies?: string[];
  metadata?: unknown;
  artifacts?: ArtifactInput[];
}

export interface ListTasksOptions {
  workspace?: string;
  status?: TaskStatus;
  assigneeId?: string;
  creatorId?: string;
  channel?: string;
  parentTaskId?: string;
  staleAfterSeconds?: number;
  limit?: number;
  offset?: number;
}

export interface ListTaskEventsOptions {
  workspace?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateTaskInput {
  agentId: string;
  workspace?: string;
  taskId: string;
  status?: TaskStatus;
  note?: string;
  title?: string;
  description?: string;
  assigneeId?: string | null;
  channel?: string | null;
  parentTaskId?: string | null;
  dependencies?: string[];
  priority?: number;
  dueAt?: string | null;
  blockedReason?: string | null;
  artifacts?: ArtifactInput[];
}

export interface WriteNoteInput {
  agentId: string;
  workspace?: string;
  noteId?: string;
  channel?: string;
  title: string;
  body: string;
  pinned?: boolean;
  metadata?: unknown;
  artifacts?: ArtifactInput[];
  /**
   * When updating an existing note, controls how `artifacts` are applied.
   * Defaults to `false` (append): passed artifacts are added to the note's
   * existing ones, and existing ones are preserved. Set to `true` to fully
   * replace the note's artifact set. Ignored when creating a new note.
   */
  replaceArtifacts?: boolean;
}

export interface ReadNotesOptions {
  workspace?: string;
  channel?: string;
  pinnedOnly?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface AcquireLockInput {
  agentId: string;
  workspace?: string;
  resource: string;
  purpose?: string;
  ttlSeconds?: number;
}

export interface ListLocksOptions {
  workspace?: string;
  includeExpired?: boolean;
  resource?: string;
  limit?: number;
  offset?: number;
}

export interface CreateAccessKeyInput {
  name: string;
  agentId: string;
  agentName?: string;
  workspace?: string;
  token?: string;
}
