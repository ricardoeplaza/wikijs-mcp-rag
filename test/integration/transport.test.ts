import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { EventSourceFetchInit } from 'eventsource';
import { createApp } from '../../src/main.js';
import type { Config } from '../../src/config.js';

const TOKEN = 'test-token';

/**
 * The `eventsource` package (v3, used by SSEClientTransport) does not accept
 * custom headers in EventSourceInit, so we wrap fetch to inject the bearer.
 */
function sseAuthFetch(authorization: string) {
  return (url: string | URL, init: EventSourceFetchInit): Promise<Response> =>
    fetch(url as string, { ...init, headers: { ...init.headers, authorization } });
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    wikijsBaseUrl: 'http://wikijs:3000',
    wikijsToken: 'wiki-token',
    wikijsInsecureTls: true,
    embeddingsBaseUrl: 'http://localhost:8071/v1',
    embeddingsApiKey: 'no-key',
    embeddingsModel: 'Qwen3-Embedding-0.6B',
    embeddingsDim: 1024,
    mcpToken: TOKEN,
    mcpAllowNoAuth: false,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    ragDbPath: ':memory:',
    syncPollIntervalMs: 300_000,
    nightlyResyncHour: 3,
    nightlyResyncEnabled: true,
    logLevel: 'error',
    chunkTargetTokens: 800,
    chunkOverlapTokens: 150,
    ragDefaultTopK: 5,
    ...overrides,
  };
}

interface RunningApp {
  app: FastifyInstance;
  baseUrl: string;
}

async function startApp(config: Config): Promise<RunningApp> {
  const app = createApp(config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

type CallToolOutcome = Awaited<ReturnType<Client['callTool']>>;

function pingText(result: CallToolOutcome): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected ping result shape: ${JSON.stringify(result)}`);
  }
  return first.text;
}

describe('MCP transport integration', () => {
  let running: RunningApp;
  const clients: Client[] = [];

  beforeAll(async () => {
    running = await startApp(testConfig());
  });

  afterAll(async () => {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
    await running.app.close();
  });

  it('GET /health responds { status: "ok" } without auth', async () => {
    const res = await fetch(`${running.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('POST /mcp without token -> 401', async () => {
    const res = await fetch(`${running.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp with wrong token -> 401', async () => {
    const res = await fetch(`${running.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}-wrong`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('Streamable HTTP client (POST /mcp) calls ping -> { pong: true }', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${running.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({ name: 'ping', arguments: {} }, CallToolResultSchema);
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(pingText(result)) as { pong: boolean; timestamp: string };
    expect(parsed.pong).toBe(true);
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('SSE client (GET /sse + POST /message) calls ping -> { pong: true }', async () => {
    const transport = new SSEClientTransport(new URL(`${running.baseUrl}/sse`), {
      eventSourceInit: { fetch: sseAuthFetch(`Bearer ${TOKEN}`) },
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'integration-test-sse', version: '0.0.0' });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({ name: 'ping', arguments: {} }, CallToolResultSchema);
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(pingText(result)) as { pong: boolean; timestamp: string };
    expect(parsed.pong).toBe(true);
  });

  it('GET /sse without token -> 401, and accepts ?token= fallback', async () => {
    const noAuth = await fetch(`${running.baseUrl}/sse`);
    expect(noAuth.status).toBe(401);
    await noAuth.body?.cancel();

    const withQueryToken = await fetch(`${running.baseUrl}/sse?token=${TOKEN}`, {
      signal: AbortSignal.timeout(500),
    });
    // The SSE stream stays open; abort it once headers arrive.
    expect(withQueryToken.status).toBe(200);
    expect(withQueryToken.headers.get('content-type')).toContain('text/event-stream');
    await withQueryToken.body?.cancel();
  });

  it('POST /message with unknown session -> 404', async () => {
    const res = await fetch(`${running.baseUrl}/message?sessionId=does-not-exist`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe('MCP auth disabled (MCP_ALLOW_NOAUTH=true)', () => {
  let running: RunningApp;
  let client: Client | undefined;

  beforeAll(async () => {
    running = await startApp(testConfig({ mcpToken: '', mcpAllowNoAuth: true }));
  });

  afterAll(async () => {
    if (client) await client.close().catch(() => undefined);
    await running.app.close();
  });

  it('POST /mcp works without any token', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${running.baseUrl}/mcp`));
    client = new Client({ name: 'noauth-test', version: '0.0.0' });
    await client.connect(transport);

    const result = await client.callTool({ name: 'ping', arguments: {} }, CallToolResultSchema);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(pingText(result)).pong).toBe(true);
  });
});
