import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { RagDb } from '../../src/rag/db.js';

const DIMS = 4;

const tempDirs: string[] = [];

function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'rag.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      // Best effort: on Windows a file-backed DB can still be locked briefly.
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore EPERM; the temp dir is harmless and OS-cleaned eventually
    }
  }
});

describe('RagDb (Etapa 6a, SQLite + sqlite-vec storage)', () => {
  it('creates the §7 schema (meta, pages, chunks + idx_chunks_page, chunks_vec vec0) without indexing the vec0 table', () => {
    // Single controlled file-backed case: a raw reopen is needed to inspect sqlite_master.
    const file = makeTempFile();
    const db = new RagDb({ file, dims: DIMS });
    db.upsertPage({ page_id: 1, path: '/a', title: 'A' });
    db.replaceChunksForPage(1, [{ chunk_index: 0, content: 'body', embedding: [1, 0, 0, 0] }]);
    expect(db.getStoredDims()).toBe(DIMS);
    db.close(); // close BEFORE any file removal (Windows locking)

    const raw = new Database(file, { readonly: true });
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name);
    const indexes = raw
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string; tbl_name: string }[];
    raw.close();

    expect(tables).toEqual(expect.arrayContaining(['meta', 'pages', 'chunks', 'chunks_vec']));
    expect(indexes.map((row) => row.name)).toContain('idx_chunks_page');
    // vec0 tables may NOT be indexed ("virtual tables may not be indexed").
    expect(indexes.filter((row) => row.tbl_name === 'chunks_vec')).toHaveLength(0);

    // Reopen with other dims: stored value is preserved and integrity throws.
    const second = new RagDb({ file, dims: 8 });
    expect(second.getStoredDims()).toBe(DIMS);
    expect(() => second.checkIntegrity(8)).toThrow(/dimension mismatch/i);
    expect(() => second.checkIntegrity(DIMS)).not.toThrow();
    second.close();
  });

  it('replaceChunksForPage inserts N chunks + N vectors and replaces without duplicating', () => {
    const db = new RagDb({ dims: DIMS });
    db.upsertPage({ page_id: 1, path: '/a', title: 'A' });

    const inserted = db.replaceChunksForPage(1, [
      { chunk_index: 0, heading: 'H0', content: 'first', embedding: [1, 0, 0, 0] },
      { chunk_index: 1, heading: 'H1', content: 'second', embedding: [0, 1, 0, 0] },
      { chunk_index: 2, heading: 'H2', content: 'third', embedding: [0, 0, 1, 0] },
    ]);
    expect(inserted).toBe(3);
    // k larger than N returns exactly N hits → N aligned rows in chunks and chunks_vec.
    expect(db.searchByVector([0.5, 0.5, 0.5, 0.5], 10)).toHaveLength(3);

    // Replacing the same page must not duplicate rows (old vectors are removed too).
    const replaced = db.replaceChunksForPage(1, [
      { chunk_index: 0, content: 'replaced-a', embedding: [0, 0, 0, 1] },
      { chunk_index: 1, content: 'replaced-b', embedding: [0.5, 0.5, 0, 0] },
    ]);
    expect(replaced).toBe(2);

    const hits = db.searchByVector([0.5, 0.5, 0, 0], 10);
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.content).sort()).toEqual(['replaced-a', 'replaced-b']);
    expect(new Set(hits.map((hit) => hit.chunk_id)).size).toBe(2);

    db.close();
  });

  it('searchByVector returns the nearest chunks ordered by ascending distance', () => {
    const db = new RagDb({ dims: DIMS });
    db.upsertPage({ page_id: 7, path: '/guide', title: 'Guide' });
    db.replaceChunksForPage(7, [
      { chunk_index: 0, heading: 'Alpha', content: 'alpha body', embedding: [1, 0, 0, 0] },
      { chunk_index: 1, heading: 'Beta', content: 'beta body', embedding: [0, 1, 0, 0] },
      { chunk_index: 2, heading: 'Gamma', content: 'gamma body', embedding: [0.9, 0.1, 0, 0] },
    ]);

    const hits = db.searchByVector([1, 0, 0, 0], 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.content).toBe('alpha body');
    expect(hits[1]?.content).toBe('gamma body');
    expect(hits[2]?.content).toBe('beta body');

    // Distances strictly ascending; nearest is the exact match (distance 0).
    expect(hits[0]?.distance).toBeCloseTo(0, 6);
    expect(hits[1]?.distance).toBeGreaterThan(hits[0]?.distance ?? Number.POSITIVE_INFINITY);
    expect(hits[2]?.distance).toBeGreaterThan(hits[1]?.distance ?? Number.POSITIVE_INFINITY);

    // Metadata joined from pages + chunk fields.
    expect(hits[0]).toMatchObject({ page_id: 7, path: '/guide', title: 'Guide', heading: 'Alpha' });

    // limit is honored.
    const top2 = db.searchByVector([1, 0, 0, 0], 2);
    expect(top2).toHaveLength(2);
    expect(top2.map((hit) => hit.content)).toEqual(['alpha body', 'gamma body']);

    db.close();
  });

  it('purgePage removes chunks, vectors and the page row', () => {
    const db = new RagDb({ dims: DIMS });
    db.upsertPage({ page_id: 1, path: '/a', title: 'A' });
    db.upsertPage({ page_id: 2, path: '/b', title: 'B' });
    db.replaceChunksForPage(1, [
      { chunk_index: 0, content: 'a1', embedding: [1, 0, 0, 0] },
      { chunk_index: 1, content: 'a2', embedding: [0.9, 0.1, 0, 0] },
    ]);
    db.replaceChunksForPage(2, [{ chunk_index: 0, content: 'b1', embedding: [0, 1, 0, 0] }]);
    expect(db.searchByVector([0.5, 0.5, 0, 0], 10)).toHaveLength(3);

    db.purgePage(1);

    expect(db.listIndexedPageIds()).toEqual([2]);
    expect(db.getPageUpdatedAt(1)).toBeNull();
    const hits = db.searchByVector([0.5, 0.5, 0, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe('b1');

    db.close();
  });

  it('checkIntegrity passes on matching dims and throws an actionable error on mismatch', () => {
    const db = new RagDb({ dims: DIMS }); // file omitted → in-memory
    expect(db.getStoredDims()).toBe(DIMS);

    expect(() => db.checkIntegrity(DIMS)).not.toThrow();
    expect(() => db.checkIntegrity(8)).toThrow(/dimension mismatch/i);
    expect(() => db.checkIntegrity(8)).toThrow(/reindex/i);

    db.close();
  });

  it('upsertPage replaces the row and stores content_hash + updated_at', () => {
    const db = new RagDb({ dims: DIMS });
    db.upsertPage({ page_id: 1, path: '/guide', title: 'Guide v1' }, 'hash-1');
    expect(db.getPageContentHash(1)).toBe('hash-1');
    expect(db.getPageUpdatedAt(1)).not.toBeNull();

    db.upsertPage(
      { page_id: 1, path: '/guide', title: 'Guide v2', updated_at: '2026-01-02T00:00:00.000Z' },
      'hash-2',
    );
    expect(db.listIndexedPageIds()).toEqual([1]);
    expect(db.getPageContentHash(1)).toBe('hash-2');
    expect(db.getPageUpdatedAt(1)).toBe('2026-01-02T00:00:00.000Z');

    db.replaceChunksForPage(1, [{ chunk_index: 0, content: 'body', embedding: [1, 0, 0, 0] }]);
    const hits = db.searchByVector([1, 0, 0, 0], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ page_id: 1, path: '/guide', title: 'Guide v2', content: 'body' });

    db.close();
  });
});
