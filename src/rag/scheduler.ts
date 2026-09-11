/**
 * RAG nightly full-reindex scheduler (Etapa 8b).
 *
 * Schedules a full-corpus `indexer.reindexAll()` once per day at the configured
 * `hour:minute` (default 03:00). This is the periodic safety net that rebuilds
 * the whole index from scratch, complementing the incremental {@link Poller}.
 *
 * Testability:
 * - `now?: () => number` injects the clock used by {@link msUntilNext}.
 * - `msUntilNext()` exposes the "ms until the next scheduled run" calculation so
 *   it can be asserted without waiting, and so `start()`'s initial delay is
 *   deterministic.
 *
 * `start()` arms a one-shot `setTimeout` for the next occurrence and, once that
 * fires, a repeating `setInterval` every 24h. `stop()` clears both. Timers are
 * stored on fields so they can be inspected/cleared in tests.
 */

import type { Logger } from 'pino';
import type { Indexer, ReindexAllResult } from './indexer.js';

export interface SchedulerOptions {
  indexer: Indexer;
  /** Hour of day (0-23) for the nightly run. Default 3. */
  hour?: number;
  /** Minute of the hour for the nightly run. Default 0. */
  minute?: number;
  logger?: Logger;
  /** Injectable clock (`Date.now` by default) used to compute the next run. */
  now?: () => number;
}

const DEFAULT_HOUR = 3;
const DEFAULT_MINUTE = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

export class Scheduler {
  private readonly indexer: Indexer;
  private readonly hour: number;
  private readonly minute: number;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private timeout: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(deps: SchedulerOptions) {
    this.indexer = deps.indexer;
    this.hour = deps.hour ?? DEFAULT_HOUR;
    this.minute = deps.minute ?? DEFAULT_MINUTE;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Runs the full reindex now and logs a summary. Returns the result. */
  async runNightly(): Promise<ReindexAllResult> {
    const result = await this.indexer.reindexAll();
    this.logger?.info(
      { indexed: result.indexed, chunks: result.chunks, errors: result.errors.length },
      'Scheduler.runNightly: reindex complete',
    );
    return result;
  }

  /** Milliseconds until the next occurrence of the configured `hour:minute`. */
  msUntilNext(): number {
    const nowMs = this.now();
    const target = new Date(nowMs);
    target.setHours(this.hour, this.minute, 0, 0);
    if (target.getTime() <= nowMs) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - nowMs;
  }

  /** Arms the one-shot timer for the next run, then a repeating 24h interval. */
  start(): void {
    if (this.timeout !== null || this.interval !== null) return; // already started
    this.timeout = setTimeout(() => {
      this.timeout = null;
      void this.runNightly().catch((error: unknown) => {
        this.logger?.warn({ err: error }, 'Scheduler: nightly run failed');
      });
      this.interval = setInterval(() => {
        void this.runNightly().catch((error: unknown) => {
          this.logger?.warn({ err: error }, 'Scheduler: scheduled run failed');
        });
      }, DAY_MS);
    }, this.msUntilNext());
  }

  /** Clears the pending/running timers. Safe to call when not started. */
  stop(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
