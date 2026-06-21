import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpAgentTokenConfig } from "../src/config";
import { startAgentMailboxHttpServer, type AgentMailboxHttpServer } from "../src/http";
import type { AccessKeyRecord } from "../src/store";

const tempDirs: string[] = [];
const servers: AgentMailboxHttpServer[] = [];
const adminToken = "test-admin-token";

interface CreatedAccessKeyResponse {
  key: AccessKeyRecord;
  token: string;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "streamable HTTP server manages keys and shares mailbox state",
  async () => {
    const server = await startTestServer();

    const health = await fetch(`http://${server.host}:${server.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      name: "agent-mailbox",
      transport: "streamable-http",
      status: "ok",
    });

    const deniedOverview = await fetch(`http://${server.host}:${server.port}/api/overview`);
    expect(deniedOverview.status).toBe(401);

    const agentAKey = await createAccessKey(server, {
      name: "Agent A token",
      agent_id: "agent-a",
      agent_name: "Agent A",
      workspace: "fullstack",
    });
    const agentBKey = await createAccessKey(server, {
      name: "Agent B token",
      agent_id: "agent-b",
      agent_name: "Agent B",
      workspace: "fullstack",
    });

    const overview = await adminJson<{ summary: Record<string, number> }>(server, "/api/overview");
    expect(overview.summary.enabled_keys).toBe(2);

    const agentA = createHttpClient(server.url, agentAKey.token, "agent-a-client");
    const agentB = createHttpClient(server.url, agentBKey.token, "agent-b-client");

    try {
      await agentA.client.connect(agentA.transport);
      await agentB.client.connect(agentB.transport);

      const session = await agentA.client.callTool({
        name: "session_start",
        arguments: {},
      });
      expect(session.isError).not.toBe(true);
      expect(JSON.stringify(session.structuredContent)).toContain("agent-a");

      const message = await agentA.client.callTool({
        name: "send_message",
        arguments: {
          recipient_id: "agent-b",
          body: "hello over streamable http",
          artifacts: [{ type: "file", path: "/tmp/frontend/app.ts", label: "frontend file" }],
        },
      });
      expect(message.isError).not.toBe(true);
      const sentMessage = (
        message.structuredContent as {
          message: { id: string; thread_id: string };
        }
      ).message;

      const task = await agentA.client.callTool({
        name: "create_task",
        arguments: {
          title: "Review API contract",
          description: "Check the frontend/backend boundary.",
          assignee_id: "agent-b",
        },
      });
      expect(task.isError).not.toBe(true);
      const createdTask = (
        task.structuredContent as {
          task: { id: string };
        }
      ).task;

      const agentBSession = await agentB.client.callTool({
        name: "session_start",
        arguments: {},
      });
      const sessionContent = agentBSession.structuredContent as {
        session_summary: { unread_messages: number; open_tasks: number };
        next_actions: { priority: number; tool: string; related_ids: string[] }[];
        unread_messages: { id: string }[];
        open_tasks: { id: string }[];
      };
      expect(sessionContent.session_summary.unread_messages).toBe(1);
      expect(sessionContent.session_summary.open_tasks).toBe(1);
      expect(sessionContent.next_actions[0]?.priority).toBe(1);
      expect(sessionContent.next_actions[0]?.tool).toBe("inbox");
      expect(sessionContent.next_actions.map((action) => action.tool)).toContain("claim_task");
      expect(sessionContent.unread_messages.map((item) => item.id)).toContain(sentMessage.id);
      expect(sessionContent.open_tasks.map((item) => item.id)).toContain(createdTask.id);

      const inbox = await agentB.client.callTool({
        name: "inbox",
        arguments: {
          unread_only: true,
        },
      });
      expect(JSON.stringify(inbox.structuredContent)).toContain("hello over streamable http");
      expect(JSON.stringify(inbox.structuredContent)).toContain("/tmp/frontend/app.ts");

      const tasks = await agentB.client.callTool({
        name: "list_tasks",
        arguments: {
          assignee_id: "agent-b",
        },
      });
      expect(JSON.stringify(tasks.structuredContent)).toContain("Review API contract");

      const artifacts = await agentB.client.callTool({
        name: "list_artifacts",
        arguments: {
          owner_type: "message",
          owner_id: sentMessage.id,
        },
      });
      expect(JSON.stringify(artifacts.structuredContent)).toContain("/tmp/frontend/app.ts");

      const search = await agentB.client.callTool({
        name: "search_messages",
        arguments: {
          query: "streamable",
        },
      });
      expect(JSON.stringify(search.structuredContent)).toContain("hello over streamable http");

      const read = await agentB.client.callTool({
        name: "read_message",
        arguments: {
          message_id: sentMessage.id,
        },
      });
      expect(JSON.stringify(read.structuredContent)).toContain('"unread":false');

      const reply = await agentB.client.callTool({
        name: "reply_message",
        arguments: {
          message_id: sentMessage.id,
          body: "acknowledged",
        },
      });
      expect(reply.isError).not.toBe(true);

      const threads = await agentB.client.callTool({
        name: "list_threads",
        arguments: {},
      });
      expect(JSON.stringify(threads.structuredContent)).toContain(sentMessage.thread_id);

      const thread = await agentB.client.callTool({
        name: "get_thread",
        arguments: {
          thread_id: sentMessage.thread_id,
        },
      });
      expect(JSON.stringify(thread.structuredContent)).toContain("acknowledged");

      const note = await agentB.client.callTool({
        name: "write_note",
        arguments: {
          title: "API context",
          body: "Keep contract changes coordinated.",
          pinned: true,
        },
      });
      expect(note.isError).not.toBe(true);
      const writtenNote = (
        note.structuredContent as {
          note: { id: string };
        }
      ).note;

      const notes = await agentA.client.callTool({
        name: "read_notes",
        arguments: {
          pinned_only: true,
        },
      });
      expect(JSON.stringify(notes.structuredContent)).toContain("API context");

      const unpinned = await agentB.client.callTool({
        name: "pin_note",
        arguments: {
          note_id: writtenNote.id,
          pinned: false,
        },
      });
      expect(JSON.stringify(unpinned.structuredContent)).toContain('"pinned":false');

      const summary = await agentA.client.callTool({
        name: "summarize_channel",
        arguments: {},
      });
      expect(JSON.stringify(summary.structuredContent)).toContain("task_count");

      const claimed = await agentB.client.callTool({
        name: "claim_task",
        arguments: {
          task_id: createdTask.id,
          note: "Working on it.",
        },
      });
      expect(JSON.stringify(claimed.structuredContent)).toContain('"status":"claimed"');

      const updated = await agentB.client.callTool({
        name: "update_task",
        arguments: {
          task_id: createdTask.id,
          status: "done",
          note: "Looks good.",
          artifacts: [{ type: "log", path: "/tmp/review.log", label: "review log" }],
        },
      });
      expect(JSON.stringify(updated.structuredContent)).toContain("status_changed");
      expect(JSON.stringify(updated.structuredContent)).toContain("/tmp/review.log");

      const lock = await agentA.client.callTool({
        name: "acquire_lock",
        arguments: {
          resource: "src/http.ts",
          purpose: "review",
        },
      });
      expect(JSON.stringify(lock.structuredContent)).toContain("src/http.ts");

      const locks = await agentA.client.callTool({
        name: "list_locks",
        arguments: {
          resource: "src/http.ts",
        },
      });
      expect(JSON.stringify(locks.structuredContent)).toContain("review");

      const released = await agentA.client.callTool({
        name: "release_lock",
        arguments: {
          resource: "src/http.ts",
        },
      });
      expect(JSON.stringify(released.structuredContent)).toContain("src/http.ts");

      const handoff = await agentA.client.callTool({
        name: "create_handoff",
        arguments: {
          title: "Polish agent handoff copy",
          description: "Tighten wording and report the changed file.",
          assignee_id: "agent-b",
          notification_body: "Please pick up the handoff copy task.",
          artifacts: [{ type: "file", path: "/tmp/copy.md", label: "copy" }],
        },
      });
      expect(JSON.stringify(handoff.structuredContent)).toContain("notification_message");
      expect(JSON.stringify(handoff.structuredContent)).toContain("/tmp/copy.md");
      const handoffTask = (
        handoff.structuredContent as {
          task: { id: string };
        }
      ).task;

      await agentB.client.callTool({
        name: "acquire_lock",
        arguments: {
          resource: "docs/handoff.md",
          purpose: "handoff cleanup",
        },
      });
      const finished = await agentB.client.callTool({
        name: "finish_work",
        arguments: {
          task_id: handoffTask.id,
          note: "Copy is polished.",
          artifacts: [{ type: "file", path: "/tmp/final-copy.md", label: "final copy" }],
          release_locks: ["docs/handoff.md"],
          handoff_body: "Finished the handoff copy cleanup.",
        },
      });
      expect(JSON.stringify(finished.structuredContent)).toContain("/tmp/final-copy.md");
      expect(JSON.stringify(finished.structuredContent)).toContain('"release_errors":[]');
      expect(JSON.stringify(finished.structuredContent)).toContain("docs/handoff.md");

      const updates = await agentA.client.callTool({
        name: "watch_updates",
        arguments: {
          since: new Date(Date.now() - 1_000).toISOString(),
        },
      });
      expect(JSON.stringify(updates.structuredContent)).toContain("updates");

      const resources = await agentA.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("local-comms://agents");

      const openTasksResource = await agentA.client.readResource({
        uri: "local-comms://tasks/open",
      });
      expect(JSON.stringify(openTasksResource.contents)).toContain("local-comms://tasks/open");
    } finally {
      if (agentA.transport.sessionId) {
        await agentA.transport.terminateSession();
      }
      if (agentB.transport.sessionId) {
        await agentB.transport.terminateSession();
      }
      await agentA.client.close();
      await agentB.client.close();
    }
  },
  15_000,
);

test("streamable HTTP rejects missing and mismatched bearer tokens", async () => {
  const server = await startTestServer();
  const agentAKey = await createAccessKey(server, {
    name: "Agent A token",
    agent_id: "agent-a",
    workspace: "fullstack",
  });
  const agentBKey = await createAccessKey(server, {
    name: "Agent B token",
    agent_id: "agent-b",
    workspace: "fullstack",
  });

  const unauthorized = await fetch(server.url, { method: "POST" });
  expect(unauthorized.status).toBe(401);

  const agentA = createHttpClient(server.url, agentAKey.token, "agent-a-client");
  try {
    await agentA.client.connect(agentA.transport);
    const sessionId = agentA.transport.sessionId;
    expect(sessionId).toBeString();

    const forbidden = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentBKey.token}`,
        "Content-Type": "application/json",
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(forbidden.status).toBe(403);

    await agentA.transport.terminateSession();

    const closed = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentAKey.token}`,
        "Content-Type": "application/json",
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(closed.status).toBe(404);
  } finally {
    await agentA.client.close();
  }
});

