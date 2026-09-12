/**
 * SQLite + sqlite-vec storage for the RAG index.
 *
 * Single database file with a 3-table schema:
 * - `meta`:       key/value store of the active index parameters. The dims used to build
 *                 the vec0 table are persisted as `embedding_dims` (written once, on first
 *                 creation; never overwritten on reopen).
 * - `pages`:      one row per indexed Wiki.js page (metadata only; the markdown content
 *                 lives in Wiki.js and is never duplicated here).
 * - `chunks`:     REAL table holding each chunk's content (`chunk_id`, `page_id`,
 *                 `chunk_index`, `heading`, `content`), indexed by `page_id`.
 * - `chunks_vec`: vec0 VIRTUAL table holding one row per chunk vector
 *                 (`chunk_id INTEGER PRIMARY KEY, embedding FLOAT[dims]`). Linked to
 *                 `chunks` by `chunk_id`. It is NEVER indexed: sqlite-vec forbids indexes
 *                 on vec0 tables ("virtual tables may not be indexed").
 *
 * `chunk_id` alignment: the vector is inserted FIRST into `chunks_vec` leaving the rowid
 * auto-assigned; `info.lastInsertRowid` is then used as the explicit `chunk_id` when
 * inserting the content row into `chunks`. The auto-rowid path keeps the two tables
 * aligned without pre-computing ids and avoids relying on an explicit-rowid insert
 * into the vec0 table.
 *
 * Foreign keys are declared (`chunks.page_id REFERENCES pages(page_id) ON DELETE CASCADE`)
 * but NOT enforced: `PRAGMA foreign_keys` is left OFF (the better-sqlite3 default) because
 * an enforced cascade from `pages` could not reach the vec0 rows and would orphan vectors.
 * All chunk/vector cleanup is done explicitly in `replaceChunksForPage`/`purgePage`.
 *
 * The `sqlite-vec` extension is loaded per connection and MUST be loaded before the vec0
 * virtual table is created. On ESM/Windows the loadable path is resolved by the package
 * itself: `load(db)` → no manual path handling needed.
 *
 * Dims integrity: `checkIntegrity(expectedDims)` compares the configured dims against
 * `meta.embedding_dims` and throws an actionable error on mismatch — vector spaces must
 * never be mixed; the fix is to delete the DB file and reindex (`reindex_all`).
 *
 * Distances: sqlite-vec KNN uses L2 distance by default and vectors are stored as given
 * (no normalization in this layer). Callers that want cosine semantics should normalize
 * vectors before storing/querying.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

export interface RagDbOptions {
  /** SQLite file path. Omitted → in-memory database (`:memory:`). */
  file?: string;
  /** Embedding dimensionality; the vec0 table is created with `FLOAT[dims]`. */
  dims: number;
}

/** Page metadata to index (mirrors the `pages` table columns). */
export interface RagPage {
  page_id: number;
  path: string;
  title: string;
  updated_at?: string | null;
}

/** A chunk ready to be stored, with its embedding. */
export interface RagChunkInput {
  chunk_index: number;
  heading?: string | null;
  content: string;
  embedding: number[];
}

/** One KNN hit joined with its page metadata. */
export interface RagSearchHit {
  chunk_id: number;
  page_id: number;
  path: string;
  title: string;
  heading?: string | null;
  content: string;
  distance: number;
}

type SqliteDb = InstanceType<typeof Database>;
type Stmt = Database.Statement<unknown[], unknown>;

interface MetaRow {
  value: string;
}

interface KnnRow {
  chunk_id: number;
  distance: number;
}

interface ChunkRow {
  chunk_id: number;
  page_id: number;
  heading: string | null;
  content: string;
}

interface PageMetaRow {
  page_id: number;
  path: string;
  title: string;
}

interface IdRow {
  id: number;
}

const META_KEY_DIMS = 'embedding_dims';

export class RagDb {
  private readonly db: SqliteDb;
  private readonly dims: number;
  private readonly stmt: {
    upsertPage: Stmt;
    pageUpdatedAt: Stmt;
    pageContentHash: Stmt;
    pageIds: Stmt;
    chunkIdsByPage: Stmt;
    deleteVecRow: Stmt;
    deleteChunksByPage: Stmt;
    deletePage: Stmt;
    insertVec: Stmt;
    insertChunk: Stmt;
    knn: Stmt;
  };

