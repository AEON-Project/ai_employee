/**
 * Events 层用到的最小 domain 类型。
 *
 * 这里只放 events payload 里直接引用的类型；完整领域模型（Employee/Skill/...）
 * 在 T0.4 后落到 @ai-emp/core/domain，那时候本文件保留这层的"精简快照"角色，
 * 让 events 包零依赖 core（避免循环依赖）。
 */

// ── ID 别名（运行时都是 uuid string，但用别名提高可读性） ─────────
export type RequirementId = string
export type EmployeeId = string
export type ProjectId = string
export type ThreadId = string
export type MessageId = string
export type ClarificationId = string
export type ReportId = string

// ── 状态机 ────────────────────────────────────────────────────
export const REQUIREMENT_STATUSES = [
  '待分派',
  '待澄清',
  '进行中',
  '等待回答',
  '已暂停',
  '待验收',
  '已完成',
  '已驳回',
  '已取消',
] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

// ── Budget ────────────────────────────────────────────────────
export const BUDGET_GATES = ['iterations', 'tokens', 'wallTime'] as const
export type BudgetGate = (typeof BUDGET_GATES)[number]

export interface BudgetUsed {
  iterations: number
  tokensIn: number
  tokensOut: number
  wallTimeMs: number
}

export interface BudgetCap {
  maxIterations: number
  maxTokens: number
  maxWallTimeMs: number
}

// ── PauseReason ───────────────────────────────────────────────
export const PAUSE_REASONS = [
  'user',
  'budget_iterations',
  'budget_tokens',
  'budget_walltime',
  'llm_error',
  'tool_fatal',
  'system',
] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

// ── Memory ────────────────────────────────────────────────────
export const MEMORY_SCOPES = ['project', 'employee'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_KINDS = ['fact', 'pitfall', 'lesson'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** events 里只引用 MemoryItem 的"轻量引用"，完整结构在 storage 层 */
export interface MemoryItemRef {
  id: string
  scope: MemoryScope
  scopeId: string
  kind: MemoryKind
  content: string
}

// ── Message ───────────────────────────────────────────────────
export const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

export const MESSAGE_TYPES = [
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'clarification_request',
  'clarification_answer',
  'plan_update',
  'error',
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

/** events 里用 MessageRef 而不是完整 Message（避免把 content_json 推到所有订阅者） */
export interface MessageRef {
  id: MessageId
  threadId: ThreadId
  seq: number
  role: MessageRole
  type: MessageType
}
