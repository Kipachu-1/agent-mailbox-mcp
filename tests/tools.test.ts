import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactStorage,
  ReadArtifactContentOutput,
  UploadArtifactContentInput,
} from "../src/artifact-storage";
import { LocalCommsStore, type ArtifactInput, type ArtifactRecord } from "../src/store";
import { createCommunicationTools } from "../src/tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-tools-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "mailbox.sqlite") };
}

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

async function setup(
  agentId = "codex",
  agentName = "Codex",
  workspace?: string,
): Promise<{
  store: LocalCommsStore;
  tools: ReturnType<typeof createCommunicationTools>;
  storage: FakeArtifactStorage;
}> {
  const { path } = tempDb();
  const store = await LocalCommsStore.openSqlite(path);
  const storage = new FakeArtifactStorage();
  const tools = createCommunicationTools(
    store,
    { id: agentId, name: agentName, workspace },
    storage,
  );
  return { store, tools, storage };
}

// ---------------------------------------------------------------------------
// Session tools
// ---------------------------------------------------------------------------

test("session_start returns presence, inbox, tasks, locks, notes, and conventions", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  // Seed some state so the collections are non-empty.
  await store.sendMessage({
    senderId: "claude",
    workspace: "repo-a",
    recipientId: "codex",
    body: "Welcome back.",
  });

  const result = await runTool(tools, "session_start", { workspace: "repo-a" });

  expect(result.agent).toMatchObject({ id: "codex", name: "Codex" });
  expect(result.workspace).toBe("repo-a");
  expect(result.checked_at).toBeString();
  expect(Array.isArray(result.unread_messages)).toBe(true);
  expect((result.unread_messages as unknown[]).length).toBe(1);
  expect(Array.isArray(result.open_tasks)).toBe(true);
  expect(Array.isArray(result.active_locks)).toBe(true);
  expect(Array.isArray(result.online_agents)).toBe(true);
  expect(result.conventions).toBeDefined();
  expect(Array.isArray(result.recommended_next_steps)).toBe(true);

  await store.close();
});

test("register_agent creates or refreshes the agent identity", async () => {
  const { store, tools } = await setup("codex", "Codex");

  const result = await runTool(tools, "register_agent", {
    name: "Codex Pro",
    workspace: "repo-a",
    status: "available",
  });

  expect(result.agent).toMatchObject({ id: "codex", name: "Codex Pro", status: "available" });
  await store.close();
});

test("heartbeat updates presence and status", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  const result = await runTool(tools, "heartbeat", { status: "working" });

  expect(result.agent).toMatchObject({ id: "codex", status: "working" });
  await store.close();
});

test("agent_status returns the current registered agent", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await runTool(tools, "register_agent", { status: "busy" });

  const result = await runTool(tools, "agent_status", {});

  expect(result.agent).toMatchObject({ id: "codex", name: "Codex", status: "busy" });
  await store.close();
});

test("list_agents returns registered agents optionally scoped by workspace", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  // register_agent must be called first — tools do not auto-register the agent.
  await runTool(tools, "register_agent", { workspace: "repo-a" });
  await store.registerAgent({ id: "claude", name: "Claude", workspace: "repo-a" });

  const result = await runTool(tools, "list_agents", { workspace: "repo-a" });

  expect((result.agents as { id: string }[]).map((a) => a.id).sort()).toEqual([
    "claude",
    "codex",
  ]);
  await store.close();
});

test("who_is_online returns agents with recent heartbeats", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await store.heartbeat({ id: "codex", name: "Codex", workspace: "repo-a" });

  const result = await runTool(tools, "who_is_online", { workspace: "repo-a" });

  expect((result.agents as { id: string }[]).map((a) => a.id)).toContain("codex");
  await store.close();
});

// ---------------------------------------------------------------------------
// Message tools
// ---------------------------------------------------------------------------

