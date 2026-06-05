import { DynamicTool, JSONToolOutput, type AnyTool } from "beeai-framework/tools/base";
import { z } from "zod";
import type { AgentConfig } from "./config";
import { LocalCommsStore, type TaskStatus } from "./store";

const metadataSchema = z.record(z.string(), z.unknown()).optional();
const workspaceSchema = z.string().min(1).optional();
const taskStatusSchema = z.enum(["open", "claimed", "done", "blocked", "cancelled"]);
const artifactTypeSchema = z.enum(["file", "url", "diff", "screenshot", "log", "command", "other"]);
const artifactSchema = z.object({
  type: artifactTypeSchema,
  label: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  metadata: metadataSchema,
});

export function createCommunicationTools(store: LocalCommsStore, agent: AgentConfig): AnyTool[] {
  return [
    new DynamicTool({
      name: "register_agent",
      description: "Register or refresh the current local AI agent identity.",
      inputSchema: z.object({
        name: z.string().min(1).optional(),
        workspace: workspaceSchema,
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        metadata: metadataSchema,
      }),
      handler: async (input: any) =>
        json({
          agent: store.registerAgent({
            id: agent.id,
            name: input.name ?? agent.name,
            workspace: input.workspace ?? agent.workspace,
            status: input.status,
            currentTaskId: input.current_task_id,
            metadata: input.metadata,
          }),
        }),
    }),
    new DynamicTool({
      name: "heartbeat",
      description: "Update current agent presence, status, current task, and last-seen timestamp.",
      inputSchema: z.object({
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        workspace: workspaceSchema,
        metadata: metadataSchema,
      }),
      handler: async (input: any) =>
        json({
          agent: store.heartbeat({
            id: agent.id,
            name: agent.name,
            workspace: input.workspace ?? agent.workspace,
            status: input.status,
            currentTaskId: input.current_task_id,
            metadata: input.metadata,
          }),
        }),
    }),
    new DynamicTool({
      name: "agent_status",
      description: "Get the current registered status for this local agent.",
      inputSchema: z.object({}),
      handler: async () => json({ agent: store.getAgent(agent.id) }),
    }),
    new DynamicTool({
      name: "list_agents",
      description: "List known local AI agents that have registered with this mailbox.",
      inputSchema: z.object({
        workspace: workspaceSchema,
      }),
      handler: async (input: any) => json({ agents: store.listAgents(input.workspace) }),
    }),
    new DynamicTool({
      name: "who_is_online",
      description: "List agents with a recent heartbeat in the current or requested workspace.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        active_within_seconds: z.number().int().min(1).max(86_400).optional(),
      }),
      handler: async (input: any) =>
        json({
          agents: store.whoIsOnline(
            input.workspace ?? agent.workspace,
            input.active_within_seconds,
          ),
        }),
    }),
    new DynamicTool({
      name: "send_message",
      description: "Send a direct message to one agent or post a message to a local channel.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        recipient_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        reply_to_message_id: z.string().min(1).optional(),
        body: z.string().min(1),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input: any) =>
        json({
          message: store.sendMessage({
            senderId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            recipientId: input.recipient_id,
            channel: input.channel,
            threadId: input.thread_id,
            replyToMessageId: input.reply_to_message_id,
            body: input.body,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    new DynamicTool({
      name: "reply_message",
      description: "Reply to a visible direct or channel message, preserving its thread.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        message_id: z.string().min(1),
        body: z.string().min(1),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input: any) =>
        json({
          message: store.replyMessage({
            senderId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            messageId: input.message_id,
            body: input.body,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    new DynamicTool({
      name: "inbox",
      description: "List unread or recent direct and channel messages visible to the current agent.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        unread_only: z.boolean().optional(),
        include_sent: z.boolean().optional(),
        channel: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          messages: store.inbox(agent.id, {
            workspace: input.workspace ?? agent.workspace,
            unreadOnly: input.unread_only,
            includeSent: input.include_sent,
            channel: input.channel,
            threadId: input.thread_id,
            limit: input.limit,
          }),
        }),
    }),
    new DynamicTool({
      name: "read_message",
      description: "Fetch one visible message and mark it read for the current agent.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        message_id: z.string().min(1),
      }),
      handler: async (input: any) =>
        json({
          message: store.readMessage(agent.id, input.message_id, input.workspace ?? agent.workspace),
        }),
    }),
    new DynamicTool({
      name: "search_messages",
      description: "Search visible direct and channel message bodies.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        query: z.string().min(1),
        channel: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          messages: store.searchMessages(agent.id, {
            workspace: input.workspace ?? agent.workspace,
            query: input.query,
            channel: input.channel,
            limit: input.limit,
          }),
        }),
    }),
    new DynamicTool({
      name: "list_threads",
      description: "List visible message threads in the current or requested workspace.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          threads: store.listThreads(agent.id, input.workspace ?? agent.workspace, input.limit),
        }),
    }),
    new DynamicTool({
      name: "get_thread",
      description: "Return visible messages for one thread in chronological order.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        thread_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          messages: store.getThread(
            agent.id,
            input.thread_id,
            input.workspace ?? agent.workspace,
            input.limit,
          ),
        }),
    }),
    new DynamicTool({
      name: "watch_updates",
      description: "Poll for new messages, tasks, task events, notes, or locks since a timestamp.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        since: z.string().min(1).optional(),
        timeout_ms: z.number().int().min(0).max(60_000).optional(),
        interval_ms: z.number().int().min(100).max(5_000).optional(),
      }),
      handler: async (input: any) => {
        const timeoutMs = input.timeout_ms ?? 0;
        const intervalMs = input.interval_ms ?? 500;
        const deadline = Date.now() + timeoutMs;
        let updates = store.updatesSince(agent.id, input.workspace ?? agent.workspace, input.since);
        while (!hasUpdates(updates) && Date.now() < deadline) {
          await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
          updates = store.updatesSince(agent.id, input.workspace ?? agent.workspace, input.since);
        }
        return json({ updates });
      },
    }),
    new DynamicTool({
      name: "create_task",
      description: "Create a claimable handoff task for local AI coordination.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        assignee_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        blocked_reason: z.string().min(1).optional(),
        dependencies: z.array(z.string().min(1)).optional(),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input: any) =>
        json({
          task: store.createTask({
            creatorId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            title: input.title,
            description: input.description,
            assigneeId: input.assignee_id,
            channel: input.channel,
            priority: input.priority,
            dueAt: input.due_at,
            parentTaskId: input.parent_task_id,
            blockedReason: input.blocked_reason,
            dependencies: input.dependencies,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    new DynamicTool({
      name: "list_tasks",
      description: "List visible tasks by status, assignee, creator, channel, parent, or recency.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        status: taskStatusSchema.optional(),
        assignee_id: z.string().min(1).optional(),
        creator_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          tasks: store.listTasks(agent.id, {
            workspace: input.workspace ?? agent.workspace,
            status: input.status as TaskStatus | undefined,
            assigneeId: input.assignee_id,
            creatorId: input.creator_id,
            channel: input.channel,
            parentTaskId: input.parent_task_id,
            limit: input.limit,
          }),
        }),
    }),
    new DynamicTool({
      name: "claim_task",
      description: "Atomically claim an open task for the current agent.",
      inputSchema: z.object({
        task_id: z.string().min(1),
        note: z.string().optional(),
      }),
      handler: async (input: any) =>
        json({
          task: store.claimTask(agent.id, input.task_id, input.note),
        }),
    }),
    new DynamicTool({
      name: "update_task",
      description: "Change a task status, update workflow fields, and append an audit note.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        status: taskStatusSchema,
        note: z.string().optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).nullable().optional(),
        blocked_reason: z.string().min(1).nullable().optional(),
      }),
      handler: async (input: any) =>
        json({
          task: store.updateTask({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            taskId: input.task_id,
            status: input.status as TaskStatus,
            note: input.note,
            priority: input.priority,
            dueAt: input.due_at,
            blockedReason: input.blocked_reason,
          }),
          events: store.listTaskEvents(input.task_id),
        }),
    }),
    new DynamicTool({
      name: "write_note",
      description: "Write or update a shared scratchpad note in a workspace or channel.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        note_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        title: z.string().min(1),
        body: z.string().min(1),
        pinned: z.boolean().optional(),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input: any) =>
        json({
          note: store.writeNote({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            noteId: input.note_id,
            channel: input.channel,
            title: input.title,
            body: input.body,
            pinned: input.pinned,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    new DynamicTool({
      name: "read_notes",
      description: "Read shared scratchpad notes by workspace, channel, pin state, or search query.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        channel: z.string().min(1).optional(),
        pinned_only: z.boolean().optional(),
        query: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) =>
        json({
          notes: store.readNotes({
            workspace: input.workspace ?? agent.workspace,
            channel: input.channel,
            pinnedOnly: input.pinned_only,
            query: input.query,
            limit: input.limit,
          }),
        }),
    }),
    new DynamicTool({
      name: "pin_note",
      description: "Pin or unpin a shared scratchpad note.",
      inputSchema: z.object({
        note_id: z.string().min(1),
        pinned: z.boolean(),
      }),
      handler: async (input: any) =>
        json({
          note: store.pinNote(input.note_id, input.pinned),
        }),
    }),
    new DynamicTool({
      name: "summarize_channel",
      description: "Return a compact structured digest of recent channel messages, tasks, and notes.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        channel: z.string().min(1).optional(),
      }),
      handler: async (input: any) =>
        json({
          summary: store.summarizeChannel(agent.id, input.workspace ?? agent.workspace, input.channel),
        }),
    }),
    new DynamicTool({
      name: "list_artifacts",
      description: "List structured artifact references attached to a message, task, or note.",
      inputSchema: z.object({
        owner_type: z.enum(["message", "task", "note"]),
        owner_id: z.string().min(1),
      }),
      handler: async (input: any) =>
        json({
          artifacts: store.listArtifacts(input.owner_type, input.owner_id),
        }),
    }),
    new DynamicTool({
      name: "acquire_lock",
      description: "Acquire or renew a workspace-scoped lease for a file, task, or other resource.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1),
        purpose: z.string().min(1).optional(),
        ttl_seconds: z.number().int().min(1).max(86_400).optional(),
      }),
      handler: async (input: any) =>
        json({
          lock: store.acquireLock({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            resource: input.resource,
            purpose: input.purpose,
            ttlSeconds: input.ttl_seconds,
          }),
        }),
    }),
    new DynamicTool({
      name: "release_lock",
      description: "Release a lock owned by the current agent.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1),
      }),
      handler: async (input: any) =>
        json({
          lock: store.releaseLock(agent.id, input.resource, input.workspace ?? agent.workspace),
        }),
    }),
    new DynamicTool({
      name: "list_locks",
      description: "List active or expired workspace-scoped locks.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1).optional(),
        include_expired: z.boolean().optional(),
      }),
      handler: async (input: any) =>
        json({
          locks: store.listLocks({
            workspace: input.workspace ?? agent.workspace,
            resource: input.resource,
            includeExpired: input.include_expired,
          }),
        }),
    }),
  ];
}

function json<T>(value: T): JSONToolOutput<T> {
  return new JSONToolOutput(value);
}

function hasUpdates(updates: {
  messages: unknown[];
  tasks: unknown[];
  task_events: unknown[];
  notes: unknown[];
  locks: unknown[];
}): boolean {
  return (
    updates.messages.length > 0 ||
    updates.tasks.length > 0 ||
    updates.task_events.length > 0 ||
    updates.notes.length > 0 ||
    updates.locks.length > 0
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
