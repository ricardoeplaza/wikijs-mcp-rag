import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger.js';
import { createMcpServer } from './mcp-server.js';

/**
 * POST /mcp — MCP Streamable HTTP transport, stateless (plan §10.1).
 *
 * A new McpServer is created per request and closed when the request finishes:
 * no session state is kept between requests (`sessionIdGenerator: undefined`).
 */
export function registerHttpTransport(app: FastifyInstance): void {
  app.post('/mcp', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer();
    try {
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      logger.error({ err: error }, 'Streamable HTTP request failed');
      if (!reply.raw.headersSent) {
        reply.code(500).send({ error: 'internal_error' });
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
