/**
 * Requirement 主状态机 — 对应 ARCHITECTURE §9.1 完整状态转移图。
 *
 * 设计：
 *   - 9 个状态，事件驱动
 *   - 合法转移矩阵硬编码（任何外部 mutate 都过 transition()）
 *   - 非法转移抛 IllegalTransition；调用方决定回退/熔断
 *   - transition() 是纯函数；写库 + 发 event_bus 由调用方负责
 */

import type { PauseReason, RequirementStatus } from '@ai-emp/domain'

// ──────────────────────────────────────────────────────────────
// Event 集合
// ──────────────────────────────────────────────────────────────
export type RequirementEvent =
  /** 创建后立即可用：assign + skip clarification = 直接进入"进行中" */
  | { kind: 'assign'; skipClarification: boolean }
  /** 用户确认澄清卡片 / 跳过澄清 */
  | { kind: 'clarify_confirmed' }
  /** LLM tool_use=ask_user → 转 等待回答 */
  | { kind: 'ask_user' }
  /** 用户回复澄清 */
  | { kind: 'answer' }
  /** 用户主动暂停（在 进行中 / 等待回答 状态可触发） */
  | { kind: 'user_pause' }
  /** Budget 触达 / LLM 错误 / 工具致命错误 */
  | { kind: 'system_pause'; reason: PauseReason }
  /** 用户继续；含增加 budget 的情形 */
  | { kind: 'resume' }
  /** LLM tool_use=emit_deliverable → 待验收 */
  | { kind: 'deliver' }
  /** 用户验收 / 驳回 */
  | { kind: 'approve' }
  | { kind: 'reject' }
  /** 取消（待澄清 / 已暂停 时） */
  | { kind: 'cancel' }
  /** 强制结束（来自进行中 / 已暂停）：keep=true→已完成，keep=false→已取消 */
  | { kind: 'force_end'; keep: boolean }

export type RequirementEventKind = RequirementEvent['kind']

// ──────────────────────────────────────────────────────────────
// 转移结果
// ──────────────────────────────────────────────────────────────
export interface TransitionResult {
  from: RequirementStatus
  to: RequirementStatus
  /** 描述性 reason，供 emit('requirement.state_changed', { reason }) 使用 */
  reason: string
}

// ──────────────────────────────────────────────────────────────
// IllegalTransition
// ──────────────────────────────────────────────────────────────
export class IllegalTransition extends Error {
  constructor(
    readonly from: RequirementStatus,
    readonly event: RequirementEvent,
  ) {
    super(`Illegal transition: ${from} + ${event.kind}`)
    this.name = 'IllegalTransition'
  }
}

// ──────────────────────────────────────────────────────────────
// transition 纯函数
// ──────────────────────────────────────────────────────────────
export function transition(from: RequirementStatus, event: RequirementEvent): TransitionResult {
  const to = compute(from, event)
  if (!to) throw new IllegalTransition(from, event)
  return { from, to: to.to, reason: to.reason }
}

/** 仅查询而不抛错：返回 null 表示非法转移；用于 UI 决定按钮是否可用 */
export function canTransition(
  from: RequirementStatus,
  event: RequirementEvent,
): TransitionResult | null {
  const r = compute(from, event)
  if (!r) return null
  return { from, to: r.to, reason: r.reason }
}

/** 返回 from 状态下所有合法事件（不携带 payload） */
export function listAllowedEvents(from: RequirementStatus): RequirementEventKind[] {
  const out = new Set<RequirementEventKind>()
  const probes: RequirementEvent[] = [
    { kind: 'assign', skipClarification: false },
    { kind: 'assign', skipClarification: true },
    { kind: 'clarify_confirmed' },
    { kind: 'ask_user' },
    { kind: 'answer' },
    { kind: 'user_pause' },
    { kind: 'system_pause', reason: 'system' },
    { kind: 'resume' },
    { kind: 'deliver' },
    { kind: 'approve' },
    { kind: 'reject' },
    { kind: 'cancel' },
    { kind: 'force_end', keep: true },
    { kind: 'force_end', keep: false },
  ]
  for (const p of probes) {
    if (compute(from, p)) out.add(p.kind)
  }
  return [...out]
}

// ──────────────────────────────────────────────────────────────
// 内部：状态 + 事件 → (to, reason) | null
// ──────────────────────────────────────────────────────────────
function compute(
  from: RequirementStatus,
  ev: RequirementEvent,
): { to: RequirementStatus; reason: string } | null {
  switch (from) {
    case '待分派':
      if (ev.kind === 'assign') {
        return ev.skipClarification
          ? { to: '进行中', reason: 'assign_skip_clarification' }
          : { to: '待澄清', reason: 'assign' }
      }
      if (ev.kind === 'cancel') return { to: '已取消', reason: 'user_cancel' }
      return null

    case '待澄清':
      if (ev.kind === 'clarify_confirmed') return { to: '进行中', reason: 'clarify_confirmed' }
      if (ev.kind === 'cancel') return { to: '已取消', reason: 'user_cancel' }
      return null

    case '进行中':
      if (ev.kind === 'ask_user') return { to: '等待回答', reason: 'ask_user' }
      if (ev.kind === 'deliver') return { to: '待验收', reason: 'deliver' }
      if (ev.kind === 'user_pause') return { to: '已暂停', reason: 'user_pause' }
      if (ev.kind === 'system_pause') return { to: '已暂停', reason: `system:${ev.reason}` }
      if (ev.kind === 'cancel') return { to: '已取消', reason: 'user_cancel_in_progress' }
      if (ev.kind === 'force_end') {
        return ev.keep
          ? { to: '已完成', reason: 'force_end_keep' }
          : { to: '已取消', reason: 'force_end_discard' }
      }
      return null

    case '等待回答':
      if (ev.kind === 'answer') return { to: '进行中', reason: 'answer' }
      if (ev.kind === 'user_pause') return { to: '已暂停', reason: 'user_pause_in_await' }
      if (ev.kind === 'cancel') return { to: '已取消', reason: 'user_cancel' }
      return null

    case '已暂停':
      if (ev.kind === 'resume') return { to: '进行中', reason: 'resume' }
      if (ev.kind === 'cancel') return { to: '已取消', reason: 'user_cancel' }
      if (ev.kind === 'force_end') {
        return ev.keep
          ? { to: '已完成', reason: 'force_end_keep' }
          : { to: '已取消', reason: 'force_end_discard' }
      }
      return null

    case '待验收':
      if (ev.kind === 'approve') return { to: '已完成', reason: 'approve' }
      if (ev.kind === 'reject') return { to: '已驳回', reason: 'reject' }
      return null

    case '已完成':
    case '已驳回':
    case '已取消':
      // 终态：不允许任何转移
      return null

    default: {
      // exhaustive check
      const _: never = from
      throw new Error(`Unknown status: ${String(_)}`)
    }
  }
}

/** 终态判断（UI / scheduler / cleanup 用） */
const TERMINAL: Set<RequirementStatus> = new Set(['已完成', '已驳回', '已取消'])
export function isTerminal(status: RequirementStatus): boolean {
  return TERMINAL.has(status)
}

/** runtime 应当主动驱动的状态（IDLE/STREAMING/...所在主状态） */
export function isExecuting(status: RequirementStatus): boolean {
  return status === '进行中'
}
