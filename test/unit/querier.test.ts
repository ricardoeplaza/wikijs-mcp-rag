import { describe, expect, it, vi } from 'vitest';
import type { RagDb, RagSearchHit } from '../../src/rag/db.js';
import type { EmbeddingsClient } from '../../src/rag/embeddings.js';
import { Querier } from '../../src/rag/querier.js';

const QVEC = [0.1, 0.2, 0.3, 0.4];

function makeEmbeddings(): { embeddings: EmbeddingsClient; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn().mockResolvedValue([QVEC]);
  const embeddings = { embed } as unknown as EmbeddingsClient;
  return { embeddings, embed };
}

interface DbMockOptions {
  candidates: RagSearchHit[];
  pages?: number[];
  chunks?: number;
  dims?: number | null;
  lastIndexedAt?: string | null;
}

function makeDb(options: DbMockOptions): { db: RagDb; searchByVector: ReturnType<typeof vi.fn> } {
  const searchByVector = vi.fn().mockReturnValue(options.candidates);
  const listIndexedPageIds = vi.fn().mockReturnValue(options.pages ?? []);
  const countChunks = vi.fn().mockReturnValue(options.chunks ?? 0);
  const getStoredDims = vi.fn().mockReturnValue(options.dims ?? null);
  const lastIndexedAt = vi.fn().mockReturnValue(options.lastIndexedAt ?? null);
  const db = { searchByVector, listIndexedPageIds, countChunks, getStoredDims, lastIndexedAt } as unknown as RagDb;
  return { db, searchByVector };
}

function hit(chunkId: number, distance: number, content: string): RagSearchHit {
  return {
    chunk_id: chunkId,
    page_id: 100 + chunkId,
    path: `/p${chunkId}`,
    title: `Title ${chunkId}`,
    heading: null,
    content,
    distance,
  };
}

describe('Querier (hybrid semantic + lexical search)', () => {
  it('search returns the top-`limit` candidates ordered by descending hybrid score', async () => {
    const query = 'alpha beta gamma';
    const candidates: RagSearchHit[] = [
      hit(1, 0.5, 'alpha beta gamma delta'), // lex 3/3, vecSim 1/1.5 → 0.767
      hit(2, 1.0, 'alpha beta zeta eta'), // lex 2/3, vecSim 1/2 → 0.55
      hit(3, 0.2, 'theta iota kappa lambda'), // lex 0, vecSim 1/1.2 → 0.583
      hit(4, 2.0, 'mu nu xi omicron'), // lex 0, vecSim 1/3 → 0.233
      hit(5, 3.0, 'pi rho sigma tau'), // lex 0, vecSim 1/4 → 0.175
      hit(6, 4.0, 'upsilon phi chi psi'), // lex 0, vecSim 1/5 → 0.14
    ];
    const { db, searchByVector } = makeDb({ candidates });
    const { embeddings, embed } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const results = await querier.search(query, { limit: 3 });

    expect(embed).toHaveBeenCalledWith([query]);
    // candidate pool is max(limit*3, 10) = 10
    expect(searchByVector).toHaveBeenCalledWith(QVEC, 10);
    expect(results).toHaveLength(3);
    // Hybrid order (by score) differs from pure distance order: [1, 3, 2], not [3, 1, 2].
    expect(results.map((r) => r.chunk_id)).toEqual([1, 3, 2]);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.score).toBeLessThanOrEqual(prev.score);
    }
  });

  it('hybrid rerank: small distance + high lexical overlap beats large distance + no overlap', async () => {
    const query = 'database configuration guide';
    const nearMatch = hit(1, 0.1, 'This is the database configuration guide for sqlite');
    const farNoMatch = hit(2, 5.0, 'completely unrelated text about cooking recipes');
    // Feed the far one first to prove the rerank reorders by score, not input order.
    const { db } = makeDb({ candidates: [farNoMatch, nearMatch] });
    const { embeddings } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const results = await querier.search(query);

    expect(results.map((r) => r.chunk_id)).toEqual([1, 2]);
    const near = results[0];
    const far = results[1];
    if (near === undefined || far === undefined) throw new Error('expected two results');
    // near: vecSim=1/1.1≈0.909, lex=1 → score≈0.7*0.909+0.3*1 = 0.936
    expect(near.score).toBeGreaterThan(0.9);
    // far: vecSim=1/6≈0.167, lex=0 → score≈0.7*0.167 = 0.117
    expect(far.score).toBeLessThan(0.2);
  });

  it('search with an empty query returns [] and never calls the db or embeddings', async () => {
    const { db, searchByVector } = makeDb({ candidates: [hit(1, 0.5, 'x')] });
    const { embeddings, embed } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const results = await querier.search('   ');

    expect(results).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(searchByVector).not.toHaveBeenCalled();
  });

  it('search with no candidates returns []', async () => {
    const { db } = makeDb({ candidates: [] });
    const { embeddings, embed } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const results = await querier.search('anything at all');

    expect(results).toEqual([]);
    expect(embed).toHaveBeenCalledWith(['anything at all']);
  });

  it('indexStatus returns pages/chunks/dims/lastIndexedAt from the db', async () => {
    const { db } = makeDb({
      candidates: [],
      pages: [1, 2, 3],
      chunks: 7,
      dims: 1024,
      lastIndexedAt: '2026-01-02T00:00:00.000Z',
    });
    const { embeddings } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const status = await querier.indexStatus();

    expect(status).toEqual({ pages: 3, chunks: 7, dims: 1024, lastIndexedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('indexStatus reflects an empty index (no pages/chunks/dims/lastIndexedAt)', async () => {
    const { db } = makeDb({ candidates: [] });
    const { embeddings } = makeEmbeddings();
    const querier = new Querier({ db, embeddings });

    const status = await querier.indexStatus();

    expect(status).toEqual({ pages: 0, chunks: 0, dims: null, lastIndexedAt: null });
  });
});
