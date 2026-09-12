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
 * Registers the 12 page CRUD tools on an MCP server.
 *
 * Every tool follows the same contract: on success it returns the Wiki.js payload
 * as JSON in `content[0].text`; on failure it returns `isError: true` with the
 * error message, so a thrown `WikiClient` error never crashes the transport.
 *
 * After each successful MUTATING operation (create/update/publish/
 * delete/force_delete) the optional `sync` hook is fired WITHOUT awaiting, so
 * RAG reindex/purge runs in the background and never affects the tool response.
 */
export function registerPageTools(server: McpServer, wiki: WikiClient, sync?: SyncService): void {
  server.registerTool(
    'get_page',
    {
      description: 'Gets the metadata of a page (without content) by its numeric id.',
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
      description: 'Gets the Markdown content of a page by id ({ title, content }).',
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
         'Lists pages (by default the first 50, ordered by title). With includeUnpublished=false only published pages are returned.',
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
      description: 'Searches published pages by full text and returns up to `limit` results.',
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
         'Creates a Markdown page and publishes it. The client applies defaults: locale "es", markdown editor, isPublished true. DB limits: path, title and description max 255 characters; each tag max 255 (normalized to lowercase).',
      inputSchema: z.object({
        path: z.string().min(1).max(255),
        title: z.string().min(1).max(255),
        content: z.string(),
        locale: z.string().optional(),
        description: z.string().max(255).optional(),
        isPrivate: z.boolean().optional(),
        tags: z.array(z.string().max(255)).optional(),
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
      description:
         'Updates fields of an existing page (content, title, description, isPublished, tags). tags is OPTIONAL and uses replace-all semantics: the list sent COMPLETELY replaces the current tags (normalized to lowercase); use [] to remove all. If omitted, tags are unchanged. DB limits: title and description max 255 characters; each tag max 255.',
      inputSchema: z.object({
        id: z.number().int(),
        content: z.string().optional(),
        isPublished: z.boolean().optional(),
        title: z.string().max(255).optional(),
        description: z.string().max(255).optional(),
        tags: z.array(z.string().max(255)).optional(),
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
      description: 'Deletes a page (Wiki.js soft delete; does not purge data).',
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
      description: 'Publishes a page (equivalent to update with isPublished=true).',
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
      description: 'Permanently deletes a page (purge). Irreversible.',
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
      description: 'Gets the status of a page (metadata, including isPublished).',
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
         'Lists the entire page corpus in a single request. With includeUnpublished=false only published pages are returned.',
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
         'Client-side filter of the unpublished pages across the whole corpus; with `query` only those whose path or title contains it (case-insensitive).',
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
