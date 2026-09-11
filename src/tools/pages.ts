import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SyncService } from '../rag/sync.js';
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

const onlyPublished = (pages: { isPublished: boolean }[]) => pages.filter((page) => page.isPublished);

/**
 * Registers the 12 page CRUD tools (Etapa 4a) on an MCP server.
 *
 * Every tool follows the same contract: on success it returns the Wiki.js payload
 * as JSON in `content[0].text`; on failure it returns `isError: true` with the
 * error message, so a thrown `WikiClient` error never crashes the transport.
 *
 * Etapa 8a: after each successful MUTATING operation (create/update/publish/
 * delete/force_delete) the optional `sync` hook is fired WITHOUT awaiting, so
 * RAG reindex/purge runs in the background and never affects the tool response.
 */
export function registerPageTools(server: McpServer, wiki: WikiClient, sync?: SyncService): void {
  server.registerTool(
    'get_page',
    {
      description: 'Obtiene los metadatos de una página (sin contenido) a partir de su id numérico.',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        return jsonResult(await wiki.getPage(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_page_content',
    {
      description: 'Obtiene el contenido Markdown de una página por id ({ title, content }).',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        return jsonResult(await wiki.getPageContent(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_pages',
    {
      description:
        'Lista páginas (por defecto las primeras 50 ordenadas por título). Con includeUnpublished=false solo devuelve páginas publicadas.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(50),
        orderBy: z.enum(['TITLE', 'CREATED', 'UPDATED']).default('TITLE'),
        includeUnpublished: z.boolean().default(true),
      }),
    },
    async ({ limit, orderBy, includeUnpublished }) => {
      try {
        const pages = await wiki.listPages(limit, orderBy);
        return jsonResult(includeUnpublished ? pages : onlyPublished(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search_pages',
    {
      description: 'Busca páginas publicadas por texto completo y devuelve hasta `limit` resultados.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    async ({ query, limit }) => {
      try {
        const pages = await wiki.searchPages(query);
        return jsonResult(pages.slice(0, limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'create_page',
    {
      description:
        'Crea una página en Markdown y la publica. El cliente aplica defaults: locale "es", editor markdown, isPublished true.',
      inputSchema: z.object({
        path: z.string().min(1),
        title: z.string().min(1),
        content: z.string(),
        locale: z.string().optional(),
        description: z.string().optional(),
        isPrivate: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
    },
    async (args) => {
      try {
        const page = await wiki.createPage(args);
        sync?.onAfterChange(page.id);
        return jsonResult(page);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'update_page',
    {
      description: 'Actualiza campos de una página existente (content, title, description, isPublished).',
      inputSchema: z.object({
        id: z.number().int(),
        content: z.string().optional(),
        isPublished: z.boolean().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
    },
    async ({ id, ...input }) => {
      try {
        const page = await wiki.updatePage(id, input);
        sync?.onAfterChange(id);
        return jsonResult(page);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_page',
    {
      description: 'Elimina una página (soft delete de Wiki.js; no purga datos).',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        await wiki.deletePage(id);
        sync?.onAfterDelete(id);
        return jsonResult({ deleted: true, id });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'publish_page',
    {
      description: 'Publica una página (equivalente a update con isPublished=true).',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        const page = await wiki.publishPage(id);
        sync?.onAfterChange(id);
        return jsonResult(page);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'force_delete_page',
    {
      description: 'Elimina una página de forma permanente (purge). Irreversible.',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        await wiki.forceDeletePage(id);
        sync?.onAfterDelete(id);
        return jsonResult({ deleted: true, id, forced: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_page_status',
    {
      description: 'Obtiene el estado de una página (metadatos, incluido isPublished).',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        return jsonResult(await wiki.getPageStatus(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_all_pages',
    {
      description:
        'Lista todo el corpus de páginas en una sola petición. Con includeUnpublished=false solo devuelve publicadas.',
      inputSchema: z.object({
        includeUnpublished: z.boolean().default(true),
      }),
    },
    async ({ includeUnpublished }) => {
      try {
        const pages = await wiki.listAllPages();
        return jsonResult(includeUnpublished ? pages : onlyPublished(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'search_unpublished_pages',
    {
      description:
        'Filtra en cliente las páginas no publicadas de todo el corpus; con `query` solo aquellas cuyo path o title la contengan (case-insensitive).',
      inputSchema: z.object({
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    async ({ query, limit }) => {
      try {
        const pages = await wiki.listAllPages();
        const q = query?.toLowerCase();
        const unpublished = pages.filter((page) => {
          if (page.isPublished) return false;
          if (!q) return true;
          return page.path.toLowerCase().includes(q) || page.title.toLowerCase().includes(q);
        });
        return jsonResult(unpublished.slice(0, limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
