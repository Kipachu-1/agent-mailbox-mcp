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

test("two store instances communicate through the same sqlite database", async () => {
  const { path } = tempDb();
  const codex = await LocalCommsStore.openSqlite(path);
  const claude = await LocalCommsStore.openSqlite(path);

  await codex.registerAgent({ id: "codex", name: "Codex" });
  await claude.registerAgent({ id: "claude", name: "Claude Code" });

  const message = await codex.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Can you inspect the failing test?",
  });

  expect((await claude.inbox("claude")).map((item) => item.id)).toContain(message.id);
  expect((await codex.inbox("codex")).map((item) => item.id)).toContain(message.id);
  expect((await claude.inbox("cursor")).map((item) => item.id)).not.toContain(message.id);

  await codex.close();
  await claude.close();
});

test("channel messages keep independent per-agent read state", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const message = await store.sendMessage({
    senderId: "codex",
    channel: "handoffs",
    body: "Shared channel update.",
  });

  expect((await store.inbox("claude", { unreadOnly: true })).map((item) => item.id)).toContain(message.id);
  expect((await store.inbox("cursor", { unreadOnly: true })).map((item) => item.id)).toContain(message.id);

  const read = await store.readMessage("claude", message.id);
  expect(read.unread).toBe(false);
  expect(read.read_at).toBeString();

  expect((await store.inbox("claude", { unreadOnly: true })).map((item) => item.id)).not.toContain(message.id);
  expect((await store.inbox("cursor", { unreadOnly: true })).map((item) => item.id)).toContain(message.id);

  await store.close();
});

test("claim_task atomically rejects already claimed tasks", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    title: "Implement mailbox server",
  });

  const claimed = await store.claimTask("claude", task.id);
  expect(claimed.status).toBe("claimed");
  expect(claimed.assignee_id).toBe("claude");

  await expect(store.claimTask("cursor", task.id)).rejects.toThrow(/cannot be claimed/);

  await store.close();
});

test("task updates append audit events", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    title: "Review README",
    channel: "docs",
    artifacts: [{ type: "file", path: "/tmp/README.md", line: 1, label: "README" }],
  });

  await store.claimTask("claude", task.id, "Taking this.");
  const done = await store.updateTask({
    agentId: "claude",
    taskId: task.id,
    status: "done",
    note: "README updated.",
    artifacts: [{ type: "diff", path: "/tmp/README.patch", label: "completion diff" }],
  });

  const events = await store.listVisibleTaskEvents("claude", task.id);
  expect(done.status).toBe("done");
  expect(events.map((event) => event.event_type)).toEqual([
    "created",
    "claimed",
    "status_changed",
  ]);
  expect(events.at(-1)?.note).toBe("README updated.");
  expect(done.artifacts.map((artifact) => artifact.path)).toContain("/tmp/README.patch");

  const notifications = await store.inbox("codex", { unreadOnly: true });
  const metadata = notifications[0]?.metadata as Record<string, unknown> | undefined;
  expect(notifications[0]?.recipient_id).toBe("codex");
  expect(notifications[0]?.sender_id).toBe("claude");
  expect(notifications[0]?.body).toContain("Task completed: Review README");
  expect(metadata?.event_type).toBe("task_status_notification");
  expect(metadata?.task_id).toBe(task.id);
  expect(notifications[0]?.artifacts.map((artifact) => artifact.path)).toContain("/tmp/README.md");
  expect(notifications[0]?.artifacts.map((artifact) => artifact.path)).toContain(
    "/tmp/README.patch",
  );

  await store.close();
});

test("presence and workspace scoping isolate agents and messages", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.heartbeat({
    id: "codex",
    name: "Codex",
    workspace: "repo-a",
    status: "working",
    currentTaskId: "task-1",
  });
  await store.heartbeat({ id: "claude", name: "Claude", workspace: "repo-b" });

  await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    channel: "handoffs",
    body: "repo-a only",
  });

  expect((await store.whoIsOnline("repo-a")).map((item) => item.id)).toEqual(["codex"]);
  expect((await store.getAgent("codex"))?.status).toBe("working");
  expect(await store.inbox("claude", { workspace: "repo-b", channel: "handoffs" })).toHaveLength(0);
  expect(await store.inbox("claude", { workspace: "repo-a", channel: "handoffs" })).toHaveLength(1);

  await store.close();
});

