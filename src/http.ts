import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpServerConfig } from "./config";
import { readHttpServerConfig } from "./config";
import { createLocalCommsMcpServer } from "./mcp";
import type { AccessKeyRecord } from "./store";
import { LocalCommsStore } from "./store";

interface HttpSession {
  accessKeyId: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface AgentMailboxHttpServer {
  close: () => Promise<void>;
  host: string;
  path: string;
  port: number;
  server: Bun.Server<undefined>;
  url: string;
}

export function startAgentMailboxHttpServer(
  config: HttpServerConfig = readHttpServerConfig(),
): AgentMailboxHttpServer {
  const store = new LocalCommsStore(config.dbPath);
  for (const entry of config.tokens) {
    store.createAccessKey({
      token: entry.token,
      name: `Bootstrap: ${entry.agent.id}`,
      agentId: entry.agent.id,
      agentName: entry.agent.name,
      workspace: entry.agent.workspace,
    });
  }

  const sessions = new Map<string, HttpSession>();
  const healthPath = "/health";
  const publicRoot = new URL("../public/", import.meta.url);

  const bunServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === healthPath) {
        return jsonResponse(200, {
          name: "agent-mailbox",
          access_keys: store.listAccessKeys().length,
          transport: "streamable-http",
          status: "ok",
          version: "0.1.0",
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return handleAdminApi(request, url);
      }

      if (url.pathname === config.path) {
        const key = authenticateMcpRequest(request);
        if (!key) {
          return jsonResponse(401, { error: "Unauthorized" });
        }

        if (request.method === "POST") {
          return handlePost(request, key);
        }
        if (request.method === "GET" || request.method === "DELETE") {
          return handleSessionRequest(request, key);
        }

        return jsonResponse(405, { error: "Method not allowed" }, { Allow: "GET, POST, DELETE" });
      }

      return serveDashboardAsset(url, publicRoot);
    },
  });

  function authenticateMcpRequest(request: Request): AccessKeyRecord | null {
    const token = bearerToken(request);
    if (!token) {
      return null;
    }
    return store.authenticateAccessToken(token);
  }

  async function handleAdminApi(request: Request, url: URL): Promise<Response> {
    if (bearerToken(request) !== config.adminToken) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      return jsonResponse(200, dashboardPayload());
    }

    if (request.method === "GET" && url.pathname === "/api/access-keys") {
      return jsonResponse(200, { keys: store.listAccessKeys() });
    }

    if (request.method === "POST" && url.pathname === "/api/access-keys") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        return jsonResponse(400, { error: "JSON object body required" });
      }
      try {
        const created = store.createAccessKey({
          name: stringValue(body.name) ?? "",
          agentId: stringValue(body.agent_id) ?? "",
          agentName: stringValue(body.agent_name),
          workspace: stringValue(body.workspace),
        });
        return jsonResponse(201, created);
      } catch (error) {
        return jsonResponse(400, { error: errorMessage(error) });
      }
    }

    const revokeMatch = url.pathname.match(/^\/api\/access-keys\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revokeMatch?.[1]) {
      try {
        return jsonResponse(200, { key: store.revokeAccessKey(decodeURIComponent(revokeMatch[1])) });
      } catch (error) {
        return jsonResponse(404, { error: errorMessage(error) });
      }
    }

    return jsonResponse(404, { error: "Not found" });
  }

  function dashboardPayload() {
    const keys = store.listAccessKeys();
    const agents = store.listAgents();
    const onlineAgents = store.whoIsOnline(undefined, 300);
    const tasks = store.listAllTasks({ limit: 200 });
    const locks = store.listAllLocks();
    const pinnedNotes = store.listAllNotes({ pinnedOnly: true, limit: 50 });
    const workspaces = Array.from(
      new Set([
        ...keys.map((item) => item.workspace),
        ...agents.map((item) => item.workspace),
        ...tasks.map((item) => item.workspace),
        ...locks.map((item) => item.workspace),
        ...pinnedNotes.map((item) => item.workspace),
      ]),
    ).sort();

    return {
      summary: {
        access_keys: keys.length,
        enabled_keys: keys.filter((item) => item.enabled).length,
        agents: agents.length,
        online_agents: onlineAgents.length,
        open_tasks: tasks.filter((item) => item.status === "open").length,
        claimed_tasks: tasks.filter((item) => item.status === "claimed").length,
        active_locks: locks.length,
        pinned_notes: pinnedNotes.length,
        workspaces: workspaces.length,
      },
      keys,
      agents,
      online_agents: onlineAgents,
      recent_tasks: tasks.slice(0, 20),
      active_locks: locks,
      pinned_notes: pinnedNotes,
      workspaces,
    };
  }

  async function handlePost(request: Request, key: AccessKeyRecord): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      return handleSessionRequest(request, key);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.clone().json();
    } catch {
      return jsonRpcErrorResponse(400, -32700, "Parse error");
    }

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcErrorResponse(400, -32000, "Bad Request: initialize request required");
    }

    let mcpServer: McpServer;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, {
          accessKeyId: key.id,
          server: mcpServer,
          transport,
        });
      },
      onsessionclosed: (closedSessionId) => {
        if (closedSessionId) {
          closeSession(closedSessionId);
        }
      },
    });
    const agent = agentFromAccessKey(key);
    store.registerAgent(agent);
    mcpServer = createLocalCommsMcpServer(store, agent);
    await mcpServer.connect(transport);
    return transport.handleRequest(request, { parsedBody });
  }

  async function handleSessionRequest(request: Request, key: AccessKeyRecord): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId) {
      return jsonRpcErrorResponse(404, -32001, "Session not found");
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return jsonRpcErrorResponse(404, -32001, "Session not found");
    }
    if (session.accessKeyId !== key.id) {
      return jsonRpcErrorResponse(403, -32000, "Forbidden: token does not match session");
    }

    return session.transport.handleRequest(request);
  }

  function closeSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    sessions.delete(sessionId);
    session.server.close();
  }

  async function close(): Promise<void> {
    for (const [sessionId, session] of sessions) {
      sessions.delete(sessionId);
      await session.transport.close();
      session.server.close();
    }
    store.close();
    await bunServer.stop(true);
  }

  return {
    close,
    host: config.host,
    path: config.path,
    port: bunServer.port ?? config.port,
    server: bunServer,
    url: `http://${config.host}:${bunServer.port ?? config.port}${config.path}`,
  };
}

async function serveDashboardAsset(url: URL, publicRoot: URL): Promise<Response> {
  const relativePath = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (relativePath.includes("..")) {
    return jsonResponse(400, { error: "Bad path" });
  }

  const file = Bun.file(new URL(relativePath, publicRoot));
  if (await file.exists()) {
    return new Response(file);
  }

  const index = Bun.file(new URL("index.html", publicRoot));
  if (await index.exists()) {
    return new Response(index, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return jsonResponse(404, {
    error: "Dashboard build not found. Run 'bun run build' first.",
  });
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return undefined;
  }
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) {
    return undefined;
  }
  return token.trim();
}

function agentFromAccessKey(key: AccessKeyRecord) {
  return {
    id: key.agent_id,
    name: key.agent_name,
    workspace: key.workspace,
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: null,
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const httpServer = startAgentMailboxHttpServer();
  console.log(`Agent Mailbox Streamable HTTP listening at ${httpServer.url}`);

  const shutdown = async () => {
    await httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
