import type { FastifyInstance } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { logger } from '../logger.js';
import type { SyncService } from '../rag/sync.js';
import type { WikiClient } from '../wiki/client.js';
import { createMcpServer } from './mcp-server.js';
import type { RagToolsDeps } from '../tools/rag.js';

/**
 * GET /sse + POST /message?sessionId=... — legacy MCP SSE transport (plan §10.2/§10.3).
 *
 * One McpServer per SSE connection, kept in an in-memory map keyed by the
 * transport session id. Entries are removed when the SSE connection closes.
 * The shared `wiki` client (and optional RAG deps + sync hooks) are passed to
 * every per-session server.
 */
export function registerSseTransports(
  app: FastifyInstance,
  wiki: WikiClient,
  rag?: RagToolsDeps,
  sync?: SyncService,
): void {
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (request, reply) => {
    const transport = new SSEServerTransport('/message', reply.raw);
    const server = createMcpServer({ wiki, rag, sync });
    try {
      reply.hijack();
      // server.connect() calls transport.start(), which opens the SSE stream.
      await server.connect(transport);
      transports.set(transport.sessionId, transport);
      reply.raw.on('close', () => {
        transports.delete(transport.sessionId);
        void server.close().catch(() => undefined);
      });
    } catch (error) {
      logger.error({ err: error }, 'SSE connection failed');
      transports.delete(transport.sessionId);
      if (!reply.raw.headersSent) {
        // The reply was hijacked, so `reply.send()` is a no-op; write the 500
        // straight to the raw socket or the client would hang on the error.
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify({ error: 'internal_error' }));
      } else {
        reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  app.post('/message', async (request, reply) => {
    const sessionId = (request.query as Record<string, unknown> | undefined)?.sessionId;
    const transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!transport) {
      reply.code(404).send({ error: 'session_not_found' });
      return;
    }
    try {
      await transport.handlePostMessage(request.raw, reply.raw, request.body);
    } catch (error) {
      logger.error({ err: error }, 'SSE message handling failed');
      if (!reply.raw.headersSent) {
        reply.code(500).send({ error: 'internal_error' });
      } else {
        reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
