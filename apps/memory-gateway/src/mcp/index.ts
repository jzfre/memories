import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./build";
import { resolveProfile } from "../connectors/profile";

async function main(): Promise<void> {
  const server = buildMcpServer(resolveProfile("claude-code"));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
