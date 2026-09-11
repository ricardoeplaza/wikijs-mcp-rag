import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { Scheduler } from '../../src/rag/scheduler.js';
import type { Indexer } from '../../src/rag/indexer.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeIndexerMock() {
  const reindexAll = vi.fn(async () => ({ indexed: 2, chunks: 5, errors: [] as Array<{ id: number; error: string }> }));
  return { indexer: { reindexAll } as unknown as Indexer, reindexAll };
}

/** Local-time `hour:minute` today, in ms (timezone-independent for delay math). */
function localAt(hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Scheduler (Etapa 8b, nightly full reindex)', () => {
  it('runNightly delegates to reindexAll and logs a summary', async () => {
    const { indexer, reindexAll } = makeIndexerMock();
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    const scheduler = new Scheduler({ indexer, logger });

    const result = await scheduler.runNightly();

    expect(reindexAll).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ indexed: 2, chunks: 5, errors: [] });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ indexed: 2, chunks: 5, errors: 0 }),
      expect.stringContaining('reindex'),
    );
  });

  it('msUntilNext returns the delay to the next configured hour:minute', () => {
    const { indexer } = makeIndexerMock();

    // Midnight → next 03:00 is 3h away.
    const fromMidnight = new Scheduler({ indexer, hour: 3, minute: 0, now: () => localAt(0, 0) });
    expect(fromMidnight.msUntilNext()).toBe(3 * HOUR_MS);

    // Exactly at 03:00 → rolls to the next day (24h).
    const atTarget = new Scheduler({ indexer, hour: 3, minute: 0, now: () => localAt(3, 0) });
    expect(atTarget.msUntilNext()).toBe(DAY_MS);

    // After the target time (05:00) → next day's 03:00 is 22h away.
    const afterTarget = new Scheduler({ indexer, hour: 3, minute: 0, now: () => localAt(5, 0) });
    expect(afterTarget.msUntilNext()).toBe(22 * HOUR_MS);
  });

  it('start() fires the scheduled run once the delay elapses', async () => {
    vi.useFakeTimers();
    const { indexer, reindexAll } = makeIndexerMock();
    const base = localAt(0, 0); // 00:00
    const scheduler = new Scheduler({ indexer, hour: 3, minute: 0, now: () => base });

    scheduler.start();
    expect(reindexAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(scheduler.msUntilNext()); // advance to 03:00
    expect(reindexAll).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('stop() before the delay elapses cancels the run', async () => {
    vi.useFakeTimers();
    const { indexer, reindexAll } = makeIndexerMock();
    const base = localAt(0, 0);
    const scheduler = new Scheduler({ indexer, hour: 3, minute: 0, now: () => base });

    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(reindexAll).not.toHaveBeenCalled();
  });

  it('start() is idempotent (a second call does not double-schedule)', async () => {
    vi.useFakeTimers();
    const { indexer, reindexAll } = makeIndexerMock();
    const base = localAt(0, 0);
    const scheduler = new Scheduler({ indexer, hour: 3, minute: 0, now: () => base });

    scheduler.start();
    scheduler.start(); // no-op

    await vi.advanceTimersByTimeAsync(scheduler.msUntilNext());
    expect(reindexAll).toHaveBeenCalledTimes(1); // still a single run at 03:00

    scheduler.stop();
  });
});
