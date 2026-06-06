import type {
  AgentRecord,
  LockRecord,
  MessageRecord,
  NoteRecord,
  TaskRecord,
} from "./store";

export const coordinationConventions = [
  "Start each session with session_start before reading code, editing files, or claiming work so unread handoffs, pinned conventions, open tasks, stale claims, and active locks are visible.",
  "Acquire a cooperative advisory lock for each file, module, task, or other resource before editing it; locks are coordination records, not filesystem locks.",
  "Attach file, URL, diff, screenshot, log, or command artifacts to tasks and messages whenever they would help another agent resume the work.",
  "When finishing a task, call update_task with a useful note; done, blocked, and cancelled updates notify the task creator automatically.",
  "Use a distinct workspace per repository or project so unrelated task lists, locks, notes, and channels stay separate.",
];

export const recommendedSessionSteps = [
  "Read unread_messages and call read_message after each message is handled.",
  "Review pinned_notes for workspace conventions before changing behavior.",
  "Claim only open tasks you intend to work on now; treat stale_claimed_tasks as reclaim candidates after checking recent agent presence.",
  "Check active_locks before editing and acquire your own locks for touched resources.",
  "Use heartbeat during long work so other agents can distinguish active work from stale presence.",
];

export interface SessionCollections {
  unreadMessages: MessageRecord[];
  openTasks: TaskRecord[];
  claimedTasks: TaskRecord[];
  staleClaimedTasks: TaskRecord[];
  activeLocks: LockRecord[];
  pinnedNotes: NoteRecord[];
  onlineAgents: AgentRecord[];
}

export interface SessionSummary {
  unread_messages: number;
  open_tasks: number;
  claimed_tasks: number;
  stale_claimed_tasks: number;
  active_locks: number;
  pinned_notes: number;
  online_agents: number;
}

export interface NextAction {
  priority: number;
  action: string;
  reason: string;
  tool: string;
  arguments: Record<string, unknown>;
  related_ids: string[];
}

export function buildSessionSummary(collections: SessionCollections): SessionSummary {
  return {
    unread_messages: collections.unreadMessages.length,
    open_tasks: collections.openTasks.length,
    claimed_tasks: collections.claimedTasks.length,
    stale_claimed_tasks: collections.staleClaimedTasks.length,
    active_locks: collections.activeLocks.length,
    pinned_notes: collections.pinnedNotes.length,
    online_agents: collections.onlineAgents.length,
  };
}

export function buildNextActions(input: {
  agentId: string;
  workspace: string;
  channel?: string;
  collections: SessionCollections;
}): NextAction[] {
  const { agentId, workspace, channel, collections } = input;
  const actions: NextAction[] = [];
  const scopedArgs = compactArgs({ workspace, channel });

  if (collections.unreadMessages.length > 0) {
    actions.push({
      priority: 1,
      action: "Handle unread messages",
      reason: `${collections.unreadMessages.length} unread message(s) may contain handoffs or blockers.`,
      tool: "inbox",
      arguments: compactArgs({
        ...scopedArgs,
        unread_only: true,
        include_sent: false,
        limit: collections.unreadMessages.length,
      }),
      related_ids: collections.unreadMessages.map((message) => message.id),
    });
  }

  if (collections.staleClaimedTasks.length > 0) {
    actions.push({
      priority: 2,
      action: "Review stale claimed tasks",
      reason: `${collections.staleClaimedTasks.length} claimed task(s) look stale; check presence and message context before reclaiming.`,
      tool: "list_tasks",
      arguments: compactArgs({
        ...scopedArgs,
        stale_after_seconds: 3_600,
        limit: collections.staleClaimedTasks.length,
      }),
      related_ids: collections.staleClaimedTasks.map((task) => task.id),
    });
  }

  if (collections.claimedTasks.length > 0) {
    actions.push({
      priority: 3,
      action: "Continue or update claimed work",
      reason: `${collections.claimedTasks.length} task(s) are assigned to ${agentId}; heartbeat or update their status before starting new work.`,
      tool: "list_tasks",
      arguments: compactArgs({
        ...scopedArgs,
        status: "claimed",
        assignee_id: agentId,
        limit: collections.claimedTasks.length,
      }),
      related_ids: collections.claimedTasks.map((task) => task.id),
    });
  }

  if (collections.activeLocks.length > 0) {
    actions.push({
      priority: 4,
      action: "Check active locks before editing",
      reason: `${collections.activeLocks.length} active lock(s) are present in this workspace.`,
      tool: "list_locks",
      arguments: { workspace },
      related_ids: collections.activeLocks.map((lock) => lock.id),
    });
  }

  if (collections.openTasks.length > 0) {
    actions.push({
      priority: 5,
      action: "Claim an open task when ready",
      reason: `${collections.openTasks.length} open task(s) are available; claim only one you intend to start now.`,
      tool: "claim_task",
      arguments: compactArgs({
        workspace,
        task_id: collections.openTasks[0]?.id,
      }),
      related_ids: collections.openTasks.map((task) => task.id),
    });
  }

  if (collections.pinnedNotes.length > 0) {
    actions.push({
      priority: 6,
      action: "Review pinned workspace notes",
      reason: `${collections.pinnedNotes.length} pinned note(s) may contain conventions or durable project context.`,
      tool: "read_notes",
      arguments: compactArgs({
        ...scopedArgs,
        pinned_only: true,
        limit: collections.pinnedNotes.length,
      }),
      related_ids: collections.pinnedNotes.map((note) => note.id),
    });
  }

  actions.push({
    priority: 7,
    action: "Watch for new coordination updates",
    reason: "No higher-priority startup action remains, or you need a pull-based wait loop.",
    tool: "watch_updates",
    arguments: {
      workspace,
      timeout_ms: 30_000,
      interval_ms: 1_000,
    },
    related_ids: [],
  });

  return actions;
}

function compactArgs(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}
