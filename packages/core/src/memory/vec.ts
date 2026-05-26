/**
 * 向量层封装 — 借助 sqlite-vec 虚表 `vec_chunks` 做 KNN 检索。
 *
 * Repos 抽象之外的部分（虚表查询）这里直接用 sqlite prepared statement。
 * 后续可由 storage 层暴露 query 接口；当前保持简单。
 */

import type { Database } from 'bun:sqlite'

export interface VecHit {
  chunkId: string
  distance: number
}

/** 插入向量；vec_chunks 的 rowid 自增，chunk_id 是关联回 chunks 表的 string PK */
export function insertVec(sqlite: Database, chunkId: string, embedding: Float32Array): void {
  sqlite
    .prepare(`INSERT INTO vec_chunks(embedding, chunk_id) VALUES (?, ?)`)
    .run(embedding, chunkId)
}

/** 删除某 chunk_id 的所有向量行（reindex 时配合） */
export function deleteVecByChunkIds(sqlite: Database, chunkIds: string[]): void {
  if (chunkIds.length === 0) return
  const stmt = sqlite.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`)
  for (const id of chunkIds) stmt.run(id)
}

/** KNN 查询；返回 (chunkId, distance) Top-K */
export function knn(sqlite: Database, embedding: Float32Array, k: number): VecHit[] {
  const rows = sqlite
    .prepare<{ chunk_id: string; distance: number }, [Float32Array, number]>(
      `SELECT chunk_id, distance
         FROM vec_chunks
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(embedding, k)
  return rows.map((r) => ({ chunkId: r.chunk_id, distance: r.distance }))
}
