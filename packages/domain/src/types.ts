/**
 * 领域类型 — V1.0 全部 JSON 字段契约 + ID 别名 + enum 集合。
 *
 * 这是单一真实源（single source of truth）：
 *   - storage 用 `import type` 在 drizzle `$type<>()` 引用
 *   - events 共享部分类型（先在 events 包内自己定义，T1.0+ 视情况合并）
 *   - server / web 通过 `import type` 共享
 */

// ──────────────────────────────────────────────────────────────
// ID 别名（运行时都是 uuid string）
// ──────────────────────────────────────────────────────────────
export type ProjectId = string
export type EmployeeId = string
export type SkillId = string
export type RequirementId = string
export type ThreadId = string
export type MessageId = string
export type ClarificationId = string
export type ReportId = string
export type MemoryItemId = string
export type ConventionId = string
export type ToolId = string
export type CredentialRefId = string
export type ChunkId = string

// ──────────────────────────────────────────────────────────────
// 状态机
// ──────────────────────────────────────────────────────────────
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

export const PRIORITIES = ['P0', 'P1', 'P2'] as const
export type Priority = (typeof PRIORITIES)[number]

// ──────────────────────────────────────────────────────────────
// Budget
// ──────────────────────────────────────────────────────────────
export const BUDGET_GATES = ['iterations', 'tokens', 'wallTime'] as const
export type BudgetGate = (typeof BUDGET_GATES)[number]

export interface BudgetCap {
  maxIterations: number
  maxTokens: number
  maxWallTimeMs: number
}

export interface BudgetUsed {
  iterations: number
  tokensIn: number
  tokensOut: number
  wallTimeMs: number
}

export const DEFAULT_BUDGET_CAP: BudgetCap = {
  maxIterations: 30,
  maxTokens: 200_000,
  maxWallTimeMs: 30 * 60 * 1000,
}

// ──────────────────────────────────────────────────────────────
// Plan / Step
// ──────────────────────────────────────────────────────────────
export const STEP_STATUSES = ['pending', 'doing', 'done'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

export interface PlanStep {
  idx: number
  text: string
  status: StepStatus
}

export interface Plan {
  steps: PlanStep[]
}

// ──────────────────────────────────────────────────────────────
// PauseReason
// ──────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────
// Token / Cost
// ──────────────────────────────────────────────────────────────
export interface TokenUsage {
  input: number
  output: number
  cached?: number
}

// ──────────────────────────────────────────────────────────────
// LLM
// ──────────────────────────────────────────────────────────────
export const LLM_PROVIDERS = ['anthropic', 'openai-compat'] as const
export type LLMProvider = (typeof LLM_PROVIDERS)[number]

export interface ModelConfig {
  provider: LLMProvider
  model: string
  baseUrl?: string
  keyRef: string
  temperature?: number
  maxTokens?: number
}

// ──────────────────────────────────────────────────────────────
// Clarification
// ──────────────────────────────────────────────────────────────
export const CLARIFICATION_TRIGGERS = [
  'initial',
  'decision_split',
  'missing_info',
  'pitfall_hit',
  'cost_alert',
  'judgment',
] as const
export type ClarificationTrigger = (typeof CLARIFICATION_TRIGGERS)[number]

export const ANSWER_MODES = ['user', 'auto_proceed'] as const
export type AnswerMode = (typeof ANSWER_MODES)[number]

export interface ClarificationQuestion {
  question: string
  answer?: string
  answerMode: AnswerMode
}

// ──────────────────────────────────────────────────────────────
// Skill
// ──────────────────────────────────────────────────────────────
export const SKILL_CATEGORIES = ['技术', '设计', '内容', '数据', '运营', '通用'] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

export interface SkillExample {
  input: string
  output: string
}

// ──────────────────────────────────────────────────────────────
// Memory
// ──────────────────────────────────────────────────────────────
export const MEMORY_SCOPES = ['project', 'employee'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_KINDS = ['fact', 'pitfall', 'lesson', 'skill'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const USER_FEEDBACK_VALUES = ['none', 'positive', 'negative'] as const
export type UserFeedback = (typeof USER_FEEDBACK_VALUES)[number]

export const CONVENTION_ENFORCEMENT = ['required', 'recommended'] as const
export type ConventionEnforcement = (typeof CONVENTION_ENFORCEMENT)[number]

export const CONVENTION_SOURCES = ['ui', 'agents_md', 'claude_md', 'cursor_rules'] as const
export type ConventionSource = (typeof CONVENTION_SOURCES)[number]

export const SOURCE_TYPES = ['project_desc', 'convention', 'memory_item'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

// ──────────────────────────────────────────────────────────────
// Message
// ──────────────────────────────────────────────────────────────
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

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  // args / value 都是不固定形状的 LLM tool 参数；标记 optional 以与 zod 推断对齐
  | { type: 'tool_call'; name: string; callId: string; args?: unknown }
  | {
      type: 'tool_result'
      callId: string
      ok: boolean
      value?: unknown
      error?: string
    }
  | { type: 'plan_update'; plan: Plan; reason: string }
  | { type: 'error'; message: string; fatal: boolean }

// ──────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────
export interface ReportMetrics {
  durationMs: number
  tokens: TokenUsage
  iterations: number
  rejected: boolean
}

// ──────────────────────────────────────────────────────────────
// Employee Stats
// ──────────────────────────────────────────────────────────────
export interface EmployeeStats {
  completedCount: number
  avgDurationMs: number
  successRate: number
}

// ──────────────────────────────────────────────────────────────
// Credential
// ──────────────────────────────────────────────────────────────
export const CREDENTIAL_KINDS = ['llm_key', 'tg_bot', 'embedding_key', 'localhost_token'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

// ──────────────────────────────────────────────────────────────
// Tool
// ──────────────────────────────────────────────────────────────
export interface ToolResult<T = unknown> {
  ok: boolean
  value?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// Status enums for active/archived
// ──────────────────────────────────────────────────────────────
export const ACTIVE_STATUSES = ['active', 'archived'] as const
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number]

export const PROJECT_KNOWLEDGE_STATUSES = ['idle', 'indexing', 'ready', 'error'] as const
export type ProjectKnowledgeStatus = (typeof PROJECT_KNOWLEDGE_STATUSES)[number]

export const REPORT_GENERATED_BY = ['auto', 'manual'] as const
export type ReportGeneratedBy = (typeof REPORT_GENERATED_BY)[number]
