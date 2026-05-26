/**
 * 每个事件的 Zod schema。
 *
 * 作用：
 *   - 给 WS / HTTP / TG bridge 等跨进程通道做 payload 校验
 *   - dev 模式下用 `assertPayload` 在 emit 路径校验
 * 编译期校验由 EventMap 完成；schemas 是运行期补充。
 */

import { z } from 'zod'
import type { EventMap, EventName } from './event-map.js'
import {
  BUDGET_GATES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MESSAGE_ROLES,
  MESSAGE_TYPES,
  PAUSE_REASONS,
  REQUIREMENT_STATUSES,
} from './types.js'

// ── 基础 schema ────────────────────────────────────────────────
const Id = z.string().min(1)
const NonNegInt = z.number().int().nonnegative()

const RequirementStatusZ = z.enum(REQUIREMENT_STATUSES)
const BudgetGateZ = z.enum(BUDGET_GATES)
const PauseReasonZ = z.enum(PAUSE_REASONS)
const MemoryScopeZ = z.enum(MEMORY_SCOPES)
const MemoryKindZ = z.enum(MEMORY_KINDS)
const MessageRoleZ = z.enum(MESSAGE_ROLES)
const MessageTypeZ = z.enum(MESSAGE_TYPES)

const BudgetUsedZ = z.object({
  iterations: NonNegInt,
  tokensIn: NonNegInt,
  tokensOut: NonNegInt,
  wallTimeMs: NonNegInt,
})

const MemoryItemRefZ = z.object({
  id: Id,
  scope: MemoryScopeZ,
  scopeId: Id,
  kind: MemoryKindZ,
  content: z.string(),
})

const MessageRefZ = z.object({
  id: Id,
  threadId: Id,
  seq: NonNegInt,
  role: MessageRoleZ,
  type: MessageTypeZ,
})

// ── 事件 schema map ────────────────────────────────────────────
// 每条 schema 的 z.infer 必须与 EventMap 对应键的类型一致；
// 通过 `satisfies` 在编译期校验对齐（见底部）。
export const eventSchemas = {
  'requirement.created': z.object({ reqId: Id }),

  'requirement.state_changed': z.object({
    reqId: Id,
    from: RequirementStatusZ,
    to: RequirementStatusZ,
    reason: z.string().optional(),
  }),

  'requirement.clarification_ready': z.object({
    reqId: Id,
    clarificationId: Id,
    round: NonNegInt,
  }),

  'requirement.clarification_answered': z.object({
    reqId: Id,
    clarificationId: Id,
  }),

  'requirement.frame': z.object({
    reqId: Id,
    currentStep: NonNegInt,
    budgetUsed: BudgetUsedZ,
  }),

  'requirement.deliverable_ready': z.object({
    reqId: Id,
    deliverableRef: z.string(),
  }),

  'requirement.completed': z.object({ reqId: Id, reportId: Id }),
  'requirement.rejected': z.object({ reqId: Id, reportId: Id }),
  'requirement.cancelled': z.object({ reqId: Id }),
  'requirement.paused': z.object({ reqId: Id, reason: PauseReasonZ }),

  'message.appended': z.object({
    threadId: Id,
    message: MessageRefZ,
  }),

  // input / result 形状取决于 tool，事件层不校验；EventMap 已标记 optional
  'tool.invoked': z.object({ reqId: Id, tool: z.string(), input: z.unknown() }),
  'tool.result': z.object({
    reqId: Id,
    tool: z.string(),
    result: z.unknown(),
    ok: z.boolean(),
  }),
  'tool.failed': z.object({
    reqId: Id,
    tool: z.string(),
    error: z.string(),
    retryCount: NonNegInt,
  }),

  'budget.warning': z.object({
    reqId: Id,
    gate: BudgetGateZ,
    used: z.number().nonnegative(),
    cap: z.number().positive(),
  }),
  'budget.exceeded': z.object({ reqId: Id, gate: BudgetGateZ }),

  'context.compacted': z.object({
    reqId: Id,
    savedTokens: NonNegInt,
    keptMessages: NonNegInt,
  }),

  'memory.recalled': z.object({
    reqId: Id,
    scope: MemoryScopeZ,
    items: z.array(MemoryItemRefZ),
  }),
  'memory.persisted': z.object({ items: z.array(MemoryItemRefZ) }),
  'memory.pending_review': z.object({
    item: MemoryItemRefZ,
    confidence: z.number().min(0).max(1),
  }),

  'runtime.heartbeat': z.object({ reqId: Id, ts: NonNegInt }),
  'runtime.recovered': z.object({ reqIds: z.array(Id) }),
  'runtime.scheduler_state': z.object({
    active: NonNegInt,
    queued: NonNegInt,
    max: NonNegInt,
  }),

  'tg.message_received': z.object({ chatId: z.number(), raw: z.unknown() }),
  'tg.message_sent': z.object({
    chatId: z.number(),
    msgId: z.number(),
    kind: z.string(),
    refId: z.string(),
  }),
  'tg.error': z.object({ error: z.string(), context: z.unknown().optional() }),
} satisfies { [K in EventName]: z.ZodType<EventMap[K]> }

/** 运行期校验：调用方手动用于跨进程边界（WS/HTTP/TG） */
export function parsePayload<K extends EventName>(name: K, payload: unknown): EventMap[K] {
  return eventSchemas[name].parse(payload) as EventMap[K]
}

/** 仅校验，不抛 — 用于流入端的 soft check */
export function safeParsePayload<K extends EventName>(
  name: K,
  payload: unknown,
): { ok: true; value: EventMap[K] } | { ok: false; error: z.ZodError } {
  const r = eventSchemas[name].safeParse(payload)
  if (r.success) return { ok: true, value: r.data as EventMap[K] }
  return { ok: false, error: r.error }
}