  constructor(options: RagDbOptions) {
    if (!Number.isInteger(options.dims) || options.dims < 1) {
      throw new Error(`RagDb: dims must be a positive integer, got ${options.dims}.`);
    }
    this.dims = options.dims;

    const file = options.file ?? ':memory:';
    if (file !== ':memory:') {
      // Ensure the parent directory exists (e.g. ./data/rag.db). No-op for bare
      // filenames and for Docker, where /data is a pre-mounted volume.
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new Database(file);
    // The extension must be loaded before the vec0 virtual table is created.
    loadSqliteVec(this.db);

    this.createSchema();
    this.stmt = {
      upsertPage: this.db.prepare(
        'INSERT OR REPLACE INTO pages (page_id, path, title, content_hash, updated_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      pageUpdatedAt: this.db.prepare('SELECT updated_at FROM pages WHERE page_id = ?'),
      pageContentHash: this.db.prepare('SELECT content_hash FROM pages WHERE page_id = ?'),
      pageIds: this.db.prepare('SELECT page_id FROM pages ORDER BY page_id'),
      chunkIdsByPage: this.db.prepare('SELECT chunk_id AS id FROM chunks WHERE page_id = ?'),
      deleteVecRow: this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?'),
      deleteChunksByPage: this.db.prepare('DELETE FROM chunks WHERE page_id = ?'),
      deletePage: this.db.prepare('DELETE FROM pages WHERE page_id = ?'),
      insertVec: this.db.prepare('INSERT INTO chunks_vec (embedding) VALUES (?)'),
      insertChunk: this.db.prepare(
        'INSERT INTO chunks (chunk_id, page_id, chunk_index, heading, content) VALUES (?, ?, ?, ?, ?)',
      ),
      knn: this.db.prepare(
        'SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      ),
    };

    this.storeDimsIfAbsent();
  }

  /** Creates the schema. The vec0 DDL is generated with the constructor `dims`. */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pages (
        page_id      INTEGER PRIMARY KEY,
        path         TEXT    NOT NULL UNIQUE,
        title        TEXT    NOT NULL,
        content_hash TEXT,
        updated_at   TEXT    NOT NULL,
        indexed_at   TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        heading     TEXT,
        content     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${this.dims}]
      );
    `);
  }

  /** Persists the active dims on first creation only (never overwrites on reopen). */
  private storeDimsIfAbsent(): void {
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run(META_KEY_DIMS, String(this.dims));
  }

  private metaValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as MetaRow | undefined;
    return row === undefined ? null : row.value;
  }

  /** Dims recorded when the index was created, or `null` if `meta` has no record. */
  getStoredDims(): number | null {
    const raw = this.metaValue(META_KEY_DIMS);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

  /**
   * Throws an actionable error when the stored dims differ from `expectedDims` (or no
   * record exists). Call this at startup: on mismatch the process must not run — delete
   * the DB file and reindex, or restore the previous model/dims.
   */
  checkIntegrity(expectedDims: number): void {
    const stored = this.getStoredDims();
    if (stored === null) {
      throw new Error(
        'RAG DB integrity check failed: no embedding_dims recorded in meta. ' +
          'The index is unusable; delete the RAG database file and reindex.',
      );
    }
    if (stored !== expectedDims) {
      throw new Error(
        `RAG DB dimension mismatch: the index was built with ${stored} dimensions but the configured model uses ${expectedDims}. ` +
          'Mixing vector spaces would corrupt search results. Delete the RAG database file and reindex (reindex_all), ' +
          'or restore the previous EMBEDDINGS_DIM/EMBEDDINGS_MODEL.',
      );
    }
  }

  /** Inserts or replaces the page row. `indexed_at` is always set to now (ISO). */
  upsertPage(page: RagPage, contentHash?: string | null): void {
    const now = new Date().toISOString();
    this.stmt.upsertPage.run(
      page.page_id,
      page.path,
      page.title,
      contentHash ?? null,
      page.updated_at ?? now,
      now,
    );
  }

  /** `pages.updated_at` for the given page, or `null` if not indexed. */
  getPageUpdatedAt(pageId: number): string | null {
    const row = this.stmt.pageUpdatedAt.get(pageId) as { updated_at: string } | undefined;
    return row === undefined ? null : row.updated_at;
  }

  /** `pages.content_hash` for the given page, or `null` if absent/unknown. */
  getPageContentHash(pageId: number): string | null {
    const row = this.stmt.pageContentHash.get(pageId) as { content_hash: string | null } | undefined;
    return row === undefined ? null : (row.content_hash ?? null);
  }

  /** Ids of all indexed pages, ascending. */
  listIndexedPageIds(): number[] {
    const rows = this.stmt.pageIds.all() as { page_id: number }[];
    return rows.map((row) => row.page_id);
  }

  /** Alias of {@link listIndexedPageIds} (used by the poller/resync). */
  listAllPageIds(): number[] {
    return this.listIndexedPageIds();
  }

  /**
   * Replaces all chunks of a page in a single transaction: deletes the old rows
   * (vectors + content) and inserts the new ones. Returns the number of chunks inserted.
   */
  replaceChunksForPage(pageId: number, chunks: RagChunkInput[]): number {
    for (const chunk of chunks) {
      if (chunk.embedding.length !== this.dims) {
        throw new Error(
          `RagDb.replaceChunksForPage: chunk ${chunk.chunk_index} has ${chunk.embedding.length} dimensions ` +
            `but the index was created with ${this.dims}. Reindex with a consistent model.`,
        );
      }
    }

    const runAll = this.db.transaction((items: RagChunkInput[]) => {
      // Delete old vectors first (vec0 rows are keyed by chunk_id), then the content.
      const oldIds = this.stmt.chunkIdsByPage.all(pageId) as IdRow[];
      for (const row of oldIds) {
        this.stmt.deleteVecRow.run(row.id);
      }
      this.stmt.deleteChunksByPage.run(pageId);

      // Insert each new chunk: vector first (auto rowid), then content with that id.
      for (const chunk of items) {
        const vecInfo = this.stmt.insertVec.run(this.toBlob(chunk.embedding));
        const chunkId = Number(vecInfo.lastInsertRowid);
        this.stmt.insertChunk.run(chunkId, pageId, chunk.chunk_index, chunk.heading ?? null, chunk.content);
      }
    });

    runAll(chunks);
    return chunks.length;
  }

  /** Deletes the page row and all its chunks/vectors in a single transaction. */
  purgePage(pageId: number): void {
    const run = this.db.transaction(() => {
      const oldIds = this.stmt.chunkIdsByPage.all(pageId) as IdRow[];
      for (const row of oldIds) {
        this.stmt.deleteVecRow.run(row.id);
      }
      this.stmt.deleteChunksByPage.run(pageId);
      this.stmt.deletePage.run(pageId);
    });
    run();
  }

  /**
   * KNN search over `chunks_vec`: `WHERE embedding MATCH ? AND k = ?`, joined with
   * `chunks` and `pages` to return content and metadata. Results are ordered by
   * ascending L2 distance.
   */
  searchByVector(embedding: number[], limit: number): RagSearchHit[] {
    if (embedding.length !== this.dims) {
      throw new Error(
        `RagDb.searchByVector: the query embedding has ${embedding.length} dimensions but the index was created with ${this.dims}.`,
      );
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`RagDb.searchByVector: limit must be a positive integer, got ${limit}.`);
    }

    const knnRows = this.stmt.knn.all(this.toBlob(embedding), limit) as KnnRow[];
    if (knnRows.length === 0) return [];

    const chunkIds = knnRows.map((row) => row.chunk_id);
    const chunkPlaceholders = chunkIds.map(() => '?').join(', ');
    const chunkRows = this.db
      .prepare(`SELECT chunk_id, page_id, heading, content FROM chunks WHERE chunk_id IN (${chunkPlaceholders})`)
      .all(...chunkIds) as ChunkRow[];

    const pageIds = [...new Set(chunkRows.map((row) => row.page_id))];
    if (pageIds.length === 0) return [];
    const pagePlaceholders = pageIds.map(() => '?').join(', ');
    const pageRows = this.db
      .prepare(`SELECT page_id, path, title FROM pages WHERE page_id IN (${pagePlaceholders})`)
      .all(...pageIds) as PageMetaRow[];

    const chunksById = new Map<number, ChunkRow>(chunkRows.map((row): [number, ChunkRow] => [row.chunk_id, row]));
    const pagesById = new Map<number, PageMetaRow>(pageRows.map((row): [number, PageMetaRow] => [row.page_id, row]));

    const hits: RagSearchHit[] = [];
    for (const row of knnRows) {
      const chunk = chunksById.get(row.chunk_id);
      if (chunk === undefined) continue; // orphaned vector (defensive; cleanup keeps both in sync)
      const page = pagesById.get(chunk.page_id);
      if (page === undefined) continue; // orphaned content (defensive)
      hits.push({
        chunk_id: row.chunk_id,
        page_id: chunk.page_id,
        path: page.path,
        title: page.title,
        heading: chunk.heading ?? null,
        content: chunk.content,
        distance: row.distance,
      });
    }
    return hits;
  }

  /** Total number of chunks stored across all pages. */
  countChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return Number(row.n);
  }

  /** The most recent `indexed_at` across all pages, or `null` when no page is indexed. */
  lastIndexedAt(): string | null {
    const row = this.db.prepare('SELECT MAX(indexed_at) AS latest FROM pages').get() as { latest: string | null };
    return row.latest === null ? null : row.latest;
  }

  /** Closes the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }

  /** Encodes a vector as the little-endian float32 BLOB expected by sqlite-vec. */
  private toBlob(vector: number[]): Uint8Array {
    const f32 = new Float32Array(vector);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }
}
