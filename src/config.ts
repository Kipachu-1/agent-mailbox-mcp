import { dirname, join } from "node:path";

export interface AgentConfig {
  id: string;
  name: string;
  workspace?: string;
}

export interface HttpAgentTokenConfig {
  token: string;
  agent: AgentConfig;
}

export interface HttpServerConfig {
  adminToken: string;
  host: string;
  port: number;
  path: string;
  dbPath: string;
  tokens: HttpAgentTokenConfig[];
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOCAL_AI_COMMS_DB?.trim()) {
    return env.LOCAL_AI_COMMS_DB;
  }

  const home = env.HOME?.trim() || process.cwd();
  return join(home, ".local", "share", "local-ai-comms.sqlite");
}

export function dbDirectory(path: string): string {
  return dirname(path);
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const id = env.LOCAL_AI_COMMS_AGENT_ID?.trim();
  if (!id) {
    throw new Error("LOCAL_AI_COMMS_AGENT_ID is required for the Agent Mailbox CLI.");
  }

  return {
    id,
    name: env.LOCAL_AI_COMMS_AGENT_NAME?.trim() || id,
    workspace: env.LOCAL_AI_COMMS_WORKSPACE?.trim() || undefined,
  };
}

export function readHttpServerConfig(env: NodeJS.ProcessEnv = process.env): HttpServerConfig {
  const adminToken = env.AGENT_MAILBOX_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new Error("AGENT_MAILBOX_ADMIN_TOKEN is required for HTTP mode.");
  }
  const host = env.AGENT_MAILBOX_HTTP_HOST?.trim() || "127.0.0.1";
  const port = parsePort(env.AGENT_MAILBOX_HTTP_PORT ?? env.PORT, 8137);
  const path = normalizeHttpPath(env.AGENT_MAILBOX_HTTP_PATH);
  const tokens = readHttpTokens(env);
  return {
    adminToken,
    host,
    port,
    path,
    dbPath: defaultHttpDbPath(env),
    tokens,
  };
}

export function readHttpTokens(env: NodeJS.ProcessEnv = process.env): HttpAgentTokenConfig[] {
  const raw = env.AGENT_MAILBOX_HTTP_TOKENS?.trim();
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `AGENT_MAILBOX_HTTP_TOKENS must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AGENT_MAILBOX_HTTP_TOKENS must be a JSON array.");
  }

  const seenTokens = new Set<string>();
  return parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`AGENT_MAILBOX_HTTP_TOKENS[${index}] must be an object.`);
    }

    const token = stringValue(item.token);
    const id = stringValue(item.agent_id);
    const name = stringValue(item.agent_name) || id;
    const workspace = stringValue(item.workspace) || undefined;
    if (!token) {
      throw new Error(`AGENT_MAILBOX_HTTP_TOKENS[${index}].token is required.`);
    }
    if (!id) {
      throw new Error(`AGENT_MAILBOX_HTTP_TOKENS[${index}].agent_id is required.`);
    }
    if (seenTokens.has(token)) {
      throw new Error(`AGENT_MAILBOX_HTTP_TOKENS[${index}].token is duplicated.`);
    }
    seenTokens.add(token);

    return {
      token,
      agent: {
        id,
        name,
        workspace,
      },
    };
  });
}

function normalizeHttpPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "/mcp";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function defaultHttpDbPath(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_MAILBOX_DB?.trim()) {
    return env.AGENT_MAILBOX_DB;
  }
  return defaultDbPath(env);
}

function parsePort(value: string | undefined, defaultValue: number): number {
  const parsed = value ? Number(value) : defaultValue;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid HTTP port '${value}'.`);
  }
  return parsed;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
