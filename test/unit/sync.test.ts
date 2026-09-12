import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { SyncService } from '../../src/rag/sync.js';
import type { Indexer } from '../../src/rag/indexer.js';

/**
 * Builds an Indexer mock backed by vi.fn so each test can assert the exact
 * method/arguments invoked and override implementations per case.
 */
function makeIndexer() {
  const fns = {
    reindexPage: vi.fn(async (id: number) => ({ chunks: id % 3 })),
    purgePage: vi.fn(),
  };
  return { indexer: fns as unknown as Indexer, fns };
}

function makeLogger() {
  const warn = vi.fn();
  return { warn, logger: { warn } as unknown as Logger };
}

describe('SyncService', () => {
  it('onAfterChange schedules a reindex for the given id', async () => {
    const { indexer, fns } = makeIndexer();
    const sync = new SyncService({ indexer });

    await sync.onAfterChange(42);

    expect(fns.reindexPage).toHaveBeenCalledTimes(1);
    expect(fns.reindexPage).toHaveBeenCalledWith(42);
  });

  it('onAfterDelete schedules a purge for the given id', async () => {
    const { indexer, fns } = makeIndexer();
    const sync = new SyncService({ indexer });

    await sync.onAfterDelete(7);

    expect(fns.purgePage).toHaveBeenCalledTimes(1);
    expect(fns.purgePage).toHaveBeenCalledWith(7);
  });

  it('onAfterChange never rejects when the indexer throws (logs a warning)', async () => {
    const { indexer, fns } = makeIndexer();
    const { warn, logger } = makeLogger();
    fns.reindexPage.mockImplementation(async () => {
      throw new Error('boom reindex');
    });
    const sync = new SyncService({ indexer, logger });

    await expect(sync.onAfterChange(9)).resolves.toBeUndefined();

    expect(fns.reindexPage).toHaveBeenCalledWith(9);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('onAfterDelete never rejects when the indexer throws (logs a warning)', async () => {
    const { indexer, fns } = makeIndexer();
    const { warn, logger } = makeLogger();
    fns.purgePage.mockImplementation(() => {
      throw new Error('boom purge');
    });
    const sync = new SyncService({ indexer, logger });

    await expect(sync.onAfterDelete(9)).resolves.toBeUndefined();

    expect(fns.purgePage).toHaveBeenCalledWith(9);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('works without a logger (errors are swallowed silently)', async () => {
    const { indexer, fns } = makeIndexer();
    const sync = new SyncService({ indexer });
    fns.reindexPage.mockImplementation(async () => {
      throw new Error('boom reindex');
    });
    fns.purgePage.mockImplementation(() => {
      throw new Error('boom purge');
    });

    await expect(sync.onAfterChange(1)).resolves.toBeUndefined();
    await expect(sync.onAfterDelete(2)).resolves.toBeUndefined();
  });
});
