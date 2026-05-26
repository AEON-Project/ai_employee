/**
 * Spike 1: sqlite-vec 在 Bun 下加载并跑通向量检索
 */
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

const t0 = Date.now();

// Bun 内置 sqlite 编译时关掉了 extension loading；切换到 brew 装的 sqlite
Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');

const db = new Database(':memory:');

try {
  sqliteVec.load(db);
} catch (e) {
  console.error('FAIL: load extension', e);
  process.exit(1);
}

const version = db.prepare('SELECT vec_version() as v').get() as { v: string };
console.log(`✓ sqlite-vec 版本: ${version.v}`);

// ── Test A: 4 维小向量 ────────────────────────────────────────
db.exec(`CREATE VIRTUAL TABLE t_small USING vec0(emb float[4], item text)`);

const insert = db.prepare(`INSERT INTO t_small(rowid, emb, item) VALUES (?, ?, ?)`);
const samples: [number, number[], string][] = [
  [1, [0.1, 0.1, 0.1, 0.1], '猫'],
  [2, [0.9, 0.9, 0.9, 0.9], '狗'],
  [3, [0.1, 0.2, 0.1, 0.2], '幼猫'],
  [4, [0.8, 0.9, 0.8, 0.9], '幼狗'],
];
for (const [id, vec, item] of samples) {
  insert.run(id, new Float32Array(vec), item);
}

const queryVec = new Float32Array([0.1, 0.1, 0.1, 0.1]);
const rows = db
  .prepare(`SELECT item, distance FROM t_small WHERE emb MATCH ? AND k = 2 ORDER BY distance`)
  .all(queryVec) as { item: string; distance: number }[];
console.log('✓ 4D KNN 查询结果:', rows);

if (rows[0].item !== '猫' || rows[1].item !== '幼猫') {
  console.error('FAIL: KNN 排序不对');
  process.exit(1);
}

// ── Test B: 512 维真实场景 ────────────────────────────────────
db.exec(`CREATE VIRTUAL TABLE t_big USING vec0(emb float[512])`);
const insertBig = db.prepare(`INSERT INTO t_big(rowid, emb) VALUES (?, ?)`);

function randomVec(seed: number, dim = 512): Float32Array {
  const a = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 9301 + 49297) % 233280;
    a[i] = (s / 233280) * 2 - 1;
  }
  return a;
}

const tBigInsert = Date.now();
for (let i = 1; i <= 1000; i++) {
  insertBig.run(i, randomVec(i));
}
console.log(`✓ 插入 1000 条 512 维向量耗时: ${Date.now() - tBigInsert}ms`);

const tBigQuery = Date.now();
const queryBig = randomVec(42);
const bigRows = db
  .prepare(`SELECT rowid, distance FROM t_big WHERE emb MATCH ? AND k = 10 ORDER BY distance`)
  .all(queryBig) as { rowid: number; distance: number }[];
console.log(`✓ 1000 条 512D KNN Top-10 耗时: ${Date.now() - tBigQuery}ms`);
console.log('  Top-3:', bigRows.slice(0, 3));

console.log(`\n=== PASS in ${Date.now() - t0}ms ===`);
