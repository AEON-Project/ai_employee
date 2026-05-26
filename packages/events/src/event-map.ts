/**
 * EventMap — 全部事件名 → payload 类型映射。
 * 对应 ARCHITECTURE §10 完整事件目录。
 *
 * 任何向 EventBus emit 的 payload 都通过此 map 做编译期检查。
 * 运行期校验见 ./schemas.ts。
 */

import type {
  BudgetGate,
  BudgetUsed,
  ClarificationId,
  MemoryItemRef,
  MemoryScope,
  MessageRef,
  PauseReason,
  ReportId,
  RequirementId,
  RequirementStatus,
  ThreadId,
} from './types.js'

export interface EventMap {
  // ── requirement.* ─────────────────────────────────────────
  'requirement.created': { reqId: RequirementId }
  'requirement.state_changed': {
    reqId: RequirementId
    from: RequirementStatus
    to: RequirementStatus
    reason?: string
  }
  'requirement.clarification_ready': {
    reqId: RequirementId
    clarificationId: ClarificationId
    round: number
  }
  'requirement.clarification_answered': {
    reqId: RequirementId
    clarificationId: ClarificationId
  }
  'requirement.frame': {
    reqId: RequirementId
    currentStep: number
    budgetUsed: BudgetUsed
  }
  'requirement.deliverable_ready': {
    reqId: RequirementId
    deliverableRef: string
  }
  'requirement.completed': { reqId: RequirementId; reportId: ReportId }
  'requirement.rejected': { reqId: RequirementId; reportId: ReportId }
  'requirement.cancelled': { reqId: RequirementId }
  'requirement.paused': { reqId: RequirementId; reason: PauseReason }

  // ── message.* ─────────────────────────────────────────────
  'message.appended': { threadId: ThreadId; message: MessageRef }

  // ── tool.* ────────────────────────────────────────────────
  // 注：input/result 类型不固定（不同 tool 形状不一）。设为 optional unknown，
  //     避免与 zod object 的 unknown→optional 推断产生类型冲突；
  //     消费方负责按 tool name 做二次 cast/parse。
  'tool.invoked': { reqId: RequirementId; tool: string; input?: unknown }
  'tool.result': {
    reqId: RequirementId
    tool: string
    result?: unknown
    ok: boolean
  }
  'tool.failed': {
    reqId: RequirementId
    tool: string
    error: string
    retryCount: number
  }

  // ── budget.* ──────────────────────────────────────────────
  'budget.warning': {
    reqId: RequirementId
    gate: BudgetGate
    used: number
    cap: number
  }
  'budget.exceeded': { reqId: RequirementId; gate: BudgetGate }

  // ── context.* ─────────────────────────────────────────────
  'context.compacted': {
    reqId: RequirementId
    savedTokens: number
    keptMessages: number
  }

  // ── memory.* ──────────────────────────────────────────────
  'memory.recalled': {
    reqId: RequirementId
    scope: MemoryScope
    items: MemoryItemRef[]
  }
  'memory.persisted': { items: MemoryItemRef[] }
  'memory.pending_review': { item: MemoryItemRef; confidence: number }

  // ── runtime.* ─────────────────────────────────────────────
  'runtime.heartbeat': { reqId: RequirementId; ts: number }
  'runtime.recovered': { reqIds: RequirementId[] }
  'runtime.scheduler_state': { active: number; queued: number; max: number }

  // ── tg.* (bridge 自有) ────────────────────────────────────
  'tg.message_received': { chatId: number; raw?: unknown }
  'tg.message_sent': {
    chatId: number
    msgId: number
    kind: string
    refId: string
  }
  'tg.error': { error: string; context?: unknown }
}

export type EventName = keyof EventMap
