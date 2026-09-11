/**
 * RAG querier (Etapa 7a).
 *
 * Hybrid semantic + lexical search over a {@link RagDb}:
 *   query → `embeddings.embed([query])` → `db.searchByVector(qvec, max(limit*3, 10))`
 *   → per-candidate rerank → top-`limit` by descending score.
 *
 * Per candidate:
 *   vecSim  = 1 / (1 + distance)            (distance is the L2 from sqlite-vec)
 *   lexical = |queryTerms ∩ contentTerms| / max(1, |queryTerms|)
 *   score   = alpha * vecSim + (1 - alpha) * lexical
 *
 * `alpha` (default 0.7) is the weight of the vectorial component; the rest goes to the
 * lexical one. Tokenization: lowercase, split on non-alphanumerics, drop tokens shorter
 * than 3 chars and trivial stopwords.
 */

import type { RagDb } from './db.js';
import type { EmbeddingsClient } from './embeddings.js';

/** One reranked search hit returned to the caller. */
export interface SearchResult {
  chunk_id: number;
  page_id: number;
  path: string;
  title: string;
  heading?: string | null;
  content: string;
  /** Hybrid score in [0, 1]; higher is better. */
  score: number;
  /** Raw L2 distance from the vector KNN (kept for transparency/debugging). */
  distance: number;
}

export interface SearchOptions {
  /** Maximum number of results to return (default 5). */
  limit?: number;
}

export interface IndexStatus {
  pages: number;
  chunks: number;
  dims: number | null;
  lastIndexedAt?: string | null;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_ALPHA = 0.7;
const MIN_TOKEN_LENGTH = 3;

/** Trivial function words (es + en) ignored during tokenization. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'were', 'with',
  'con', 'una', 'uno', 'los', 'las', 'del', 'por', 'que', 'sus', 'mas', 'como', 'this',
]);

/** Lowercases, splits on non-alphanumerics and keeps tokens ≥ MIN_TOKEN_LENGTH minus stopwords. */
function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  const parts = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const part of parts) {
    if (part.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(part)) continue;
    terms.add(part);
  }
  return terms;
}

/** |queryTerms ∩ contentTerms| / max(1, |queryTerms|). */
function lexicalOverlap(queryTerms: Set<string>, contentTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) overlap += 1;
  }
  return overlap / Math.max(1, queryTerms.size);
}

export class Querier {
  private readonly db: RagDb;
  private readonly embeddings: EmbeddingsClient;
  private readonly alpha: number;

  constructor(options: { db: RagDb; embeddings: EmbeddingsClient; alpha?: number }) {
    this.db = options.db;
    this.embeddings = options.embeddings;
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
  }

  /**
   * Embeds `query`, retrieves the KNN candidates and reranks them with the hybrid
   * score. Returns the top `limit` hits by descending score. Empty query or no
   * candidates → `[]`.
   */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    if (query.trim().length === 0) return [];

    const [qvec] = await this.embeddings.embed([query]);
    if (qvec === undefined) return [];

    const candidates = this.db.searchByVector(qvec, Math.max(limit * 3, 10));
    if (candidates.length === 0) return [];

    const queryTerms = tokenize(query);
    const results: SearchResult[] = [];
    for (const hit of candidates) {
      const vecSim = 1 / (1 + hit.distance);
      const lexical = lexicalOverlap(queryTerms, tokenize(hit.content));
      results.push({
        chunk_id: hit.chunk_id,
        page_id: hit.page_id,
        path: hit.path,
        title: hit.title,
        heading: hit.heading,
        content: hit.content,
        score: this.alpha * vecSim + (1 - this.alpha) * lexical,
        distance: hit.distance,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Snapshot of the index size/health for observability and the `reindex_all` tool. */
  async indexStatus(): Promise<IndexStatus> {
    const pages = this.db.listIndexedPageIds().length;
    const chunks = this.db.countChunks();
    const dims = this.db.getStoredDims();
    const lastIndexedAt = this.db.lastIndexedAt() ?? null;
    return { pages, chunks, dims, lastIndexedAt };
  }
}