test("streamable HTTP can bootstrap access keys from environment-compatible config", async () => {
  const server = await startTestServer([
    {
      token: "bootstrap-token",
      agent: {
        id: "bootstrap-agent",
        name: "Bootstrap Agent",
        workspace: "ops",
      },
    },
  ]);

  const client = createHttpClient(server.url, "bootstrap-token", "bootstrap-client");
  try {
    await client.client.connect(client.transport);
    const tools = await client.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("session_start");
  } finally {
    if (client.transport.sessionId) {
      await client.transport.terminateSession();
    }
    await client.client.close();
  }
});

test("update_task edits editable fields end-to-end over MCP", async () => {
  const server = await startTestServer();

  const agentAKey = await createAccessKey(server, {
    name: "Agent A token",
    agent_id: "agent-a",
    agent_name: "Agent A",
    workspace: "fullstack",
  });
  const agentBKey = await createAccessKey(server, {
    name: "Agent B token",
    agent_id: "agent-b",
    agent_name: "Agent B",
    workspace: "fullstack",
  });

  const agentA = createHttpClient(server.url, agentAKey.token, "agent-a-client");
  const agentB = createHttpClient(server.url, agentBKey.token, "agent-b-client");
  try {
    await agentA.client.connect(agentA.transport);
    await agentB.client.connect(agentB.transport);

    // Register both agents so assignee_id validation can resolve them.
    await agentA.client.callTool({ name: "register_agent", arguments: {} });
    await agentB.client.callTool({ name: "register_agent", arguments: {} });

    const created = await agentA.client.callTool({
      name: "create_task",
      arguments: {
        title: "Original title",
        description: "Original description",
        channel: "docs",
      },
    });
    expect(created.isError).not.toBe(true);
    const task = (created.structuredContent as { task: { id: string } }).task;

    // Partial update: edit title, description, assign directly to agent-b, move channel.
    const updated = await agentA.client.callTool({
      name: "update_task",
      arguments: {
        task_id: task.id,
        title: "Corrected title",
        description: "Revised description",
        assignee_id: "agent-b",
        channel: "backend",
      },
    });
    expect(updated.isError).not.toBe(true);
    const updatedTask = (updated.structuredContent as { task: Record<string, unknown> }).task;
    expect(updatedTask.title).toBe("Corrected title");
    expect(updatedTask.description).toBe("Revised description");
    expect(updatedTask.assignee_id).toBe("agent-b");
    expect(updatedTask.channel).toBe("backend");
    expect(updatedTask.status).toBe("open");
    // An `updated` event was emitted for the changed fields.
    expect(JSON.stringify(updated.structuredContent)).toContain('"updated"');

    // Invalid assignee_id returns a clear error (no silent no-op).
    const invalid = await agentA.client.callTool({
      name: "update_task",
      arguments: { task_id: task.id, assignee_id: "ghost" },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("Invalid assignee_id");

    // The failed update did not mutate the task.
    const listed = await agentA.client.callTool({
      name: "list_tasks",
      arguments: { status: "open" },
    });
    expect(JSON.stringify(listed.structuredContent)).toContain("Corrected title");
    expect(JSON.stringify(listed.structuredContent)).not.toContain('"assignee_id":"ghost"');
  } finally {
    if (agentA.transport.sessionId) {
      await agentA.transport.terminateSession();
    }
    if (agentB.transport.sessionId) {
      await agentB.transport.terminateSession();
    }
    await agentA.client.close();
    await agentB.client.close();
  }
});

async function startTestServer(tokens: HttpAgentTokenConfig[] = []): Promise<AgentMailboxHttpServer> {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-http-"));
  tempDirs.push(dir);
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const dbPath = join(dir, "mailbox.sqlite");
      const server = await startAgentMailboxHttpServer({
        adminToken,
        host: "127.0.0.1",
        port: randomPort(),
        path: "/mcp",
        dbPath,
        database: { kind: "sqlite", path: dbPath },
        s3: null,
        tokens,
      });
      servers.push(server);
      return server;
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Failed to start server")) {
        throw error;
      }
    }
  }
  throw lastError;
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

function createHttpClient(url: string, token: string, name: string) {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  return { client, transport };
}

async function createAccessKey(
  server: AgentMailboxHttpServer,
  body: Record<string, string>,
): Promise<CreatedAccessKeyResponse> {
  return adminJson(server, "/api/access-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function adminJson<T>(
  server: AgentMailboxHttpServer,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`http://${server.host}:${server.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  expect(response.status).toBeLessThan(400);
  return response.json() as Promise<T>;
}
