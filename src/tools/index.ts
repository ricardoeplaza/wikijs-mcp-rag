import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncService } from '../rag/sync.js';
import type { WikiClient } from '../wiki/client.js';
import { registerPageTools } from './pages.js';
import { registerUserTools } from './users.js';
import { registerGroupTools } from './groups.js';

/**
 * Registers every CRUD tool family (12 pages + 4 users + 1 group = 17 tools)
 * on an MCP server. The RAG tools (Etapa 5) will be added here too.
 *
 * Etapa 8a: the optional `sync` hook is forwarded to the page tools so their
 * mutating operations can trigger background reindex/purge.
 */
export function registerAllTools(server: McpServer, wiki: WikiClient, sync?: SyncService): void {
  registerPageTools(server, wiki, sync);
  registerUserTools(server, wiki);
  registerGroupTools(server, wiki);
}
