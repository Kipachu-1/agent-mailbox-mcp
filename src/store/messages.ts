import type { SQLQueryBindings } from "bun:sqlite";
import { insertArtifacts, listArtifacts } from "./artifacts";
import { visibleMessageClause } from "./context";
import type { StoreContext } from "./context";
import { emptyToNull, encodeJson, isoNow, limit, mapMessage, type MessageRow, type ThreadRow } from "./mappers";
import type {
  InboxOptions,
  MessageRecord,
  ReplyMessageInput,
  SearchMessagesOptions,
  SendMessageInput,
  ThreadRecord,
} from "./types";

export function sendMessage(ctx: StoreContext, input: SendMessageInput): MessageRecord {
  const workspace = input.workspace?.trim() || "default";
  const recipientId = emptyToNull(input.recipientId);
  const channel = emptyToNull(input.channel);
  if ((recipientId && channel) || (!recipientId && !channel)) {
    throw new Error("send_message requires exactly one of recipient_id or channel.");
  }

  const now = isoNow();
  const id = crypto.randomUUID();
  const reply = input.replyToMessageId
    ? getMessageForAgent(ctx, input.senderId, input.replyToMessageId, workspace)
    : null;
  if (input.replyToMessageId && !reply) {
    throw new Error(`Message '${input.replyToMessageId}' is not visible for replies.`);
  }
  const threadId = input.threadId?.trim() || reply?.thread_id || id;

  ctx.exec("BEGIN IMMEDIATE");
  try {
    ctx.run(
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
    insertArtifacts(ctx, "message", id, input.artifacts ?? []);
    ctx.exec("COMMIT");
  } catch (error) {
    ctx.exec("ROLLBACK");
    throw error;
  }

  const message = getMessageForAgent(ctx, input.senderId, id, workspace);
  if (!message) {
    throw new Error(`Failed to create message '${id}'.`);
  }
  return message;
}

export function replyMessage(ctx: StoreContext, input: ReplyMessageInput): MessageRecord {
  const workspace = input.workspace?.trim() || "default";
  const original = getMessageForAgent(ctx, input.senderId, input.messageId, workspace);
  if (!original) {
    throw new Error(`Message '${input.messageId}' is not visible to agent '${input.senderId}'.`);
  }

  if (original.channel) {
    return sendMessage(ctx, {
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

  return sendMessage(ctx, {
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

export function inbox(ctx: StoreContext, agentId: string, options: InboxOptions = {}): MessageRecord[] {
  const workspace = options.workspace?.trim() || "default";
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
  return ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    params,
  ).map((row) => messageWithRelations(ctx, row, agentId));
}

export function readMessage(
  ctx: StoreContext,
  agentId: string,
  messageId: string,
  workspace?: string,
): MessageRecord {
  const scope = workspace?.trim() || "default";
  const message = getMessageForAgent(ctx, agentId, messageId, scope);
  if (!message) {
    throw new Error(`Message '${messageId}' is not visible to agent '${agentId}'.`);
  }

  const now = isoNow();
  ctx.run(
    `INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at)
     VALUES (?, ?, ?)`,
    [messageId, agentId, now],
  );

  const readMessage = getMessageForAgent(ctx, agentId, messageId, scope);
  if (!readMessage) {
    throw new Error(`Message '${messageId}' disappeared after reading.`);
  }
  return readMessage;
}

export function searchMessages(
  ctx: StoreContext,
  agentId: string,
  options: SearchMessagesOptions,
): MessageRecord[] {
  const workspace = options.workspace?.trim() || "default";
  const clauses = [visibleMessageClause(true), "m.body LIKE ? COLLATE NOCASE"];
  const params: SQLQueryBindings[] = [agentId, workspace, agentId, agentId, `%${options.query}%`];

  if (options.channel) {
    clauses.push("m.channel = ?");
    params.push(options.channel);
  }

  params.push(limit(options.limit));
  return ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    params,
  ).map((row) => messageWithRelations(ctx, row, agentId));
}

export function listThreads(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  limitValue?: number,
): ThreadRecord[] {
  const scope = workspace?.trim() || "default";
  return ctx.all<ThreadRow>(
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

export function getThread(
  ctx: StoreContext,
  agentId: string,
  threadId: string,
  workspace?: string,
  limitValue?: number,
): MessageRecord[] {
  const scope = workspace?.trim() || "default";
  return ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
     WHERE ${visibleMessageClause(true)} AND m.thread_id = ?
     ORDER BY m.created_at ASC, m.rowid ASC
     LIMIT ?`,
    [agentId, scope, agentId, agentId, threadId, limit(limitValue)],
  ).map((row) => messageWithRelations(ctx, row, agentId));
}

export function getMessageForAgent(
  ctx: StoreContext,
  agentId: string,
  messageId: string,
  workspace: string,
): MessageRecord | null {
  const row = ctx.get<MessageRow>(
    `SELECT m.*, r.read_at
     FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
     WHERE m.id = ? AND ${visibleMessageClause(true)}`,
    [agentId, messageId, workspace, agentId, agentId],
  );
  return row ? messageWithRelations(ctx, row, agentId) : null;
}

export function messageWithRelations(
  ctx: Pick<StoreContext, "all">,
  row: MessageRow,
  agentId: string,
): MessageRecord {
  return {
    ...mapMessage(row, agentId),
    artifacts: listArtifacts(ctx, "message", row.id),
  };
}
