import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyTool, JSONToolOutput } from "beeai-framework/tools/base";
import type { AgentConfig } from "./config";
import { LocalCommsStore } from "./store";
import { createCommunicationTools } from "./tools";

export function createLocalCommsMcpServer(store: LocalCommsStore, agent: AgentConfig): McpServer {
  const server = new McpServer(
    {
      name: "beeai-local-comms",
      version: "0.1.0",
    },
    {
      instructions:
        "Use these tools to coordinate with local AI agents through a shared SQLite mailbox.",
    },
  );

  registerBeeAiTools(server, createCommunicationTools(store, agent));
  registerResources(server, store, agent);
  return server;
}

export function registerBeeAiTools(server: McpServer, tools: AnyTool[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema() as any,
      },
      async (input: any): Promise<CallToolResult> => {
        try {
          const output = (await tool.run(input)) as JSONToolOutput<unknown>;
          return {
            structuredContent: output.result as Record<string, unknown>,
            content: [
              {
                type: "text",
                text: output.getTextContent(),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: errorMessage(error),
              },
            ],
          };
        }
      },
    );
  }
}

function registerResources(server: McpServer, store: LocalCommsStore, agent: AgentConfig): void {
  const workspace = agent.workspace || "default";
  server.registerResource(
    "agents",
    "local-comms://agents",
    {
      title: "Local AI Agents",
      description: "Registered local AI agents for this mailbox.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri.toString(), { agents: store.listAgents(workspace) }),
  );

  server.registerResource(
    "open-tasks",
    "local-comms://tasks/open",
    {
      title: "Open Tasks",
      description: "Open handoff tasks visible to this agent.",
      mimeType: "application/json",
    },
    (uri) =>
      jsonResource(uri.toString(), {
        tasks: store.listTasks(agent.id, { workspace, status: "open", limit: 200 }),
      }),
  );

  server.registerResource(
    "active-locks",
    "local-comms://locks/active",
    {
      title: "Active Locks",
      description: "Active workspace-scoped locks.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri.toString(), { locks: store.listLocks({ workspace }) }),
  );

  server.registerResource(
    "pinned-notes",
    "local-comms://notes/pinned",
    {
      title: "Pinned Notes",
      description: "Pinned scratchpad notes in this workspace.",
      mimeType: "application/json",
    },
    (uri) =>
      jsonResource(uri.toString(), {
        notes: store.readNotes({ workspace, pinnedOnly: true, limit: 200 }),
      }),
  );

  server.registerResource(
    "channel",
    new ResourceTemplate("local-comms://channels/{channel}", { list: undefined }),
    {
      title: "Channel Messages",
      description: "Recent messages for a workspace channel.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const channel = String((variables as Record<string, string>).channel);
      return jsonResource(uri.toString(), {
        messages: store.inbox(agent.id, {
          workspace,
          channel,
          includeSent: true,
          limit: 100,
        }),
      });
    },
  );
}

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