test("same agent id keeps separate presence in each workspace", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.heartbeat({
    id: "codex",
    name: "Codex A",
    workspace: "repo-a",
    status: "working",
    currentTaskId: "task-a",
  });
  await store.heartbeat({
    id: "codex",
    name: "Codex B",
    workspace: "repo-b",
    status: "available",
    currentTaskId: "task-b",
  });

  expect((await store.getAgent("codex", "repo-a"))?.status).toBe("working");
  expect((await store.getAgent("codex", "repo-a"))?.current_task_id).toBe("task-a");
  expect((await store.getAgent("codex", "repo-b"))?.status).toBe("available");
  expect((await store.getAgent("codex", "repo-b"))?.current_task_id).toBe("task-b");
  expect((await store.listAgents("repo-a")).map((agent) => agent.name)).toEqual(["Codex A"]);
  expect((await store.listAgents("repo-b")).map((agent) => agent.name)).toEqual(["Codex B"]);

  await store.close();
});

test("migration upgrades legacy agent primary key and task dependency foreign keys", async () => {
  const { path } = tempDb();
  const now = new Date().toISOString();
  const db = new Database(path);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'available',
      current_task_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    INSERT INTO agents
      (id, name, workspace, status, current_task_id, metadata, created_at, updated_at, last_seen_at)
    VALUES
      ('codex', 'Codex', 'repo-a', 'working', 'task-1', '{}', '${now}', '${now}', '${now}');

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      creator_id TEXT NOT NULL,
      assignee_id TEXT,
      channel TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done', 'blocked', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      parent_task_id TEXT,
      blocked_reason TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tasks
      (id, workspace, title, creator_id, status, created_at, updated_at)
    VALUES
      ('parent', 'repo-a', 'Parent', 'codex', 'open', '${now}', '${now}'),
      ('child', 'repo-a', 'Child', 'codex', 'open', '${now}', '${now}');

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    INSERT INTO task_dependencies (task_id, depends_on_task_id)
    VALUES ('child', 'parent'), ('child', 'missing');
  `);
  db.close();

  const store = await LocalCommsStore.openSqlite(path);
  expect((await store.getAgent("codex", "repo-a"))?.current_task_id).toBe("task-1");
  expect(
    (await store.listTasks("codex", { workspace: "repo-a", parentTaskId: undefined })).map((task) => task.id),
  ).toContain("child");
  await store.close();

  const migrated = new Database(path);
  const agentColumns = migrated
    .query<{ name: string; pk: number }, []>(`PRAGMA table_info(agents)`)
    .all();
  const dependencyForeignKeys = migrated
    .query<{ from: string; table: string }, []>(`PRAGMA foreign_key_list(task_dependencies)`)
    .all();
  const dependencies = migrated
    .query<{ depends_on_task_id: string }, []>(
      `SELECT depends_on_task_id FROM task_dependencies ORDER BY depends_on_task_id`,
    )
    .all();
  migrated.close();

  expect(agentColumns.find((column) => column.name === "workspace")?.pk).toBe(1);
  expect(agentColumns.find((column) => column.name === "id")?.pk).toBe(2);
  expect(dependencyForeignKeys.map((key) => key.from).sort()).toEqual([
    "depends_on_task_id",
    "task_id",
  ]);
  expect(dependencies.map((dependency) => dependency.depends_on_task_id)).toEqual(["parent"]);
});

test("threads, replies, and message artifacts are preserved", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const first = await store.sendMessage({
    senderId: "codex",
    recipientId: "claude",
    body: "Please review src/store.ts",
    artifacts: [{ type: "file", path: "/tmp/src/store.ts", line: 12, label: "store" }],
  });
  const reply = await store.replyMessage({
    senderId: "claude",
    messageId: first.id,
    body: "I will check it.",
  });

  const threads = await store.listThreads("claude");
  const messages = await store.getThread("claude", first.thread_id);

  expect(reply.thread_id).toBe(first.thread_id);
  expect(threads[0]?.thread_id).toBe(first.thread_id);
  expect(messages.map((message) => message.body)).toEqual([
    "Please review src/store.ts",
    "I will check it.",
  ]);
  expect(messages[0]?.artifacts[0]?.path).toBe("/tmp/src/store.ts");

  await store.close();
});

test("tasks support dependencies, priority, due dates, blocked reasons, and artifacts", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const parent = await store.createTask({
    creatorId: "codex",
    title: "Parent",
  });
  const child = await store.createTask({
    creatorId: "codex",
    title: "Child",
    priority: 10,
    dueAt: "2026-06-07T00:00:00.000Z",
    parentTaskId: parent.id,
    dependencies: [parent.id],
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
  });

  const blocked = await store.updateTask({
    agentId: "claude",
    taskId: child.id,
    status: "blocked",
    blockedReason: "Waiting on parent.",
  });

  expect(child.dependencies).toEqual([parent.id]);
  expect(child.priority).toBe(10);
  expect(child.artifacts[0]?.url).toBe("https://example.com/spec");
  expect(blocked.blocked_reason).toBe("Waiting on parent.");
  expect((await store.listTasks("codex", { parentTaskId: parent.id })).map((task) => task.id)).toEqual([
    child.id,
  ]);

  await store.close();
});

test("notes, channel summaries, and update watching expose shared memory", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const since = new Date(Date.now() - 1000).toISOString();

  await store.sendMessage({
    senderId: "codex",
    channel: "docs",
    body: "Docs update.",
  });
  const note = await store.writeNote({
    agentId: "codex",
    channel: "docs",
    title: "Docs context",
    body: "README examples need to stay current.",
    pinned: true,
  });
  const unpinned = await store.pinNote(note.id, false);
  const summary = await store.summarizeChannel("claude", undefined, "docs");
  const updates = await store.updatesSince("claude", undefined, since);

  expect(unpinned.pinned).toBe(false);
  expect((await store.readNotes({ channel: "docs", query: "README" }))[0]?.id).toBe(note.id);
  expect(JSON.stringify(summary)).toContain("Docs update.");
  expect(updates.messages.length).toBeGreaterThan(0);
  expect(updates.notes.length).toBeGreaterThan(0);

  await store.close();
});

test("notes cannot be overwritten or pinned across workspaces", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const note = await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    noteId: "shared-note",
    title: "Repo A",
    body: "Repo A context.",
  });

  await expect(
    store.writeNote({
      agentId: "claude",
      workspace: "repo-b",
      noteId: note.id,
      title: "Repo B",
      body: "Attempted overwrite.",
    }),
  ).rejects.toThrow(/not in workspace 'repo-b'/);
  await expect(store.pinNote(note.id, true, "repo-b")).rejects.toThrow(/not in workspace 'repo-b'/);
  expect((await store.pinNote(note.id, true, "repo-a")).pinned).toBe(true);
  expect((await store.readNotes({ workspace: "repo-a" }))[0]?.title).toBe("Repo A");
  expect(await store.readNotes({ workspace: "repo-b" })).toHaveLength(0);

  await store.close();
});

test("write_note update preserves artifacts by default and appends new ones", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const note = await store.writeNote({
    agentId: "codex",
    channel: "docs",
    title: "Conventions",
    body: "Keep examples current.",
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
  });
  expect(note.artifacts.map((a) => a.url)).toEqual(["https://example.com/spec"]);

  // Update the title without re-passing artifacts: existing artifact is kept.
  const updated = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Conventions (v2)",
    body: "Keep examples current.",
  });
  expect(updated.title).toBe("Conventions (v2)");
  expect(updated.artifacts.map((a) => a.url)).toEqual(["https://example.com/spec"]);

  // Append a new artifact by default; existing one is preserved.
  const appended = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Conventions (v2)",
    body: "Keep examples current.",
    artifacts: [{ type: "file", path: "/tmp/README.md", label: "readme" }],
  });
  expect(appended.artifacts.map((a) => a.url ?? a.path).sort()).toEqual([
    "/tmp/README.md",
    "https://example.com/spec",
  ]);

  await store.close();
});

test("write_note append is idempotent by artifact identity", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const note = await store.writeNote({
    agentId: "codex",
    title: "Links",
    body: "Reference list.",
    artifacts: [{ type: "url", url: "https://example.com/a", label: "a" }],
  });

  // Re-passing the same reference does not create a duplicate.
  const reappended = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Links",
    body: "Reference list.",
    artifacts: [{ type: "url", url: "https://example.com/a", label: "a (again)" }],
  });
  expect(reappended.artifacts).toHaveLength(1);
  expect(reappended.artifacts[0]?.url).toBe("https://example.com/a");

  // A different identity is added; the same one is still deduped.
  const mixed = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Links",
    body: "Reference list.",
    artifacts: [
      { type: "url", url: "https://example.com/a", label: "a" },
      { type: "url", url: "https://example.com/b", label: "b" },
    ],
  });
  expect(mixed.artifacts.map((a) => a.url).sort()).toEqual([
    "https://example.com/a",
    "https://example.com/b",
  ]);

  await store.close();
});

test("write_note replace_artifacts fully overwrites the artifact set on update", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const note = await store.writeNote({
    agentId: "codex",
    title: "Files",
    body: "Tracked files.",
    artifacts: [
      { type: "file", path: "/tmp/old.ts", label: "old" },
      { type: "file", path: "/tmp/keep.ts", label: "keep" },
    ],
  });
  expect(note.artifacts.map((a) => a.path).sort()).toEqual(["/tmp/keep.ts", "/tmp/old.ts"]);

  const replaced = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Files",
    body: "Tracked files.",
    artifacts: [{ type: "file", path: "/tmp/new.ts", label: "new" }],
    replaceArtifacts: true,
  });
  expect(replaced.artifacts.map((a) => a.path)).toEqual(["/tmp/new.ts"]);
  // Old artifacts are gone.
  expect(replaced.artifacts.map((a) => a.path)).not.toContain("/tmp/old.ts");

  // replaceArtifacts: true with an empty set clears all artifacts.
  const cleared = await store.writeNote({
    agentId: "codex",
    noteId: note.id,
    title: "Files",
    body: "Tracked files.",
    artifacts: [],
    replaceArtifacts: true,
  });
  expect(cleared.artifacts).toEqual([]);

  await store.close();
});

test("write_note create attaches artifacts as today (replace flag ignored)", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const note = await store.writeNote({
    agentId: "codex",
    title: "Fresh",
    body: "Brand new note.",
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
    // replaceArtifacts has no effect on create.
    replaceArtifacts: true,
  });
  expect(note.artifacts.map((a) => a.url)).toEqual(["https://example.com/spec"]);

  await store.close();
});

test("watch updates only returns task events visible to the requesting agent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const since = new Date(Date.now() - 1000).toISOString();

  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Private task",
    assigneeId: "claude",
  });
  await store.updateTask({
    agentId: "claude",
    workspace: "repo-a",
    taskId: task.id,
    status: "done",
  });

  expect((await store.updatesSince("cursor", "repo-a", since)).task_events).toHaveLength(0);
  expect((await store.updatesSince("codex", "repo-a", since)).task_events.length).toBeGreaterThan(0);
  expect((await store.updatesSince("claude", "repo-a", since)).task_events.length).toBeGreaterThan(0);

  await store.close();
});

test("task updates and artifacts require owner visibility", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Private message.",
    artifacts: [{ type: "file", path: "/tmp/private.ts" }],
  });
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Private task",
    assigneeId: "claude",
    artifacts: [{ type: "url", url: "https://example.com/private" }],
  });

  expect((await store.listVisibleArtifacts("claude", "repo-a", "message", message.id))[0]?.path).toBe(
    "/tmp/private.ts",
  );
  expect((await store.listVisibleArtifacts("claude", "repo-a", "task", task.id))[0]?.url).toBe(
    "https://example.com/private",
  );
  await expect(store.listVisibleArtifacts("cursor", "repo-a", "message", message.id)).rejects.toThrow(
    /not visible/,
  );
  await expect(store.listVisibleArtifacts("cursor", "repo-a", "task", task.id)).rejects.toThrow(
    /not visible/,
  );
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

test("locks enforce workspace-scoped leases", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const lock = await store.acquireLock({
    agentId: "codex",
    resource: "src/store.ts",
    purpose: "editing",
  });
  const renewed = await store.acquireLock({
    agentId: "codex",
    resource: "src/store.ts",
    purpose: "still editing",
  });

  expect(lock.owner_agent_id).toBe("codex");
  expect(renewed.purpose).toBe("still editing");
  await expect(
    store.acquireLock({
      agentId: "claude",
      resource: "src/store.ts",
    }),
  ).rejects.toThrow(/locked by 'codex'/);

  await store.releaseLock("codex", "src/store.ts");
  expect(await store.listLocks()).toHaveLength(0);

  await store.close();
});

test("access keys authenticate by token and can be revoked", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const created = await store.createAccessKey({
    name: "Codex HTTP",
    agentId: "codex",
    agentName: "Codex",
    workspace: "mcp",
    token: "known-token",
  });

  expect(created.token).toBe("known-token");
  expect(created.key.token_prefix).toContain("...");
  expect((await store.listAccessKeys())[0]?.token_prefix).toBe(created.key.token_prefix);

  const authenticated = await store.authenticateAccessToken("known-token");
  expect(authenticated?.agent_id).toBe("codex");
  expect(authenticated?.workspace).toBe("mcp");
  expect(authenticated?.last_used_at).toBeString();
  expect(await store.authenticateAccessToken("wrong-token")).toBeNull();

  const revoked = await store.revokeAccessKey(created.key.id);
  expect(revoked.enabled).toBe(false);
  expect(await store.authenticateAccessToken("known-token")).toBeNull();

  await store.close();
});

test("stale claimed tasks are visible for reclamation checks", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    title: "Possibly abandoned task",
  });

  await store.claimTask("claude", task.id, "Starting.");
  expect((await store.listTasks("codex", { staleAfterSeconds: 3_600 })).map((item) => item.id)).not.toContain(
    task.id,
  );

  const db = new Database(path);
  db.query(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(
    "2000-01-01T00:00:00.000Z",
    task.id,
  );
  db.close();

  expect((await store.listTasks("codex", { staleAfterSeconds: 3_600 })).map((item) => item.id)).toContain(
    task.id,
  );

  await store.close();
});

test("claim_task respects workspace scope when provided", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Repo A task",
  });

  await expect(store.claimTask("claude", task.id, undefined, "repo-b")).rejects.toThrow(/not in workspace/);
  expect((await store.claimTask("claude", task.id, undefined, "repo-a")).assignee_id).toBe("claude");

  await store.close();
});

test("update_task edits editable fields with partial-update semantics", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  await store.registerAgent({ id: "codex", name: "Codex" });
  await store.registerAgent({ id: "claude", name: "Claude Code" });
  await store.registerAgent({ id: "cursor", name: "Cursor" });

  const parent = await store.createTask({
    creatorId: "codex",
    title: "Parent task",
  });
  const other = await store.createTask({
    creatorId: "codex",
    title: "Other dependency",
  });

  const task = await store.createTask({
    creatorId: "codex",
    title: "Original title",
    description: "Original description",
    channel: "docs",
  });

  // Partial update: only title and assignee_id. Omitted fields stay unchanged.
  const updated = await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    title: "Corrected title",
    assigneeId: "claude",
  });

  expect(updated.title).toBe("Corrected title");
  expect(updated.assignee_id).toBe("claude");
  expect(updated.description).toBe("Original description");
  expect(updated.channel).toBe("docs");
  expect(updated.status).toBe("open");

  // Reassign directly to another agent (direct-assignment path).
  const reassigned = await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    assigneeId: "cursor",
  });
  expect(reassigned.assignee_id).toBe("cursor");

  // Update description, channel, parent_task_id, and dependencies together.
  const withDeps = await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    description: "Revised description",
    channel: "backend",
    parentTaskId: parent.id,
    dependencies: [parent.id, other.id],
  });
  expect(withDeps.description).toBe("Revised description");
  expect(withDeps.channel).toBe("backend");
  expect(withDeps.parent_task_id).toBe(parent.id);
  expect(withDeps.dependencies).toEqual([other.id, parent.id].sort());

  // Clearing dependencies with [] and clearing channel/parent/assignee with null.
  const cleared = await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    dependencies: [],
    channel: null,
    parentTaskId: null,
    assigneeId: null,
  });
  expect(cleared.dependencies).toEqual([]);
  expect(cleared.channel).toBeNull();
  expect(cleared.parent_task_id).toBeNull();
  expect(cleared.assignee_id).toBeNull();

  // Omitting dependencies leaves them unchanged (still empty here).
  const untouched = await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    title: "Final title",
  });
  expect(untouched.dependencies).toEqual([]);
  expect(untouched.title).toBe("Final title");

  await store.close();
});

test("update_task emits updated events for changed fields and status_changed for status", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.registerAgent({ id: "codex", name: "Codex" });

  const task = await store.createTask({ creatorId: "codex", title: "Audit task" });

  // Field-only update emits `updated`, not `status_changed` (status unchanged).
  await store.updateTask({
    agentId: "codex",
    taskId: task.id,
    title: "Audited task",
    note: "Fixed typo",
  });
  let events = await store.listVisibleTaskEvents("codex", task.id);
  expect(events.map((e) => e.event_type)).toEqual(["created", "updated"]);
  expect(events.at(-1)?.note).toContain("title");
  expect(events.at(-1)?.note).toContain("Fixed typo");

  // Status change emits `status_changed`.
  await store.updateTask({ agentId: "codex", taskId: task.id, status: "done" });
  events = await store.listVisibleTaskEvents("codex", task.id);
  expect(events.map((e) => e.event_type)).toEqual(["created", "updated", "status_changed"]);

  await store.close();
});

test("update_task rejects invalid assignee_id, parent_task_id, and self-parent", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.registerAgent({ id: "codex", name: "Codex", workspace: "ws" });

  const task = await store.createTask({
    creatorId: "codex",
    workspace: "ws",
    title: "Task",
  });

  await expect(
    store.updateTask({ agentId: "codex", workspace: "ws", taskId: task.id, assigneeId: "ghost" }),
  ).rejects.toThrow(/Invalid assignee_id 'ghost'/);

  await expect(
    store.updateTask({
      agentId: "codex",
      workspace: "ws",
      taskId: task.id,
      parentTaskId: "nonexistent",
    }),
  ).rejects.toThrow(/Invalid parent_task_id 'nonexistent'/);

  await expect(
    store.updateTask({ agentId: "codex", workspace: "ws", taskId: task.id, parentTaskId: task.id }),
  ).rejects.toThrow(/cannot be its own parent/);

  // Parent in a different workspace is invalid.
  const otherWsTask = await store.createTask({
    creatorId: "codex",
    workspace: "other-ws",
    title: "Other workspace task",
  });
  await expect(
    store.updateTask({
      agentId: "codex",
      workspace: "ws",
      taskId: task.id,
      parentTaskId: otherWsTask.id,
    }),
  ).rejects.toThrow(/Invalid parent_task_id/);

  // No fields were mutated by the failed updates.
  const fresh = (await store.listAllTasks({ workspace: "ws" })).find((t) => t.id === task.id);
  expect(fresh?.assignee_id).toBeNull();
  expect(fresh?.parent_task_id).toBeNull();

  await store.close();
});

test("update_task validates dependencies and avoids spurious events", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  await store.registerAgent({ id: "codex", name: "Codex", workspace: "ws" });

  const dep = await store.createTask({ creatorId: "codex", workspace: "ws", title: "Dependency" });
  const task = await store.createTask({ creatorId: "codex", workspace: "ws", title: "Task" });

  // Unknown dependency id is rejected (no silent drop).
  await expect(
    store.updateTask({
      agentId: "codex",
      workspace: "ws",
      taskId: task.id,
      dependencies: ["ghost"],
    }),
  ).rejects.toThrow(/Invalid dependency 'ghost'/);

  // Self-dependency is rejected.
  await expect(
    store.updateTask({
      agentId: "codex",
      workspace: "ws",
      taskId: task.id,
      dependencies: [task.id],
    }),
  ).rejects.toThrow(/cannot depend on itself/);

  // Dependency in a different workspace is rejected.
  const otherWsDep = await store.createTask({
    creatorId: "codex",
    workspace: "other-ws",
    title: "Other workspace dep",
  });
  await expect(
    store.updateTask({
      agentId: "codex",
      workspace: "ws",
      taskId: task.id,
      dependencies: [otherWsDep.id],
    }),
  ).rejects.toThrow(/Invalid dependency/);

  // Valid dependency set is applied and emits an `updated` event.
  await store.updateTask({
    agentId: "codex",
    workspace: "ws",
    taskId: task.id,
    dependencies: [dep.id],
  });
  let events = await store.listVisibleTaskEvents("codex", task.id, "ws");
  expect(events.map((e) => e.event_type)).toEqual(["created", "updated"]);
  expect(events.at(-1)?.note).toContain("dependencies");

  // Re-setting the same dependency set does NOT emit a spurious event.
  await store.updateTask({
    agentId: "codex",
    workspace: "ws",
    taskId: task.id,
    dependencies: [dep.id],
    note: "no-op deps",
  });
  events = await store.listVisibleTaskEvents("codex", task.id, "ws");
  // The only new event should be a note-only `updated` (no `dependencies` field
  // flagged because the set is unchanged).
  const lastEvent = events.at(-1);
  expect(lastEvent?.event_type).toBe("updated");
  expect(lastEvent?.note).toBe("no-op deps");

  await store.close();
});

test("update_task enforces visibility and rejects empty title", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Private task",
    assigneeId: "claude",
  });

  // An agent that cannot see the task cannot edit it.
  await expect(
    store.updateTask({
      agentId: "cursor",
      workspace: "repo-a",
      taskId: task.id,
      title: "Hijacked",
    }),
  ).rejects.toThrow(/not visible/);

  // Empty title is rejected.
  await expect(
    store.updateTask({ agentId: "codex", workspace: "repo-a", taskId: task.id, title: "   " }),
  ).rejects.toThrow(/title cannot be empty/);

  await store.close();
});

test.skipIf(!process.env.AGENT_MAILBOX_TEST_DATABASE_URL)(
  "postgres store supports core mailbox operations",
  async () => {
    const store = await LocalCommsStore.openPostgres(process.env.AGENT_MAILBOX_TEST_DATABASE_URL!);
    const workspace = `pg-${crypto.randomUUID()}`;
    try {
      await store.registerAgent({ id: "codex", name: "Codex", workspace });
      const message = await store.sendMessage({
        senderId: "codex",
        workspace,
        channel: "handoffs",
        body: "Postgres integration message.",
      });
      const task = await store.createTask({
        creatorId: "codex",
        workspace,
        title: "Postgres integration task",
      });
      const note = await store.writeNote({
        agentId: "codex",
        workspace,
        title: "Postgres note",
        body: "Postgres-backed note.",
      });

      expect((await store.inbox("claude", { workspace })).map((item) => item.id)).toContain(message.id);
      expect((await store.claimTask("claude", task.id, undefined, workspace)).status).toBe("claimed");
      expect((await store.readNotes({ workspace }))[0]?.id).toBe(note.id);
    } finally {
      await store.close();
    }
  },
);

test("listVisibleTaskEventsPage paginates events oldest-first and enforces visibility without mutating", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  // Private task: assigned to claude, no channel -> visible only to codex
  // (creator) and claude (assignee), not to other agents like cursor.
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Audit log task",
    assigneeId: "claude",
  });
  // created -> claimed -> status_changed(done) => 3 events, oldest-first.
  await store.claimTask("claude", task.id, "Claiming.", "repo-a");
  await store.updateTask({
    agentId: "claude",
    workspace: "repo-a",
    taskId: task.id,
    status: "done",
    note: "Done.",
  });

  const allEvents = await store.listVisibleTaskEvents("codex", task.id, "repo-a");
  expect(allEvents).toHaveLength(3);
  expect(allEvents.map((e) => e.event_type)).toEqual(["created", "claimed", "status_changed"]);

  // Page 1: first two events, oldest-first.
  const page1 = await store.listVisibleTaskEventsPage("codex", task.id, {
    workspace: "repo-a",
    limit: 2,
    offset: 0,
  });
  expect(page1.results).toHaveLength(2);
  expect(page1.total).toBe(3);
  expect(page1.has_more).toBe(true);
  expect(page1.results.map((e) => e.event_type)).toEqual(["created", "claimed"]);
  // Ordering is by created_at ascending.
  expect(page1.results[0]!.created_at <= page1.results[1]!.created_at).toBe(true);

  // Page 2: the remaining event, has_more false.
  const page2 = await store.listVisibleTaskEventsPage("codex", task.id, {
    workspace: "repo-a",
    limit: 2,
    offset: 2,
  });
  expect(page2.results).toHaveLength(1);
  expect(page2.has_more).toBe(false);
  expect(page2.results[0]?.event_type).toBe("status_changed");

  // Default limit (50) returns everything in one page.
  const fullPage = await store.listVisibleTaskEventsPage("codex", task.id, { workspace: "repo-a" });
  expect(fullPage.results).toHaveLength(3);
  expect(fullPage.total).toBe(3);
  expect(fullPage.has_more).toBe(false);
  expect(fullPage.results.map((e) => e.event_type)).toEqual([
    "created",
    "claimed",
    "status_changed",
  ]);

  // Offset beyond total -> empty, not an error, total still correct.
  const beyond = await store.listVisibleTaskEventsPage("codex", task.id, {
    workspace: "repo-a",
    limit: 2,
    offset: 99,
  });
  expect(beyond.results).toHaveLength(0);
  expect(beyond.total).toBe(3);
  expect(beyond.has_more).toBe(false);

  // Read-only guarantee: reading events does not create a new event.
  const beforeCount = (await store.listVisibleTaskEvents("codex", task.id, "repo-a")).length;
  await store.listVisibleTaskEventsPage("codex", task.id, { workspace: "repo-a" });
  const afterCount = (await store.listVisibleTaskEvents("codex", task.id, "repo-a")).length;
  expect(afterCount).toBe(beforeCount);

  // Visibility: an agent that cannot see the task gets a clear error.
  await expect(
    store.listVisibleTaskEventsPage("cursor", task.id, { workspace: "repo-a" }),
  ).rejects.toThrow(/not visible/);

  // Non-existent task also returns a clear error (no existence leak).
  await expect(
    store.listVisibleTaskEventsPage("codex", "no-such-task", { workspace: "repo-a" }),
  ).rejects.toThrow(/not visible/);

  await store.close();
});

test("listVisibleTaskEventsPage pagination is stable across same-timestamp events", async () => {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);

  // A single updateTask that changes BOTH status and a field inserts
  // status_changed + updated in one transaction. These routinely share the
  // same ms-precision created_at (the tiebreaker review finding), which must
  // not cause rows to be skipped or duplicated across LIMIT/OFFSET pages.
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-b",
    title: "Tiebreaker task",
  });
  await store.updateTask({
    agentId: "codex",
    workspace: "repo-b",
    taskId: task.id,
    status: "done",
    title: "Renamed",
    note: "status + field in one update",
  });

  const allEvents = await store.listVisibleTaskEvents("codex", task.id, "repo-b");
  expect(allEvents.map((e) => e.event_type)).toEqual(["created", "status_changed", "updated"]);

  // If the two same-ms events tied, confirm the tie exists (this guards the
  // scenario; the pagination assertion below holds regardless).
  const hasTie = allEvents.some(
    (e, i) => i > 0 && e.created_at === allEvents[i - 1]!.created_at,
  );
  expect(hasTie).toBe(true);

  // Walk the full set one row at a time. With a stable tiebreaker (id ASC),
  // every event appears exactly once across pages — no skips, no duplicates.
  const seen: string[] = [];
  let off = 0;
  for (;;) {
    const page = await store.listVisibleTaskEventsPage("codex", task.id, {
      workspace: "repo-b",
      limit: 1,
      offset: off,
    });
    for (const e of page.results) seen.push(e.id);
    if (!page.has_more) break;
    off += 1;
  }
  expect(seen).toHaveLength(allEvents.length);
  expect(new Set(seen).size).toBe(allEvents.length);
  // Page-by-page order matches the single-query order.
  expect(seen).toEqual(allEvents.map((e) => e.id));

  await store.close();
});

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}
