import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../src/config";
import { LocalCommsStore, type MessageRecord, type TaskRecord } from "../src/store";
import { createCommunicationTools } from "../src/tools";

const tempDirs: string[] = [];
const stores: LocalCommsStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const agent: AgentConfig = { id: "claude", name: "Claude", workspace: undefined };

async function setupAsync(): Promise<{
  store: LocalCommsStore;
  tools: ReturnType<typeof createCommunicationTools>;
  path: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-tools-"));
  tempDirs.push(dir);
  const path = join(dir, "mailbox.sqlite");
  const store = await LocalCommsStore.openSqlite(path);
  stores.push(store);
  const tools = createCommunicationTools(store, agent);
  return { store, tools, path };
}

async function runTool(
  tools: ReturnType<typeof createCommunicationTools>,
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  const output = (await tool!.run(input)) as { result: Record<string, unknown> };
  return output.result;
}

// beeai-framework wraps handler errors in a ToolError whose `.errors[0].message`
// holds the original thrown message. Assert against that inner message.
async function expectToolError(
  tools: ReturnType<typeof createCommunicationTools>,
  name: string,
  input: Record<string, unknown>,
  pattern: RegExp,
): Promise<void> {
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  try {
    await tool!.run(input);
    expect("tool should have errored").toBe("but it did not");
  } catch (error) {
    const errors = (error as { errors?: Array<{ message: string }> }).errors;
    const inner = errors?.[0]?.message ?? (error as Error).message;
    expect(inner).toMatch(pattern);
  }
}

// --- session & presence ---

test("session_start registers presence and returns startup digest", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "session_start", { name: "Claude Code" });

  expect((result.agent as { id: string }).id).toBe("claude");
  expect((result.agent as { name: string }).name).toBe("Claude Code");
  expect(result.session_summary).toMatchObject({
    unread_messages: 0,
    open_tasks: 0,
    claimed_tasks: 0,
    stale_claimed_tasks: 0,
    active_locks: 0,
    pinned_notes: 0,
    online_agents: 1,
  });
  expect(Array.isArray(result.next_actions)).toBe(true);
  expect(result.workspace).toBe("default");
});

test("register_agent refreshes identity fields", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "register_agent", {
    name: "Claude v2",
    status: "available",
    current_task_id: "task-99",
  });
  expect((result.agent as { name: string; status: string; current_task_id: string }).name).toBe(
    "Claude v2",
  );
  expect((result.agent as { status: string }).status).toBe("available");
  expect((result.agent as { current_task_id: string }).current_task_id).toBe("task-99");
});

test("heartbeat updates presence without reregistering collections", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "register_agent", { status: "available" });
  const result = await runTool(tools, "heartbeat", { status: "working", current_task_id: "t1" });
  expect((result.agent as { status: string; current_task_id: string }).status).toBe("working");
  expect((result.agent as { current_task_id: string }).current_task_id).toBe("t1");
});

test("agent_status returns the current registered agent", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "register_agent", { status: "busy" });
  const result = await runTool(tools, "agent_status", {});
  expect((result.agent as { status: string }).status).toBe("busy");
  expect((result.agent as { id: string }).id).toBe("claude");
});

test("list_agents lists registered agents in the workspace", async () => {
  const { store, tools } = await setupAsync();
  await runTool(tools, "register_agent", {});
  await store.registerAgent({ id: "codex", name: "Codex" });
  const result = await runTool(tools, "list_agents", {});
  expect((result.agents as Array<{ id: string }>).map((a) => a.id)).toContain("codex");
  expect((result.agents as Array<{ id: string }>).map((a) => a.id)).toContain("claude");
});

test("who_is_online returns agents with recent heartbeats", async () => {
  const { store, tools } = await setupAsync();
  await runTool(tools, "register_agent", {});
  await store.heartbeat({ id: "codex", name: "Codex", status: "online" });
  const result = await runTool(tools, "who_is_online", { active_within_seconds: 300 });
  const ids = (result.agents as Array<{ id: string }>).map((a) => a.id);
  expect(ids).toContain("claude");
  expect(ids).toContain("codex");
});

// --- messaging ---

