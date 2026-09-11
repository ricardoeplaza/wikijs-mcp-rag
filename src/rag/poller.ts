/**
 * RAG incremental resync poller (Etapa 8b).
 *
 * Periodically reconciles the RAG index with the live Wiki.js corpus so that
 * changes made OUTSIDE the MCP tools (direct edits in the Wiki.js UI) are
 * picked up and externally-deleted pages are cleaned out of the index.
 *
 * `runOnce()` does a single reconciliation pass:
 *   - For every remote page: compare sha256(content) with the stored
 *     `content_hash`. Different (or absent) → `indexer.indexPage` (counted as
 *     `indexed`); identical → `unchanged`.
 *   - For every indexed page id that is no longer in the remote set →
 *     `indexer.purgePage` (counted as `purged`).
 *   - Per-page failures are isolated into `errors` and never abort the run.
 *
 * `start()` fires an immediate fire-and-forget `runOnce()` and then schedules
 * one every `intervalMs` (default 5 min). `stop()` clears the interval. The
 * timers are stored on fields so they can be observed/cleared in tests.
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { WikiClient } from '../wiki/client.js';
import type { RagDb } from './db.js';
import type { Indexer } from './indexer.js';

/** Aggregated result of a single reconciliation pass. */
export interface SyncReport {
  /** Pages (re)indexed because their content changed (or they were new). */
  indexed: number;
  /** Indexed pages removed because they no longer exist in the wiki. */
  purged: number;
  /** Remote pages whose stored hash already matched (no-op). */
  unchanged: number;
  /** Per-page failures; never aborts the run. */
  errors: Array<{ id: number; error: string }>;
}

export interface PollerOptions {
  wiki: WikiClient;
  db: RagDb;
  indexer: Indexer;
  /** Reconciliation period in ms. Default 5 minutes. */
  intervalMs?: number;
  logger?: Logger;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** sha256 hex digest of a UTF-8 string (mirrors the Indexer's content hash). */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class Poller {
  private readonly wiki: WikiClient;
  private readonly db: RagDb;
  private readonly indexer: Indexer;
  private readonly intervalMs: number;
  private readonly logger?: Logger;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: PollerOptions) {
    this.wiki = deps.wiki;
    this.db = deps.db;
    this.indexer = deps.indexer;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = deps.logger;
  }

  /** Runs a single reconciliation pass over the whole corpus. */
  async runOnce(): Promise<SyncReport> {
    const report: SyncReport = { indexed: 0, purged: 0, unchanged: 0, errors: [] };
    const remote = await this.wiki.listAllPages();
    const remoteIds = new Set<number>(remote.map((page) => page.id));

    for (const page of remote) {
      try {
        const { content } = await this.wiki.getPageContent(page.id);
        const hash = sha256Hex(content);
        const stored = this.db.getPageContentHash(page.id);
        if (stored !== hash) {
          await this.indexer.indexPage({
            id: page.id,
            path: page.path,
            title: page.title,
            content,
            updatedAt: page.updatedAt,
          });
          report.indexed += 1;
        } else {
          report.unchanged += 1;
        }
      } catch (err) {
        report.errors.push({ id: page.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const localId of this.db.listIndexedPageIds()) {
      if (remoteIds.has(localId)) continue;
      try {
        this.indexer.purgePage(localId);
        report.purged += 1;
      } catch (err) {
        report.errors.push({ id: localId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return report;
  }

  /** Fires an immediate fire-and-forget `runOnce()` and schedules the interval. */
  start(): void {
    if (this.timer !== null) return; // already started
    void this.runOnce().catch((error: unknown) => {
      this.logger?.warn({ err: error }, 'Poller: initial runOnce failed');
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger?.warn({ err: error }, 'Poller: scheduled runOnce failed');
      });
    }, this.intervalMs);
  }

  /** Clears the interval. Safe to call when not started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
