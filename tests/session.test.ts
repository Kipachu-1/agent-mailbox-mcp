import { expect, test } from "bun:test";
import { buildNextActions, buildSessionSummary, type SessionCollections } from "../src/session";
import type {
  AgentRecord,
  LockRecord,
  MessageRecord,
  NoteRecord,
  TaskRecord,
} from "../src/store";

const now = "2026-06-07T00:00:00.000Z";

test("session summary counts each startup collection", () => {
  const collections = collectionsWithAllSignals();

  expect(buildSessionSummary(collections)).toEqual({
    unread_messages: 1,
    open_tasks: 1,
    claimed_tasks: 1,
    stale_claimed_tasks: 1,
    active_locks: 1,
    pinned_notes: 1,
    online_agents: 1,
  });
});

test("next actions are ranked by agent startup priority", () => {
  const actions = buildNextActions({
    agentId: "codex",
    workspace: "repo-a",
    channel: "handoffs",
    collections: collectionsWithAllSignals(),
  });

  expect(actions.map((action) => action.priority)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(actions.map((action) => action.tool)).toEqual([
    "inbox",
    "list_tasks",
    "list_tasks",
    "list_locks",
    "claim_task",
    "read_notes",
    "watch_updates",
  ]);
  expect(actions[0]?.related_ids).toEqual(["message-1"]);
  expect(actions[4]?.arguments).toMatchObject({
    workspace: "repo-a",
    task_id: "task-open",
  });
  expect(actions[6]?.arguments).toMatchObject({
    workspace: "repo-a",
    timeout_ms: 30_000,
  });
});

function collectionsWithAllSignals(): SessionCollections {
  return {
    unreadMessages: [message("message-1")],
    openTasks: [task("task-open", "open", null)],
    claimedTasks: [task("task-claimed", "claimed", "codex")],
    staleClaimedTasks: [task("task-stale", "claimed", "claude")],
    activeLocks: [lock("lock-1")],
    pinnedNotes: [note("note-1")],
    onlineAgents: [agent("codex")],
  };
}

function agent(id: string): AgentRecord {
  return {
    id,
    name: id,
    workspace: "repo-a",
    status: "available",
    current_task_id: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

function message(id: string): MessageRecord {
  return {
    id,
    workspace: "repo-a",
    kind: "direct",
    thread_id: id,
    reply_to_message_id: null,
    sender_id: "claude",
    recipient_id: "codex",
    channel: null,
    body: "handoff",
    metadata: {},
    artifacts: [],
    created_at: now,
    read_at: null,
    unread: true,
  };
}

function task(id: string, status: TaskRecord["status"], assigneeId: string | null): TaskRecord {
  return {
    id,
    workspace: "repo-a",
    title: id,
    description: "",
    creator_id: "codex",
    assignee_id: assigneeId,
    channel: "handoffs",
    status,
    priority: 0,
    due_at: null,
    parent_task_id: null,
    blocked_reason: null,
    dependencies: [],
    metadata: {},
    artifacts: [],
    created_at: now,
    updated_at: now,
  };
}

function lock(id: string): LockRecord {
  return {
    id,
    workspace: "repo-a",
    resource: "src/session.ts",
    owner_agent_id: "claude",
    purpose: "editing",
    expires_at: now,
    created_at: now,
    updated_at: now,
    expired: false,
  };
}

function note(id: string): NoteRecord {
  return {
    id,
    workspace: "repo-a",
    channel: "handoffs",
    title: "Pinned",
    body: "Use locks.",
    pinned: true,
    creator_id: "codex",
    metadata: {},
    artifacts: [],
    created_at: now,
    updated_at: now,
  };
}
