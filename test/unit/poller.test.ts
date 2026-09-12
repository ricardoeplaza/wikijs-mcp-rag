import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { EmbeddingsClient } from '../../src/rag/embeddings.js';
import { RagDb, type RagDbOptions } from '../../src/rag/db.js';
import { Indexer } from '../../src/rag/indexer.js';
import { Poller } from '../../src/rag/poller.js';
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Deterministic embeddings mock: fixed unit vectors derived from the text position. */
function makeEmbeddingsMock(): { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) => {
    return texts.map((_, i) => {
      const vector = new Array<number>(DIMS).fill(0);
      vector[i % DIMS] = 1;
      return vector;
    });
  });
  return { embed };
}

interface RemotePage {
  id: number;
  path: string;
  title: string;
  content: string;
  updatedAt?: string;
}

/** In-memory WikiClient mock covering the methods the Poller uses. */
function makeWikiMock(pages: RemotePage[], opts: { failContentFor?: Set<number> } = {}) {
  const byId = new Map<number, RemotePage>(pages.map((p) => [p.id, p]));
  const metaOf = (p: RemotePage): WikiPage => ({
    id: p.id,
    path: p.path,
    title: p.title,
    isPublished: true,
    updatedAt: p.updatedAt ?? '2026-01-01T00:00:00.000Z',
  });

  const listAllPages = vi.fn(async (): Promise<WikiPage[]> => pages.map(metaOf));
  const getPageContent = vi.fn(async (id: number): Promise<{ title: string; content: string }> => {
    if (opts.failContentFor?.has(id)) throw new Error(`content boom ${id}`);
    const p = byId.get(id);
    if (p === undefined) throw new Error(`Wiki page ${id} not found`);
    return { title: p.title, content: p.content };
  });

  return { listAllPages, getPageContent };
}

const CONTENT_A = '# A\nBody one.\n\n## B\nBody two.';
const CONTENT_B = '# A\nBody one EDITED.\n\n## B\nBody two.';

describe('Poller (incremental resync)', () => {
  it('indexes a page that is not yet in the db', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    const wiki = makeWikiMock([{ id: 1, path: '/a', title: 'A', content: CONTENT_A }]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    const indexSpy = vi.spyOn(indexer, 'indexPage');
    const report = await poller.runOnce();

    expect(report).toEqual({ indexed: 1, purged: 0, unchanged: 0, errors: [] });
    expect(indexSpy).toHaveBeenCalledTimes(1);
    expect(indexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, path: '/a', title: 'A', content: CONTENT_A }),
    );
    expect(db.listIndexedPageIds()).toContain(1);
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(2);
  });

  it('leaves unchanged a page whose stored hash already matches', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    // Seed the exact same content the wiki will report.
    await indexer.indexPage({ id: 1, path: '/a', title: 'A', content: CONTENT_A });
    const wiki = makeWikiMock([{ id: 1, path: '/a', title: 'A', content: CONTENT_A }]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    const indexSpy = vi.spyOn(indexer, 'indexPage');
    const report = await poller.runOnce();

    expect(report).toEqual({ indexed: 0, purged: 0, unchanged: 1, errors: [] });
    expect(indexSpy).not.toHaveBeenCalled();
    expect(db.getPageContentHash(1)).not.toBeNull();
  });

  it('re-indexes a page whose content changed', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    // Seed with the OLD content so the stored hash differs from the wiki's new one.
    await indexer.indexPage({ id: 1, path: '/a', title: 'A', content: CONTENT_A });
    const wiki = makeWikiMock([{ id: 1, path: '/a', title: 'A', content: CONTENT_B }]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    const indexSpy = vi.spyOn(indexer, 'indexPage');
    const report = await poller.runOnce();

    expect(report).toEqual({ indexed: 1, purged: 0, unchanged: 0, errors: [] });
    expect(indexSpy).toHaveBeenCalledTimes(1);
    expect(indexSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1, content: CONTENT_B }));
    // The stored hash now reflects the new content.
    expect(db.getPageContentHash(1)).not.toBeNull();
  });

  it('purges an indexed page that no longer exists in the wiki', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    await indexer.indexPage({ id: 1, path: '/a', title: 'A', content: CONTENT_A });
    expect(db.listIndexedPageIds()).toContain(1);

    // The wiki now reports an empty corpus (page deleted externally).
    const wiki = makeWikiMock([]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    const purgeSpy = vi.spyOn(indexer, 'purgePage');
    const report = await poller.runOnce();

    expect(report).toEqual({ indexed: 0, purged: 1, unchanged: 0, errors: [] });
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(purgeSpy).toHaveBeenCalledWith(1);
    expect(db.listIndexedPageIds()).toEqual([]);
  });

  it('records a per-page failure in errors and keeps processing the rest', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    const wiki = makeWikiMock(
      [
        { id: 1, path: '/a', title: 'A', content: CONTENT_A },
        { id: 2, path: '/b', title: 'B', content: '# B\nBody two.' },
      ],
      { failContentFor: new Set([2]) },
    );
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    const report = await poller.runOnce();

    expect(report.indexed).toBe(1); // page 1 still indexed
    expect(report.errors).toEqual([{ id: 2, error: 'content boom 2' }]);
    expect(db.listIndexedPageIds()).toContain(1);
    expect(db.listIndexedPageIds()).not.toContain(2);
  });

  it('start() fires an immediate run and schedules the interval; stop() cancels it', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    const wiki = makeWikiMock([{ id: 1, path: '/a', title: 'A', content: CONTENT_A }]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 1000 });

    poller.start();
    // The immediate fire-and-forget runOnce calls listAllPages synchronously.
    expect(wiki.listAllPages).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(wiki.listAllPages).toHaveBeenCalledTimes(2); // one interval tick

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(wiki.listAllPages).toHaveBeenCalledTimes(2); // no further runs after stop
  });

  it('records a purge failure in errors (purgePage throws)', async () => {
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    await indexer.indexPage({ id: 1, path: '/a', title: 'A', content: CONTENT_A });
    // The wiki reports an empty corpus → page 1 must be purged.
    const wiki = makeWikiMock([]);
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 60_000 });

    vi.spyOn(indexer, 'purgePage').mockImplementation(() => {
      throw new Error('purge boom');
    });
    const report = await poller.runOnce();

    expect(report.purged).toBe(0);
    expect(report.errors).toEqual([{ id: 1, error: 'purge boom' }]);
  });

  it('start() logs a warning when the initial fire-and-forget runOnce fails', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const wiki = { listAllPages: vi.fn(async () => { throw new Error('list boom'); }), getPageContent: vi.fn() };
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 1000, logger });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget rejection settle

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Poller: initial runOnce failed',
    );
    poller.stop();
  });

  it('logs a warning when a scheduled runOnce fails', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const indexer = new Indexer({ db, embeddings: makeEmbeddingsMock() as unknown as EmbeddingsClient });
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const wiki = { listAllPages: vi.fn(async () => { throw new Error('list boom'); }), getPageContent: vi.fn() };
    const poller = new Poller({ wiki: wiki as unknown as WikiClient, db, indexer, intervalMs: 1000, logger });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // settle the initial failure
    warn.mockClear();
    await vi.advanceTimersByTimeAsync(1000); // trigger one scheduled tick

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Poller: scheduled runOnce failed',
    );
    poller.stop();
  });
});
