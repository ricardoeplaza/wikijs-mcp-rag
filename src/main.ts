import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { WikiClient } from './wiki/client.js';
import { RagDb } from './rag/db.js';
import { EmbeddingsClient } from './rag/embeddings.js';
import { Indexer } from './rag/indexer.js';
import { Querier } from './rag/querier.js';
import { SyncService } from './rag/sync.js';
import { Poller } from './rag/poller.js';
import { Scheduler } from './rag/scheduler.js';
import { createAuthMiddleware } from './server/auth.js';
import { registerHttpTransport } from './server/http-transport.js';
import { registerSseTransports } from './server/sse-transport.js';

export interface CreateAppOptions {
  /**
   * When true, the background RAG sync (poller + nightly scheduler) is started
   * as part of app construction. Off by default so tests can build the app
   * without any timers or live wiki traffic; `main()` turns it on.
   */
  startLifecycle?: boolean;
}

/**
 * Builds the Fastify app without listening, so tests can start it on an
 * ephemeral port. Routes:
 * - GET  /health   -> { status: 'ok' } (no auth)
 * - POST /mcp      -> Streamable HTTP (stateless), bearer auth
 * - GET  /sse      -> SSE, bearer auth (?token= fallback)
 * - POST /message  -> SSE message endpoint, bearer auth
 *
 * The RAG resync lifecycle (poller + nightly scheduler) is built here and torn
 * down via an `onClose` hook; it is only STARTED when `startLifecycle` is set.
 */
export function createApp(config: Config, options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Single shared WikiClient for the whole app. It is lazy: the constructor
  // only builds the HTTP client, no live connection happens until the first
  // GraphQL call (the real endpoint wiring stays in the integration stage).
  const wiki = new WikiClient(config);

  // RAG stack (Etapa 7b). All local/lazy at construction: RagDb opens the SQLite
  // file (no network), EmbeddingsClient only stores options, Indexer/Querier just
  // hold references. checkIntegrity surfaces an actionable error on a dims mismatch
  // (rebuild is Etapa 8/9) instead of corrupting search results later.
  const ragDb = new RagDb({ file: config.ragDbPath, dims: config.embeddingsDim });
  ragDb.checkIntegrity(config.embeddingsDim);
  const embeddings = new EmbeddingsClient({
    baseUrl: config.embeddingsBaseUrl,
    model: config.embeddingsModel,
    dims: config.embeddingsDim,
  });
  const indexer = new Indexer({ db: ragDb, embeddings, wiki });
  const querier = new Querier({ db: ragDb, embeddings });
  const rag = { querier, indexer };

  // Etapa 8a: fire-and-forget RAG sync hooks for the page CRUD tools. Failures
  // are logged by the SyncService and never propagate to tool responses.
  const sync = new SyncService({ indexer, logger });

  // Etapa 8b: background RAG resync. The Poller reconciles index vs wiki every
  // `syncPollIntervalMs` (incremental, hash-based); the Scheduler runs a full
  // reindex nightly at `nightlyResyncHour`. Both are built here but only started
  // when requested; teardown is centralized in the onClose hook below.
  const poller = new Poller({ wiki, db: ragDb, indexer, intervalMs: config.syncPollIntervalMs, logger });
  const scheduler = new Scheduler({ indexer, hour: config.nightlyResyncHour, minute: 0, logger });

  app.addHook('onClose', async () => {
    poller.stop();
    scheduler.stop();
    try {
      ragDb.close();
    } catch {
      // already closed (defensive; better-sqlite3 throws on a double close)
    }
  });

  if (options.startLifecycle) {
    poller.start();
    if (config.nightlyResyncEnabled) scheduler.start();
  }

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(async (scope) => {
    scope.addHook('onRequest', createAuthMiddleware(config));
    registerHttpTransport(scope, wiki, rag, sync);
    registerSseTransports(scope, wiki, rag, sync);
  });

  return app;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  // startLifecycle turns on the poller + nightly scheduler; their teardown is
  // wired to app.close() via the onClose hook registered in createApp.
  const app = createApp(config, { startLifecycle: true });
  await app.listen({ host: config.mcpHost, port: config.mcpPort });
  logger.info(`MCP server listening on http://${config.mcpHost}:${config.mcpPort}`);

  // Minimal shutdown hook: closing the app stops the poller/scheduler and closes
  // the RAG DB (onClose hook), then the process exits.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down MCP server');
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    logger.fatal({ err: error }, 'Failed to start MCP server');
    process.exit(1);
  });
}
