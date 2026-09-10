import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { WikiClient } from '../wiki/client.js';
import { registerAllTools } from '../tools/index.js';

export const SERVER_INFO: Implementation = {
  name: 'wikijs-mcp-rag',
  version: '0.1.0',
};

/** Dependencies for {@link createMcpServer}. */
export interface McpServerDeps {
  wiki: WikiClient;
}

/**
 * Creates a fresh McpServer with all tools registered.
 *
 * Etapa 4b: `ping` + the 17 CRUD tools (pages/users/groups) via
 * `registerAllTools`. The RAG tools (Etapa 5) will be registered here too.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerPing(server);
  registerAllTools(server, deps.wiki);
  return server;
}

function registerPing(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      description: 'Health check tool. Returns { pong: true, timestamp }.',
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ pong: true, timestamp: new Date().toISOString() }),
        },
      ],
    }),
  );
}
