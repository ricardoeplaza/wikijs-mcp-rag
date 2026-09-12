import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { SyncService } from '../rag/sync.js';
import type { WikiClient } from '../wiki/client.js';
import { registerAllTools } from '../tools/index.js';
import { registerRagTools, type RagToolsDeps } from '../tools/rag.js';

export const SERVER_INFO: Implementation = {
  name: 'wikijs-mcp-rag',
  version: '0.1.0',
};

/** Dependencies for {@link createMcpServer}. */
export interface McpServerDeps {
  wiki: WikiClient;
  /** Optional RAG stack. When present, the 4 RAG tools are registered too. */
  rag?: RagToolsDeps;
  /** Optional sync hooks. When present, page CRUD tools fire background reindex/purge. */
  sync?: SyncService;
}

/**
 * Creates a fresh McpServer with all tools registered.
 *
 * Registers `ping` + the 17 CRUD tools (pages/users/groups) via
 * `registerAllTools`, and — when `deps.rag` is provided — the 4 RAG tools via
 * `registerRagTools`. `deps.sync` is forwarded to the page tools.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerPing(server);
  registerAllTools(server, deps.wiki, deps.sync);
  if (deps.rag) {
    registerRagTools(server, deps.rag);
  }
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
