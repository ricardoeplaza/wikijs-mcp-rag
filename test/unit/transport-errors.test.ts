import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WikiClient } from '../../src/wiki/client.js';
import { registerHttpTransport } from '../../src/server/http-transport.js';
import { registerSseTransports } from '../../src/server/sse-transport.js';

/**
 * The hijacked-route error branches (POST /mcp, GET /sse) can only be reached
 * when the MCP transport fails AFTER `reply.hijack()`. We mock the SDK server
 * transports so `server.connect(transport)` (which awaits `transport.start()`)
 * throws, forcing the catch path. This file is isolated because `vi.mock` of the
 * SDK transport modules must not leak into the integration tests.
 */
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  class StreamableHTTPServerTransport {
    async start(): Promise<void> {
      throw new Error('streamable boom');
    }
    async handleRequest(): Promise<void> {}
    async close(): Promise<void> {}
  }
  return { StreamableHTTPServerTransport };
});

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => {
  class SSEServerTransport {
    sessionId = 'mock-sse-session';
    // No-arg constructor: the real signature is (endpoint, res); extra args are ignored.
    async start(): Promise<void> {
      throw new Error('sse boom');
    }
    async handlePostMessage(): Promise<void> {}
    async close(): Promise<void> {}
  }
  return { SSEServerTransport };
});

const wiki = {} as unknown as WikiClient;

describe('hijacked-route error branches (transport start throws)', () => {
  it('POST /mcp returns a raw 500 when the transport fails to connect', async () => {
    const app: FastifyInstance = Fastify();
    registerHttpTransport(app, wiki);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error' });
    } finally {
      await app.close();
    }
  });

  it('GET /sse returns a raw 500 when the transport fails to connect', async () => {
    const app: FastifyInstance = Fastify();
    registerSseTransports(app, wiki);
    try {
      const res = await app.inject({ method: 'GET', url: '/sse' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error' });
    } finally {
      await app.close();
    }
  });
});
