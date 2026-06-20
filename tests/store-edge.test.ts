import { afterEach, expect, test } from "bun:test";
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

// ---------------------------------------------------------------------------
// Messages — edge cases
// ---------------------------------------------------------------------------

test("sendMessage rejects when both recipient_id and channel are set", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(
    store.sendMessage({
      senderId: "codex",
      recipientId: "claude",
      channel: "handoffs",
      body: "ambiguous",
    }),
  ).rejects.toThrow(/exactly one of recipient_id or channel/);

  await store.close();
});

test("sendMessage rejects when neither recipient_id nor channel is set", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(
    store.sendMessage({ senderId: "codex", body: "no destination" }),
  ).rejects.toThrow(/exactly one of recipient_id or channel/);

  await store.close();
});

test("replyMessage rejects when the original message is not visible", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(
    store.replyMessage({ senderId: "codex", messageId: "nonexistent", body: "reply" }),
  ).rejects.toThrow(/not visible/);

  await store.close();
});

test("readMessage marks a message read and it disappears from unread inbox", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const message = await store.sendMessage({
    senderId: "claude",
    recipientId: "codex",
    body: "Read me.",
  });

  expect((await store.inbox("codex", { unreadOnly: true })).map((m) => m.id)).toContain(message.id);
  const read = await store.readMessage("codex", message.id);
  expect(read.unread).toBe(false);
  expect((await store.inbox("codex", { unreadOnly: true })).map((m) => m.id)).not.toContain(
    message.id,
  );

  await store.close();
});

test("readMessage rejects when the message is not visible to the agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(store.readMessage("cursor", "nonexistent")).rejects.toThrow(/not visible/);

  await store.close();
});

test("searchMessages returns only visible messages matching the query", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.sendMessage({ senderId: "codex", recipientId: "claude", body: "alpha beta" });
  await store.sendMessage({ senderId: "codex", recipientId: "claude", body: "gamma delta" });

  const results = await store.searchMessages("claude", { query: "alpha" });
  expect(results.map((m) => m.body)).toEqual(["alpha beta"]);

  const empty = await store.searchMessages("claude", { query: "zzz" });
  expect(empty).toHaveLength(0);

  await store.close();
});

test("inbox respects the limit option", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  for (let i = 0; i < 5; i++) {
    await store.sendMessage({ senderId: "claude", recipientId: "codex", body: `msg ${i}` });
  }

  expect((await store.inbox("codex", { limit: 2 })).length).toBe(2);
  await store.close();
});

test("getThread rejects when the thread is not visible to the agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const results = await store.getThread("cursor", "nonexistent-thread");
  expect(results).toHaveLength(0);

  await store.close();
});

// ---------------------------------------------------------------------------
// Tasks — edge cases
// ---------------------------------------------------------------------------

test("claimTask rejects when the task does not exist", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(store.claimTask("codex", "nonexistent")).rejects.toThrow(/does not exist/);

  await store.close();
});

test("claimTask rejects when the task is already claimed", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({ creatorId: "codex", title: "Task" });

  await store.claimTask("claude", task.id);
  await expect(store.claimTask("cursor", task.id)).rejects.toThrow(/cannot be claimed/);

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
    store.updateTask({
      agentId: "cursor",
      workspace: "repo-a",
      taskId: task.id,
      status: "done",
    }),
  ).rejects.toThrow(/not visible/);

  await store.close();
});

test("listTasks filters by assignee and creator", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.createTask({ creatorId: "codex", title: "A", assigneeId: "claude" });
  await store.createTask({ creatorId: "claude", title: "B", assigneeId: "codex" });

  expect(
    (await store.listTasks("codex", { assigneeId: "codex" })).map((t) => t.title),
  ).toEqual(["B"]);
  expect(
    (await store.listTasks("codex", { creatorId: "codex" })).map((t) => t.title),
  ).toEqual(["A"]);

  await store.close();
});

test("updateTask to claimed status does not notify the creator", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Task",
    assigneeId: "claude",
  });

  // "claimed" is not in shouldNotifyForStatus, so the creator gets no notification.
  await store.updateTask({
    agentId: "claude",
    workspace: "repo-a",
    taskId: task.id,
    status: "claimed",
    note: "Taking this.",
  });

  const notifications = await store.inbox("codex", { workspace: "repo-a", unreadOnly: true });
  expect(notifications).toHaveLength(0);

  await store.close();
});

test("createTask with dependencies and parent stores them for retrieval", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const parent = await store.createTask({ creatorId: "codex", title: "Parent" });
  const child = await store.createTask({
    creatorId: "codex",
    title: "Child",
    parentTaskId: parent.id,
    dependencies: [parent.id],
  });

  expect(child.dependencies).toEqual([parent.id]);
  expect(child.parent_task_id).toBe(parent.id);
  expect((await store.listTasks("codex", { parentTaskId: parent.id })).map((t) => t.id)).toEqual([
    child.id,
  ]);

  await store.close();
});

