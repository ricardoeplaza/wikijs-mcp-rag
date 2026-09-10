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
 * Registers the 4 user management tools (Etapa 4b) on an MCP server.
 *
 * Same handler contract as pages.ts: on success the Wiki.js payload is returned
 * as JSON in `content[0].text`; on failure `isError: true` with the error
 * message, so a thrown `WikiClient` error never crashes the transport.
 */
export function registerUserTools(server: McpServer, wiki: WikiClient): void {
  server.registerTool(
    'list_users',
    {
      description: 'Lista todos los usuarios de la instancia de Wiki.js.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return jsonResult(await wiki.listUsers());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search_users',
    {
      description: 'Busca usuarios por texto (nombre o email).',
      inputSchema: z.object({ query: z.string().min(1) }),
    },
    async ({ query }) => {
      try {
        return jsonResult(await wiki.searchUsers(query));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'create_user',
    {
      description:
        'Crea un usuario local (providerKey "local", groups por defecto [2]; la password se envía como passwordRaw).',
      inputSchema: z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(1),
        role: z.string().optional(),
        groups: z.array(z.number().int()).optional(),
      }),
    },
    async (input) => {
      try {
        return jsonResult(await wiki.createUser(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'update_user',
    {
      description: 'Actualiza campos de un usuario existente (name, email, password).',
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().optional(),
        email: z.string().email().optional(),
        password: z.string().optional(),
      }),
    },
    async ({ id, ...input }) => {
      try {
        return jsonResult(await wiki.updateUser(id, input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
