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
  database: StoreConfig;
  s3: S3StorageConfig | null;
  tokens: HttpAgentTokenConfig[];
}

export type StoreConfig =
  | {
      kind: "sqlite";
      path: string;
    }
  | {
      kind: "postgres";
      url: string;
    };

export interface S3StorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  endpoint?: string;
  bucket: string;
  sessionToken?: string;
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
  const database = readStoreConfig(env, defaultHttpDbPath(env));
  const tokens = readHttpTokens(env);
  return {
    adminToken,
    host,
    port,
    path,
    dbPath: database.kind === "sqlite" ? database.path : database.url,
    database,
    s3: readS3StorageConfig(env),
    tokens,
  };
}

export function readStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
  sqlitePath = defaultDbPath(env),
): StoreConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return {
      kind: "postgres",
      url: databaseUrl,
    };
  }
  return {
    kind: "sqlite",
    path: sqlitePath,
  };
}

export function readS3StorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): S3StorageConfig | null {
  const config = {
    accessKeyId: stringValue(env.S3_ACCESS_KEY_ID) || stringValue(env.AWS_ACCESS_KEY_ID),
    secretAccessKey:
      stringValue(env.S3_SECRET_ACCESS_KEY) || stringValue(env.AWS_SECRET_ACCESS_KEY),
    region:
      stringValue(env.S3_REGION) ||
      stringValue(env.AWS_REGION) ||
      stringValue(env.AWS_DEFAULT_REGION),
    endpoint:
      stringValue(env.S3_ENDPOINT) ||
      stringValue(env.AWS_ENDPOINT) ||
      stringValue(env.AWS_ENDPOINT_URL) ||
      undefined,
    bucket:
      stringValue(env.S3_BUCKET) ||
      stringValue(env.AWS_BUCKET) ||
      stringValue(env.AWS_S3_BUCKET_NAME),
    sessionToken:
      stringValue(env.S3_SESSION_TOKEN) || stringValue(env.AWS_SESSION_TOKEN) || undefined,
  };

  const anyConfigured = Object.values(config).some((value) => Boolean(value));
  if (!anyConfigured) {
    return null;
  }

  const missing = [];
  if (!config.accessKeyId) {
    missing.push("AWS_ACCESS_KEY_ID");
  }
  if (!config.secretAccessKey) {
    missing.push("AWS_SECRET_ACCESS_KEY");
  }
  if (!config.region) {
    missing.push("AWS_DEFAULT_REGION");
  }
  if (!config.bucket) {
    missing.push("AWS_S3_BUCKET_NAME");
  }
  if (missing.length > 0) {
    throw new Error(`S3 storage config is incomplete. Missing: ${missing.join(", ")}.`);
  }

  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    endpoint: config.endpoint,
    bucket: config.bucket,
    sessionToken: config.sessionToken,
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
