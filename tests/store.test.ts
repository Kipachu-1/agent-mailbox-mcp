import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCommsStore } from "../src/store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two store instances communicate through the same sqlite database", () => {
  const { path } = tempDb();
  const codex = new LocalCommsStore(path);
  const claude = new LocalCommsStore(path);

  codex.registerAgent({ id: "codex", name: "Codex" });
  claude.registerAgent({ id: "claude", name: "Claude Code" });

  const message = codex.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Can you inspect the failing test?",
  });

  expect(claude.inbox("claude").map((item) => item.id)).toContain(message.id);
  expect(codex.inbox("codex").map((item) => item.id)).toContain(message.id);
  expect(claude.inbox("cursor").map((item) => item.id)).not.toContain(message.id);

  codex.close();
  claude.close();
});

test("channel messages keep independent per-agent read state", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  const message = store.sendMessage({
    senderId: "codex",
    channel: "handoffs",
    body: "Shared channel update.",
  });

  expect(store.inbox("claude", { unreadOnly: true }).map((item) => item.id)).toContain(message.id);
  expect(store.inbox("cursor", { unreadOnly: true }).map((item) => item.id)).toContain(message.id);

  const read = store.readMessage("claude", message.id);
  expect(read.unread).toBe(false);
  expect(read.read_at).toBeString();

  expect(store.inbox("claude", { unreadOnly: true }).map((item) => item.id)).not.toContain(message.id);
  expect(store.inbox("cursor", { unreadOnly: true }).map((item) => item.id)).toContain(message.id);

  store.close();
});

test("claim_task atomically rejects already claimed tasks", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);
  const task = store.createTask({
    creatorId: "codex",
    title: "Implement mailbox server",
  });

  const claimed = store.claimTask("claude", task.id);
  expect(claimed.status).toBe("claimed");
  expect(claimed.assignee_id).toBe("claude");

  expect(() => store.claimTask("cursor", task.id)).toThrow(/cannot be claimed/);

  store.close();
});

test("task updates append audit events", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);
  const task = store.createTask({
    creatorId: "codex",
    title: "Review README",
    channel: "docs",
    artifacts: [{ type: "file", path: "/tmp/README.md", line: 1, label: "README" }],
  });

  store.claimTask("claude", task.id, "Taking this.");
  const done = store.updateTask({
    agentId: "claude",
    taskId: task.id,
    status: "done",
    note: "README updated.",
  });

  const events = store.listTaskEvents(task.id);
  expect(done.status).toBe("done");
  expect(events.map((event) => event.event_type)).toEqual([
    "created",
    "claimed",
    "status_changed",
  ]);
  expect(events.at(-1)?.note).toBe("README updated.");

  const notifications = store.inbox("codex", { unreadOnly: true });
  const metadata = notifications[0]?.metadata as Record<string, unknown> | undefined;
  expect(notifications[0]?.recipient_id).toBe("codex");
  expect(notifications[0]?.sender_id).toBe("claude");
  expect(notifications[0]?.body).toContain("Task completed: Review README");
  expect(metadata?.event_type).toBe("task_status_notification");
  expect(metadata?.task_id).toBe(task.id);
  expect(notifications[0]?.artifacts[0]?.path).toBe("/tmp/README.md");

  store.close();
});

test("presence and workspace scoping isolate agents and messages", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  store.heartbeat({
    id: "codex",
    name: "Codex",
    workspace: "repo-a",
    status: "working",
    currentTaskId: "task-1",
  });
  store.heartbeat({ id: "claude", name: "Claude", workspace: "repo-b" });

  store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    channel: "handoffs",
    body: "repo-a only",
  });

  expect(store.whoIsOnline("repo-a").map((item) => item.id)).toEqual(["codex"]);
  expect(store.getAgent("codex")?.status).toBe("working");
  expect(store.inbox("claude", { workspace: "repo-b", channel: "handoffs" })).toHaveLength(0);
  expect(store.inbox("claude", { workspace: "repo-a", channel: "handoffs" })).toHaveLength(1);

  store.close();
});

test("threads, replies, and message artifacts are preserved", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  const first = store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Please review src/store.ts",
    artifacts: [{ type: "file", path: "/tmp/src/store.ts", line: 12, label: "store" }],
  });
  const reply = store.replyMessage({
    senderId: "claude",
    messageId: first.id,
    body: "I will check it.",
  });

  const threads = store.listThreads("claude");
  const messages = store.getThread("claude", first.thread_id);

  expect(reply.thread_id).toBe(first.thread_id);
  expect(threads[0]?.thread_id).toBe(first.thread_id);
  expect(messages.map((message) => message.body)).toEqual([
    "Please review src/store.ts",
    "I will check it.",
  ]);
  expect(messages[0]?.artifacts[0]?.path).toBe("/tmp/src/store.ts");

  store.close();
});

