import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingsClient } from '../../src/rag/embeddings.js';
import { chunkMarkdown } from '../../src/rag/chunker.js';
import { RagDb, type RagDbOptions } from '../../src/rag/db.js';
import { Indexer } from '../../src/rag/indexer.js';
import type { WikiClient } from '../../src/wiki/client.js';
import type { WikiPage } from '../../src/wiki/types.js';

const DIMS = 4;

const dbs: RagDb[] = [];

function makeDb(): RagDb {
  const options: RagDbOptions = { dims: DIMS }; // :memory:
  const db = new RagDb(options);
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

/** Deterministic embeddings mock: fixed unit vectors derived from the text position. */
function makeEmbeddingsMock(failOn?: (text: string) => boolean): { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) => {
    if (failOn !== undefined && texts.some(failOn)) {
      throw new Error('embeddings exploded');
    }
    return texts.map((_, i) => {
      const vector = new Array<number>(DIMS).fill(0);
      vector[i % DIMS] = 1;
      return vector;
    });
  });
  return { embed };
}

interface WikiFixture {
  id: number;
  path: string;
  title: string;
  content: string;
}

/** In-memory WikiClient mock covering the methods the indexer uses. */
function makeWikiMock(fixtures: WikiFixture[]) {
  const byId = new Map<number, WikiFixture>(fixtures.map((f) => [f.id, f]));
  const metaOf = (f: WikiFixture): WikiPage => ({
    id: f.id,
    path: f.path,
    title: f.title,
    isPublished: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const getPage = vi.fn(async (id: number): Promise<WikiPage> => {
    const f = byId.get(id);
    if (f === undefined) throw new Error(`Wiki page ${id} not found`);
    return metaOf(f);
  });
  const getPageContent = vi.fn(async (id: number): Promise<{ title: string; content: string }> => {
    const f = byId.get(id);
    if (f === undefined) throw new Error(`Wiki page ${id} not found`);
    return { title: f.title, content: f.content };
  });
  const listAllPages = vi.fn(async (): Promise<WikiPage[]> => fixtures.map(metaOf));

  return { getPage, getPageContent, listAllPages };
}

const THREE_SECTIONS = [
  '# Intro',
  'First section body.',
  '',
  '## Middle',
  'Second section body.',
  '',
  '# End',
  'Third section body.',
].join('\n');

describe('Indexer (chunk + embed + store)', () => {
  it('indexPage stores N chunks and N vectors for a multi-section document, embedding in one batch', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock();
    const indexer = new Indexer({ db, embeddings: emb as unknown as EmbeddingsClient });

    const result = await indexer.indexPage({ id: 7, path: '/three', title: 'Three', content: THREE_SECTIONS });

    expect(result).toEqual({ chunks: 3 });
    // ALL chunk texts go through a SINGLE embed() call (batching contract).
    expect(emb.embed).toHaveBeenCalledTimes(1);
    const batch = emb.embed.mock.calls[0]?.[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(chunkMarkdown(THREE_SECTIONS)).toHaveLength(3);

    // N chunks ↔ N vectors: a k>N KNN returns exactly the stored chunks, all of page 7.
    expect(db.listIndexedPageIds()).toContain(7);
    const hits = db.searchByVector([0.5, 0.5, 0.5, 0.5], 10);
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.page_id === 7)).toBe(true);
    expect(hits.map((hit) => hit.heading).sort()).toEqual(['End', 'Intro', 'Middle']);
  });

  it('indexPage with empty content stores the page with 0 chunks, drops stale chunks and never embeds', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock();
    const indexer = new Indexer({ db, embeddings: emb as unknown as EmbeddingsClient });

    // Seed the page with real chunks first, then reindex it with empty content.
    await indexer.indexPage({ id: 1, path: '/e', title: 'E', content: THREE_SECTIONS });
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(3);

    const result = await indexer.indexPage({ id: 1, path: '/e', title: 'E', content: '' });

    expect(result).toEqual({ chunks: 0 });
    expect(db.listIndexedPageIds()).toContain(1); // page row kept (hash of '')
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(0); // stale chunks dropped
    expect(emb.embed).toHaveBeenCalledTimes(1); // only the first call embedded anything
  });

  it('reindexPage fetches metadata + content from the wiki and indexes the page', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock();
    const wiki = makeWikiMock([
      { id: 5, path: '/five', title: 'Five', content: '# A\nBody one.\n\n## B\nBody two.' },
    ]);
    const indexer = new Indexer({
      db,
      embeddings: emb as unknown as EmbeddingsClient,
      wiki: wiki as unknown as WikiClient,
    });

    const result = await indexer.reindexPage(5);

    expect(result.chunks).toBe(2);
    expect(wiki.getPage).toHaveBeenCalledWith(5);
    expect(wiki.getPageContent).toHaveBeenCalledWith(5);
    expect(db.listIndexedPageIds()).toContain(5);
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(2);
  });

  it('reindexPage without a WikiClient rejects with an actionable error', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });

    await expect(indexer.reindexPage(1)).rejects.toThrow(/WikiClient/);
  });

  it('purgePage removes the page row and all its chunks/vectors', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });

    await indexer.indexPage({ id: 9, path: '/nine', title: 'Nine', content: THREE_SECTIONS });
    expect(db.listIndexedPageIds()).toContain(9);

    indexer.purgePage(9);

    expect(db.listIndexedPageIds()).not.toContain(9);
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(0);
  });

  it('reindexAll indexes every page from listAllPages', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock();
    const wiki = makeWikiMock([
      { id: 1, path: '/a', title: 'A', content: '# A\nBody one.' },
      { id: 2, path: '/b', title: 'B', content: '# B\nBody two.\n\nSecond paragraph of page B.' },
    ]);
    const indexer = new Indexer({
      db,
      embeddings: emb as unknown as EmbeddingsClient,
      wiki: wiki as unknown as WikiClient,
    });

    const result = await indexer.reindexAll();

    expect(result).toEqual({ indexed: 2, chunks: 2, errors: [] });
    expect(db.listIndexedPageIds()).toEqual([1, 2]);
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(2);
  });

  it('reindexAll records a per-page embedding failure in errors and keeps indexing the rest', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock((text) => text.includes('boom'));
    const wiki = makeWikiMock([
      { id: 1, path: '/a', title: 'A', content: '# A\nThis page will boom.' },
      { id: 2, path: '/b', title: 'B', content: '# B\nBody two.' },
    ]);
    const indexer = new Indexer({
      db,
      embeddings: emb as unknown as EmbeddingsClient,
      wiki: wiki as unknown as WikiClient,
    });

    const result = await indexer.reindexAll();

    expect(result.indexed).toBe(1);
    expect(result.chunks).toBe(1);
    expect(result.errors).toEqual([{ id: 1, error: 'embeddings exploded' }]);
    expect(db.listIndexedPageIds()).toEqual([2]); // page 2 indexed despite page 1 failing
  });

  it('reindexAll skips pages whose stored content_hash already matches (second run is a no-op)', async () => {
    const db = makeDb();
    const emb = makeEmbeddingsMock();
    const wiki = makeWikiMock([
      { id: 1, path: '/a', title: 'A', content: '# A\nBody one.' },
      { id: 2, path: '/b', title: 'B', content: '# B\nBody two.' },
    ]);
    const indexer = new Indexer({
      db,
      embeddings: emb as unknown as EmbeddingsClient,
      wiki: wiki as unknown as WikiClient,
    });

    const first = await indexer.reindexAll();
    expect(first).toEqual({ indexed: 2, chunks: 2, errors: [] });

    const second = await indexer.reindexAll();
    expect(second).toEqual({ indexed: 0, chunks: 0, errors: [] }); // unchanged → skipped, not an error
    expect(emb.embed).toHaveBeenCalledTimes(2); // one embed per page, only during the first run
    expect(db.listIndexedPageIds()).toEqual([1, 2]);
  });
});