// ---------------------------------------------------------------------------
// Locks — edge cases
// ---------------------------------------------------------------------------

test("releaseLock rejects when the lock does not exist", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(store.releaseLock("codex", "nonexistent")).rejects.toThrow(/does not exist/);

  await store.close();
});

test("releaseLock rejects when the lock is owned by another agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.acquireLock({ agentId: "codex", resource: "src/file.ts" });
  await expect(store.releaseLock("claude", "src/file.ts")).rejects.toThrow(/owned by 'codex'/);

  await store.close();
});

test("acquireLock allows the same agent to renew and update the purpose", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.acquireLock({ agentId: "codex", resource: "src/file.ts", purpose: "editing" });
  const renewed = await store.acquireLock({
    agentId: "codex",
    resource: "src/file.ts",
    purpose: "still editing",
  });

  expect(renewed.purpose).toBe("still editing");
  expect(renewed.owner_agent_id).toBe("codex");

  await store.close();
});

test("listLocks filters by resource and includes expired when requested", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.acquireLock({ agentId: "codex", resource: "src/a.ts" });
  await store.acquireLock({
    agentId: "codex",
    resource: "src/b.ts",
    ttlSeconds: 1,
  });

  // Both visible before expiry.
  expect((await store.listLocks()).length).toBe(2);

  // Force expiry of src/b.ts.
  const db = new (await import("bun:sqlite")).Database(path);
  db.query(`UPDATE locks SET expires_at = ? WHERE resource = ?`).run(
    "2000-01-01T00:00:00.000Z",
    "src/b.ts",
  );
  db.close();

  // Without includeExpired, only the active lock shows.
  expect((await store.listLocks()).map((l) => l.resource)).toEqual(["src/a.ts"]);
  // With includeExpired, both show.
  expect((await store.listLocks({ includeExpired: true })).map((l) => l.resource).sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
  ]);
  // Filter by resource.
  expect((await store.listLocks({ resource: "src/a.ts" })).map((l) => l.resource)).toEqual([
    "src/a.ts",
  ]);

  await store.close();
});

test("locks are isolated by workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.acquireLock({ agentId: "codex", workspace: "repo-a", resource: "src/file.ts" });
  // Same resource in a different workspace is allowed.
  const other = await store.acquireLock({
    agentId: "claude",
    workspace: "repo-b",
    resource: "src/file.ts",
  });

  expect(other.owner_agent_id).toBe("claude");
  expect((await store.listLocks({ workspace: "repo-a" })).length).toBe(1);
  expect((await store.listLocks({ workspace: "repo-b" })).length).toBe(1);

  await store.close();
});

// ---------------------------------------------------------------------------
// Notes — edge cases
// ---------------------------------------------------------------------------

test("writeNote updates an existing note in the same workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    noteId: "conventions",
    title: "Original",
    body: "Original body.",
  });
  const updated = await store.writeNote({
    agentId: "claude",
    workspace: "repo-a",
    noteId: "conventions",
    title: "Updated",
    body: "Updated body.",
  });

  expect(updated.title).toBe("Updated");
  expect(updated.body).toBe("Updated body.");
  expect((await store.readNotes({ workspace: "repo-a" })).length).toBe(1);

  await store.close();
});

test("writeNote rejects overwriting a note from a different workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    noteId: "shared",
    title: "A",
    body: "A body.",
  });

  await expect(
    store.writeNote({
      agentId: "claude",
      workspace: "repo-b",
      noteId: "shared",
      title: "B",
      body: "B body.",
    }),
  ).rejects.toThrow(/not in workspace 'repo-b'/);

  await store.close();
});

test("readNotes searches by query across title and body", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Coding Standards",
    body: "Use TypeScript strict mode.",
  });
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Random",
    body: "Nothing relevant here.",
  });

  const byTitle = await store.readNotes({ workspace: "repo-a", query: "Standards" });
  const byBody = await store.readNotes({ workspace: "repo-a", query: "TypeScript" });

  expect(byTitle.map((n) => n.title)).toEqual(["Coding Standards"]);
  expect(byBody.map((n) => n.title)).toEqual(["Coding Standards"]);

  await store.close();
});

test("pinNote rejects when the note does not exist", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await expect(store.pinNote("nonexistent", true)).rejects.toThrow(/does not exist/);

  await store.close();
});

test("summarizeChannel returns zero counts for an empty channel", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const summary = await store.summarizeChannel("codex", "repo-a", "empty");

  expect(summary).toMatchObject({
    workspace: "repo-a",
    channel: "empty",
    message_count: 0,
    task_count: 0,
    note_count: 0,
  });

  await store.close();
});