test("tasks support dependencies, priority, due dates, blocked reasons, and artifacts", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  const parent = store.createTask({
    creatorId: "codex",
    title: "Parent",
  });
  const child = store.createTask({
    creatorId: "codex",
    title: "Child",
    priority: 10,
    dueAt: "2026-06-07T00:00:00.000Z",
    parentTaskId: parent.id,
    dependencies: [parent.id],
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
  });

  const blocked = store.updateTask({
    agentId: "claude",
    taskId: child.id,
    status: "blocked",
    blockedReason: "Waiting on parent.",
  });

  expect(child.dependencies).toEqual([parent.id]);
  expect(child.priority).toBe(10);
  expect(child.artifacts[0]?.url).toBe("https://example.com/spec");
  expect(blocked.blocked_reason).toBe("Waiting on parent.");
  expect(store.listTasks("codex", { parentTaskId: parent.id }).map((task) => task.id)).toEqual([
    child.id,
  ]);

  store.close();
});

test("notes, channel summaries, and update watching expose shared memory", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);
  const since = new Date(Date.now() - 1000).toISOString();

  store.sendMessage({
    senderId: "codex",
    channel: "docs",
    body: "Docs update.",
  });
  const note = store.writeNote({
    agentId: "codex",
    channel: "docs",
    title: "Docs context",
    body: "README examples need to stay current.",
    pinned: true,
  });
  const unpinned = store.pinNote(note.id, false);
  const summary = store.summarizeChannel("claude", undefined, "docs");
  const updates = store.updatesSince("claude", undefined, since);

  expect(unpinned.pinned).toBe(false);
  expect(store.readNotes({ channel: "docs", query: "README" })[0]?.id).toBe(note.id);
  expect(JSON.stringify(summary)).toContain("Docs update.");
  expect(updates.messages.length).toBeGreaterThan(0);
  expect(updates.notes.length).toBeGreaterThan(0);

  store.close();
});

test("locks enforce workspace-scoped leases", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  const lock = store.acquireLock({
    agentId: "codex",
    resource: "src/store.ts",
    purpose: "editing",
  });
  const renewed = store.acquireLock({
    agentId: "codex",
    resource: "src/store.ts",
    purpose: "still editing",
  });

  expect(lock.owner_agent_id).toBe("codex");
  expect(renewed.purpose).toBe("still editing");
  expect(() =>
    store.acquireLock({
      agentId: "claude",
      resource: "src/store.ts",
    }),
  ).toThrow(/locked by 'codex'/);

  store.releaseLock("codex", "src/store.ts");
  expect(store.listLocks()).toHaveLength(0);

  store.close();
});

test("access keys authenticate by token and can be revoked", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);

  const created = store.createAccessKey({
    name: "Codex HTTP",
    agentId: "codex",
    agentName: "Codex",
    workspace: "mcp",
    token: "known-token",
  });

  expect(created.token).toBe("known-token");
  expect(created.key.token_prefix).toContain("...");
  expect(store.listAccessKeys()[0]?.token_prefix).toBe(created.key.token_prefix);

  const authenticated = store.authenticateAccessToken("known-token");
  expect(authenticated?.agent_id).toBe("codex");
  expect(authenticated?.workspace).toBe("mcp");
  expect(authenticated?.last_used_at).toBeString();
  expect(store.authenticateAccessToken("wrong-token")).toBeNull();

  const revoked = store.revokeAccessKey(created.key.id);
  expect(revoked.enabled).toBe(false);
  expect(store.authenticateAccessToken("known-token")).toBeNull();

  store.close();
});

test("stale claimed tasks are visible for reclamation checks", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);
  const task = store.createTask({
    creatorId: "codex",
    title: "Possibly abandoned task",
  });

  store.claimTask("claude", task.id, "Starting.");
  expect(store.listTasks("codex", { staleAfterSeconds: 3_600 }).map((item) => item.id)).not.toContain(
    task.id,
  );

  const db = new Database(path);
  db.query(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(
    "2000-01-01T00:00:00.000Z",
    task.id,
  );
  db.close();

  expect(store.listTasks("codex", { staleAfterSeconds: 3_600 }).map((item) => item.id)).toContain(
    task.id,
  );

  store.close();
});

test("claim_task respects workspace scope when provided", () => {
  const { path } = tempDb();
  const store = new LocalCommsStore(path);
  const task = store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Repo A task",
  });

  expect(() => store.claimTask("claude", task.id, undefined, "repo-b")).toThrow(/not in workspace/);
  expect(store.claimTask("claude", task.id, undefined, "repo-a").assignee_id).toBe("claude");

  store.close();
});

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}