test("send_message posts a direct message with artifacts", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "send_message", {
    recipient_id: "codex",
    body: "Please review the diff.",
    artifacts: [{ type: "diff", path: "/tmp/changes.patch", label: "changes" }],
  });
  const message = result.message as MessageRecord;
  expect(message.body).toBe("Please review the diff.");
  expect(message.recipient_id).toBe("codex");
  expect(message.artifacts[0]?.path).toBe("/tmp/changes.patch");
});

test("send_message posts a channel message", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "send_message", {
    channel: "handoffs",
    body: "Channel update.",
  });
  const message = result.message as MessageRecord;
  expect(message.kind).toBe("channel");
  expect(message.channel).toBe("handoffs");
});

test("send_message rejects when both recipient and channel are provided", async () => {
  const { tools } = await setupAsync();
  await expectToolError(
    tools,
    "send_message",
    { recipient_id: "codex", channel: "handoffs", body: "x" },
    /exactly one of recipient_id or channel/,
  );
});

test("send_message rejects when neither recipient nor channel is provided", async () => {
  const { tools } = await setupAsync();
  await expectToolError(tools, "send_message", { body: "x" }, /exactly one of recipient_id or channel/);
});

test("reply_message preserves the original thread", async () => {
  const { tools } = await setupAsync();
  const sent = await runTool(tools, "send_message", {
    recipient_id: "codex",
    body: "Original handoff.",
  });
  const reply = await runTool(tools, "reply_message", {
    message_id: (sent.message as MessageRecord).id,
    body: "Acknowledged.",
  });
  expect((reply.message as MessageRecord).thread_id).toBe(
    (sent.message as MessageRecord).thread_id,
  );
  expect((reply.message as MessageRecord).reply_to_message_id).toBe(
    (sent.message as MessageRecord).id,
  );
});

test("reply_message rejects when the message is not visible", async () => {
  const { tools } = await setupAsync();
  await expectToolError(tools, "reply_message", { message_id: "missing", body: "x" }, /not visible/);
});

test("inbox lists unread messages and respects filters", async () => {
  const { store, tools } = await setupAsync();
  await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "First unread.",
  });
  await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Second unread.",
  });
  const unread = await runTool(tools, "inbox", { unread_only: true });
  const bodies = (unread.messages as Array<{ body: string }>).map((m) => m.body);
  expect(bodies).toHaveLength(2);
  expect(bodies).toContain("First unread.");
  expect(bodies).toContain("Second unread.");
});

test("read_message marks a message read", async () => {
  const { store, tools } = await setupAsync();
  const message = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Mark me.",
  });
  const result = await runTool(tools, "read_message", { message_id: message.id });
  expect((result.message as { unread: boolean }).unread).toBe(false);
  expect((result.message as { read_at: string }).read_at).toBeString();
});

test("search_messages finds visible messages by body query", async () => {
  const { store, tools } = await setupAsync();
  await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "deploy the widget factory",
  });
  const result = await runTool(tools, "search_messages", { query: "widget" });
  expect((result.messages as Array<{ body: string }>).map((m) => m.body)).toContain(
    "deploy the widget factory",
  );
});

test("list_threads returns threads ordered by recency", async () => {
  const { store, tools } = await setupAsync();
  const first = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Thread one.",
  });
  await store.sendMessage({ senderId: "codex", recipientId: "claude", body: "Thread two." });
  const result = await runTool(tools, "list_threads", {});
  const threadIds = (result.threads as Array<{ thread_id: string }>).map((t) => t.thread_id);
  expect(threadIds).toContain(first.thread_id);
});

test("get_thread returns messages in chronological order", async () => {
  const { store, tools } = await setupAsync();
  const first = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "First.",
  });
  await store.replyMessage({
    senderId: "claude",
    messageId: first.id,
    body: "Second.",
  });
  const result = await runTool(tools, "get_thread", { thread_id: first.thread_id });
  expect((result.messages as Array<{ body: string }>).map((m) => m.body)).toEqual([
    "First.",
    "Second.",
  ]);
});

