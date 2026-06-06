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
    const server = startTestServer();

    const health = await fetch(`http://${server.host}:${server.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      name: "agent-mailbox",
      transport: "streamable-http",
      status: "ok",
    });

    const deniedDashboard = await fetch(`http://${server.host}:${server.port}/api/dashboard`);
    expect(deniedDashboard.status).toBe(401);

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

    const dashboard = await adminJson<{ summary: Record<string, number> }>(server, "/api/dashboard");
    expect(dashboard.summary.enabled_keys).toBe(2);

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

      const task = await agentA.client.callTool({
        name: "create_task",
        arguments: {
          title: "Review API contract",
          description: "Check the frontend/backend boundary.",
          assignee_id: "agent-b",
        },
      });
      expect(task.isError).not.toBe(true);

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
  const server = startTestServer();
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
  const server = startTestServer([
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

function startTestServer(tokens: HttpAgentTokenConfig[] = []): AgentMailboxHttpServer {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-http-"));
  tempDirs.push(dir);
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const server = startAgentMailboxHttpServer({
        adminToken,
        host: "127.0.0.1",
        port: randomPort(),
        path: "/mcp",
        dbPath: join(dir, "mailbox.sqlite"),
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
