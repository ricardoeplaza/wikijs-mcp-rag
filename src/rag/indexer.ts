/**
 * RAG indexer (Etapa 6b).
 *
 * Orchestrates the indexing pipeline over a {@link RagDb}:
 *   page content → `chunkMarkdown` → ONE batched `embeddings.embed()` call →
 *   `db.upsertPage` + `db.replaceChunksForPage`.
 *
 * Responsibilities:
 * - `indexPage`: chunk + embed + store a single page. Empty content is legal and
 *   indexes the page row with 0 chunks (any stale chunks are dropped).
 * - `reindexPage`: fetch metadata (`wiki.getPage`) and content
 *   (`wiki.getPageContent`) for one id and index it. Requires a `WikiClient`.
 * - `purgePage`: delegate to `db.purgePage` (page row + chunks + vectors).
 * - `reindexAll`: walk `wiki.listAllPages()` and reindex every page, isolating
 *   per-page errors in the result (one failure never stops the rest). Pages whose
 *   stored `content_hash` already matches the current content are skipped (not an
 *   error, not counted as indexed).
 *
 * Content hashing: sha256 hex of the raw markdown (`node:crypto`), stored via
 * `upsertPage(page, hash)` so incremental runs can skip unchanged pages.
 */

import { createHash } from 'node:crypto';
import type { WikiClient } from '../wiki/client.js';
import { chunkMarkdown, type ChunkOptions } from './chunker.js';
import type { RagChunkInput, RagDb, RagPage } from './db.js';
import type { EmbeddingsClient } from './embeddings.js';

/** A page ready to be indexed (metadata + raw markdown content). */
export interface IndexerPage {
  id: number;
  path: string;
  title: string;
  content: string;
  updatedAt?: string | null;
}

/** Result of indexing a single page. `skipped` is reserved for callers that short-circuit. */
export interface IndexResult {
  chunks: number;
  skipped?: boolean;
}

/** One failed page in a {@link ReindexAllResult}. */
export interface ReindexAllError {
  id: number;
  error: string;
}

/** Aggregated result of a full-corpus reindex. */
export interface ReindexAllResult {
  /** Pages for which chunks were (re)written during this run. */
  indexed: number;
  /** Total chunks written across all indexed pages. */
  chunks: number;
  /** Per-page failures; never aborts the run. */
  errors: ReindexAllError[];
}

export interface IndexerOptions {
  db: RagDb;
  embeddings: EmbeddingsClient;
  /** Required for `reindexPage`/`reindexAll`; optional so `indexPage` works standalone. */
  wiki?: WikiClient;
  chunkOptions?: ChunkOptions;
}

/** sha256 hex digest of a UTF-8 string (content hash for skip-if-unchanged). */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class Indexer {
  private readonly db: RagDb;
  private readonly embeddings: EmbeddingsClient;
  private readonly wiki?: WikiClient;
  private readonly chunkOptions?: ChunkOptions;

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.embeddings = options.embeddings;
    this.wiki = options.wiki;
    this.chunkOptions = options.chunkOptions;
  }

  /**
   * Chunks `page.content`, embeds ALL chunk texts in a single batched call and
   * stores the page row + chunks/vectors. Empty content → page row with 0 chunks
   * (stale chunks dropped) and `{ chunks: 0 }`.
   */
  async indexPage(page: IndexerPage): Promise<IndexResult> {
    const contentHash = sha256Hex(page.content);
    const chunks = chunkMarkdown(page.content, this.chunkOptions);

    if (chunks.length === 0) {
      this.db.upsertPage(this.toRagPage(page), contentHash);
      // Drop any stale chunks/vectors left over from a previous non-empty version.
      this.db.replaceChunksForPage(page.id, []);
      return { chunks: 0 };
    }

    const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.text));
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Indexer.indexPage: expected ${chunks.length} embeddings but the client returned ${vectors.length}.`,
      );
    }

    const inputs: RagChunkInput[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = vectors[i];
      if (chunk === undefined || embedding === undefined) {
        throw new Error(`Indexer.indexPage: embeddings result is misaligned at position ${i}.`);
      }
      inputs.push({ chunk_index: i, heading: chunk.heading ?? null, content: chunk.text, embedding });
    }

    this.db.upsertPage(this.toRagPage(page), contentHash);
    this.db.replaceChunksForPage(page.id, inputs);
    return { chunks: chunks.length };
  }

  /**
   * Fetches metadata + content of one page from the wiki and indexes it.
   * Throws when no `WikiClient` was provided.
   */
  async reindexPage(id: number): Promise<IndexResult> {
    const wiki = this.requireWiki('reindexPage');
    const [meta, content] = await Promise.all([wiki.getPage(id), wiki.getPageContent(id)]);
    return this.indexPage({
      id,
      path: meta.path,
      title: meta.title,
      content: content.content,
      updatedAt: meta.updatedAt,
    });
  }

  /** Removes the page row and all its chunks/vectors from the index. */
  purgePage(id: number): void {
    this.db.purgePage(id);
  }

  /**
   * Reindexes the whole corpus from `wiki.listAllPages()`. A per-page failure is
   * recorded in `errors` and never aborts the run. A page whose stored
   * `content_hash` already matches the current content is skipped (not counted as
   * indexed, not an error).
   */
  async reindexAll(): Promise<ReindexAllResult> {
    const wiki = this.requireWiki('reindexAll');
    const pages = await wiki.listAllPages();

    let indexed = 0;
    let chunks = 0;
    const errors: ReindexAllError[] = [];

    for (const page of pages) {
      try {
        const content = await wiki.getPageContent(page.id);
        if (this.db.getPageContentHash(page.id) === sha256Hex(content.content)) {
          continue; // unchanged since the last index: nothing to do
        }
        const result = await this.indexPage({
          id: page.id,
          path: page.path,
          title: page.title,
          content: content.content,
          updatedAt: page.updatedAt,
        });
        indexed += 1;
        chunks += result.chunks;
      } catch (err) {
        errors.push({ id: page.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { indexed, chunks, errors };
  }

  private requireWiki(operation: string): WikiClient {
    const wiki = this.wiki;
    if (wiki === undefined) {
      throw new Error(`Indexer.${operation}: no WikiClient configured; pass \`wiki\` in the constructor.`);
    }
    return wiki;
  }

  private toRagPage(page: IndexerPage): RagPage {
    return { page_id: page.id, path: page.path, title: page.title, updated_at: page.updatedAt ?? null };
  }
}
