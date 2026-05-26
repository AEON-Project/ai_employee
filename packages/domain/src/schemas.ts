/**
 * Zod schemas — 与 types.ts 的类型一一对应。
 *
 * 用于：
 *   - HTTP / WS / TG bridge 边界的运行期校验
 *   - storage JSON 字段解码后的形状验证（可选）
 *   - tool 输入参数 schema（registry 自动 zod → JSON Schema 转换）
 */

import { z } from 'zod'
import {
  ACTIVE_STATUSES,
  ANSWER_MODES,
  BUDGET_GATES,
  CLARIFICATION_TRIGGERS,
  CONVENTION_ENFORCEMENT,
  CONVENTION_SOURCES,
  CREDENTIAL_KINDS,
  LLM_PROVIDERS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MESSAGE_ROLES,
  MESSAGE_TYPES,
  PAUSE_REASONS,
  PRIORITIES,
  PROJECT_KNOWLEDGE_STATUSES,
  REPORT_GENERATED_BY,
  REQUIREMENT_STATUSES,
  SKILL_CATEGORIES,
  SOURCE_TYPES,
  STEP_STATUSES,
  USER_FEEDBACK_VALUES,
  type BudgetCap,
  type BudgetUsed,
  type ClarificationQuestion,
  type EmployeeStats,
  type MessageContent,
  type ModelConfig,
  type Plan,
  type PlanStep,
  type ReportMetrics,
  type SkillExample,
  type TokenUsage,
} from './types.js'

// ── 基础 ──────────────────────────────────────────────────────
const Id = z.string().min(1)
const NonNegInt = z.number().int().nonnegative()
const NonNegNum = z.number().nonnegative()

// ── enum ─────────────────────────────────────────────────────
export const RequirementStatusZ = z.enum(REQUIREMENT_STATUSES)
export const PriorityZ = z.enum(PRIORITIES)
export const BudgetGateZ = z.enum(BUDGET_GATES)
export const PauseReasonZ = z.enum(PAUSE_REASONS)
export const ClarificationTriggerZ = z.enum(CLARIFICATION_TRIGGERS)
export const AnswerModeZ = z.enum(ANSWER_MODES)
export const SkillCategoryZ = z.enum(SKILL_CATEGORIES)
export const MemoryScopeZ = z.enum(MEMORY_SCOPES)
export const MemoryKindZ = z.enum(MEMORY_KINDS)
export const UserFeedbackZ = z.enum(USER_FEEDBACK_VALUES)
export const ConventionEnforcementZ = z.enum(CONVENTION_ENFORCEMENT)
export const ConventionSourceZ = z.enum(CONVENTION_SOURCES)
export const SourceTypeZ = z.enum(SOURCE_TYPES)
export const MessageRoleZ = z.enum(MESSAGE_ROLES)
export const MessageTypeZ = z.enum(MESSAGE_TYPES)
export const StepStatusZ = z.enum(STEP_STATUSES)
export const LLMProviderZ = z.enum(LLM_PROVIDERS)
export const CredentialKindZ = z.enum(CREDENTIAL_KINDS)
export const ActiveStatusZ = z.enum(ACTIVE_STATUSES)
export const ProjectKnowledgeStatusZ = z.enum(PROJECT_KNOWLEDGE_STATUSES)
export const ReportGeneratedByZ = z.enum(REPORT_GENERATED_BY)

// ── object schemas ────────────────────────────────────────────
export const BudgetCapZ: z.ZodType<BudgetCap> = z.object({
  maxIterations: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxWallTimeMs: z.number().int().positive(),
})

export const BudgetUsedZ: z.ZodType<BudgetUsed> = z.object({
  iterations: NonNegInt,
  tokensIn: NonNegInt,
  tokensOut: NonNegInt,
  wallTimeMs: NonNegInt,
})

export const PlanStepZ: z.ZodType<PlanStep> = z.object({
  idx: NonNegInt,
  text: z.string(),
  status: StepStatusZ,
})

export const PlanZ: z.ZodType<Plan> = z.object({
  steps: z.array(PlanStepZ),
})

export const TokenUsageZ: z.ZodType<TokenUsage> = z.object({
  input: NonNegInt,
  output: NonNegInt,
  cached: NonNegInt.optional(),
})

export const ClarificationQuestionZ: z.ZodType<ClarificationQuestion> = z.object({
  question: z.string(),
  answer: z.string().optional(),
  answerMode: AnswerModeZ,
})

export const SkillExampleZ: z.ZodType<SkillExample> = z.object({
  input: z.string(),
  output: z.string(),
})

export const EmployeeStatsZ: z.ZodType<EmployeeStats> = z.object({
  completedCount: NonNegInt,
  avgDurationMs: NonNegNum,
  successRate: z.number().min(0).max(1),
})

export const ReportMetricsZ: z.ZodType<ReportMetrics> = z.object({
  durationMs: NonNegInt,
  tokens: TokenUsageZ,
  iterations: NonNegInt,
  rejected: z.boolean(),
})

export const ModelConfigZ: z.ZodType<ModelConfig> = z.object({
  provider: LLMProviderZ,
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  keyRef: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
})

export const MessageContentZ: z.ZodType<MessageContent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    name: z.string(),
    args: z.unknown(),
    callId: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_update'),
    plan: PlanZ,
    reason: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    fatal: z.boolean(),
  }),
])

// re-export IdZ for convenience
export { Id as IdZ }
