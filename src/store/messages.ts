import { insertArtifacts, listArtifacts } from "./artifacts";
import {
  addDateRange,
  caseInsensitiveLike,
  doNothingOnConflict,
  insertOrIgnore,
  visibleMessageClause,
  type StoreContext,
  type StoreValue,
} from "./context";
import {
  emptyToNull,
  encodeJson,
  hasMore,
  isoNow,
  limit,
  mapMessage,
  offset,
  type MessageRow,
  type ThreadRow,
} from "./mappers";
import type {
  InboxOptions,
  MessageRecord,
  Paginated,
  ReplyMessageInput,
  SearchMessagesOptions,
  SendMessageInput,
  ThreadRecord,
} from "./types";

export async function sendMessage(ctx: StoreContext, input: SendMessageInput): Promise<MessageRecord> {
  const workspace = input.workspace?.trim() || "default";
  const recipientId = emptyToNull(input.recipientId);
  const channel = emptyToNull(input.channel);
  if ((recipientId && channel) || (!recipientId && !channel)) {
    throw new Error("send_message requires exactly one of recipient_id or channel.");
  }

  const now = isoNow();
  const id = crypto.randomUUID();
  const reply = input.replyToMessageId
    ? await getMessageForAgent(ctx, input.senderId, input.replyToMessageId, workspace)
    : null;
  if (input.replyToMessageId && !reply) {
    throw new Error(`Message '${input.replyToMessageId}' is not visible for replies.`);
  }
  const threadId = input.threadId?.trim() || reply?.thread_id || id;

  await ctx.transaction(async (tx) => {
    await tx.run(
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
    await insertArtifacts(tx, "message", id, input.artifacts ?? []);
  });

  const message = await getMessageForAgent(ctx, input.senderId, id, workspace);
  if (!message) {
    throw new Error(`Failed to create message '${id}'.`);
  }
  return message;
}

export async function replyMessage(ctx: StoreContext, input: ReplyMessageInput): Promise<MessageRecord> {
  const workspace = input.workspace?.trim() || "default";
  const original = await getMessageForAgent(ctx, input.senderId, input.messageId, workspace);
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

export async function inbox(
  ctx: StoreContext,
  agentId: string,
  options: InboxOptions = {},
): Promise<MessageRecord[]> {
  const { clauses, params } = inboxWhere(agentId, options);
  const rows = await ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     ${INBOX_FROM}
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ? OFFSET ?`,
    [agentId, ...params, limit(options.limit), offset(options.offset)],
  );
  return Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
}

export async function inboxPaginated(
  ctx: StoreContext,
  agentId: string,
  options: InboxOptions = {},
): Promise<Paginated<MessageRecord>> {
  const { clauses, params } = inboxWhere(agentId, options);
  const offsetValue = offset(options.offset);
  const [rows, totalRow] = await Promise.all([
    ctx.all<MessageRow>(
      `SELECT m.*, r.read_at
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [agentId, ...params, limit(options.limit), offsetValue],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}`,
      [agentId, ...params],
    ),
  ]);
  const results = await Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValue, results.length, total) };
}

const INBOX_FROM = `FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?`;

function inboxWhere(
  agentId: string,
  options: InboxOptions,
): { clauses: string[]; params: StoreValue[] } {
  const clauses = [visibleMessageClause(options.includeSent !== false)];
  const params: StoreValue[] = [options.workspace?.trim() || "default", agentId];
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
  addDateRange(clauses, params, "m.created_at", options.since, options.until);
  return { clauses, params };
}

export async function readMessage(
  ctx: StoreContext,
  agentId: string,
  messageId: string,
  workspace?: string,
): Promise<MessageRecord> {
  const scope = workspace?.trim() || "default";
  const message = await getMessageForAgent(ctx, agentId, messageId, scope);
  if (!message) {
    throw new Error(`Message '${messageId}' is not visible to agent '${agentId}'.`);
  }

  const now = isoNow();
  await ctx.run(
    `${insertOrIgnore(ctx)} message_reads (message_id, agent_id, read_at)
     VALUES (?, ?, ?) ${doNothingOnConflict(ctx)}`,
    [messageId, agentId, now],
  );

  const readMessage = await getMessageForAgent(ctx, agentId, messageId, scope);
  if (!readMessage) {
    throw new Error(`Message '${messageId}' disappeared after reading.`);
  }
  return readMessage;
}

export async function searchMessages(
  ctx: StoreContext,
  agentId: string,
  options: SearchMessagesOptions,
): Promise<MessageRecord[]> {
  const { clauses, params } = searchMessagesWhere(ctx, agentId, options);
  const rows = await ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     ${INBOX_FROM}
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ? OFFSET ?`,
    [agentId, ...params, limit(options.limit), offset(options.offset)],
  );
  return Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
}

export async function searchMessagesPaginated(
  ctx: StoreContext,
  agentId: string,
  options: SearchMessagesOptions,
): Promise<Paginated<MessageRecord>> {
  const { clauses, params } = searchMessagesWhere(ctx, agentId, options);
  const offsetValue = offset(options.offset);
  const [rows, totalRow] = await Promise.all([
    ctx.all<MessageRow>(
      `SELECT m.*, r.read_at
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [agentId, ...params, limit(options.limit), offsetValue],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}`,
      [agentId, ...params],
    ),
  ]);
  const results = await Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValue, results.length, total) };
}

