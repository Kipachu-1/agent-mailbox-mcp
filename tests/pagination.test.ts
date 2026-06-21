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
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-page-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}

const WORKSPACE = "page-ws";

async function seed() {
  const store = await LocalCommsStore.openSqlite(tempDb().path);
  const agent = "codex";

  // 5 agents
  for (let i = 0; i < 5; i++) {
    await store.registerAgent({ id: `agent-${i}`, name: `Agent ${i}`, workspace: WORKSPACE });
  }

  // 5 channel messages (visible to everyone, distinct threads)
  const messageIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const msg = await store.sendMessage({
      senderId: agent,
      workspace: WORKSPACE,
      channel: "handoffs",
      body: `message body ${i} searchable`,
    });
    messageIds.push(msg.id);
  }

  // A long thread: original + 4 replies = 5 messages in one thread
  const threadRoot = await store.sendMessage({
    senderId: agent,
    workspace: WORKSPACE,
    channel: "thread-channel",
    body: "thread root",
  });
  for (let i = 0; i < 4; i++) {
    await store.replyMessage({
      senderId: agent,
      workspace: WORKSPACE,
      messageId: threadRoot.id,
      body: `thread reply ${i}`,
    });
  }

  // 5 tasks (open, assignee null -> visible to all)
  const taskIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const task = await store.createTask({
      creatorId: agent,
      workspace: WORKSPACE,
      channel: "tasks",
      title: `Task ${i}`,
    });
    taskIds.push(task.id);
  }

  // 5 notes
  const noteIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const note = await store.writeNote({
      agentId: agent,
      workspace: WORKSPACE,
      channel: "notes",
      title: `Note ${i}`,
      body: `note body ${i}`,
    });
    noteIds.push(note.id);
  }

  // 5 locks
  const lockResources: string[] = [];
  for (let i = 0; i < 5; i++) {
    const lock = await store.acquireLock({
      agentId: agent,
      workspace: WORKSPACE,
      resource: `file-${i}.ts`,
      ttlSeconds: 3600,
    });
    lockResources.push(lock.resource);
  }

  return { store, agent, messageIds, threadRoot, taskIds, noteIds, lockResources };
}

test("inbox pagination returns total and has_more and walks the full set", async () => {
  const { store, agent } = await seed();
  try {
    const page1 = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      limit: 2,
      offset: 0,
    });
    expect(page1.results).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page2 = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      limit: 2,
      offset: 2,
    });
    expect(page2.results).toHaveLength(2);
    expect(page2.has_more).toBe(true);

    const page3 = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      limit: 2,
      offset: 4,
    });
    expect(page3.results).toHaveLength(1);
    expect(page3.has_more).toBe(false);

    // offset beyond total -> empty, not an error, total still correct
    const beyond = await store.inboxPage(agent, {
      workspace: WORKSPACE,
      channel: "handoffs",
      limit: 2,
      offset: 99,
    });
    expect(beyond.results).toHaveLength(0);
    expect(beyond.total).toBe(5);
    expect(beyond.has_more).toBe(false);

    // all pages combined cover every message exactly once
    const all = [...page1.results, ...page2.results, ...page3.results];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((m) => m.id)).size).toBe(5);
  } finally {
    await store.close();
  }
});

