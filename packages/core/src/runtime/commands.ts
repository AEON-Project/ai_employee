/**
 * 命令式 API — pause / resume / cancel / forceEnd / answer / draftClarification。
 *
 * 这些命令的语义：触发状态机转移 + 同步 DB + emit 事件；
 * 必要时调用方在外层接 executeRequirement() 继续推进。
 */

import {
  type AnswerMode,
  type ClarificationTrigger,
  type PauseReason,
  type RequirementId,
} from '@ai-emp/domain'
import { transition } from './state-machine.js'
import { reindexSource } from '../memory/memory.js'
import { revert as revertSnapshot } from '../checkpoint/index.js'
import type { RuntimeServices } from './services.js'

export interface AnswerEntry {
  question: string
  answer: string
  answerMode?: AnswerMode
}

/** 触发系统/用户 pause */
export function pauseRequirement(
  services: RuntimeServices,
  reqId: RequirementId,
  reason: PauseReason = 'user',
): void {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const ev =
    reason === 'user'
      ? ({ kind: 'user_pause' } as const)
      : ({ kind: 'system_pause', reason } as const)
  const t = transition(req.status, ev)
  repos.requirements.setStatus(reqId, t.to)
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
  bus.emit('requirement.paused', { reqId, reason })
}

export function resumeRequirement(services: RuntimeServices, reqId: RequirementId): void {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const t = transition(req.status, { kind: 'resume' })
  repos.requirements.setStatus(reqId, t.to)
  // 复位 budgetUsed —— 用户主动 resume 等同于"给一次新额度"，
  // 否则 budget_iterations / budget_tokens 暂停后 resume 会立刻再次撞 cap。
  // 保留 currentStep + historySummary（不丢进度）。
  const rs = repos.runtimeState.find(reqId)
  if (rs) {
    repos.runtimeState.upsert({
      requirementId: reqId,
      currentStep: rs.currentStep,
      historySummary: rs.historySummary,
      budgetUsed: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
    })
  }
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
}

export function cancelRequirement(services: RuntimeServices, reqId: RequirementId): void {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const t = transition(req.status, { kind: 'cancel' })
  repos.requirements.setStatus(reqId, t.to, { completedAt: new Date() })
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
  bus.emit('requirement.cancelled', { reqId })
}

export function forceEndRequirement(
  services: RuntimeServices,
  reqId: RequirementId,
  opts: { keep: boolean },
): void {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const t = transition(req.status, { kind: 'force_end', keep: opts.keep })
  repos.requirements.setStatus(reqId, t.to, { completedAt: new Date() })
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
}

/** 用户验收 → 已完成 */
export function approveRequirement(services: RuntimeServices, reqId: RequirementId): void {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const t = transition(req.status, { kind: 'approve' })
  repos.requirements.setStatus(reqId, t.to, { completedAt: new Date() })
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
}

/**
 * 用户驳回 → 已驳回。
 *
 * V2 O2 memory 闭环（PRD §3「纠错沉淀」）：
 *   - reason 非空时把用户驳回原因自动写入 employee.lesson（最小开销，不调 LLM 复盘）
 *   - 下次同员工接到相似需求时，composer 通过 lessons RAG 自动注入到 system prompt
 *   - reason 也作为一条 system message 落入 thread，方便 UI 思维链可见
 */
export async function rejectRequirement(
  services: RuntimeServices,
  reqId: RequirementId,
  opts?: { reason?: string },
): Promise<void> {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const reason = opts?.reason?.trim() ?? ''
  const t = transition(req.status, { kind: 'reject' })
  repos.requirements.setStatus(reqId, t.to, { completedAt: new Date() })
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })

  // 自动沉淀：把驳回原因写进 employee.lesson（V2 O2 PRD §3 核心机制最后一环）
  if (reason && req.assigneeId) {
    const thread = repos.threads.findByRequirement(reqId)
    if (thread) {
      repos.messages.append({
        threadId: thread.id,
        role: 'system',
        type: 'text',
        content: { type: 'text', text: `🚫 用户驳回。原因：${reason}` },
      })
    }
    const lessonContent = `用户驳回时反馈：${reason}（来自工单"${req.title}"）`
    const lessonId = repos.memoryItems.create({
      scope: 'employee',
      scopeId: req.assigneeId,
      kind: 'lesson',
      content: lessonContent,
      sourceRequirementId: reqId,
    })
    if (services.memory) {
      try {
        await reindexSource(
          { repos, sqlite: services.memory.sqlite, embed: services.memory.embed },
          'memory_item',
          lessonId,
          lessonContent,
        )
      } catch {
        // reindex 失败不阻断 reject 主流程；lesson 仍写入了表，只是 RAG 命中率低
      }
    }
    bus.emit('memory.persisted', {
      items: [
        {
          id: lessonId,
          scope: 'employee',
          scopeId: req.assigneeId,
          kind: 'lesson',
          content: lessonContent,
        },
      ],
    })
  }
}

/**
 * draftClarification — α 阶段最小版本：直接产出一个 initial 澄清，
 * 用户在 UI/TG 上确认即可。完整版本（LLM 生成 understanding + plan + 问题）
 * 由 PromptComposer / T2.4 完整实现接入。
 *
 * 当前签名留给上层注入一个 producer：
 */
