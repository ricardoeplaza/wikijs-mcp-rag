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
 * Registers the 4 RAG tools (Etapa 7b) on an MCP server.
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
        'Búsqueda semántica (híbrida vectorial + léxica) sobre el índice RAG de la wiki. Devuelve hasta `limit` hits con path, title, heading opcional, snippet (~300 chars) y score.',
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
        'Devuelve un bloque de contexto ensamblado (contents separados por ---, cada uno con su path/title como encabezado) más la lista de sources, para dar contexto a un LLM.',
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
      description: 'Estado del índice RAG: nº de páginas, chunks, dims y último indexado.',
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
        'Re-indexa una página concreta (rechunk + re-embed + store). Requiere indexer disponible.',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      try {
        if (!indexer) {
          return errorResult('indexer no disponible');
        }
        return jsonResult(await indexer.reindexPage(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
