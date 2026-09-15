/**
 * Native smoke test: exercises the exact native ops (vec0 DDL + KNN) in plain
 * Node, outside the test runner. Used by CI to bisect crashes:
 *   - fails here  => bindings broken on this platform
 *   - passes here but tests fail => Vitest/runner-specific issue
 */
import Database from 'better-sqlite3';
import { load } from '@photostructure/sqlite-vec';

const dims = 8;
const db = new Database(':memory:');
load(db);

db.exec(`CREATE VIRTUAL TABLE vec USING vec0(embedding FLOAT[${dims}])`);

const toBlob = (v) => Buffer.from(new Float32Array(v).buffer);

const insert = db.prepare('INSERT INTO vec (embedding) VALUES (?)');
for (const v of [
  [1, 0, 0, 0, 0, 0, 0, 0],
  [0.9, 0.1, 0, 0, 0, 0, 0, 0],
  [0, 0.9, 0.1, 0, 0, 0, 0, 0],
  [0, 0, 0.9, 0.1, 0, 0, 0, 0],
]) {
  insert.run(toBlob(v));
}

const knn = db.prepare('SELECT rowid, distance FROM vec WHERE embedding MATCH ? AND k = ? ORDER BY distance');
const hits = knn.all(toBlob([0.95, 0.05, 0, 0, 0, 0, 0, 0]), 2);

console.log(`native-smoke: ${hits.length}/2 KNN hits`);
for (const hit of hits) {
  console.log(`  rowid=${hit.rowid} distance=${hit.distance.toFixed(4)}`);
}
db.close();

if (hits.length !== 2 || hits[0].rowid > 2) {
  console.error('native-smoke: unexpected KNN results');
  process.exit(1);
}
console.log('native-smoke: OK');
