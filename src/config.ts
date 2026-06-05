import { dirname, join } from "node:path";

export interface AgentConfig {
  id: string;
  name: string;
  workspace?: string;
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
    throw new Error("LOCAL_AI_COMMS_AGENT_ID is required for this MCP server.");
  }

  return {
    id,
    name: env.LOCAL_AI_COMMS_AGENT_NAME?.trim() || id,
    workspace: env.LOCAL_AI_COMMS_WORKSPACE?.trim() || undefined,
  };
}