test("send_message posts a direct message to a recipient", async () => {
  const { store, tools } = await setup("codex", "Codex");

  const result = await runTool(tools, "send_message", { recipient_id: "claude", body: "Hello." });

  expect(result.message).toMatchObject({
    sender_id: "codex",
    recipient_id: "claude",
    body: "Hello.",
    kind: "direct",
  });
  await store.close();
});

test("send_message posts a channel message", async () => {
  const { store, tools } = await setup("codex", "Codex");

  const result = await runTool(tools, "send_message", { channel: "handoffs", body: "Heads up." });

  expect(result.message).toMatchObject({ channel: "handoffs", body: "Heads up.", kind: "channel" });
  await store.close();
});

test("reply_message replies to a visible direct message preserving the thread", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const original = await runTool(tools, "send_message", { recipient_id: "claude", body: "Ping." });
  const originalId = (original.message as { id: string }).id;

  const reply = await runTool(tools, "reply_message", { message_id: originalId, body: "Pong." });

  expect(reply.message).toMatchObject({
    body: "Pong.",
    reply_to_message_id: originalId,
    thread_id: (original.message as { thread_id: string }).thread_id,
  });
  await store.close();
});

test("inbox lists messages visible to the agent", async () => {
  const { store, tools } = await setup("codex", "Codex");
  await store.sendMessage({ senderId: "claude", recipientId: "codex", body: "Inbox item." });

  const result = await runTool(tools, "inbox", {});

  expect((result.messages as { body: string }[]).map((m) => m.body)).toContain("Inbox item.");
  await store.close();
});

test("read_message fetches and marks a message read", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const sent = await store.sendMessage({ senderId: "claude", recipientId: "codex", body: "Read me." });

  const result = await runTool(tools, "read_message", { message_id: sent.id });

  expect(result.message).toMatchObject({ id: sent.id, unread: false });
  await store.close();
});

test("search_messages finds messages by body query", async () => {
  const { store, tools } = await setup("codex", "Codex");
  await store.sendMessage({ senderId: "claude", recipientId: "codex", body: "Unique search term." });

  const result = await runTool(tools, "search_messages", { query: "Unique search" });

  expect((result.messages as { body: string }[]).length).toBe(1);
  await store.close();
});

test("list_threads returns threads ordered by recent activity", async () => {
  const { store, tools } = await setup("codex", "Codex");
  await store.sendMessage({ senderId: "codex", recipientId: "claude", body: "Thread 1." });

  const result = await runTool(tools, "list_threads", {});

  expect((result.threads as unknown[]).length).toBeGreaterThan(0);
  await store.close();
});

test("get_thread returns messages in chronological order", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const first = await store.sendMessage({ senderId: "codex", recipientId: "claude", body: "First." });
  await store.replyMessage({ senderId: "claude", messageId: first.id, body: "Second." });

  const result = await runTool(tools, "get_thread", { thread_id: first.thread_id });

  expect((result.messages as { body: string }[]).map((m) => m.body)).toEqual([
    "First.",
    "Second.",
  ]);
  await store.close();
});

test("watch_updates returns updates since a timestamp", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const since = new Date(Date.now() - 1000).toISOString();
  await store.sendMessage({ senderId: "claude", recipientId: "codex", body: "New update." });

  const result = await runTool(tools, "watch_updates", { since, timeout_ms: 0 });

  expect((result.updates as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
  await store.close();
});

// ---------------------------------------------------------------------------
// Task tools (priority)
// ---------------------------------------------------------------------------

test("create_task creates an open claimable task", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  const result = await runTool(tools, "create_task", {
    workspace: "repo-a",
    title: "Implement feature X",
    description: "See spec.",
    channel: "features",
    priority: 5,
  });

  expect(result.task).toMatchObject({
    title: "Implement feature X",
    status: "open",
    priority: 5,
    creator_id: "codex",
  });
  await store.close();
});

