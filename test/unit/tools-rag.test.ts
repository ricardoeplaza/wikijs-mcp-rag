import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/mcp-server.js';
import type { WikiClient } from '../../src/wiki/client.js';
import type { Querier, SearchResult } from '../../src/rag/querier.js';
import type { Indexer } from '../../src/rag/indexer.js';

const longContent = 'Contenido largo de la guía. '.repeat(25); // > 300 chars → truncated snippet

const mockResults: SearchResult[] = [
  {
    chunk_id: 1,
    page_id: 10,
    path: '/guide',
    title: 'Guía',
    heading: 'Instalación',
    content: longContent,
    score: 0.9,
    distance: 0.1,
  },
  {
    chunk_id: 2,
    page_id: 11,
    path: '/api',
    title: 'API',
    content: 'Documento de API.',
    score: 0.5,
    distance: 0.5,
  },
];

const indexStatus = { pages: 2, chunks: 7, dims: 1024, lastIndexedAt: '2024-05-05T00:00:00.000Z' };

/** ping + 17 CRUD (pages/users/groups) + 4 RAG = 22 tools. */
const EXPECTED_TOOL_NAMES = [
  'ping',
  'get_page',
  'get_page_content',
  'list_pages',
  'search_pages',
  'create_page',
  'update_page',
  'delete_page',
  'publish_page',
  'force_delete_page',
  'get_page_status',
  'list_all_pages',
  'search_unpublished_pages',
  'list_users',
  'search_users',
  'create_user',
  'update_user',
  'list_groups',
  'rag_search',
  'rag_get_context',
  'rag_index_status',
  'rag_reindex_page',
];

type CallToolOutcome = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallToolOutcome): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(result)}`);
  }
  return first.text;
}

function isErrorOf(result: CallToolOutcome): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** Plain-object Querier mock (vi.fn per method, no network). */
function makeQuerier() {
  const fns = {
    search: vi.fn().mockResolvedValue(mockResults),
    indexStatus: vi.fn(async () => indexStatus),
  };
  return { querier: fns as unknown as Querier, fns };
}

/** Plain-object Indexer mock (vi.fn per method, no network). */
function makeIndexer() {
  const fns = { reindexPage: vi.fn(async (id: number) => ({ chunks: id })) };
  return { indexer: fns as unknown as Indexer, fns };
}

interface Harness {
  client: Client;
  querierFns: ReturnType<typeof makeQuerier>['fns'];
  indexerFns: ReturnType<typeof makeIndexer>['fns'] | null;
  close: () => Promise<void>;
}

/** Real createMcpServer (full wiring) + real SDK client over an in-memory transport. */
async function setup(withIndexer = true): Promise<Harness> {
  const wiki = {} as unknown as WikiClient; // page/user/group tools are registered but never called here
  const { querier, fns: querierFns } = makeQuerier();

  let indexer: Indexer | undefined;
  let indexerFns: ReturnType<typeof makeIndexer>['fns'] | null = null;
  if (withIndexer) {
    const made = makeIndexer();
    indexer = made.indexer;
    indexerFns = made.fns;
  }

  const rag: { querier: Querier; indexer?: Indexer } = indexer ? { querier, indexer } : { querier };
  const server = createMcpServer({ wiki, rag });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rag-test-client', version: '0.0.1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    querierFns,
    indexerFns,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('registerRagTools (Etapa 7b)', () => {
  it('registers the 22 tools (ping + 17 CRUD + 4 RAG)', async () => {
    const { client, close } = await setup();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await close();
    }
  });

  it('rag_search returns snippets + scores and calls querier.search(query, { limit })', async () => {
    const { client, querierFns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'rag_search', arguments: { query: 'guía' } });
      expect(querierFns.search).toHaveBeenCalledWith('guía', { limit: 5 });

      const rows = JSON.parse(textOf(result)) as Record<string, unknown>[];
      expect(rows).toHaveLength(2);

      // Short content row: exact mapping, no truncation, no heading key.
      expect(rows[1]).toEqual({ path: '/api', title: 'API', snippet: 'Documento de API.', score: 0.5 });

      // Long content row: metadata preserved, snippet truncated to ~300 chars + ellipsis.
      const first = rows[0];
      expect(first).toBeDefined();
      if (!first) throw new Error('rows[0] missing');
      expect(first.path).toBe('/guide');
      expect(first.title).toBe('Guía');
      expect(first.heading).toBe('Instalación');
      expect(first.score).toBe(0.9);
      const snippet = first.snippet as string;
      expect(typeof snippet).toBe('string');
      expect(snippet.length).toBeLessThanOrEqual(301);
      expect(snippet.endsWith('…')).toBe(true);
      expect(longContent.startsWith(snippet.slice(0, -1))).toBe(true);
    } finally {
      await close();
    }
  });

  it('rag_get_context returns the assembled context + sources', async () => {
    const { client, querierFns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'rag_get_context', arguments: { query: 'q' } });
      expect(querierFns.search).toHaveBeenCalledWith('q', { limit: 3 });

      const parsed = JSON.parse(textOf(result)) as { context: string; sources: unknown };
      expect(parsed.sources).toEqual([
        { path: '/guide', title: 'Guía', score: 0.9 },
        { path: '/api', title: 'API', score: 0.5 },
      ]);
      expect(parsed.context).toBe(
        `## /guide — Guía\n\n${longContent}\n\n---\n\n## /api — API\n\nDocumento de API.`,
      );
    } finally {
      await close();
    }
  });

  it('rag_index_status returns the querier index status', async () => {
    const { client, querierFns, close } = await setup();
    try {
      const result = await client.callTool({ name: 'rag_index_status', arguments: {} });
      expect(querierFns.indexStatus).toHaveBeenCalledTimes(1);
      expect(JSON.parse(textOf(result))).toEqual(indexStatus);
    } finally {
      await close();
    }
  });

  it('rag_reindex_page calls indexer.reindexPage(id) and returns the result', async () => {
    const { client, indexerFns, close } = await setup(true);
    try {
      expect(indexerFns).not.toBeNull();
      const result = await client.callTool({ name: 'rag_reindex_page', arguments: { id: 42 } });
      expect(indexerFns?.reindexPage).toHaveBeenCalledWith(42);
      expect(JSON.parse(textOf(result))).toEqual({ chunks: 42 });
    } finally {
      await close();
    }
  });

  it('rag_reindex_page returns isError when no indexer is configured', async () => {
    const { client, close } = await setup(false);
    try {
      const result = await client.callTool({ name: 'rag_reindex_page', arguments: { id: 1 } });
      expect(isErrorOf(result)).toBe(true);
      expect(textOf(result)).toBe('indexer no disponible');
    } finally {
      await close();
    }
  });

  it('returns isError:true with the message when querier.search throws', async () => {
    const { client, querierFns, close } = await setup();
    try {
      querierFns.search.mockImplementation(async () => {
        throw new Error('boom rag_search');
      });
      const result = await client.callTool({ name: 'rag_search', arguments: { query: 'x' } });
      expect(isErrorOf(result)).toBe(true);
      expect(textOf(result)).toBe('boom rag_search');
    } finally {
      await close();
    }
  });
});
