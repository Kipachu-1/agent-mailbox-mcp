import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "stdio MCP server exposes BeeAI-backed communication tools",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ai-comms-mcp-"));
    const client = new Client({ name: "local-comms-smoke", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "index.ts"],
      cwd: process.cwd(),
      env: {
        ...stringEnv(),
        LOCAL_AI_COMMS_DB: join(dir, "mailbox.sqlite"),
        LOCAL_AI_COMMS_AGENT_ID: "codex",
        LOCAL_AI_COMMS_AGENT_NAME: "Codex",
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("session_start");
      expect(names).toContain("send_message");
      expect(names).toContain("reply_message");
      expect(names).toContain("watch_updates");
      expect(names).toContain("acquire_lock");
      expect(names).toContain("write_note");
      expect(names).toContain("claim_task");

      const sent = await client.callTool({
        name: "send_message",
        arguments: {
          channel: "smoke",
          body: "hello from stdio",
          artifacts: [{ type: "file", path: "/tmp/example.ts", line: 3 }],
        },
      });
      expect(sent.isError).not.toBe(true);
      expect(JSON.stringify(sent.structuredContent)).toContain("hello from stdio");

      const inbox = await client.callTool({
        name: "inbox",
        arguments: {
          channel: "smoke",
        },
      });
      expect(inbox.isError).not.toBe(true);
      expect(JSON.stringify(inbox.structuredContent)).toContain("hello from stdio");

      const session = await client.callTool({
        name: "session_start",
        arguments: {
          channel: "smoke",
        },
      });
      expect(session.isError).not.toBe(true);
      expect(JSON.stringify(session.structuredContent)).toContain("recommended_next_steps");

      const note = await client.callTool({
        name: "write_note",
        arguments: {
          channel: "smoke",
          title: "Smoke note",
          body: "resource check",
          pinned: true,
        },
      });
      expect(note.isError).not.toBe(true);

      const watch = await client.callTool({
        name: "watch_updates",
        arguments: {
          since: "1970-01-01T00:00:00.000Z",
          timeout_ms: 0,
        },
      });
      expect(watch.isError).not.toBe(true);
      expect(JSON.stringify(watch.structuredContent)).toContain("resource check");

      const resource = await client.readResource({
        uri: "local-comms://channels/smoke",
      });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : "").toContain("hello from stdio");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}
