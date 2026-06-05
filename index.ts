import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDbPath, readAgentConfig } from "./src/config";
import { createLocalCommsMcpServer } from "./src/mcp";
import { LocalCommsStore } from "./src/store";

async function main(): Promise<void> {
  const agent = readAgentConfig();
  const store = new LocalCommsStore(defaultDbPath());
  store.registerAgent(agent);

  const server = createLocalCommsMcpServer(store, agent);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