test("watch_updates returns recent coordination updates", async () => {
  const { store, tools } = await setupAsync();
  const since = new Date(Date.now() - 1000).toISOString();
  await store.sendMessage({ senderId: "codex", channel: "handoffs", body: "New update." });
  const result = await runTool(tools, "watch_updates", { since, timeout_ms: 0 });
  expect((result.updates as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
});

// --- tasks ---

test("create_task creates an open task with artifacts", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "create_task", {
    title: "Build feature",
    description: "Implement the widget.",
    assignee_id: "codex",
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
  });
  const task = result.task as TaskRecord;
  expect(task.title).toBe("Build feature");
  expect(task.status).toBe("open");
  expect(task.assignee_id).toBe("codex");
  expect(task.artifacts[0]?.url).toBe("https://example.com/spec");
});

test("create_handoff creates a task and notifies the assignee", async () => {
  const { store, tools } = await setupAsync();
  await store.registerAgent({ id: "codex", name: "Codex" });
  const result = await runTool(tools, "create_handoff", {
    title: "Handoff copy",
    assignee_id: "codex",
    notification_body: "Please pick this up.",
  });
  expect((result.task as TaskRecord).title).toBe("Handoff copy");
  expect(result.notification_message).not.toBeNull();
  expect(
    (result.notification_message as MessageRecord).body,
  ).toBe("Please pick this up.");
});

test("create_handoff rejects when both recipient and channel destinations are given", async () => {
  const { tools } = await setupAsync();
  await expectToolError(
    tools,
    "create_handoff",
    {
      title: "Bad handoff",
      notification_recipient_id: "codex",
      notification_channel: "handoffs",
      notification_body: "x",
    },
    /exactly one destination/,
  );
});

test("list_tasks filters by status", async () => {
  const { store, tools } = await setupAsync();
  await store.createTask({ creatorId: "claude", title: "Open one" });
  const claimed = await store.createTask({ creatorId: "claude", title: "Claimed one" });
  await store.claimTask("codex", claimed.id);

  const open = await runTool(tools, "list_tasks", { status: "open" });
  expect((open.tasks as Array<{ title: string }>).map((t) => t.title)).toContain("Open one");
  expect((open.tasks as Array<{ title: string }>).map((t) => t.title)).not.toContain("Claimed one");
});

test("claim_task atomically claims an open task", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({ creatorId: "claude", title: "Claim me" });
  const result = await runTool(tools, "claim_task", { task_id: task.id, note: "Taking it." });
  expect((result.task as TaskRecord).status).toBe("claimed");
  expect((result.task as TaskRecord).assignee_id).toBe("claude");
});

test("claim_task rejects an already claimed task", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({ creatorId: "claude", title: "Claimed" });
  await store.claimTask("codex", task.id);
  await expectToolError(tools, "claim_task", { task_id: task.id }, /cannot be claimed/);
});

test("update_task changes status and appends a visible event", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({ creatorId: "claude", title: "Do work" });
  await store.claimTask("claude", task.id);
  const result = await runTool(tools, "update_task", {
    task_id: task.id,
    status: "done",
    note: "Finished.",
  });
  expect((result.task as TaskRecord).status).toBe("done");
  expect(
    (result.events as Array<{ event_type: string }>).map((e) => e.event_type),
  ).toContain("status_changed");
});

test("update_task rejects when the task is not visible", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({
    creatorId: "claude",
    workspace: "repo-a",
    title: "Private",
    assigneeId: "codex",
  });
  await expectToolError(tools, "update_task", { task_id: task.id, status: "done" }, /not visible/);
});

test("finish_work completes a task and releases owned locks", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({ creatorId: "claude", title: "Cleanup" });
  await store.claimTask("claude", task.id);
  await store.acquireLock({ agentId: "claude", resource: "src/main.ts", purpose: "edit" });

  const result = await runTool(tools, "finish_work", {
    task_id: task.id,
    note: "Done.",
    release_locks: ["src/main.ts"],
  });
  expect((result.task as TaskRecord).status).toBe("done");
  expect((result.released_locks as Array<{ resource: string }>).map((l) => l.resource)).toContain(
    "src/main.ts",
  );
  expect(result.release_errors).toEqual([]);
});

test("finish_work records errors for locks not owned by the agent", async () => {
  const { store, tools } = await setupAsync();
  const task = await store.createTask({ creatorId: "claude", title: "Cleanup" });
  await store.claimTask("claude", task.id);
  await store.acquireLock({ agentId: "codex", resource: "src/other.ts" });

  const result = await runTool(tools, "finish_work", {
    task_id: task.id,
    release_locks: ["src/other.ts"],
  });
  expect((result.release_errors as Array<{ resource: string }>).map((e) => e.resource)).toContain(
    "src/other.ts",
  );
});

