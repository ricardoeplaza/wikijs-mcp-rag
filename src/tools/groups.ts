import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WikiClient } from '../wiki/client.js';

/** Builds the success envelope: JSON-serialized payload in a single text block. */
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/** Builds the error envelope expected by MCP tool results. */
function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * Registers the group tools on an MCP server.
 * Same handler contract as pages.ts/users.ts.
 */
export function registerGroupTools(server: McpServer, wiki: WikiClient): void {
  server.registerTool(
    'list_groups',
    {
      description: 'Lists all groups of the Wiki.js instance.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return jsonResult(await wiki.listGroups());
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
