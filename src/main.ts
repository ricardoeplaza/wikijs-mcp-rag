import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { logger } from './logger.js';
import { WikiClient } from './wiki/client.js';
import { createAuthMiddleware } from './server/auth.js';
import { registerHttpTransport } from './server/http-transport.js';
import { registerSseTransports } from './server/sse-transport.js';

/**
 * Builds the Fastify app without listening, so tests can start it on an
 * ephemeral port. Routes:
 * - GET  /health   -> { status: 'ok' } (no auth)
 * - POST /mcp      -> Streamable HTTP (stateless), bearer auth
 * - GET  /sse      -> SSE, bearer auth (?token= fallback)
 * - POST /message  -> SSE message endpoint, bearer auth
 */
export function createApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: false });

  // Single shared WikiClient for the whole app. It is lazy: the constructor
  // only builds the HTTP client, no live connection happens until the first
  // GraphQL call (the real endpoint wiring stays in the integration stage).
  const wiki = new WikiClient(config);

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(async (scope) => {
    scope.addHook('onRequest', createAuthMiddleware(config));
    registerHttpTransport(scope, wiki);
    registerSseTransports(scope, wiki);
  });

  return app;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  await app.listen({ host: config.mcpHost, port: config.mcpPort });
  logger.info(`MCP server listening on http://${config.mcpHost}:${config.mcpPort}`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    logger.fatal({ err: error }, 'Failed to start MCP server');
    process.exit(1);
  });
}
