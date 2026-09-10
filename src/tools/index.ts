import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiClient } from '../wiki/client.js';
import { registerPageTools } from './pages.js';
import { registerUserTools } from './users.js';
import { registerGroupTools } from './groups.js';

/**
 * Registers every CRUD tool family (12 pages + 4 users + 1 group = 17 tools)
 * on an MCP server. The RAG tools (Etapa 5) will be added here too.
 */
export function registerAllTools(server: McpServer, wiki: WikiClient): void {
  registerPageTools(server, wiki);
  registerUserTools(server, wiki);
  registerGroupTools(server, wiki);
}
