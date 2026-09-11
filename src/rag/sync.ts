/**
 * RAG sync hooks (Etapa 8a).
 *
 * Fire-and-forget bridge between the page CRUD tools and the {@link Indexer}:
 * after a successful create/update/publish/delete, the tools call
 * `onAfterChange`/`onAfterDelete` WITHOUT awaiting. The returned promise never
 * rejects — indexer failures are logged (`logger.warn`) and swallowed so a RAG
 * hiccup can never break (or delay) a CRUD tool response. Tests may await the
 * returned promise to observe completion.
 */

import type { Logger } from 'pino';
import type { Indexer } from './indexer.js';

export interface SyncServiceOptions {
  indexer: Indexer;
  logger?: Logger;
}

export class SyncService {
  private readonly indexer: Indexer;
  private readonly logger?: Logger;

  constructor(deps: SyncServiceOptions) {
    this.indexer = deps.indexer;
    this.logger = deps.logger;
  }

  /** Schedules a reindex for `id`. Returns a promise that never rejects. */
  onAfterChange(id: number): Promise<void> {
    return Promise.resolve()
      .then(async () => {
        await this.indexer.reindexPage(id);
      })
      .catch((error: unknown) => {
        this.logger?.warn({ err: error, pageId: id }, 'SyncService.onAfterChange: reindex failed');
      });
  }

  /** Schedules a purge for `id`. Returns a promise that never rejects. */
  onAfterDelete(id: number): Promise<void> {
    return Promise.resolve()
      .then(async () => {
        this.indexer.purgePage(id);
      })
      .catch((error: unknown) => {
        this.logger?.warn({ err: error, pageId: id }, 'SyncService.onAfterDelete: purge failed');
      });
  }
}
