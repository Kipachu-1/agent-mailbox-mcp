import { mkdirSync } from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { dbDirectory, defaultDbPath } from "./config";

export type MessageKind = "direct" | "channel";
export type TaskStatus = "open" | "claimed" | "done" | "blocked" | "cancelled";
export type ArtifactType = "file" | "url" | "diff" | "screenshot" | "log" | "command" | "other";

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

interface AgentRow extends Omit<AgentRecord, "metadata"> {
  metadata: string | null;
}

interface ArtifactRow extends Omit<ArtifactRecord, "metadata"> {
  metadata: string | null;
}

interface MessageRow extends Omit<MessageRecord, "metadata" | "artifacts" | "unread"> {
  metadata: string | null;
}

interface ThreadRow {
  thread_id: string;
  workspace: string;
  channel: string | null;
  message_count: number;
  last_message_at: string;
  last_message_body: string;
}

interface TaskRow extends Omit<TaskRecord, "metadata" | "artifacts" | "dependencies"> {
  metadata: string | null;
}

interface NoteRow extends Omit<NoteRecord, "metadata" | "artifacts" | "pinned"> {
  metadata: string | null;
  pinned: number;
}

interface LockRow extends Omit<LockRecord, "expired"> {}

interface AccessKeyRow extends Omit<AccessKeyRecord, "enabled"> {
  token_hash: string;
  enabled: number;
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
}

export interface SearchMessagesOptions {
  workspace?: string;
  query: string;
  channel?: string;
  limit?: number;
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
}

export interface UpdateTaskInput {
  agentId: string;
  workspace?: string;
  taskId: string;
  status: TaskStatus;
  note?: string;
  priority?: number;
  dueAt?: string | null;
  blockedReason?: string | null;
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
}

export interface ReadNotesOptions {
  workspace?: string;
  channel?: string;
  pinnedOnly?: boolean;
  query?: string;
  limit?: number;
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
}

export interface CreateAccessKeyInput {
  name: string;
  agentId: string;
  agentName?: string;
  workspace?: string;
  token?: string;
}

export class LocalCommsStore {
  private readonly db: Database;

