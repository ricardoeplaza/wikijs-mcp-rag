import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger.js';
import type { SyncService } from '../rag/sync.js';
import type { WikiClient } from '../wiki/client.js';
import { createMcpServer } from './mcp-server.js';
import type { RagToolsDeps } from '../tools/rag.js';

/**
 * POST /mcp — MCP Streamable HTTP transport, stateless.
 *
 * A new McpServer is created per request and closed when the request finishes:
 * no session state is kept between requests (`sessionIdGenerator: undefined`).
 * The shared `wiki` client (and optional RAG deps + sync hooks) are passed to
 * every per-request server.
 */
export function registerHttpTransport(
  app: FastifyInstance,
  wiki: WikiClient,
  rag?: RagToolsDeps,
  sync?: SyncService,
): void {
  app.post('/mcp', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer({ wiki, rag, sync });
    try {
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      logger.error({ err: error }, 'Streamable HTTP request failed');
      if (!reply.raw.headersSent) {
        // The reply was hijacked, so `reply.send()` is a no-op; write the 500
        // straight to the raw socket or the client would hang on the error.
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify({ error: 'internal_error' }));
      } else {
        reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });

  // Stateless servers do not offer a GET SSE stream: the spec allows 405 and the
  // MCP SDK client treats it as "stateless mode" (no reconnection loop).
  app.get('/mcp', async (_request, reply) => {
    reply.code(405).send({ error: 'method_not_allowed' });
  });
}