test("inbox paginated results match the array method for the same filter", async () => {
  const { store, agent } = await seed();
  try {
    const array = await store.inbox(agent, { workspace: WORKSPACE, channel: "handoffs" });
    const page = await store.inboxPage(agent, { workspace: WORKSPACE, channel: "handoffs" });
    expect(page.results.map((m) => m.id)).toEqual(array.map((m) => m.id));
    expect(page.total).toBe(array.length);
    expect(page.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("search_messages pagination counts matches, not the page", async () => {
  const { store, agent } = await seed();
  try {
    const page = await store.searchMessagesPage(agent, {
      workspace: WORKSPACE,
      query: "searchable",
      limit: 2,
      offset: 0,
    });
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.has_more).toBe(true);

    const tail = await store.searchMessagesPage(agent, {
      workspace: WORKSPACE,
      query: "searchable",
      limit: 2,
      offset: 4,
    });
    expect(tail.results).toHaveLength(1);
    expect(tail.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("list_threads pagination counts distinct threads", async () => {
  const { store, agent, threadRoot } = await seed();
  try {
    // 5 handoffs threads + 1 thread-channel thread = 6 visible threads
    const page = await store.listThreadsPage(agent, WORKSPACE, 2, 0);
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(6);
    expect(page.has_more).toBe(true);

    const full = await store.listThreadsPage(agent, WORKSPACE, 50, 0);
    expect(full.results).toHaveLength(6);
    expect(full.has_more).toBe(false);
    expect(full.results.some((t) => t.thread_id === threadRoot.thread_id)).toBe(true);
  } finally {
    await store.close();
  }
});

test("get_thread pagination walks a long thread chronologically", async () => {
  const { store, agent, threadRoot } = await seed();
  try {
    const page1 = await store.getThreadPage(agent, threadRoot.thread_id, WORKSPACE, 2, 0);
    expect(page1.results).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page2 = await store.getThreadPage(agent, threadRoot.thread_id, WORKSPACE, 2, 2);
    expect(page2.results).toHaveLength(2);
    expect(page2.has_more).toBe(true);

    const page3 = await store.getThreadPage(agent, threadRoot.thread_id, WORKSPACE, 2, 4);
    expect(page3.results).toHaveLength(1);
    expect(page3.has_more).toBe(false);

    const all = [...page1.results, ...page2.results, ...page3.results];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((m) => m.id)).size).toBe(5);
    expect(all.map((m) => m.body).sort()).toEqual(
      ["thread root", "thread reply 0", "thread reply 1", "thread reply 2", "thread reply 3"].sort(),
    );
  } finally {
    await store.close();
  }
});

test("list_tasks pagination returns total and has_more", async () => {
  const { store, agent } = await seed();
  try {
    const page = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
      limit: 2,
      offset: 0,
    });
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.has_more).toBe(true);

    const tail = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
      limit: 2,
      offset: 4,
    });
    expect(tail.results).toHaveLength(1);
    expect(tail.has_more).toBe(false);

    const beyond = await store.listTasksPage(agent, {
      workspace: WORKSPACE,
      channel: "tasks",
      limit: 2,
      offset: 99,
    });
    expect(beyond.results).toHaveLength(0);
    expect(beyond.total).toBe(5);
    expect(beyond.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("read_notes pagination returns total and has_more", async () => {
  const { store } = await seed();
  try {
    const page = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
      limit: 2,
      offset: 0,
    });
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.has_more).toBe(true);

    const tail = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
      limit: 2,
      offset: 4,
    });
    expect(tail.results).toHaveLength(1);
    expect(tail.has_more).toBe(false);

    const beyond = await store.readNotesPage({
      workspace: WORKSPACE,
      channel: "notes",
      limit: 2,
      offset: 99,
    });
    expect(beyond.results).toHaveLength(0);
    expect(beyond.total).toBe(5);
    expect(beyond.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("list_locks pagination returns total and has_more", async () => {
  const { store } = await seed();
  try {
    const page = await store.listLocksPage({
      workspace: WORKSPACE,
      limit: 2,
      offset: 0,
    });
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.has_more).toBe(true);

    const tail = await store.listLocksPage({
      workspace: WORKSPACE,
      limit: 2,
      offset: 4,
    });
    expect(tail.results).toHaveLength(1);
    expect(tail.has_more).toBe(false);

    const beyond = await store.listLocksPage({
      workspace: WORKSPACE,
      limit: 2,
      offset: 99,
    });
    expect(beyond.results).toHaveLength(0);
    expect(beyond.total).toBe(5);
    expect(beyond.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("list_agents pagination returns total and has_more, and no limit returns all", async () => {
  const { store } = await seed();
  try {
    // codex is registered implicitly via sendMessage/createTask/writeNote/acquireLock
    await store.registerAgent({ id: "codex", name: "Codex", workspace: WORKSPACE });

    const page = await store.listAgentsPage(WORKSPACE, 2, 0);
    expect(page.results).toHaveLength(2);
    expect(page.total).toBe(6);
    expect(page.has_more).toBe(true);

    const tail = await store.listAgentsPage(WORKSPACE, 2, 4);
    expect(tail.results).toHaveLength(2);
    expect(tail.has_more).toBe(false);

    // omitting limit returns all (backward compatible), has_more false
    const all = await store.listAgentsPage(WORKSPACE);
    expect(all.results).toHaveLength(6);
    expect(all.total).toBe(6);
    expect(all.has_more).toBe(false);

    // offset beyond total
    const beyond = await store.listAgentsPage(WORKSPACE, 2, 99);
    expect(beyond.results).toHaveLength(0);
    expect(beyond.total).toBe(6);
    expect(beyond.has_more).toBe(false);
  } finally {
    await store.close();
  }
});

test("list_locks without limit is backward compatible (returns all)", async () => {
  const { store } = await seed();
  try {
    const all = await store.listLocksPage({ workspace: WORKSPACE });
    expect(all.results).toHaveLength(5);
    expect(all.total).toBe(5);
    expect(all.has_more).toBe(false);
  } finally {
    await store.close();
  }
});