  constructor(readonly path: string = defaultDbPath()) {
    mkdirSync(dbDirectory(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.configure();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  registerAgent(input: RegisterAgentInput): AgentRecord {
    const now = isoNow();
    const workspace = workspaceOf(input.workspace);
    const name = input.name?.trim() || input.id;
    const status = input.status?.trim() || "available";
    const metadata = encodeJson(input.metadata ?? {});

    this.run(
      `INSERT INTO agents
         (id, name, workspace, status, current_task_id, metadata, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         workspace = excluded.workspace,
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

    const agent = this.getAgent(input.id);
    if (!agent) {
      throw new Error(`Failed to register agent '${input.id}'.`);
    }
    return agent;
  }

  heartbeat(input: RegisterAgentInput): AgentRecord {
    return this.registerAgent(input);
  }

  listAgents(workspace?: string): AgentRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (workspace) {
      clauses.push("workspace = ?");
      params.push(workspaceOf(workspace));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.all<AgentRow>(
      `SELECT * FROM agents ${where} ORDER BY last_seen_at DESC, id ASC`,
      params,
    ).map(mapAgent);
  }

  whoIsOnline(workspace?: string, activeWithinSeconds = 300): AgentRecord[] {
    const cutoff = new Date(Date.now() - activeWithinSeconds * 1000).toISOString();
    const clauses = ["last_seen_at >= ?"];
    const params: SQLQueryBindings[] = [cutoff];
    if (workspace) {
      clauses.push("workspace = ?");
      params.push(workspaceOf(workspace));
    }
    return this.all<AgentRow>(
      `SELECT * FROM agents
       WHERE ${clauses.join(" AND ")}
       ORDER BY last_seen_at DESC, id ASC`,
      params,
    ).map(mapAgent);
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.get<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    return row ? mapAgent(row) : null;
  }

  sendMessage(input: SendMessageInput): MessageRecord {
    const workspace = workspaceOf(input.workspace);
    const recipientId = emptyToNull(input.recipientId);
    const channel = emptyToNull(input.channel);
    if ((recipientId && channel) || (!recipientId && !channel)) {
      throw new Error("send_message requires exactly one of recipient_id or channel.");
    }

    const now = isoNow();
    const id = crypto.randomUUID();
    const reply = input.replyToMessageId
      ? this.getMessageForAgent(input.senderId, input.replyToMessageId, workspace)
      : null;
    if (input.replyToMessageId && !reply) {
      throw new Error(`Message '${input.replyToMessageId}' is not visible for replies.`);
    }
    const threadId = input.threadId?.trim() || reply?.thread_id || id;

    this.exec("BEGIN IMMEDIATE");
    try {
      this.run(
        `INSERT INTO messages
           (id, workspace, kind, thread_id, reply_to_message_id, sender_id, recipient_id, channel, body, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspace,
          recipientId ? "direct" : "channel",
          threadId,
          emptyToNull(input.replyToMessageId),
          input.senderId,
          recipientId,
          channel,
          input.body,
          encodeJson(input.metadata ?? {}),
          now,
        ],
      );
      this.insertArtifacts("message", id, input.artifacts ?? []);
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const message = this.getMessageForAgent(input.senderId, id, workspace);
    if (!message) {
      throw new Error(`Failed to create message '${id}'.`);
    }
    return message;
  }

  replyMessage(input: ReplyMessageInput): MessageRecord {
    const workspace = workspaceOf(input.workspace);
    const original = this.getMessageForAgent(input.senderId, input.messageId, workspace);
    if (!original) {
      throw new Error(`Message '${input.messageId}' is not visible to agent '${input.senderId}'.`);
    }

    if (original.channel) {
      return this.sendMessage({
        senderId: input.senderId,
        workspace,
        channel: original.channel,
        body: input.body,
        threadId: original.thread_id,
        replyToMessageId: original.id,
        metadata: input.metadata,
        artifacts: input.artifacts,
      });
    }

    const recipientId =
      original.sender_id === input.senderId ? original.recipient_id : original.sender_id;
    if (!recipientId) {
      throw new Error(`Message '${input.messageId}' has no reply recipient.`);
    }

    return this.sendMessage({
      senderId: input.senderId,
      workspace,
      recipientId,
      body: input.body,
      threadId: original.thread_id,
      replyToMessageId: original.id,
      metadata: input.metadata,
      artifacts: input.artifacts,
    });
  }

  inbox(agentId: string, options: InboxOptions = {}): MessageRecord[] {
    const workspace = workspaceOf(options.workspace);
    const clauses = [visibleMessageClause(options.includeSent !== false)];
    const params: SQLQueryBindings[] = [agentId, workspace, agentId];

    if (options.includeSent !== false) {
      params.push(agentId);
    }
    if (options.channel) {
      clauses.push("m.channel = ?");
      params.push(options.channel);
    }
    if (options.threadId) {
      clauses.push("m.thread_id = ?");
      params.push(options.threadId);
    }
    if (options.unreadOnly) {
      clauses.push("m.sender_id != ? AND r.read_at IS NULL");
      params.push(agentId);
    }

    params.push(limit(options.limit));
    return this.all<MessageRow>(
      `SELECT m.*, r.read_at
       FROM messages m
       LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.messageWithRelations(row, agentId));
  }

  readMessage(agentId: string, messageId: string, workspace?: string): MessageRecord {
    const message = this.getMessageForAgent(agentId, messageId, workspaceOf(workspace));
    if (!message) {
      throw new Error(`Message '${messageId}' is not visible to agent '${agentId}'.`);
    }

    const now = isoNow();
    this.run(
      `INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at)
       VALUES (?, ?, ?)`,
      [messageId, agentId, now],
    );

    const readMessage = this.getMessageForAgent(agentId, messageId, workspaceOf(workspace));
    if (!readMessage) {
      throw new Error(`Message '${messageId}' disappeared after reading.`);
    }
    return readMessage;
  }

  searchMessages(agentId: string, options: SearchMessagesOptions): MessageRecord[] {
    const workspace = workspaceOf(options.workspace);
    const clauses = [visibleMessageClause(true), "m.body LIKE ? COLLATE NOCASE"];
    const params: SQLQueryBindings[] = [agentId, workspace, agentId, agentId, `%${options.query}%`];

    if (options.channel) {
      clauses.push("m.channel = ?");
      params.push(options.channel);
    }

    params.push(limit(options.limit));
    return this.all<MessageRow>(
      `SELECT m.*, r.read_at
       FROM messages m
       LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.messageWithRelations(row, agentId));
  }

  listThreads(agentId: string, workspace?: string, limitValue?: number): ThreadRecord[] {
    const scope = workspaceOf(workspace);
    return this.all<ThreadRow>(
      `SELECT
         m.thread_id,
         m.workspace,
         MAX(m.channel) AS channel,
         COUNT(*) AS message_count,
         MAX(m.created_at) AS last_message_at,
         (
           SELECT body FROM messages latest
           WHERE latest.thread_id = m.thread_id AND latest.workspace = m.workspace
           ORDER BY latest.created_at DESC LIMIT 1
         ) AS last_message_body
       FROM messages m
       WHERE ${visibleMessageClause(true)}
       GROUP BY m.workspace, m.thread_id
       ORDER BY last_message_at DESC
       LIMIT ?`,
      [scope, agentId, agentId, limit(limitValue)],
    ).map((row) => ({ ...row, message_count: Number(row.message_count) }));
  }

  getThread(agentId: string, threadId: string, workspace?: string, limitValue?: number): MessageRecord[] {
    const scope = workspaceOf(workspace);
    return this.all<MessageRow>(
      `SELECT m.*, r.read_at
       FROM messages m
       LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
       WHERE ${visibleMessageClause(true)} AND m.thread_id = ?
       ORDER BY m.created_at ASC, m.rowid ASC
       LIMIT ?`,
      [agentId, scope, agentId, agentId, threadId, limit(limitValue)],
    ).map((row) => this.messageWithRelations(row, agentId));
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const workspace = workspaceOf(input.workspace);
    const now = isoNow();
    const id = crypto.randomUUID();
    this.exec("BEGIN IMMEDIATE");
    try {
      this.run(
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
      this.replaceTaskDependencies(id, input.dependencies ?? []);
      this.insertArtifacts("task", id, input.artifacts ?? []);
      this.insertTaskEvent(id, input.creatorId, "created", "open", "Task created.");
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const task = this.getTask(id);
    if (!task) {
      throw new Error(`Failed to create task '${id}'.`);
    }
    return task;
  }

  listTasks(agentId: string, options: ListTasksOptions = {}): TaskRecord[] {
    const workspace = workspaceOf(options.workspace);
    const clauses = [
      "workspace = ?",
      "(creator_id = ? OR assignee_id = ? OR assignee_id IS NULL OR channel IS NOT NULL)",
    ];
    const params: SQLQueryBindings[] = [workspace, agentId, agentId];

    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.assigneeId) {
      clauses.push("assignee_id = ?");
      params.push(options.assigneeId);
    }
    if (options.creatorId) {
      clauses.push("creator_id = ?");
      params.push(options.creatorId);
    }
    if (options.channel) {
      clauses.push("channel = ?");
      params.push(options.channel);
    }
    if (options.parentTaskId) {
      clauses.push("parent_task_id = ?");
      params.push(options.parentTaskId);
    }
    if (options.staleAfterSeconds !== undefined) {
      clauses.push("status = 'claimed'");
      clauses.push("updated_at <= ?");
      params.push(new Date(Date.now() - durationSeconds(options.staleAfterSeconds) * 1000).toISOString());
    }

    params.push(limit(options.limit));
    return this.all<TaskRow>(
      `SELECT * FROM tasks
       WHERE ${clauses.join(" AND ")}
       ORDER BY priority DESC, updated_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.taskWithRelations(row));
  }

  listAllTasks(options: Omit<ListTasksOptions, "assigneeId" | "creatorId"> = {}): TaskRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (options.workspace) {
      clauses.push("workspace = ?");
      params.push(workspaceOf(options.workspace));
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.channel) {
      clauses.push("channel = ?");
      params.push(options.channel);
    }
    if (options.parentTaskId) {
      clauses.push("parent_task_id = ?");
      params.push(options.parentTaskId);
    }
    if (options.staleAfterSeconds !== undefined) {
      clauses.push("status = 'claimed'");
      clauses.push("updated_at <= ?");
      params.push(new Date(Date.now() - durationSeconds(options.staleAfterSeconds) * 1000).toISOString());
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit(options.limit));
    return this.all<TaskRow>(
      `SELECT * FROM tasks
       ${where}
       ORDER BY priority DESC, updated_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.taskWithRelations(row));
  }

  claimTask(agentId: string, taskId: string, note?: string, workspace?: string): TaskRecord {
    const now = isoNow();
    const scope = workspace ? workspaceOf(workspace) : undefined;
    const workspaceClause = scope ? "AND workspace = ?" : "";
    const params: SQLQueryBindings[] = [agentId, now, taskId];
    if (scope) {
      params.push(scope);
    }
    params.push(agentId);

    this.exec("BEGIN IMMEDIATE");
    try {
      const result = this.run(
        `UPDATE tasks
         SET assignee_id = ?, status = 'claimed', updated_at = ?
         WHERE id = ?
           ${workspaceClause}
           AND status = 'open'
           AND (assignee_id IS NULL OR assignee_id = ?)`,
        params,
      );

      if (result.changes === 0) {
        const existing = this.getTask(taskId);
        if (!existing) {
          throw new Error(`Task '${taskId}' does not exist.`);
        }
        if (scope && existing.workspace !== scope) {
          throw new Error(`Task '${taskId}' is not in workspace '${scope}'.`);
        }
        throw new Error(`Task '${taskId}' cannot be claimed from status '${existing.status}'.`);
      }

      this.insertTaskEvent(taskId, agentId, "claimed", "claimed", note ?? "Task claimed.");
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' disappeared after claiming.`);
    }
    return task;
  }

  updateTask(input: UpdateTaskInput): TaskRecord {
    const now = isoNow();
    let shouldNotifyCreator = false;
    this.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getTask(input.taskId);
      if (!existing) {
        throw new Error(`Task '${input.taskId}' does not exist.`);
      }
      if (input.workspace && existing.workspace !== workspaceOf(input.workspace)) {
        throw new Error(`Task '${input.taskId}' is not in workspace '${workspaceOf(input.workspace)}'.`);
      }

      const priority = input.priority ?? existing.priority;
      const dueAt = input.dueAt === undefined ? existing.due_at : emptyToNull(input.dueAt);
      const blockedReason =
        input.blockedReason === undefined ? existing.blocked_reason : emptyToNull(input.blockedReason);
      shouldNotifyCreator =
        input.agentId !== existing.creator_id &&
        existing.status !== input.status &&
        shouldNotifyForStatus(input.status);

      this.run(
        `UPDATE tasks
         SET status = ?, priority = ?, due_at = ?, blocked_reason = ?, updated_at = ?
         WHERE id = ?`,
        [input.status, priority, dueAt, blockedReason, now, input.taskId],
      );
      this.insertTaskEvent(input.taskId, input.agentId, "status_changed", input.status, input.note);
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const task = this.getTask(input.taskId);
    if (!task) {
      throw new Error(`Task '${input.taskId}' disappeared after updating.`);
    }
    if (shouldNotifyCreator) {
      this.sendTaskStatusNotification(input.agentId, task, input.note);
    }
    return task;
  }

  listTaskEvents(taskId: string): TaskEventRecord[] {
    return this.all<TaskEventRecord>(
      `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId],
    );
  }

  writeNote(input: WriteNoteInput): NoteRecord {
    const workspace = workspaceOf(input.workspace);
    const now = isoNow();
    const id = input.noteId?.trim() || crypto.randomUUID();
    this.exec("BEGIN IMMEDIATE");
    try {
      this.run(
        `INSERT INTO notes
           (id, workspace, channel, title, body, pinned, creator_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace = excluded.workspace,
           channel = excluded.channel,
           title = excluded.title,
           body = excluded.body,
           pinned = excluded.pinned,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
        [
          id,
          workspace,
          emptyToNull(input.channel),
          input.title,
          input.body,
          input.pinned ? 1 : 0,
          input.agentId,
          encodeJson(input.metadata ?? {}),
          now,
          now,
        ],
      );
      this.replaceArtifacts("note", id, input.artifacts ?? []);
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const note = this.getNote(id);
    if (!note) {
      throw new Error(`Failed to write note '${id}'.`);
    }
    return note;
  }

  readNotes(options: ReadNotesOptions = {}): NoteRecord[] {
    const workspace = workspaceOf(options.workspace);
    const clauses = ["workspace = ?"];
    const params: SQLQueryBindings[] = [workspace];

    if (options.channel) {
      clauses.push("channel = ?");
      params.push(options.channel);
    }
    if (options.pinnedOnly) {
      clauses.push("pinned = 1");
    }
    if (options.query) {
      clauses.push("(title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }

    params.push(limit(options.limit));
    return this.all<NoteRow>(
      `SELECT * FROM notes
       WHERE ${clauses.join(" AND ")}
       ORDER BY pinned DESC, updated_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.noteWithRelations(row));
  }

  listAllNotes(options: Omit<ReadNotesOptions, "workspace" | "channel" | "query"> = {}): NoteRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (options.pinnedOnly) {
      clauses.push("pinned = 1");
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit(options.limit));
    return this.all<NoteRow>(
      `SELECT * FROM notes
       ${where}
       ORDER BY pinned DESC, updated_at DESC
       LIMIT ?`,
      params,
    ).map((row) => this.noteWithRelations(row));
  }

  pinNote(noteId: string, pinned: boolean): NoteRecord {
    this.run(`UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?`, [
      pinned ? 1 : 0,
      isoNow(),
      noteId,
    ]);
    const note = this.getNote(noteId);
    if (!note) {
      throw new Error(`Note '${noteId}' does not exist.`);
    }
    return note;
  }

  summarizeChannel(agentId: string, workspace?: string, channel?: string): Record<string, unknown> {
    const scope = workspaceOf(workspace);
    const messages = this.inbox(agentId, { workspace: scope, channel, includeSent: true, limit: 20 });
    const tasks = this.listTasks(agentId, { workspace: scope, channel, limit: 20 });
    const notes = this.readNotes({ workspace: scope, channel, limit: 20 });
    return {
      workspace: scope,
      channel: channel ?? null,
      message_count: messages.length,
      task_count: tasks.length,
      note_count: notes.length,
      recent_messages: messages.slice(0, 5),
      open_tasks: tasks.filter((task) => task.status === "open" || task.status === "claimed"),
      pinned_notes: notes.filter((note) => note.pinned),
    };
  }

  acquireLock(input: AcquireLockInput): LockRecord {
    const workspace = workspaceOf(input.workspace);
    const now = isoNow();
    const expiresAt = new Date(Date.now() + ttlSeconds(input.ttlSeconds) * 1000).toISOString();

    this.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getLock(input.resource, workspace);
      if (
        existing &&
        !existing.expired &&
        existing.owner_agent_id !== input.agentId
      ) {
        throw new Error(
          `Resource '${input.resource}' is locked by '${existing.owner_agent_id}' until ${existing.expires_at}.`,
        );
      }

      this.run(
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
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }

    const lock = this.getLock(input.resource, workspace);
    if (!lock) {
      throw new Error(`Failed to acquire lock '${input.resource}'.`);
    }
    return lock;
  }

  releaseLock(agentId: string, resource: string, workspace?: string): LockRecord {
    const scope = workspaceOf(workspace);
    const lock = this.getLock(resource, scope);
    if (!lock) {
      throw new Error(`Lock '${resource}' does not exist.`);
    }
    if (lock.owner_agent_id !== agentId) {
      throw new Error(`Lock '${resource}' is owned by '${lock.owner_agent_id}'.`);
    }

    this.run(`DELETE FROM locks WHERE workspace = ? AND resource = ?`, [scope, resource]);
    return lock;
  }

  listLocks(options: ListLocksOptions = {}): LockRecord[] {
    const workspace = workspaceOf(options.workspace);
    const clauses = ["workspace = ?"];
    const params: SQLQueryBindings[] = [workspace];
    if (options.resource) {
      clauses.push("resource = ?");
      params.push(options.resource);
    }
    if (!options.includeExpired) {
      clauses.push("expires_at > ?");
      params.push(isoNow());
    }

    return this.all<LockRow>(
      `SELECT * FROM locks
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC`,
      params,
    ).map(mapLock);
  }

  listAllLocks(options: Pick<ListLocksOptions, "includeExpired"> = {}): LockRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (!options.includeExpired) {
      clauses.push("expires_at > ?");
      params.push(isoNow());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.all<LockRow>(
      `SELECT * FROM locks
       ${where}
       ORDER BY updated_at DESC`,
      params,
    ).map(mapLock);
  }

  createAccessKey(input: CreateAccessKeyInput): CreatedAccessKeyRecord {
    const now = isoNow();
    const token = input.token?.trim() || generateAccessToken();
    const id = crypto.randomUUID();
    const keyName = input.name.trim();
    const agentId = input.agentId.trim();
    const agentName = input.agentName?.trim() || agentId;
    const workspace = workspaceOf(input.workspace);
    if (!keyName) {
      throw new Error("Access key name is required.");
    }
    if (!agentId) {
      throw new Error("Access key agent id is required.");
    }
    if (!token) {
      throw new Error("Access key token is required.");
    }
    const hash = tokenHash(token);

    this.run(
      `INSERT INTO access_keys
         (id, token_hash, token_prefix, name, agent_id, agent_name, workspace, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET
         name = excluded.name,
         agent_id = excluded.agent_id,
         agent_name = excluded.agent_name,
         workspace = excluded.workspace,
         enabled = 1,
         updated_at = excluded.updated_at`,
      [
        id,
        hash,
        tokenPrefix(token),
        keyName,
        agentId,
        agentName,
        workspace,
        now,
        now,
      ],
    );

    const key = this.getAccessKeyByHash(hash);
    if (!key) {
      throw new Error(`Failed to create access key '${id}'.`);
    }
    return { key, token };
  }

  listAccessKeys(): AccessKeyRecord[] {
    return this.all<AccessKeyRow>(
      `SELECT * FROM access_keys ORDER BY updated_at DESC, created_at DESC`,
      [],
    ).map(mapAccessKey);
  }

  authenticateAccessToken(token: string): AccessKeyRecord | null {
    const row = this.get<AccessKeyRow>(
      `SELECT * FROM access_keys WHERE token_hash = ? AND enabled = 1`,
      [tokenHash(token)],
    );
    if (!row) {
      return null;
    }

    this.run(`UPDATE access_keys SET last_used_at = ?, updated_at = ? WHERE id = ?`, [
      isoNow(),
      isoNow(),
      row.id,
    ]);
    return this.getAccessKey(row.id);
  }

  revokeAccessKey(id: string): AccessKeyRecord {
    this.run(`UPDATE access_keys SET enabled = 0, updated_at = ? WHERE id = ?`, [isoNow(), id]);
    const key = this.getAccessKey(id);
    if (!key) {
      throw new Error(`Access key '${id}' does not exist.`);
    }
    return key;
  }

  updatesSince(agentId: string, workspace?: string, since?: string): UpdatesRecord {
    const scope = workspaceOf(workspace);
    const sinceValue = since?.trim() || "1970-01-01T00:00:00.000Z";
    return {
      since: sinceValue,
      checked_at: isoNow(),
      messages: this.inbox(agentId, { workspace: scope, includeSent: true, limit: 200 }).filter(
        (message) => message.created_at > sinceValue,
      ),
      tasks: this.listTasks(agentId, { workspace: scope, limit: 200 }).filter(
        (task) => task.updated_at > sinceValue,
      ),
      task_events: this.all<TaskEventRecord>(
        `SELECT e.* FROM task_events e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.workspace = ? AND e.created_at > ?
         ORDER BY e.created_at DESC
         LIMIT 200`,
        [scope, sinceValue],
      ),
      notes: this.readNotes({ workspace: scope, limit: 200 }).filter(
        (note) => note.updated_at > sinceValue,
      ),
      locks: this.listLocks({ workspace: scope, includeExpired: true }).filter(
        (lock) => lock.updated_at > sinceValue,
      ),
    };
  }

  listArtifacts(ownerType: string, ownerId: string): ArtifactRecord[] {
    return this.all<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE owner_type = ? AND owner_id = ?
       ORDER BY created_at ASC`,
      [ownerType, ownerId],
    ).map(mapArtifact);
  }

  private getMessageForAgent(
    agentId: string,
    messageId: string,
    workspace: string,
  ): MessageRecord | null {
    const row = this.get<MessageRow>(
      `SELECT m.*, r.read_at
       FROM messages m
       LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
       WHERE m.id = ? AND ${visibleMessageClause(true)}`,
      [agentId, messageId, workspace, agentId, agentId],
    );
    return row ? this.messageWithRelations(row, agentId) : null;
  }

  private getTask(taskId: string): TaskRecord | null {
    const row = this.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
    return row ? this.taskWithRelations(row) : null;
  }

  private getNote(noteId: string): NoteRecord | null {
    const row = this.get<NoteRow>(`SELECT * FROM notes WHERE id = ?`, [noteId]);
    return row ? this.noteWithRelations(row) : null;
  }

  private getLock(resource: string, workspace: string): LockRecord | null {
    const row = this.get<LockRow>(
      `SELECT * FROM locks WHERE workspace = ? AND resource = ?`,
      [workspace, resource],
    );
    return row ? mapLock(row) : null;
  }

  private getAccessKey(id: string): AccessKeyRecord | null {
    const row = this.get<AccessKeyRow>(`SELECT * FROM access_keys WHERE id = ?`, [id]);
    return row ? mapAccessKey(row) : null;
  }

  private getAccessKeyByHash(hash: string): AccessKeyRecord | null {
    const row = this.get<AccessKeyRow>(`SELECT * FROM access_keys WHERE token_hash = ?`, [hash]);
    return row ? mapAccessKey(row) : null;
  }

  private insertTaskEvent(
    taskId: string,
    agentId: string,
    eventType: string,
    status: TaskStatus,
    note?: string,
  ): void {
    this.run(
      `INSERT INTO task_events (id, task_id, agent_id, event_type, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), taskId, agentId, eventType, status, emptyToNull(note), isoNow()],
    );
  }

  private replaceTaskDependencies(taskId: string, dependencies: string[]): void {
    this.run(`DELETE FROM task_dependencies WHERE task_id = ?`, [taskId]);
    for (const dependency of dependencies.filter(Boolean)) {
      this.run(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
         VALUES (?, ?)`,
        [taskId, dependency],
      );
    }
  }

  private taskDependencies(taskId: string): string[] {
    return this.all<{ depends_on_task_id: string }>(
      `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id`,
      [taskId],
    ).map((row) => row.depends_on_task_id);
  }

  private replaceArtifacts(ownerType: string, ownerId: string, artifacts: ArtifactInput[]): void {
    this.run(`DELETE FROM artifacts WHERE owner_type = ? AND owner_id = ?`, [ownerType, ownerId]);
    this.insertArtifacts(ownerType, ownerId, artifacts);
  }

  private insertArtifacts(ownerType: string, ownerId: string, artifacts: ArtifactInput[]): void {
    for (const artifact of artifacts) {
      this.run(
        `INSERT INTO artifacts
           (id, owner_type, owner_id, type, label, path, url, line, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          ownerType,
          ownerId,
          artifact.type,
          emptyToNull(artifact.label),
          emptyToNull(artifact.path),
          emptyToNull(artifact.url),
          artifact.line ?? null,
          encodeJson(artifact.metadata ?? {}),
          isoNow(),
        ],
      );
    }
  }

  private sendTaskStatusNotification(agentId: string, task: TaskRecord, note?: string): void {
    if (agentId === task.creator_id) {
      return;
    }

    const statusLabel = task.status === "done" ? "completed" : task.status;
    const noteText = note?.trim() ? `\n\nNote: ${note.trim()}` : "";
    this.sendMessage({
      senderId: agentId,
      workspace: task.workspace,
      recipientId: task.creator_id,
      body: `Task ${statusLabel}: ${task.title}${noteText}`,
      metadata: {
        system_generated: true,
        event_type: "task_status_notification",
        task_id: task.id,
        task_status: task.status,
      },
      artifacts: task.artifacts.map((artifact) => ({
        type: artifact.type,
        label: artifact.label ?? undefined,
        path: artifact.path ?? undefined,
        url: artifact.url ?? undefined,
        line: artifact.line ?? undefined,
        metadata: artifact.metadata,
      })),
    });
  }

  private messageWithRelations(row: MessageRow, agentId: string): MessageRecord {
    return {
      ...mapMessage(row, agentId),
      artifacts: this.listArtifacts("message", row.id),
    };
  }

  private taskWithRelations(row: TaskRow): TaskRecord {
    return {
      ...mapTask(row),
      dependencies: this.taskDependencies(row.id),
      artifacts: this.listArtifacts("task", row.id),
    };
  }

  private noteWithRelations(row: NoteRow): NoteRecord {
    return {
      ...mapNote(row),
      artifacts: this.listArtifacts("note", row.id),
    };
  }

  private configure(): void {
    this.exec("PRAGMA journal_mode = WAL");
    this.exec("PRAGMA busy_timeout = 5000");
    this.exec("PRAGMA foreign_keys = ON");
  }

  private migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'available',
        current_task_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'channel')),
        thread_id TEXT NOT NULL,
        reply_to_message_id TEXT,
        sender_id TEXT NOT NULL,
        recipient_id TEXT,
        channel TEXT,
        body TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        CHECK (
          (recipient_id IS NOT NULL AND channel IS NULL)
          OR (recipient_id IS NULL AND channel IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS message_reads (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (message_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        creator_id TEXT NOT NULL,
        assignee_id TEXT,
        channel TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'blocked', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        due_at TEXT,
        parent_task_id TEXT,
        blocked_reason TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id)
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'blocked', 'cancelled')),
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT,
        path TEXT,
        url TEXT,
        line INTEGER,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL DEFAULT 'default',
        channel TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        creator_id TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS locks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL DEFAULT 'default',
        resource TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        purpose TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace, resource)
      );

      CREATE TABLE IF NOT EXISTS access_keys (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("agents", "workspace", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("agents", "status", "TEXT NOT NULL DEFAULT 'available'");
    this.ensureColumn("agents", "current_task_id", "TEXT");
    this.ensureColumn("messages", "workspace", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("messages", "thread_id", "TEXT");
    this.ensureColumn("messages", "reply_to_message_id", "TEXT");
    this.ensureColumn("tasks", "workspace", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("tasks", "priority", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "due_at", "TEXT");
    this.ensureColumn("tasks", "parent_task_id", "TEXT");
    this.ensureColumn("tasks", "blocked_reason", "TEXT");
    this.run(`UPDATE messages SET thread_id = id WHERE thread_id IS NULL OR thread_id = ''`, []);

    this.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_workspace_seen ON agents(workspace, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workspace_thread_created ON messages(workspace, thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(workspace, channel, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_updated ON tasks(workspace, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee_updated ON tasks(assignee_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_notes_workspace_channel_updated ON notes(workspace, channel, updated_at);
      CREATE INDEX IF NOT EXISTS idx_locks_workspace_resource ON locks(workspace, resource);
      CREATE INDEX IF NOT EXISTS idx_access_keys_agent_workspace ON access_keys(agent_id, workspace);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`, []);
    if (!columns.some((item) => item.name === column)) {
      this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private exec(sql: string): void {
    this.db.exec(sql);
  }

  private run(sql: string, params: SQLQueryBindings[]) {
    return this.db.query(sql).run(...params);
  }

  private get<T>(sql: string, params: SQLQueryBindings[]): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...params);
  }

  private all<T>(sql: string, params: SQLQueryBindings[]): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...params);
  }
}

function visibleMessageClause(includeSent: boolean): string {
  const senderClause = includeSent ? " OR m.sender_id = ?" : "";
  return `(m.workspace = ? AND (m.recipient_id = ? OR m.channel IS NOT NULL${senderClause}))`;
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    ...row,
    workspace: row.workspace || "default",
    status: row.status || "available",
    current_task_id: row.current_task_id ?? null,
    metadata: decodeJson(row.metadata),
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    ...row,
    metadata: decodeJson(row.metadata),
  };
}

function mapMessage(row: MessageRow, agentId: string): Omit<MessageRecord, "artifacts"> {
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

function mapTask(row: TaskRow): Omit<TaskRecord, "artifacts" | "dependencies"> {
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

function mapNote(row: NoteRow): Omit<NoteRecord, "artifacts"> {
  return {
    ...row,
    workspace: row.workspace || "default",
    pinned: Boolean(row.pinned),
    metadata: decodeJson(row.metadata),
  };
}

function mapLock(row: LockRow): LockRecord {
  return {
    ...row,
    workspace: row.workspace || "default",
    expired: row.expires_at <= isoNow(),
  };
}

function mapAccessKey(row: AccessKeyRow): AccessKeyRecord {
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

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function decodeJson(value: string | null): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function workspaceOf(value: string | undefined | null): string {
  return value?.trim() || "default";
}

function isoNow(): string {
  return new Date().toISOString();
}

function limit(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

function ttlSeconds(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 900;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 86_400);
}

function durationSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 3_600;
  }
  return Math.min(Math.trunc(value), 2_592_000);
}

function shouldNotifyForStatus(status: TaskStatus): boolean {
  return status === "done" || status === "blocked" || status === "cancelled";
}

function generateAccessToken(): string {
  return `amb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function tokenPrefix(token: string): string {
  if (token.length <= 8) {
    return `${token.slice(0, 2)}...${token.slice(-2)}`;
  }
  if (token.length <= 12) {
    return `${token.slice(0, 4)}...${token.slice(-2)}`;
  }
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
