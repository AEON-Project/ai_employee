/**
 * Memory 服务 —— RAG 检索 + 双向沉淀 + 项目介绍/规范的 reindex。
 *
 * α 阶段简化策略：
 *   - chunk = 整段（不分词）；query 直接嵌入；Top-K 用 sqlite-vec
 *   - importance_score 用 `vector_similarity × (0.5 + hit_count)`（简化版）
 *   - persistFromReport 不做置信度分流（α 直接写）
 */

import type { Database } from 'bun:sqlite'
import type { MemoryKind, MemoryScope, RequirementId, SourceType } from '@ai-emp/domain'
import type { Repos } from '@ai-emp/storage'
import { deleteVecByChunkIds, insertVec, knn, type VecHit } from './vec.js'

export interface MemoryServices {
  repos: Repos
  sqlite: Database
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface RecallOptions {
  scope: MemoryScope
  scopeId: string
  kinds: MemoryKind[]
  query: string
  k?: number
}

export interface RecallHit {
  itemId: string
  kind: MemoryKind
  content: string
  distance: number
  importance: number
  /** 综合排序分（distance 越小越好，importance 越大越好） */
  score: number
}

const DEFAULT_K = 5

/**
 * 检索某 scope (project/employee) 下的 memory_items（已通过 chunks + vec_chunks 索引）。
 */
export async function recall(svc: MemoryServices, opts: RecallOptions): Promise<RecallHit[]> {
  const [qvec] = await svc.embed([opts.query])
  if (!qvec) return []
  const k = opts.k ?? DEFAULT_K
  // 检索范围更大一点（×3）再在应用层按 scope/kind 过滤 + Importance 重排
  const hits = knn(svc.sqlite, qvec, k * 4)
  if (hits.length === 0) return []
  return rerank(svc, hits, opts, k)
}

function rerank(svc: MemoryServices, hits: VecHit[], opts: RecallOptions, k: number): RecallHit[] {
  const chunks = svc.repos.chunks.findByIds(hits.map((h) => h.chunkId))
  const chunkById = new Map(chunks.map((c) => [c.id, c]))

  const out: RecallHit[] = []
  for (const h of hits) {
    const chunk = chunkById.get(h.chunkId)
    if (!chunk) continue
    // 仅对 memory_item 类型走 importance 重排；project_desc/convention 直接给固定分
    if (chunk.sourceType === 'memory_item') {
      const item = svc.repos.memoryItems.findById(chunk.sourceId)
      if (!item) continue
      if (item.archived) continue
      if (item.scope !== opts.scope || item.scopeId !== opts.scopeId) continue
      if (!opts.kinds.includes(item.kind)) continue
      // similarity = 1 / (1 + distance)，importance 已是 0-1
      const similarity = 1 / (1 + h.distance)
      const score = similarity * (0.5 + item.importanceScore)
      out.push({
        itemId: item.id,
        kind: item.kind,
        content: item.content,
        distance: h.distance,
        importance: item.importanceScore,
        score,
      })
      // 命中后异步累加 hit 计数（不 await）
      svc.repos.memoryItems.incrementHit(item.id)
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, k)
}

// ──────────────────────────────────────────────────────────────
// reindex — 把某 source（项目描述 / convention / memory_item）重新切块+向量化
// ──────────────────────────────────────────────────────────────
export async function reindexSource(
  svc: MemoryServices,
  sourceType: SourceType,
  sourceId: string,
  content: string,
): Promise<{ chunkIds: string[] }> {
  // 先清旧
  const oldChunks = svc.repos.chunks.findByIds([]) // 没有 findBySource 方法；用 sqlite 直接查
  void oldChunks
  const old = svc.sqlite
    .prepare<
      { id: string },
      [string, string]
    >(`SELECT id FROM chunks WHERE source_type = ? AND source_id = ?`)
    .all(sourceType, sourceId)
  const oldIds = old.map((r) => r.id)
  if (oldIds.length > 0) {
    deleteVecByChunkIds(svc.sqlite, oldIds)
    svc.repos.chunks.deleteBySource(sourceType, sourceId)
  }

  // α 简化：整段一个 chunk
  const text = content.trim()
  if (!text) return { chunkIds: [] }
  const [vec] = await svc.embed([text])
  if (!vec) return { chunkIds: [] }

  const id = svc.repos.chunks.create({
    sourceType,
    sourceId,
    chunkIdx: 0,
    content: text,
    tokens: approxTokens(text),
  })
  insertVec(svc.sqlite, id, vec)
  return { chunkIds: [id] }
}

function approxTokens(text: string): number {
  // 简化：每个非空白字符算 1 token 上限近似
  return text.replace(/\s+/g, '').length
}

// ──────────────────────────────────────────────────────────────
// persistFromReport — 双向沉淀（α 简化：直接写入，无置信度分流）
// ──────────────────────────────────────────────────────────────
export interface ReportSplit {
  /** 项目层 fact 候选 */
  facts?: string[]
  /** 项目层 pitfall 候选 */
  pitfalls?: string[]
  /** 员工 lesson 候选 */
  lessons?: string[]
  /** 员工 style 候选（追加到 employee.memory_style_text） */
  styleAddendum?: string
}

export async function persistFromReport(
  svc: MemoryServices,
  reqId: RequirementId,
  split: ReportSplit,
): Promise<{ persistedFacts: number; persistedPitfalls: number; persistedLessons: number }> {
  const req = svc.repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const empId = req.assigneeId
  const projId = req.projectId

  let facts = 0
  let pitfalls = 0
  let lessons = 0

  if (projId && split.facts) {
    for (const f of split.facts) {
      const id = svc.repos.memoryItems.create({
        scope: 'project',
        scopeId: projId,
        kind: 'fact',
        content: f,
        sourceRequirementId: reqId,
      })
      await reindexSource(svc, 'memory_item', id, f)
      facts++
    }
  }
  if (projId && split.pitfalls) {
    for (const p of split.pitfalls) {
      const id = svc.repos.memoryItems.create({
        scope: 'project',
        scopeId: projId,
        kind: 'pitfall',
        content: p,
        sourceRequirementId: reqId,
      })
      await reindexSource(svc, 'memory_item', id, p)
      pitfalls++
    }
  }
  if (empId && split.lessons) {
    for (const l of split.lessons) {
      const id = svc.repos.memoryItems.create({
        scope: 'employee',
        scopeId: empId,
        kind: 'lesson',
        content: l,
        sourceRequirementId: reqId,
      })
      await reindexSource(svc, 'memory_item', id, l)
      lessons++
    }
  }
  if (empId && split.styleAddendum) {
    const emp = svc.repos.employees.findById(empId)
    if (emp) {
      const newStyle = emp.memoryStyleText
        ? `${emp.memoryStyleText}\n${split.styleAddendum}`
        : split.styleAddendum
      svc.repos.employees.updateStyle(empId, newStyle)
    }
  }

  return { persistedFacts: facts, persistedPitfalls: pitfalls, persistedLessons: lessons }
}