function searchMessagesWhere(
  ctx: Pick<StoreContext, "dialect">,
  agentId: string,
  options: SearchMessagesOptions,
): { clauses: string[]; params: StoreValue[] } {
  const clauses = [visibleMessageClause(true), caseInsensitiveLike(ctx, "m.body")];
  const params: StoreValue[] = [options.workspace?.trim() || "default", agentId, agentId, `%${options.query}%`];
  if (options.channel) {
    clauses.push("m.channel = ?");
    params.push(options.channel);
  }
  return { clauses, params };
}

export async function listThreads(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
  since?: string,
  until?: string,
): Promise<ThreadRecord[]> {
  const scope = workspace?.trim() || "default";
  const clauses = [visibleMessageClause(true)];
  const params: StoreValue[] = [scope, agentId, agentId];
  addDateRange(clauses, params, "m.created_at", since, until);
  return (await ctx.all<ThreadRow>(
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
     WHERE ${clauses.join(" AND ")}
     GROUP BY m.workspace, m.thread_id
     ORDER BY last_message_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit(limitValue), offset(offsetValue)],
  )).map((row) => ({ ...row, message_count: Number(row.message_count) }));
}

export async function listThreadsPaginated(
  ctx: StoreContext,
  agentId: string,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
  since?: string,
  until?: string,
): Promise<Paginated<ThreadRecord>> {
  const scope = workspace?.trim() || "default";
  const offsetValueResolved = offset(offsetValue);
  const clauses = [visibleMessageClause(true)];
  const params: StoreValue[] = [scope, agentId, agentId];
  addDateRange(clauses, params, "m.created_at", since, until);
  const [rows, totalRow] = await Promise.all([
    ctx.all<ThreadRow>(
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
       WHERE ${clauses.join(" AND ")}
       GROUP BY m.workspace, m.thread_id
       ORDER BY last_message_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit(limitValue), offsetValueResolved],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT 1 FROM messages m
         WHERE ${clauses.join(" AND ")}
         GROUP BY m.workspace, m.thread_id
       ) AS threads`,
      params,
    ),
  ]);
  const results = rows.map((row) => ({ ...row, message_count: Number(row.message_count) }));
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValueResolved, results.length, total) };
}

export async function getThread(
  ctx: StoreContext,
  agentId: string,
  threadId: string,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
): Promise<MessageRecord[]> {
  const { clauses, params } = getThreadWhere(agentId, threadId, workspace);
  const rows = await ctx.all<MessageRow>(
    `SELECT m.*, r.read_at
     ${INBOX_FROM}
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT ? OFFSET ?`,
    [agentId, ...params, limit(limitValue), offset(offsetValue)],
  );
  return Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
}

export async function getThreadPaginated(
  ctx: StoreContext,
  agentId: string,
  threadId: string,
  workspace?: string,
  limitValue?: number,
  offsetValue?: number,
): Promise<Paginated<MessageRecord>> {
  const { clauses, params } = getThreadWhere(agentId, threadId, workspace);
  const offsetValueResolved = offset(offsetValue);
  const [rows, totalRow] = await Promise.all([
    ctx.all<MessageRow>(
      `SELECT m.*, r.read_at
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ? OFFSET ?`,
      [agentId, ...params, limit(limitValue), offsetValueResolved],
    ),
    ctx.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       ${INBOX_FROM}
       WHERE ${clauses.join(" AND ")}`,
      [agentId, ...params],
    ),
  ]);
  const results = await Promise.all(rows.map((row) => messageWithRelations(ctx, row, agentId)));
  const total = Number(totalRow?.c ?? 0);
  return { results, total, has_more: hasMore(offsetValueResolved, results.length, total) };
}

function getThreadWhere(
  agentId: string,
  threadId: string,
  workspace?: string,
): { clauses: string[]; params: StoreValue[] } {
  const scope = workspace?.trim() || "default";
  return {
    clauses: [visibleMessageClause(true), "m.thread_id = ?"],
    params: [scope, agentId, agentId, threadId],
  };
}

export async function getMessageForAgent(
  ctx: StoreContext,
  agentId: string,
  messageId: string,
  workspace: string,
): Promise<MessageRecord | null> {
  const row = await ctx.get<MessageRow>(
    `SELECT m.*, r.read_at
     FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
     WHERE m.id = ? AND ${visibleMessageClause(true)}`,
    [agentId, messageId, workspace, agentId, agentId],
  );
  return row ? messageWithRelations(ctx, row, agentId) : null;
}

export async function messageWithRelations(
  ctx: Pick<StoreContext, "all">,
  row: MessageRow,
  agentId: string,
): Promise<MessageRecord> {
  return {
    ...mapMessage(row, agentId),
    artifacts: await listArtifacts(ctx, "message", row.id),
  };
}
