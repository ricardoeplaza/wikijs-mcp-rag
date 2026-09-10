import { describe, expect, it } from 'vitest';
import { EmbeddingsClient, type EmbeddingsClientOptions } from '../../src/rag/embeddings.js';

interface MockState {
  calls: number;
  inFlight: number;
  maxInFlight: number;
}

interface MockBehavior {
  /** Length of each returned embedding vector (default 4). */
  vectorLen?: number;
  /** HTTP status to return for the given 1-based call number (default 200). */
  statusForCall?: (callNo: number) => number;
}

/**
 * Injectable fetch mock (no real network). Records call count and the maximum
 * number of concurrent in-flight requests, so the mutex can be asserted. Each
 * returned embedding encodes `(callNo*100 + i*10 + j)` so positional order is
 * observable in the result.
 */
function createMockFetch(behavior: MockBehavior = {}) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;

    // Yield so that, WITHOUT the mutex, concurrent calls would overlap.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

    const callNo = calls;
    const status = behavior.statusForCall ? behavior.statusForCall(callNo) : 200;

    let payload: unknown;
    if (status === 200) {
      const body = JSON.parse((init?.body as string | undefined) ?? '{}') as { input?: string[] };
      const count = Array.isArray(body.input) ? body.input.length : 0;
      const len = behavior.vectorLen ?? 4;
      payload = {
        data: Array.from({ length: count }, (_, i) => ({
          index: i,
          embedding: Array.from({ length: len }, (_, j) => callNo * 100 + i * 10 + j),
        })),
      };
    } else {
      payload = { error: `simulated ${status}` };
    }

    inFlight -= 1;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const state = (): MockState => ({ calls, inFlight, maxInFlight });
  return { fetchImpl, state };
}

function makeClient(
  mock: ReturnType<typeof createMockFetch>,
  overrides: Partial<EmbeddingsClientOptions> = {},
): EmbeddingsClient {
  return new EmbeddingsClient({
    baseUrl: 'http://localhost:8071/v1',
    model: 'Qwen3-Embedding-0.6B',
    retryDelayMs: 0,
    fetchImpl: mock.fetchImpl,
    ...overrides,
  });
}

describe('EmbeddingsClient (Etapa 5b)', () => {
  it('returns one vector per input in the original order for a single batch', async () => {
    const mock = createMockFetch({ vectorLen: 4 });
    const client = makeClient(mock, { dims: 4 });

    const result = await client.embed(['alpha', 'beta', 'gamma']);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([100, 101, 102, 103]);
    expect(result[1]).toEqual([110, 111, 112, 113]);
    expect(result[2]).toEqual([120, 121, 122, 123]);
    for (const vector of result) {
      expect(vector).toHaveLength(4); // dims respected
    }
  });

  it('splits inputs into batches and reassembles the full ordered result', async () => {
    const mock = createMockFetch({ vectorLen: 4 });
    const client = makeClient(mock, { batchSize: 2 });

    const result = await client.embed(['a', 'b', 'c', 'd', 'e']);

    expect(result).toHaveLength(5);
    expect(mock.state().calls).toBe(3); // batches of 2 + 2 + 1
    expect(result[0]).toEqual([100, 101, 102, 103]);
    expect(result[1]).toEqual([110, 111, 112, 113]);
    expect(result[2]).toEqual([200, 201, 202, 203]);
    expect(result[3]).toEqual([210, 211, 212, 213]);
    expect(result[4]).toEqual([300, 301, 302, 303]);
  });

  it('serializes all HTTP requests through the mutex (max one in flight)', async () => {
    const mock = createMockFetch({ vectorLen: 2 });
    const client = makeClient(mock);

    await Promise.all([client.embed(['a', 'b']), client.embed(['c', 'd'])]);

    expect(mock.state().calls).toBe(2); // one batch per call, serialized
    expect(mock.state().maxInFlight).toBe(1);
  });

  it('retries on 5xx and resolves once the server recovers', async () => {
    const mock = createMockFetch({
      vectorLen: 2,
      statusForCall: (n) => (n <= 2 ? 500 : 200),
    });
    const client = makeClient(mock);

    const result = await client.embed(['a', 'b']);

    expect(result).toHaveLength(2);
    expect(mock.state().calls).toBe(3); // 2 failures + 1 success
  });

  it('throws an actionable error after exhausting retries (always 500)', async () => {
    const mock = createMockFetch({ vectorLen: 2, statusForCall: () => 500 });
    const client = makeClient(mock, { maxRetries: 4 });

    await expect(client.embed(['a'])).rejects.toThrow(/failed after 5 attempts/);
    expect(mock.state().calls).toBe(5); // initial + 4 retries
  });

  it('does not retry on 4xx (fails fast)', async () => {
    const mock = createMockFetch({ vectorLen: 2, statusForCall: () => 400 });
    const client = makeClient(mock);

    await expect(client.embed(['a'])).rejects.toThrow(/HTTP 400/);
    expect(mock.state().calls).toBe(1);
  });

  it('throws when a returned vector length does not match dims', async () => {
    const mock = createMockFetch({ vectorLen: 2 }); // server returns 2-dim vectors
    const client = makeClient(mock, { dims: 4 }); // but we expect 4

    await expect(client.embed(['a', 'b'])).rejects.toThrow(/dimension mismatch/);
  });
});