test("create_handoff creates a task and sends a notification message", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  const result = await runTool(tools, "create_handoff", {
    workspace: "repo-a",
    title: "Review PR",
    assignee_id: "claude",
    notification_recipient_id: "claude",
    notification_body: "Please review.",
  });

  expect(result.task).toMatchObject({ title: "Review PR", assignee_id: "claude" });
  expect(result.notification_message).toMatchObject({
    recipient_id: "claude",
    body: "Please review.",
  });
  await store.close();
});

test("create_handoff creates a task without notification when none requested", async () => {
  const { store, tools } = await setup("codex", "Codex");

  const result = await runTool(tools, "create_handoff", { title: "Silent task" });

  expect(result.task).toMatchObject({ title: "Silent task" });
  expect(result.notification_message).toBeNull();
  await store.close();
});

test("list_tasks filters by status", async () => {
  const { store, tools } = await setup("codex", "Codex");
  await store.createTask({ creatorId: "codex", title: "Open task" });
  const claimed = await store.createTask({ creatorId: "codex", title: "Claimed task" });
  await store.claimTask("codex", claimed.id);

  const result = await runTool(tools, "list_tasks", { status: "open" });

  expect((result.tasks as { title: string }[]).map((t) => t.title)).toContain("Open task");
  expect((result.tasks as { title: string }[]).map((t) => t.title)).not.toContain("Claimed task");
  await store.close();
});

test("claim_task atomically claims an open task", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const task = await store.createTask({ creatorId: "codex", title: "Claimable" });

  const result = await runTool(tools, "claim_task", { task_id: task.id, note: "On it." });

  expect(result.task).toMatchObject({ id: task.id, status: "claimed", assignee_id: "codex" });
  await store.close();
});

test("update_task changes status and appends events", async () => {
  const { store, tools } = await setup("codex", "Codex");
  const task = await store.createTask({ creatorId: "codex", title: "To finish" });
  await store.claimTask("codex", task.id);

  const result = await runTool(tools, "update_task", {
    task_id: task.id,
    status: "done",
    note: "Completed.",
  });

  expect(result.task).toMatchObject({ status: "done" });
  expect((result.events as { event_type: string }[]).map((e) => e.event_type)).toContain(
    "status_changed",
  );
  await store.close();
});

test("finish_work marks a task done and releases specified locks", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  const task = await store.createTask({ creatorId: "codex", workspace: "repo-a", title: "Cleanup" });
  await store.claimTask("codex", task.id, undefined, "repo-a");
  await store.acquireLock({ agentId: "codex", workspace: "repo-a", resource: "src/main.ts" });

  const result = await runTool(tools, "finish_work", {
    workspace: "repo-a",
    task_id: task.id,
    status: "done",
    note: "Done.",
    release_locks: ["src/main.ts"],
  });

  expect(result.task).toMatchObject({ status: "done" });
  expect((result.released_locks as unknown[]).length).toBe(1);
  expect(await store.listLocks({ workspace: "repo-a" })).toHaveLength(0);
  await store.close();
});

test("finish_work sends a handoff message to the task creator when requested", async () => {
  const { store, tools } = await setup("claude", "Claude", "repo-a");
  const task = await store.createTask({
    creatorId: "codex",
    workspace: "repo-a",
    title: "Handoff back",
    assigneeId: "claude",
  });
  await store.claimTask("claude", task.id, undefined, "repo-a");

  const result = await runTool(tools, "finish_work", {
    workspace: "repo-a",
    task_id: task.id,
    status: "done",
    handoff_body: "Handing back.",
  });

  expect(result.task).toMatchObject({ status: "done" });
  expect(result.handoff_message).toMatchObject({
    recipient_id: "codex",
    body: "Handing back.",
  });
  await store.close();
});

// ---------------------------------------------------------------------------
// Note tools
// ---------------------------------------------------------------------------

test("write_note creates a shared scratchpad note", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  const result = await runTool(tools, "write_note", {
    workspace: "repo-a",
    title: "Conventions",
    body: "Use locks before editing.",
    pinned: true,
  });

  expect(result.note).toMatchObject({ title: "Conventions", pinned: true, creator_id: "codex" });
  await store.close();
});

