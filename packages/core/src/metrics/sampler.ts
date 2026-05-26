/**
 * 量化指标采样器 — 对应 PRD §12 4 个量化观测指标：
 *
 *   1. 澄清卡片问题"用户认为有用"的比例 ≥ 60%
 *   2. 同类型驳回需求再次派单时引用历史教训的比例 ≥ 70%
 *   3. 项目知识 RAG 检索 Top-K 中"被员工实际引用进思维链"的比例 ≥ 40%
 *   4. 执行中刷新页面后思维链历史完整恢复 100%
 *
 * α 阶段：自动采集 + LLM-as-judge 占位（judge 函数由调用方注入）。
 */

import type { Repos } from '@ai-emp/storage'

export interface MetricsSample {
  /** 1. 澄清问题👍率（用户对每个 question 显式 👍/👎） */
  clarificationHelpfulRate: number | null
  /** 2. 历史教训引用率（同类型驳回 → 新需求引用 lesson/pitfall 比例） */
  lessonReuseRate: number | null
  /** 3. RAG 命中实际被引用率（被 inject 的 chunk 是否在交付物/思维链中被显式引用） */
  ragCitationRate: number | null
  /** 4. 刷新页面后思维链完整恢复率 */
  threadIntegrityRate: number | null
  /** 样本数 */
  sampleSize: {
    clarifications: number
    rejectedReassigned: number
    ragHits: number
    threadRecoveries: number
  }
}

export interface JudgeFns {
  /** LLM-as-judge：判断澄清 question 对用户是否"有用"。回退到用户显式打分时不传 */
  judgeClarificationHelpful?: (q: string) => Promise<boolean>
  /** 判定 prompt / 思维链是否引用了某 lesson/pitfall 内容 */
  judgeReferenceMatch?: (haystack: string, needle: string) => Promise<boolean>
}

export async function sample(repos: Repos, judges: JudgeFns = {}): Promise<MetricsSample> {
  return {
    clarificationHelpfulRate: await samplerClarifications(repos, judges),
    lessonReuseRate: await samplerLessonReuse(repos, judges),
    ragCitationRate: await samplerRagCitation(repos, judges),
    threadIntegrityRate: await samplerThreadIntegrity(repos),
    sampleSize: {
      clarifications: repos.clarifications.listByRequirement('').length || 0,
      rejectedReassigned: 0,
      ragHits: 0,
      threadRecoveries: 0,
    },
  }
}

// ──────────────────────────────────────────────────────────────
// ① 澄清问题👍率
//   - 简化：每条 clarification.questions 都有 answer 视为"有用"；用户 reject 视为 negative。
//   - 完整版需要 UI 给每个 question 独立打分（β 后补）
// ──────────────────────────────────────────────────────────────
async function samplerClarifications(repos: Repos, _judges: JudgeFns): Promise<number | null> {
  const all = repos.requirements.listActive() // 简化：扫所有；正式版应分页
  const clarifications = all.flatMap((r) => repos.clarifications.listByRequirement(r.id))
  if (clarifications.length === 0) return null
  let total = 0
  let helpful = 0
  for (const c of clarifications) {
    for (const q of c.questionsJson) {
      total++
      if (q.answer && q.answer.trim().length > 0) helpful++
    }
  }
  return total > 0 ? helpful / total : null
}

// ──────────────────────────────────────────────────────────────
// ② 历史教训引用率
// ──────────────────────────────────────────────────────────────
async function samplerLessonReuse(repos: Repos, judges: JudgeFns): Promise<number | null> {
  // 找所有 (rejected_at, lesson_persisted) → 后续是否有同员工/同项目的新需求引用此 lesson
  const allReqs = repos.requirements
    .listByStatus('已完成')
    .concat(repos.requirements.listByStatus('已驳回'))
  const rejected = allReqs.filter((r) => r.status === '已驳回')
  if (rejected.length === 0) return null

  let total = 0
  let cited = 0
  for (const r of rejected) {
    if (!r.assigneeId) continue
    // 取员工后续完成的需求
    const subsequent = allReqs.filter(
      (x) => x.assigneeId === r.assigneeId && x.createdAt > r.createdAt,
    )
    if (subsequent.length === 0) continue
    const lessons = repos.memoryItems.list({
      scope: 'employee',
      scopeId: r.assigneeId,
      kind: 'lesson',
    })
    for (const subseq of subsequent) {
      const thread = repos.threads.findByRequirement(subseq.id)
      if (!thread) continue
      const msgs = repos.messages.listByThread(thread.id)
      const haystack = msgs
        .map((m) => {
          const c = m.contentJson as { text?: string }
          return c.text ?? ''
        })
        .join('\n')
      for (const l of lessons) {
        total++
        // 简化匹配：lesson content 任意 5 字符子串在思维链出现 → 视为引用
        const judge = judges.judgeReferenceMatch
        const ok = judge
          ? await judge(haystack, l.content)
          : haystack.includes(l.content.slice(0, 10))
        if (ok) cited++
      }
    }
  }
  return total > 0 ? cited / total : null
}

// ──────────────────────────────────────────────────────────────
// ③ RAG 命中被引用率
//   - 简化：扫 memory_items.hit_count > 0 的条目，看对应 reqId 的思维链是否引用
//   - 完整：需要在 recall 时记录 (reqId, chunkId)；当前用 hit_count 近似
// ──────────────────────────────────────────────────────────────
async function samplerRagCitation(repos: Repos, _judges: JudgeFns): Promise<number | null> {
  // 简化：β 阶段需要在 memory.recall 时记录 (reqId, itemId) 到独立表
  // α 给一个占位 null
  void repos
  return null
}

// ──────────────────────────────────────────────────────────────
// ④ 刷新恢复完整率
//   - 简化：runtime_state.heartbeat 写入次数 vs message.seq 总数
//   - 完整：需要外部脚本"随机时间点强制刷新"
// ──────────────────────────────────────────────────────────────
async function samplerThreadIntegrity(repos: Repos): Promise<number | null> {
  // 验证 messages 表中 seq 连续无缺失
  const reqs = repos.requirements.listActive()
  if (reqs.length === 0) return null
  let good = 0
  for (const r of reqs) {
    const t = repos.threads.findByRequirement(r.id)
    if (!t) continue
    const msgs = repos.messages.listByThread(t.id)
    if (msgs.length === 0) continue
    const seqs = msgs.map((m) => m.seq)
    const continuous = seqs.every((s, i) => s === i)
    if (continuous) good++
  }
  return reqs.length > 0 ? good / reqs.length : null
}

// ──────────────────────────────────────────────────────────────
// 格式化报告
// ──────────────────────────────────────────────────────────────
export function formatReport(m: MetricsSample): string {
  const fmt = (v: number | null) => (v == null ? 'N/A' : `${(v * 100).toFixed(1)}%`)
  return [
    '## 量化指标报告',
    `1. 澄清问题"有用"率：${fmt(m.clarificationHelpfulRate)} (目标 ≥ 60%)`,
    `2. 历史教训引用率：${fmt(m.lessonReuseRate)} (目标 ≥ 70%)`,
    `3. RAG 检索引用率：${fmt(m.ragCitationRate)} (目标 ≥ 40%)`,
    `4. 刷新恢复完整率：${fmt(m.threadIntegrityRate)} (目标 100%)`,
  ].join('\n')
}
