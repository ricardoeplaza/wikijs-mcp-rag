import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Bearer-token middleware for the MCP endpoints.
 *
 * - MCP_TOKEN set: `Authorization: Bearer <token>` is required on /mcp, /sse and
 *   /message. On GET /sse the token may also be passed as `?token=` (fallback for
 *   EventSource clients that cannot set headers).
 * - MCP_TOKEN empty + MCP_ALLOW_NOAUTH=true: auth is skipped (dev mode). The loud
 *   warning is already emitted by loadConfig(); we log once more here, at most.
 */
export function createAuthMiddleware(config: Pick<Config, 'mcpToken' | 'mcpAllowNoAuth'>) {
  let noAuthWarned = false;

  return async function auth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mcpToken === '') {
      if (!noAuthWarned) {
        noAuthWarned = true;
        logger.warn(
          '!!! MCP auth DISABLED (MCP_TOKEN empty + MCP_ALLOW_NOAUTH=true): requests accepted without a bearer token. Development only. !!!',
        );
      }
      return;
    }

    const provided = extractToken(request);
    if (provided === undefined || !tokenMatches(provided, config.mcpToken)) {
      reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
  };
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // Fallback only for the SSE endpoint: EventSource cannot send custom headers.
  if (request.url.startsWith('/sse')) {
    const query = new URL(request.url, 'http://localhost').searchParams.get('token');
    if (query !== null) return query;
  }
  return undefined;
}

function tokenMatches(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
