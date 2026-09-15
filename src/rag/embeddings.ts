/**
 * OpenAI-compatible embeddings client.
 *
 * Talks to a llama.cpp `/v1/embeddings` endpoint (OpenAI-compatible API):
 * `POST ${baseUrl}/embeddings` with body `{ model, input: string[] }`, reading
 * each vector from `response.data[i].embedding`.
 *
 * Guarantees:
 * - Batching: inputs are split into batches of `batchSize`; the final result is
 *   reassembled in the ORIGINAL order of the input array.
 * - Mutex: every HTTP request (including its retries) is serialized through an
 *   internal promise chain, so at most ONE request is in flight at a time — even
 *   across concurrent `embed()` calls and across batches within one call.
 * - Retry with exponential backoff on network errors, HTTP 5xx and 429.
 *   Other 4xx are fatal (no retry). When retries are exhausted an actionable
 *   Error is thrown.
 * - Dims integrity: when `dims` is set, any vector whose length differs from it
 *   causes an Error.
 */

export interface EmbeddingsClientOptions {
  /**
   * Base URL of the OpenAI-compatible server (e.g. `http://host:8071/v1`).
   * Optional: when empty/undefined, {@link EmbeddingsClient.embed} throws a clear
   * "not configured" error instead of performing any HTTP request.
   */
  baseUrl?: string;
  /** Model name sent in the request body. */
  model: string;
  /** Expected embedding dimensionality. When set, vectors of a different length are rejected. */
  dims?: number;
  /** Number of inputs per HTTP request (default 32). */
  batchSize?: number;
  /** Maximum number of retries after the initial attempt (default 4). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 500). */
  retryDelayMs?: number;
  /** Injectable fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
}

interface EmbeddingDataItem {
  index?: number;
  embedding: number[];
}

interface EmbeddingsApiResponse {
  data?: EmbeddingDataItem[];
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;

type AttemptOutcome =
  | { ok: true; payload: EmbeddingsApiResponse }
  | { ok: false; retryable: boolean; status?: number; reason: string };

export class EmbeddingsClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dims?: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Internal promise chain used to serialize all HTTP requests (mutex). */
  private _chain: Promise<void> = Promise.resolve();

  constructor(options: EmbeddingsClientOptions) {
    // `baseUrl` may be empty/undefined when no embeddings server is configured
    // (EMBEDDINGS_BASE_URL optional); `embed()` then short-circuits with a clear error.
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.model = options.model;
    this.dims = options.dims;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Embeds the given texts, returning one vector per input in the SAME order as
   * the input array. Returns `[]` for empty input.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.baseUrl) {
      throw new Error(
        'Embeddings server is not configured (EMBEDDINGS_BASE_URL is empty). ' +
          'The RAG tools require an OpenAI-compatible embeddings server to be reachable.',
      );
    }
    const results: number[][] = new Array<number[]>(texts.length);
    let offset = 0;
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.embedBatch(batch);
      for (let j = 0; j < vectors.length; j++) {
        const vector = vectors[j];
        if (vector !== undefined) results[offset + j] = vector;
      }
      offset += batch.length;
    }
    return results;
  }

  /** Runs a single batch through the mutex chain, so only one request is in flight at a time. */
  private embedBatch(batch: string[]): Promise<number[][]> {
    const task = this._chain.then(() => this.runWithRetry(batch));
    // Keep the chain itself always-resolved so a failed batch does not wedge later ones.
    this._chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Performs one batch with retries + exponential backoff. */
  private async runWithRetry(batch: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({ model: this.model, input: batch });

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        await this.delay(this.retryDelayMs * 2 ** (attempt - 1));
      }

      const outcome = await this.attemptOnce(url, body);

      if (outcome.ok) {
        return this.parseAndValidate(outcome.payload, batch.length);
      }

      if (!outcome.retryable) {
        throw new Error(
          `Embeddings request failed with HTTP ${outcome.status} (not retried). ` +
            'Verify EMBEDDINGS_BASE_URL and EMBEDDINGS_MODEL.',
        );
      }

      if (attempt >= this.maxRetries) {
        throw new Error(
          `Embeddings request failed after ${this.maxRetries + 1} attempts: ${outcome.reason}. ` +
            'The embeddings server may be down or the model not loaded.',
        );
      }
    }
  }

  /** Performs a single HTTP attempt, classifying the outcome for the retry loop. */
  private async attemptOnce(url: string, body: string): Promise<AttemptOutcome> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!response.ok) {
        const status = response.status;
        const retryable = status === 429 || (status >= 500 && status <= 599);
        return { ok: false, retryable, status, reason: `HTTP ${status}` };
      }

      const payload = (await response.json()) as EmbeddingsApiResponse;
      return { ok: true, payload };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, retryable: true, reason: `network error: ${reason}` };
    }
  }

  /** Reorders the response to match the input order and validates size/dims. */
  private parseAndValidate(payload: EmbeddingsApiResponse, expectedCount: number): number[][] {
    const items: EmbeddingDataItem[] = Array.isArray(payload?.data) ? payload.data : [];

    // Preserve the original input order. OpenAI-compatible servers may return items out of
    // order but tag each with its `index`; fall back to array position when absent.
    const ordered = items
      .map((item, position) => ({ item, position }))
      .sort((a, b) => (a.item.index ?? a.position) - (b.item.index ?? b.position))
      .map(({ item }) => item);

    const vectors: number[][] = [];
    for (const item of ordered) {
      const embedding = item?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('Embeddings response is malformed: an item has no numeric "embedding" array.');
      }
      vectors.push(embedding);
    }

    if (vectors.length !== expectedCount) {
      throw new Error(
        `Embeddings response integrity error: expected ${expectedCount} vectors but the server returned ${vectors.length}.`,
      );
    }

    if (this.dims !== undefined) {
      for (let i = 0; i < vectors.length; i++) {
        const vector = vectors[i];
        if (vector !== undefined && vector.length !== this.dims) {
          throw new Error(
            `Embeddings dimension mismatch: expected ${this.dims} dimensions but a vector of length ${vector.length} was returned (position ${i}).`,
          );
        }
      }
    }

    return vectors;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
