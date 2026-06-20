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

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-store-edge-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}

test("sendMessage rejects when neither recipient nor channel is supplied", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await expect(
    store.sendMessage({ senderId: "codex", body: "no destination" }),
  ).rejects.toThrow(/exactly one of recipient_id or channel/);
  await expect(
    store.sendMessage({
      senderId: "codex",
      recipientId: "claude",
      channel: "handoffs",
      body: "both",
    }),
  ).rejects.toThrow(/exactly one of recipient_id or channel/);
  await store.close();
});

test("replyMessage routes a channel reply back to the same channel thread", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const original = await store.sendMessage({
    senderId: "codex",
    channel: "handoffs",
    body: "Channel kickoff.",
  });
  const reply = await store.replyMessage({
    senderId: "claude",
    messageId: original.id,
    body: "Channel reply.",
  });
  expect(reply.kind).toBe("channel");
  expect(reply.channel).toBe("handoffs");
  expect(reply.thread_id).toBe(original.thread_id);
  expect(reply.reply_to_message_id).toBe(original.id);
  await store.close();
});

test("replyMessage to a direct message replies to the original sender", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const original = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Direct handoff.",
  });
  const reply = await store.replyMessage({
    senderId: "claude",
    messageId: original.id,
    body: "Direct reply.",
  });
  expect(reply.kind).toBe("direct");
  expect(reply.recipient_id).toBe("codex");
  expect(reply.thread_id).toBe(original.thread_id);
  await store.close();
});

test("replyMessage rejects when the message is not visible to the agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await expect(
    store.replyMessage({ senderId: "claude", messageId: "missing", body: "x" }),
  ).rejects.toThrow(/not visible/);
  await store.close();
});

test("readMessage rejects when the message is not visible to the agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await expect(store.readMessage("claude", "missing")).rejects.toThrow(/not visible/);
  await store.close();
});

test("searchMessages only returns messages visible to the requesting agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "secret handshake",
  });
  // Cursor is neither sender nor recipient and should not see the direct message.
  expect(
    (await store.searchMessages("cursor", { query: "secret" })).map((m) => m.body),
  ).toHaveLength(0);
  expect(
    (await store.searchMessages("claude", { query: "secret" })).map((m) => m.body),
  ).toContain("secret handshake");
  await store.close();
});

test("listThreads and getThread stay scoped to visible messages", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const visible = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Visible thread root.",
  });
  const hidden = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "codex",
    body: "Private thread root.",
  });
  expect((await store.listThreads("claude")).map((t) => t.thread_id)).toContain(visible.thread_id);
  expect((await store.listThreads("cursor")).map((t) => t.thread_id)).not.toContain(hidden.thread_id);
  expect((await store.getThread("claude", visible.thread_id)).map((m) => m.body)).toEqual([
    "Visible thread root.",
  ]);
  await store.close();
});

test("claimTask rejects a nonexistent task id", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await expect(store.claimTask("claude", "missing")).rejects.toThrow(/does not exist/);
  await store.close();
});

test("updateTask rejects when the task is not visible to the agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Private",
    assigneeId: "claude",
  });
  await expect(
    store.updateTask({ agentId: "cursor", workspace: "repo-a", taskId: task.id, status: "done" }),
  ).rejects.toThrow(/not visible/);
  await store.close();
});

test("updateTask can set priority, due date, and blocked reason", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({ creatorId: "codex", title: "Triage" });
  await store.claimTask("claude", task.id);
  const updated = await store.updateTask({
    agentId: "claude",
    taskId: task.id,
    status: "blocked",
    priority: 25,
    dueAt: "2026-07-01T00:00:00.000Z",
    blockedReason: "Waiting on infra.",
  });
  expect(updated.priority).toBe(25);
  expect(updated.due_at).toBe("2026-07-01T00:00:00.000Z");
  expect(updated.blocked_reason).toBe("Waiting on infra.");
  await store.close();
});

test("listVisibleTaskEvents rejects when the task is not visible", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Private",
    assigneeId: "claude",
  });
  await expect(
    store.listVisibleTaskEvents("cursor", task.id, "repo-a"),
  ).rejects.toThrow(/not visible/);
  await store.close();
});

test("acquireLock renews an owned lock and updates purpose", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const first = await store.acquireLock({
    agentId: "claude",
    resource: "src/renew.ts",
    purpose: "first edit",
  });
  const renewed = await store.acquireLock({
    agentId: "claude",
    resource: "src/renew.ts",
    purpose: "continued edit",
    ttlSeconds: 60,
  });
  expect(renewed.id).toBe(first.id);
  expect(renewed.purpose).toBe("continued edit");
  await store.close();
});

test("releaseLock rejects a nonexistent lock", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await expect(store.releaseLock("claude", "src/none.ts")).rejects.toThrow(/does not exist/);
  await store.close();
});

test("listLocks excludes expired leases by default and includes them when asked", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.acquireLock({
    agentId: "claude",
    resource: "src/expiring.ts",
    ttlSeconds: 1,
  });

  // Force the lock to be expired without waiting on wall-clock time.
  const db = new Database(path);
  db.query(`UPDATE locks SET expires_at = ? WHERE resource = ?`).run(
    "2000-01-01T00:00:00.000Z",
    "src/expiring.ts",
  );
  db.close();

  expect((await store.listLocks({ includeExpired: false })).map((l) => l.resource)).toHaveLength(0);
  expect((await store.listLocks({ includeExpired: true })).map((l) => l.resource)).toContain(
    "src/expiring.ts",
  );
  await store.close();
});

test("writeNote rejects overwriting a note scoped to a different workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const note = await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    noteId: "shared",
    title: "Repo A",
    body: "Repo A context.",
  });
  await expect(
    store.writeNote({
      agentId: "claude",
      workspace: "repo-b",
      noteId: note.id,
      title: "Repo B",
      body: "Overwrite attempt.",
    }),
  ).rejects.toThrow(/not in workspace 'repo-b'/);
  await store.close();
});

test("readNotes supports channel and workspace scoping together", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    channel: "docs",
    title: "Docs note",
    body: "Keep examples current.",
  });
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    channel: "ops",
    title: "Ops note",
    body: "Rotate keys monthly.",
  });
  expect(
    (await store.readNotes({ workspace: "repo-a", channel: "docs" })).map((n) => n.title),
  ).toEqual(["Docs note"]);
  expect(await store.readNotes({ workspace: "repo-b", channel: "docs" })).toHaveLength(0);
  await store.close();
});

test("summarizeChannel aggregates messages, tasks, and notes for a channel", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.sendMessage({ senderId: "codex", channel: "docs", body: "Doc msg." });
  await store.createTask({ creatorId: "codex", channel: "docs", title: "Doc task" });
  await store.writeNote({ agentId: "codex", channel: "docs", title: "Doc note", body: "x" });

  const summary = await store.summarizeChannel("claude", undefined, "docs");
  expect(summary).toMatchObject({ channel: "docs", message_count: 1, task_count: 1, note_count: 1 });
  expect((summary.open_tasks as Array<{ title: string }>).map((t) => t.title)).toContain("Doc task");
  await store.close();
});
