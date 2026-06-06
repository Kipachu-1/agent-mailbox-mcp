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

const coordinationConventions = [
  "Start each session with session_start before reading code, editing files, or claiming work so unread handoffs, pinned conventions, open tasks, stale claims, and active locks are visible.",
  "Acquire a cooperative advisory lock for each file, module, task, or other resource before editing it; locks are coordination records, not filesystem locks.",
  "Attach file, URL, diff, screenshot, log, or command artifacts to tasks and messages whenever they would help another agent resume the work.",
  "When finishing a task, call update_task with a useful note; done, blocked, and cancelled updates notify the task creator automatically.",
  "Use a distinct workspace per repository or project so unrelated task lists, locks, notes, and channels stay separate.",
];

const recommendedSessionSteps = [
  "Read unread_messages and call read_message after each message is handled.",
  "Review pinned_notes for workspace conventions before changing behavior.",
  "Claim only open tasks you intend to work on now; treat stale_claimed_tasks as reclaim candidates after checking recent agent presence.",
  "Check active_locks before editing and acquire your own locks for touched resources.",
  "Use heartbeat during long work so other agents can distinguish active work from stale presence.",
];

export function createCommunicationTools(store: LocalCommsStore, agent: AgentConfig): AnyTool[] {
  return [
    new DynamicTool({
      name: "session_start",
      description:
        "First tool to call at the start of a work session. It refreshes presence and returns unread messages, open tasks, stale claimed tasks, active advisory locks, pinned notes, online agents, and recommended next steps before code reading, editing, or task claiming begins.",
      inputSchema: z.object({
        name: z.string().min(1).optional(),
        workspace: workspaceSchema,
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        metadata: metadataSchema,
        channel: z.string().min(1).optional(),
        stale_after_seconds: z.number().int().min(60).max(2_592_000).optional(),
        active_within_seconds: z.number().int().min(1).max(86_400).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input: any) => {
        const workspace = input.workspace ?? agent.workspace;
        const channel = input.channel;
        const limit = input.limit;
        const currentAgent = store.registerAgent({
          id: agent.id,
          name: input.name ?? agent.name,
          workspace,
          status: input.status,
          currentTaskId: input.current_task_id,
          metadata: input.metadata,
        });

        return json({
          agent: currentAgent,
          workspace: workspaceName(workspace),
          checked_at: new Date().toISOString(),
          unread_messages: store.inbox(agent.id, {
            workspace,
            channel,
            unreadOnly: true,
            includeSent: false,
            limit,
          }),
          open_tasks: store.listTasks(agent.id, {
            workspace,
            channel,
            status: "open",
            limit,
          }),
          claimed_tasks: store.listTasks(agent.id, {
            workspace,
            channel,
            status: "claimed",
            assigneeId: agent.id,
            limit,
          }),
          stale_claimed_tasks: store.listTasks(agent.id, {
            workspace,
            channel,
            staleAfterSeconds: input.stale_after_seconds ?? 3_600,
            limit,
          }),
          active_locks: store.listLocks({ workspace }),
          pinned_notes: store.readNotes({
            workspace,
            channel,
            pinnedOnly: true,
            limit,
          }),
          online_agents: store.whoIsOnline(
            workspace,
            input.active_within_seconds,
          ),
          conventions: coordinationConventions,
          recommended_next_steps: recommendedSessionSteps,
        });
      },
    }),
    new DynamicTool({
      name: "register_agent",
      description:
        "Register or refresh the current local AI agent identity. Prefer session_start at the beginning of a work session because it also returns inbox, task, lock, and convention context.",
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
      description:
        "Update current agent presence, status, current task, and last-seen timestamp during long work so claimed tasks do not look abandoned.",
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
      description:
        "List known local AI agents that have registered with this mailbox, optionally scoped to one workspace.",
      inputSchema: z.object({
        workspace: workspaceSchema,
      }),
      handler: async (input: any) => json({ agents: store.listAgents(input.workspace) }),
    }),
    new DynamicTool({
      name: "who_is_online",
      description:
        "List agents with a recent heartbeat in the current or requested workspace. Use this before reclaiming stale claimed tasks.",
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
      description:
        "Send a direct message to one agent or post a message to a local channel. Include artifacts for files, URLs, diffs, screenshots, logs, or commands that another agent should inspect.",
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
      description:
        "Reply to a visible direct or channel message while preserving its thread. Use this for handoff acknowledgements and completion notes tied to a message.",
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
      description:
        "List unread or recent direct and channel messages visible to the current agent. Use unread_only for triage, then read_message after handling each item.",
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
      description:
        "Fetch one visible message and mark it read for the current agent. Mark messages read only after the handoff or request has been handled or converted into a task.",
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
      description:
        "Search visible direct and channel message bodies when recovering old decisions, handoffs, or context.",
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
      description:
        "List visible message threads in the current or requested workspace, ordered by recent activity.",
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
      description:
        "Return visible messages for one thread in chronological order so an agent can reconstruct a handoff conversation before acting.",
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
      description:
        "Poll for new messages, tasks, task events, notes, or locks since a timestamp. This is pull-based long polling; it does not wake sleeping agents by itself.",
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
      description:
        "Create a claimable handoff task for local AI coordination. Provide clear acceptance criteria and attach relevant artifacts so another agent can resume without guessing.",
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
      description:
        "List visible tasks by status, assignee, creator, channel, parent, recency, or stale claim age. Use stale_after_seconds to find claimed tasks, then check recent presence and message context before reclaiming or reassigning.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        status: taskStatusSchema.optional(),
        assignee_id: z.string().min(1).optional(),
        creator_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        stale_after_seconds: z.number().int().min(60).max(2_592_000).optional(),
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
            staleAfterSeconds: input.stale_after_seconds,
            limit: input.limit,
          }),
        }),
    }),
    new DynamicTool({
      name: "claim_task",
      description:
        "Atomically claim an open task for the current agent. Claim only work you intend to start now, and follow with heartbeat during long-running work.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        note: z.string().optional(),
      }),
      handler: async (input: any) =>
        json({
          task: store.claimTask(agent.id, input.task_id, input.note, input.workspace ?? agent.workspace),
        }),
    }),
    new DynamicTool({
      name: "update_task",
      description:
        "Change a task status, update workflow fields, and append an audit note. Done, blocked, and cancelled updates from another agent automatically notify the task creator, so include a concrete completion or blocking note.",
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
      description:
        "Write or update a shared scratchpad note in a workspace or channel. Pin durable conventions, ownership rules, and project context that every agent should see.",
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
      description:
        "Read shared scratchpad notes by workspace, channel, pin state, or search query. Check pinned notes before starting work in an unfamiliar workspace.",
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
      description:
        "Pin or unpin a shared scratchpad note. Pinned notes should hold durable workspace conventions rather than transient status.",
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
      description:
        "Return a compact structured digest of recent channel messages, tasks, and notes for quick orientation in a project channel.",
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
      description:
        "List structured artifact references attached to a message, task, or note so files, URLs, diffs, screenshots, logs, and commands are easy to resume from.",
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
      description:
        "Acquire or renew a cooperative advisory workspace-scoped lease for a file, module, task, or other resource before editing. This does not lock the filesystem; if another agent owns an active lock, coordinate instead of overwriting.",
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
      description:
        "Release a lock owned by the current agent after the edit or task is complete. Keep locks short-lived and renew them for long work.",
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
      description:
        "List active or expired workspace-scoped locks. Check this before editing shared files and include expired locks when auditing stale coordination state.",
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

function workspaceName(workspace: string | undefined): string {
  return workspace?.trim() || "default";
}