test("read_notes returns notes optionally filtered by pin state", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Pinned",
    body: "Pinned body.",
    pinned: true,
  });
  await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Regular",
    body: "Regular body.",
  });

  const pinned = await runTool(tools, "read_notes", { workspace: "repo-a", pinned_only: true });
  const all = await runTool(tools, "read_notes", { workspace: "repo-a" });

  expect((pinned.notes as { title: string }[]).map((n) => n.title)).toEqual(["Pinned"]);
  expect((all.notes as { title: string }[]).map((n) => n.title).sort()).toEqual([
    "Pinned",
    "Regular",
  ]);
  await store.close();
});

test("pin_note toggles the pinned state of a note", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  const note = await store.writeNote({
    agentId: "codex",
    workspace: "repo-a",
    title: "Note",
    body: "Body.",
  });

  const result = await runTool(tools, "pin_note", {
    workspace: "repo-a",
    note_id: note.id,
    pinned: true,
  });

  expect(result.note).toMatchObject({ id: note.id, pinned: true });
  await store.close();
});

test("summarize_channel returns a compact digest of messages, tasks, and notes", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await store.sendMessage({ senderId: "codex", workspace: "repo-a", channel: "docs", body: "Doc." });
  await store.createTask({ creatorId: "codex", workspace: "repo-a", title: "Doc task", channel: "docs" });
  await store.writeNote({ agentId: "codex", workspace: "repo-a", channel: "docs", title: "N", body: "B" });

  const result = await runTool(tools, "summarize_channel", { workspace: "repo-a", channel: "docs" });

  expect(result.summary).toMatchObject({ workspace: "repo-a", channel: "docs" });
  expect((result.summary as { message_count: number }).message_count).toBeGreaterThan(0);
  await store.close();
});

// ---------------------------------------------------------------------------
// Lock tools (priority)
// ---------------------------------------------------------------------------

test("acquire_lock obtains a workspace-scoped advisory lease", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");

  const result = await runTool(tools, "acquire_lock", {
    workspace: "repo-a",
    resource: "src/config.ts",
    purpose: "editing",
  });

  expect(result.lock).toMatchObject({
    resource: "src/config.ts",
    owner_agent_id: "codex",
    purpose: "editing",
  });
  await store.close();
});

test("release_lock frees a lock owned by the current agent", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await store.acquireLock({ agentId: "codex", workspace: "repo-a", resource: "src/store.ts" });

  const result = await runTool(tools, "release_lock", {
    workspace: "repo-a",
    resource: "src/store.ts",
  });

  expect(result.lock).toMatchObject({ resource: "src/store.ts", owner_agent_id: "codex" });
  expect(await store.listLocks({ workspace: "repo-a" })).toHaveLength(0);
  await store.close();
});

test("list_locks returns active locks in the workspace", async () => {
  const { store, tools } = await setup("codex", "Codex", "repo-a");
  await store.acquireLock({ agentId: "codex", workspace: "repo-a", resource: "src/tools.ts" });

  const result = await runTool(tools, "list_locks", { workspace: "repo-a" });

  expect((result.locks as { resource: string }[]).map((l) => l.resource)).toContain("src/tools.ts");
  await store.close();
});

// ---------------------------------------------------------------------------
// Artifact tools (happy-path; S3-backed via fake storage)
// ---------------------------------------------------------------------------

test("upload_artifact attaches content to a visible message", async () => {
  const { store, tools } = await setup("claude", "Claude", "repo-a");
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Inspect this.",
  });

  const result = await runTool(tools, "upload_artifact", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
    filename: "log.txt",
    content_type: "text/plain",
    content_text: "log body",
  });

  expect(result.artifact).toMatchObject({ type: "file", path: expect.stringContaining("s3://") });
  await store.close();
});