// --- notes ---

test("write_note creates a pinned workspace note", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "write_note", {
    title: "Conventions",
    body: "Always use locks before edits.",
    pinned: true,
  });
  expect((result.note as { title: string; pinned: boolean }).title).toBe("Conventions");
  expect((result.note as { pinned: boolean }).pinned).toBe(true);
});

test("read_notes returns notes filtered by pinned state", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "write_note", { title: "Pinned", body: "Keep current.", pinned: true });
  await runTool(tools, "write_note", { title: "Scratch", body: "Transient note." });
  const pinned = await runTool(tools, "read_notes", { pinned_only: true });
  expect((pinned.notes as Array<{ title: string }>).map((n) => n.title)).toEqual(["Pinned"]);
});

test("read_notes supports a search query across title and body", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "write_note", { title: "Deployment", body: "Use blue-green deploys." });
  const result = await runTool(tools, "read_notes", { query: "green" });
  expect((result.notes as Array<{ title: string }>).map((n) => n.title)).toContain("Deployment");
});

test("pin_note toggles the pinned flag", async () => {
  const { tools } = await setupAsync();
  const created = await runTool(tools, "write_note", { title: "Note", body: "Body", pinned: true });
  const noteId = (created.note as { id: string }).id;
  const result = await runTool(tools, "pin_note", { note_id: noteId, pinned: false });
  expect((result.note as { pinned: boolean }).pinned).toBe(false);
});

test("summarize_channel returns a channel digest with counts", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "send_message", { channel: "docs", body: "Doc update." });
  const result = await runTool(tools, "summarize_channel", { channel: "docs" });
  expect(result.summary).toMatchObject({
    channel: "docs",
    message_count: 1,
  });
});

// --- locks ---

test("acquire_lock creates a workspace-scoped lease", async () => {
  const { tools } = await setupAsync();
  const result = await runTool(tools, "acquire_lock", {
    resource: "src/store.ts",
    purpose: "editing",
    ttl_seconds: 3600,
  });
  expect((result.lock as { resource: string; owner_agent_id: string }).resource).toBe(
    "src/store.ts",
  );
  expect((result.lock as { owner_agent_id: string }).owner_agent_id).toBe("claude");
});

test("release_lock removes the owned lock", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "acquire_lock", { resource: "src/a.ts" });
  const result = await runTool(tools, "release_lock", { resource: "src/a.ts" });
  expect((result.lock as { resource: string }).resource).toBe("src/a.ts");
  const locks = await runTool(tools, "list_locks", {});
  expect((locks.locks as unknown[])).toHaveLength(0);
});

test("release_lock rejects a lock owned by another agent", async () => {
  const { store, tools } = await setupAsync();
  await store.acquireLock({ agentId: "codex", resource: "src/b.ts" });
  await expectToolError(tools, "release_lock", { resource: "src/b.ts" }, /owned by 'codex'/);
});

test("list_locks filters by resource", async () => {
  const { tools } = await setupAsync();
  await runTool(tools, "acquire_lock", { resource: "src/x.ts", purpose: "editing" });
  await runTool(tools, "acquire_lock", { resource: "src/y.ts" });
  const result = await runTool(tools, "list_locks", { resource: "src/x.ts" });
  expect((result.locks as Array<{ resource: string }>).map((l) => l.resource)).toEqual(["src/x.ts"]);
});

// --- artifacts ---

test("list_artifacts returns references attached to a visible owner", async () => {
  const { store, tools } = await setupAsync();
  const message = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Inspect this.",
    artifacts: [{ type: "file", path: "/tmp/report.md", label: "report" }],
  });
  const result = await runTool(tools, "list_artifacts", {
    owner_type: "message",
    owner_id: message.id,
  });
  expect((result.artifacts as Array<{ path: string }>).map((a) => a.path)).toContain(
    "/tmp/report.md",
  );
});

test("list_artifacts rejects when the owner is not visible", async () => {
  const { store, tools } = await setupAsync();
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "codex",
    body: "Private.",
  });
  await expectToolError(
    tools,
    "list_artifacts",
    { owner_type: "message", owner_id: message.id, workspace: "repo-a" },
    /not visible/,
  );
});
