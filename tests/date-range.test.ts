import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCommsStore } from "../src/store";
import { createCommunicationTools } from "../src/tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-range-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}

const WORKSPACE = "range-ws";

/**
 * Seed a workspace with messages, tasks, notes, and locks whose timestamps
 * span a known window. Each entity type is created at one of three moments:
 *   - EARLY  (before the date range)
 *   - MID    (inside the date range)
 *   - LATE   (after the date range)
 *
 * We capture the timestamp boundaries *between* record groups (with small
 * delays) so the date-range filter has deterministic "in range" vs "out of
 * range" data: early.created_at < sinceTs <= mid.created_at <= untilTs < late.created_at.
 */
async function seed() {
  const store = await LocalCommsStore.openSqlite(tempDb().path);
  const agent = "codex";

  // --- EARLY records ---
  await store.sendMessage({
    senderId: agent,
    workspace: WORKSPACE,
    channel: "handoffs",
    body: "early message",
  });
  await store.createTask({ creatorId: agent, workspace: WORKSPACE, channel: "tasks", title: "early task" });
  await store.writeNote({ agentId: agent, workspace: WORKSPACE, channel: "notes", title: "early note", body: "early" });
  await store.acquireLock({ agentId: agent, workspace: WORKSPACE, resource: "early-lock.ts", ttlSeconds: 3600 });

  // --- MID records: created inside [sinceTs, untilTs] ---
  await new Promise((resolve) => setTimeout(resolve, 200));
  const midMessage = await store.sendMessage({
    senderId: agent,
    workspace: WORKSPACE,
    channel: "handoffs",
    body: "mid message",
  });
  const midTask = await store.createTask({
    creatorId: agent,
    workspace: WORKSPACE,
    channel: "tasks",
    title: "mid task",
  });
  const midNote = await store.writeNote({
    agentId: agent,
    workspace: WORKSPACE,
    channel: "notes",
    title: "mid note",
    body: "mid",
  });
  const midLock = await store.acquireLock({
    agentId: agent,
    workspace: WORKSPACE,
    resource: "mid-lock.ts",
    ttlSeconds: 3600,
  });
  // Bump the mid task/note updated_at into the "mid" window by touching them.
  const updatedMidTask = await store.updateTask({
    agentId: agent,
    workspace: WORKSPACE,
    taskId: midTask.id,
    status: "claimed",
    note: "claim mid",
  });
  const updatedMidNote = await store.writeNote({
    agentId: agent,
    workspace: WORKSPACE,
    noteId: midNote.id,
    channel: "notes",
    title: "mid note",
    body: "mid updated",
  });

  // Derive boundaries from the actual record timestamps so the filter is
  // deterministic regardless of clock skew between JS Date.now() and the
  // isoNow() used inside SQL transactions. Since bounds are inclusive (>=, <=),
  // use the mid window's earliest timestamp for `since` and the latest for
  // `until`: every mid record matches, and the 200ms delays guarantee the
  // early/late records fall outside.
  const sinceTs = midMessage.created_at;
  const untilTs = updatedMidNote.updated_at;

  // --- LATE records (created after untilTs) ---
  await new Promise((resolve) => setTimeout(resolve, 200));
  await store.sendMessage({
    senderId: agent,
    workspace: WORKSPACE,
    channel: "handoffs",
    body: "late message",
  });
  await store.createTask({ creatorId: agent, workspace: WORKSPACE, channel: "tasks", title: "late task" });
  await store.writeNote({ agentId: agent, workspace: WORKSPACE, channel: "notes", title: "late note", body: "late" });
  await store.acquireLock({ agentId: agent, workspace: WORKSPACE, resource: "late-lock.ts", ttlSeconds: 3600 });

  return { store, agent, sinceTs, untilTs, midMessage, midTask, midNote, midLock };
}

// ---------------------------------------------------------------------------
// Store-layer tests: each list method honors since/until on its own column.
// ---------------------------------------------------------------------------

test("inbox filters by since/until on created_at", async () => {
  const { store, agent, sinceTs, untilTs, midMessage } = await seed();
  try {
    // with range: only mid message
    const ranged = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      includeSent: true,
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.results.map((m) => m.body)).toEqual(["mid message"]);
    expect(ranged.total).toBe(1);

    // without range: all three messages
    const all = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      includeSent: true,
    });
    expect(all.results).toHaveLength(3);
    expect(all.total).toBe(3);

    // since only (no until): mid + late
    const sinceOnly = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      includeSent: true,
      since: sinceTs,
    });
    expect(sinceOnly.results.map((m) => m.body).sort()).toEqual(
      ["late message", "mid message"].sort(),
    );

    // until only (no since): early + mid
    const untilOnly = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      includeSent: true,
      until: untilTs,
    });
    expect(untilOnly.results.map((m) => m.body).sort()).toEqual(
      ["early message", "mid message"].sort(),
    );

    expect(midMessage.body).toBe("mid message");
  } finally {
    await store.close();
  }
});

test("list_tasks filters by since/until on updated_at", async () => {
  const { store, agent, sinceTs, untilTs, midTask } = await seed();
  try {
    const ranged = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
      since: sinceTs,
      until: untilTs,
    });
    // mid task was claimed (updated) in the mid window; early & late were not touched there
    expect(ranged.results.map((t) => t.title)).toEqual(["mid task"]);
    expect(ranged.total).toBe(1);

    const all = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
    });
    expect(all.results).toHaveLength(3);
    expect(all.total).toBe(3);

    expect(midTask.title).toBe("mid task");
  } finally {
    await store.close();
  }
});