test("read_artifact_content returns text content for a visible artifact", async () => {
  const { store, tools } = await setup("claude", "Claude", "repo-a");
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Read this.",
  });
  const uploaded = await runTool(tools, "upload_artifact", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
    filename: "out.log",
    content_type: "text/plain",
    content_text: "artifact body",
  });
  const artifactId = (uploaded.artifact as ArtifactRecord).id;

  const result = await runTool(tools, "read_artifact_content", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
    artifact_id: artifactId,
  });

  expect(result.artifact_content).toMatchObject({ content: "artifact body", encoding: "text" });
  await store.close();
});

test("presign_artifact returns a short-lived download URL", async () => {
  const { store, tools } = await setup("claude", "Claude", "repo-a");
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "Presign this.",
  });
  const uploaded = await runTool(tools, "upload_artifact", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
    filename: "data.bin",
    content_text: "data",
  });
  const artifactId = (uploaded.artifact as ArtifactRecord).id;

  const result = await runTool(tools, "presign_artifact", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
    artifact_id: artifactId,
    expires_in_seconds: 300,
  });

  expect(result.url).toBeString();
  expect(result.expires_in_seconds).toBe(300);
  await store.close();
});

test("list_artifacts returns references attached to a message", async () => {
  const { store, tools } = await setup("claude", "Claude", "repo-a");
  const message = await store.sendMessage({
    senderId: "codex",
    workspace: "repo-a",
    recipientId: "claude",
    body: "List these.",
    artifacts: [{ type: "url", url: "https://example.com/spec", label: "spec" }],
  });

  const result = await runTool(tools, "list_artifacts", {
    workspace: "repo-a",
    owner_type: "message",
    owner_id: message.id,
  });

  expect((result.artifacts as { url: string }[]).map((a) => a.url)).toContain(
    "https://example.com/spec",
  );
  await store.close();
});

// ---------------------------------------------------------------------------
// Fake artifact storage (mirrors tests/artifact-tools.test.ts)
// ---------------------------------------------------------------------------

class FakeArtifactStorage implements ArtifactStorage {
  readonly enabled = true;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async artifactInputForUpload(input: UploadArtifactContentInput): Promise<ArtifactInput> {
    const bytes =
      input.contentText !== undefined
        ? new TextEncoder().encode(input.contentText)
        : new Uint8Array(Buffer.from(input.contentBase64 ?? "", "base64"));
    const key = [
      "workspaces",
      input.workspace,
      input.ownerType,
      input.ownerId,
      input.artifactId,
      input.filename ?? `${input.artifactId}.bin`,
    ].join("/");
    const contentType = input.contentType ?? "application/octet-stream";
    this.objects.set(key, { bytes, contentType });
    return {
      type: input.type,
      label: input.label,
      path: `s3://fake-bucket/${key}`,
      metadata: {
        ...(input.metadata ?? {}),
        s3: {
          bucket: "fake-bucket",
          content_type: contentType,
          filename: input.filename,
          key,
          size: bytes.byteLength,
        },
      },
    };
  }

  keyFor(artifact: ArtifactRecord): string {
    const metadata = artifact.metadata as { s3?: { key?: string } };
    return metadata.s3?.key ?? "";
  }

  presign(artifact: ArtifactRecord, expiresIn: number): string {
    return `https://example.test/${this.keyFor(artifact)}?expires=${expiresIn}`;
  }

  async read(
    artifact: ArtifactRecord,
    options: { encoding?: "base64" | "text"; maxBytes?: number } = {},
  ): Promise<ReadArtifactContentOutput> {
    const key = this.keyFor(artifact);
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Missing fake object '${key}'.`);
    }
    const encoding = options.encoding ?? "text";
    return {
      artifact,
      content:
        encoding === "base64"
          ? Buffer.from(object.bytes).toString("base64")
          : new TextDecoder().decode(object.bytes),
      content_type: object.contentType,
      encoding,
      size: object.bytes.byteLength,
    };
  }
}
