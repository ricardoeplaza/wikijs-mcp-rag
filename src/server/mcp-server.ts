import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

export const SERVER_INFO: Implementation = {
  name: 'wikijs-mcp-rag',
  version: '0.1.0',
};

/**
 * Creates a fresh McpServer with all tools registered.
 *
 * Etapa 2: only the `ping` test tool. The 17 CRUD tools (Etapa 4) and the 4 RAG
 * tools (Etapa 7) will be registered here via src/tools/index.ts.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
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