test("read_notes filters by since/until on updated_at", async () => {
  const { store, sinceTs, untilTs, midNote } = await seed();
  try {
    const ranged = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.results.map((n) => n.title)).toEqual(["mid note"]);
    expect(ranged.total).toBe(1);

    const all = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
    });
    expect(all.results).toHaveLength(3);
    expect(all.total).toBe(3);

    expect(midNote.title).toBe("mid note");
  } finally {
    await store.close();
  }
});

test("list_locks filters by since/until on updated_at", async () => {
  const { store, sinceTs, untilTs, midLock } = await seed();
  try {
    const ranged = await store.listLocksPage({
      workspace: WORKSPACE,
      includeExpired: true,
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.results.map((l) => l.resource)).toEqual(["mid-lock.ts"]);
    expect(ranged.total).toBe(1);

    const all = await store.listLocksPage({
      workspace: WORKSPACE,
      includeExpired: true,
    });
    expect(all.results).toHaveLength(3);
    expect(all.total).toBe(3);

    expect(midLock.resource).toBe("mid-lock.ts");
  } finally {
    await store.close();
  }
});

test("list_threads filters by since/until on message created_at", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    // Each message is its own thread (no replies in the handoffs channel).
    // With the date range we expect only the mid message's thread.
    const ranged = await store.listThreadsPage(agent, WORKSPACE, 50, 0, sinceTs, untilTs);
    expect(ranged.results).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await store.listThreadsPage(agent, WORKSPACE, 50, 0);
    // 3 handoffs threads (each message is its own thread — no replies)
    expect(all.results).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Edge case: since > until yields an empty result (no rows match).
// ---------------------------------------------------------------------------

test("since > until yields empty results across all list tools", async () => {
  const { store, agent, sinceTs } = await seed();
  try {
    const after = new Date(Date.now() + 5_000).toISOString();

    const inboxPage = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      includeSent: true,
      since: after,
      until: sinceTs,
    });
    expect(inboxPage.results).toHaveLength(0);
    expect(inboxPage.total).toBe(0);

    const tasksPage = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
      since: after,
      until: sinceTs,
    });
    expect(tasksPage.results).toHaveLength(0);
    expect(tasksPage.total).toBe(0);

    const notesPage = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
      since: after,
      until: sinceTs,
    });
    expect(notesPage.results).toHaveLength(0);
    expect(notesPage.total).toBe(0);

    const locksPage = await store.listLocksPage({
      workspace: WORKSPACE,
      includeExpired: true,
      since: after,
      until: sinceTs,
    });
    expect(locksPage.results).toHaveLength(0);
    expect(locksPage.total).toBe(0);

    const threadsPage = await store.listThreadsPage(agent, WORKSPACE, 50, 0, after, sinceTs);
    expect(threadsPage.results).toHaveLength(0);
    expect(threadsPage.total).toBe(0);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// MCP tool-layer tests: since/until are forwarded through the tool schemas.
// ---------------------------------------------------------------------------

async function runTool(
  tools: ReturnType<typeof createCommunicationTools>,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  const output = (await tool!.run(input)) as { result: Record<string, unknown> };
  return output.result;
}

test("inbox tool forwards since/until to the store", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    const tools = createCommunicationTools(store, { id: agent, name: "Codex", workspace: WORKSPACE });

    const ranged = await runTool(tools, "inbox", {
      workspace: WORKSPACE,
      channel: "handoffs",
      include_sent: true,
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.messages).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await runTool(tools, "inbox", {
      workspace: WORKSPACE,
      channel: "handoffs",
      include_sent: true,
    });
    expect(all.messages).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});

test("list_tasks tool forwards since/until to the store", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    const tools = createCommunicationTools(store, { id: agent, name: "Codex", workspace: WORKSPACE });

    const ranged = await runTool(tools, "list_tasks", {
      workspace: WORKSPACE,
      channel: "tasks",
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.tasks).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await runTool(tools, "list_tasks", {
      workspace: WORKSPACE,
      channel: "tasks",
    });
    expect(all.tasks).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});

test("read_notes tool forwards since/until to the store", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    const tools = createCommunicationTools(store, { id: agent, name: "Codex", workspace: WORKSPACE });

    const ranged = await runTool(tools, "read_notes", {
      workspace: WORKSPACE,
      channel: "notes",
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.notes).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await runTool(tools, "read_notes", {
      workspace: WORKSPACE,
      channel: "notes",
    });
    expect(all.notes).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});

test("list_locks tool forwards since/until to the store", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    const tools = createCommunicationTools(store, { id: agent, name: "Codex", workspace: WORKSPACE });

    const ranged = await runTool(tools, "list_locks", {
      workspace: WORKSPACE,
      include_expired: true,
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.locks).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await runTool(tools, "list_locks", {
      workspace: WORKSPACE,
      include_expired: true,
    });
    expect(all.locks).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});

test("list_threads tool forwards since/until to the store", async () => {
  const { store, agent, sinceTs, untilTs } = await seed();
  try {
    const tools = createCommunicationTools(store, { id: agent, name: "Codex", workspace: WORKSPACE });

    const ranged = await runTool(tools, "list_threads", {
      workspace: WORKSPACE,
      since: sinceTs,
      until: untilTs,
    });
    expect(ranged.threads).toHaveLength(1);
    expect(ranged.total).toBe(1);

    const all = await runTool(tools, "list_threads", { workspace: WORKSPACE });
    expect(all.threads).toHaveLength(3);
    expect(all.total).toBe(3);
  } finally {
    await store.close();
  }
});
