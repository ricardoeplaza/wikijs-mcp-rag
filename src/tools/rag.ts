import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Querier, SearchResult } from '../rag/querier.js';
import type { Indexer } from '../rag/indexer.js';

/** Builds the success envelope: JSON-serialized payload in a single text block. */
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/** Builds the error envelope expected by MCP tool results. */
function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Maximum length of a `rag_search` snippet (chars). */
const SNIPPET_MAX_CHARS = 300;

/** Truncates a chunk's content to ~SNIPPET_MAX_CHARS for the search snippet. */
function toSnippet(content: string): string {
  if (content.length <= SNIPPET_MAX_CHARS) return content;
  return `${content.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…`;
}

/** One row of `rag_search` output (public shape, no internals). */
interface SearchRow {
  path: string;
  title: string;
  heading?: string;
  snippet: string;
  score: number;
}

/** Maps a {@link SearchResult} to the public search row. */
function toSearchRow(hit: SearchResult): SearchRow {
  const row: SearchRow = {
    path: hit.path,
    title: hit.title,
    snippet: toSnippet(hit.content),
    score: hit.score,
  };
  if (hit.heading) row.heading = hit.heading;
  return row;
}

/** RAG dependencies for {@link registerRagTools}. */
export interface RagToolsDeps {
  querier: Querier;
  indexer?: Indexer;
}

/**
 * Registers the 4 RAG tools on an MCP server.
 *
 * Same handler contract as pages.ts/users.ts: on success the payload is returned
 * as JSON in `content[0].text`; on failure `isError: true` with the error message,
 * so a thrown Querier/Indexer error never crashes the transport.
 *
 * - `rag_search`        → `querier.search` mapped to `{ path, title, heading?, snippet, score }`.
 * - `rag_get_context`   → `querier.search` assembled into an LLM-ready `context` + `sources`.
 * - `rag_index_status`  → `querier.indexStatus()`.
 * - `rag_reindex_page`  → `indexer.reindexPage(id)` (isError when no indexer configured).
 */
export function registerRagTools(server: McpServer, deps: RagToolsDeps): void {
  const { querier, indexer } = deps;

  server.registerTool(
    'rag_search',
    {
      description:
         'Semantic search (hybrid vectorial + lexical) over the wiki RAG index. Returns up to `limit` hits with path, title, optional heading, snippet (~300 chars) and score.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(5),
      }),
    },
    async ({ query, limit }) => {
      try {
        const results = await querier.search(query, { limit });
        return jsonResult(results.map(toSearchRow));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'rag_get_context',
    {
      description:
         'Returns an assembled context block (contents separated by ---, each with its path/title as a heading) plus the list of sources, to provide context to an LLM.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(3),
      }),
    },
    async ({ query, limit }) => {
      try {
        const results = await querier.search(query, { limit });
        const context = results
          .map((hit) => `## ${hit.path} — ${hit.title}\n\n${hit.content}`)
          .join('\n\n---\n\n');
        const sources = results.map((hit) => ({ path: hit.path, title: hit.title, score: hit.score }));
        return jsonResult({ context, sources });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'rag_index_status',
    {
      description: 'RAG index status: number of pages, chunks, dims and last indexed.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return jsonResult(await querier.indexStatus());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'rag_reindex_page',
    {
      description:
         'Re-indexes a specific page (rechunk + re-embed + store). Requires an available indexer.',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        if (!indexer) {
          return errorResult('indexer not available');
        }
        return jsonResult(await indexer.reindexPage(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
