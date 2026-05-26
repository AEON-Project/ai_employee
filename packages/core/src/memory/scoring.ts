/**
 * Importance Scoring — PRD §6.1 简化打分公式。
 *
 *   importance_score = 0.4 × normalize(hit_count)
 *                    + 0.3 × user_feedback_weight        (positive=1, none=0.5, negative=0)
 *                    + 0.2 × recency(last_hit_at)        (越近越高)
 *                    + 0.1 × source_quality              (manual=1, auto=0.7)
 *
 * 每周批处理：score < 0.2 且 30 天未命中 → 自动归档。
 */

import type { Repos } from '@ai-emp/storage'
import type { MemoryItemId } from '@ai-emp/domain'

export interface ScoringSignal {
  hitCount: number
  userFeedback: 'none' | 'positive' | 'negative'
  /** 上次命中（或创建）时间 ms */
  lastHitAtMs: number | null
  /** 'manual' 或 'auto'（来源：用户手动加 = manual） */
  source: 'manual' | 'auto'
}

export interface ScoringContext {
  /** 当前时间（默认 Date.now()，测试可注入） */
  now?: number
}

const W_HIT = 0.4
const W_FEEDBACK = 0.3
const W_RECENCY = 0.2
const W_SOURCE = 0.1

const RECENCY_DECAY_DAYS = 30

export function computeImportance(s: ScoringSignal, ctx: ScoringContext = {}): number {
  const now = ctx.now ?? Date.now()

  // normalize(hit_count)：log scale，10 次 ≈ 0.5，100 次 ≈ 1.0
  const hitNorm = Math.min(1, Math.log10(1 + s.hitCount) / 2)

  const feedbackW = s.userFeedback === 'positive' ? 1 : s.userFeedback === 'negative' ? 0 : 0.5

  const recencyW = recencyScore(s.lastHitAtMs, now)

  const sourceW = s.source === 'manual' ? 1 : 0.7

  return Math.max(
    0,
    Math.min(
      1,
      W_HIT * hitNorm + W_FEEDBACK * feedbackW + W_RECENCY * recencyW + W_SOURCE * sourceW,
    ),
  )
}

/** lastHit 越近 → 越接近 1；超过 30 天 → 接近 0（指数衰减） */
export function recencyScore(lastHitAtMs: number | null, now: number): number {
  if (lastHitAtMs == null) return 0
  const days = (now - lastHitAtMs) / (24 * 60 * 60 * 1000)
  if (days <= 0) return 1
  return Math.exp(-days / RECENCY_DECAY_DAYS)
}

// ──────────────────────────────────────────────────────────────
// 批量更新 + 归档
// ──────────────────────────────────────────────────────────────

export interface ScoringRunResult {
  scanned: number
  updated: number
  archived: number
}

/**
 * 周批：扫描所有非 archived memory_items，重算 score；
 * score < 0.2 && lastHitAt 距今 > 30 天 → archive。
 *
 * 用户手动新增（source_requirement_id == null）视为 source='manual'，
 * 自动复盘产物视为 source='auto'。
 */
export function rescoreAll(
  repos: Repos,
  scopes: { scope: 'project' | 'employee'; scopeId: string }[],
  ctx: ScoringContext = {},
): ScoringRunResult {
  const now = ctx.now ?? Date.now()
  let scanned = 0
  let updated = 0
  let archived = 0

  for (const { scope, scopeId } of scopes) {
    const items = repos.memoryItems.list({ scope, scopeId, includeArchived: false })
    for (const it of items) {
      scanned++
      const signal: ScoringSignal = {
        hitCount: it.hitCount,
        userFeedback: it.userFeedback,
        lastHitAtMs: it.lastHitAt ? it.lastHitAt.getTime() : null,
        source: it.sourceRequirementId ? 'auto' : 'manual',
      }
      const newScore = computeImportance(signal, { now })
      if (Math.abs(newScore - it.importanceScore) > 0.01) {
        repos.memoryItems.setImportance(it.id, newScore)
        updated++
      }
      const lastHitDays = it.lastHitAt
        ? (now - it.lastHitAt.getTime()) / (24 * 3600 * 1000)
        : Infinity
      if (newScore < 0.2 && lastHitDays > RECENCY_DECAY_DAYS) {
        repos.memoryItems.archive(it.id)
        archived++
      }
    }
  }

  return { scanned, updated, archived }
}

/** 命中事件：增加 hit_count + 更新 importance（recall 内调，但脚本化触发也可用） */
export function recordHit(repos: Repos, itemId: MemoryItemId, ctx: ScoringContext = {}): void {
  const it = repos.memoryItems.findById(itemId)
  if (!it) return
  repos.memoryItems.incrementHit(itemId)
  const signal: ScoringSignal = {
    hitCount: it.hitCount + 1,
    userFeedback: it.userFeedback,
    lastHitAtMs: ctx.now ?? Date.now(),
    source: it.sourceRequirementId ? 'auto' : 'manual',
  }
  const score = computeImportance(signal, ctx)
  repos.memoryItems.setImportance(itemId, score)
}