export async function draftClarification(
  services: RuntimeServices,
  reqId: RequirementId,
  producer: () => Promise<{
    employeeUnderstanding?: string
    proposedPlan?: string[]
    questions: { question: string; answerMode?: AnswerMode }[]
    trigger?: ClarificationTrigger
  }>,
): Promise<{ id: string; round: number }> {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  if (req.status !== '待澄清') {
    throw new Error(`req ${reqId} not in 待澄清 (${req.status})`)
  }
  const drafted = await producer()
  const c = repos.clarifications.create({
    requirementId: reqId,
    trigger: drafted.trigger ?? 'initial',
    employeeUnderstanding: drafted.employeeUnderstanding,
    proposedPlan: drafted.proposedPlan,
    questions: drafted.questions.map((q) => ({
      question: q.question,
      answerMode: q.answerMode ?? 'user',
    })),
  })
  bus.emit('requirement.clarification_ready', { reqId, clarificationId: c.id, round: c.round })
  return c
}

/**
 * answerClarification — 用户回复澄清。
 * 在 待澄清 / 等待回答 两种状态都可调用：
 *   - 待澄清 → 进行中 （走 clarify_confirmed）
 *   - 等待回答 → 进行中 （走 answer）
 */
export function answerClarification(
  services: RuntimeServices,
  clarificationId: string,
  answers: AnswerEntry[],
): { reqId: RequirementId; transitionedTo: '进行中' } {
  const { repos, bus } = services
  const c = repos.clarifications.findById(clarificationId)
  if (!c) throw new Error(`clarification not found: ${clarificationId}`)
  const req = repos.requirements.findById(c.requirementId)
  if (!req) throw new Error(`requirement not found: ${c.requirementId}`)

  // 写回答（按 question 文本对齐）
  const updated = c.questionsJson.map((q) => {
    const a = answers.find((x) => x.question === q.question)
    return a ? { ...q, answer: a.answer, answerMode: a.answerMode ?? q.answerMode } : q
  })
  repos.clarifications.resolve(clarificationId, updated)

  // 状态机转移
  const ev =
    req.status === '待澄清'
      ? ({ kind: 'clarify_confirmed' } as const)
      : ({ kind: 'answer' } as const)
  const t = transition(req.status, ev)
  repos.requirements.setStatus(req.id, t.to)
  bus.emit('requirement.state_changed', { reqId: req.id, from: t.from, to: t.to, reason: t.reason })
  bus.emit('requirement.clarification_answered', { reqId: req.id, clarificationId })

  // 写一条 clarification_answer message
  const thread = repos.threads.findByRequirement(req.id)
  if (thread) {
    repos.messages.append({
      threadId: thread.id,
      role: 'user',
      type: 'clarification_answer',
      content: {
        type: 'text',
        text: answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n'),
      },
    })
  }

  return { reqId: req.id, transitionedTo: '进行中' }
}

/** 给已分派需求初始化 thread（创建 Requirement 后调一次） */
export function ensureThread(services: RuntimeServices, reqId: RequirementId): string {
  const existing = services.repos.threads.findByRequirement(reqId)
  if (existing) return existing.id
  return services.repos.threads.createForRequirement(reqId)
}

/** assign：分派员工 + 状态机转移；caller 决定是否 skipClarification */
export function assignRequirement(
  services: RuntimeServices,
  reqId: RequirementId,
  employeeId: string,
  opts: { skipClarification?: boolean } = {},
): { thread: string } {
  const { repos, bus } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  repos.requirements.assign(reqId, employeeId)
  const t = transition(req.status, {
    kind: 'assign',
    skipClarification: opts.skipClarification ?? false,
  })
  repos.requirements.setStatus(reqId, t.to)
  bus.emit('requirement.state_changed', { reqId, from: t.from, to: t.to, reason: t.reason })
  const thread = ensureThread(services, reqId)
  return { thread }
}

/**
 * V2 O4: 把当前 workdir 回滚到指定 checkpoint。
 *
 * 安全策略：service 内部会先把当前 workdir 备份成 preRevert-<ts>.tar.gz，
 * 然后做硬性恢复（git reset --hard 或 tar 解压覆盖）。
 *
 * 不改变 requirement 状态机 —— 调用方决定 revert 之后是否 reject / approve / 继续。
 */
export async function revertToCheckpoint(
  services: RuntimeServices,
  checkpointId: string,
): Promise<{ ok: boolean; backupRef: string | null; error?: string }> {
  const { repos } = services
  const ckpt = repos.checkpoints.findById(checkpointId)
  if (!ckpt) {
    return { ok: false, backupRef: null, error: `checkpoint not found: ${checkpointId}` }
  }
  if (!services.checkpointsDir) {
    return { ok: false, backupRef: null, error: 'engine has no checkpointsDir configured' }
  }
  const r = await revertSnapshot({
    checkpoint: {
      id: ckpt.id,
      requirementId: ckpt.requirementId,
      kind: ckpt.kind,
      label: ckpt.label,
      backendKind: ckpt.backendKind,
      ref: ckpt.ref,
      workdir: ckpt.workdir,
    },
    checkpointsDir: services.checkpointsDir,
  })
  // 落痕到 thread
  const thread = repos.threads.findByRequirement(ckpt.requirementId)
  if (thread) {
    repos.messages.append({
      threadId: thread.id,
      role: 'system',
      type: 'text',
      content: {
        type: 'text',
        text: r.ok
          ? `↩️ 已回滚到 checkpoint「${ckpt.label}」(${ckpt.backendKind})。当前 workdir 已恢复到该快照点；preRevert 备份：${r.backupRef ?? '(无)'}。`
          : `⚠️ 回滚到「${ckpt.label}」失败：${r.error ?? 'unknown'}。preRevert 备份：${r.backupRef ?? '(无)'}。`,
      },
    })
  }
  return r
}
