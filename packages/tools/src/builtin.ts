/**
 * 内置系统级工具（4 个）。
 *
 * 关键约定：这些工具的 `invoke` 是 **占位** —— 真正语义由 runtime dispatcher 解释。
 * 例如 LLM 发出 `ask_user` tool_call，runtime 不会调用此处 invoke，而是：
 *   - 写入 clarifications 表（round++）
 *   - 把 Requirement.status 转为 '等待回答'
 *   - 终止当前执行循环
 *
 * Schemas 起到的作用：
 *   - 给 LLM tool_use 注册 input schema
 *   - ToolRegistry / tools 表的元数据
 */

import { z } from 'zod'
import { AnswerModeZ, ClarificationTriggerZ, PlanZ } from '@ai-emp/domain'
import type { ToolDef } from './types.js'

// ── ask_user ────────────────────────────────────────────────
export const AskUserArgsZ = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        // LLM 可建议回答模式；默认 'user'
        answerMode: AnswerModeZ.optional(),
      }),
    )
    .min(1),
  trigger_reason: ClarificationTriggerZ,
})
export type AskUserArgs = z.infer<typeof AskUserArgsZ>

export const askUserTool: ToolDef<AskUserArgs, never> = {
  name: 'ask_user',
  kind: 'system',
  description: [
    '向用户发起澄清提问，立即暂停当前执行直到用户回答。',
    '仅在以下场景使用：',
    '  - decision_split: 方案 A vs B 不可自行决断',
    '  - missing_info:  关键事实/参数缺失，无法继续',
    '  - judgment:      多个候选都说得通，需用户选偏好',
    '  - pitfall_hit:   察觉到本项目 pitfall 命中，先与用户确认',
    '  - cost_alert:    预估接下来要超出 budget，请用户决定是否继续',
    '⚠️ 不要把问题写在 text 输出中 — 必须以结构化 questions 数组传入；',
    '   每个 question 是一个独立可单独回答的问题对象 { question: string }。',
  ].join('\n'),
  inputSchema: AskUserArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        description: '具体问题列表；每条单独可答；不要嵌入说明文字，只放问句。',
        items: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, description: '问题原文' },
            answerMode: {
              type: 'string',
              enum: ['user', 'auto_proceed'],
              description: 'user=必须用户回答；auto_proceed=用户超时可自动放过',
            },
          },
        },
      },
      trigger_reason: {
        type: 'string',
        enum: ['decision_split', 'missing_info', 'judgment', 'pitfall_hit', 'cost_alert'],
        description: '本次澄清的触发原因，必填。',
      },
    },
    required: ['questions', 'trigger_reason'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('ask_user must be dispatched by runtime, not invoked here')
  },
}

// ── advance_step ────────────────────────────────────────────
export const AdvanceStepArgsZ = z.object({
  /** 完成的本步 idx；引擎据此推进 currentStep */
  step_idx: z.number().int().nonnegative(),
  /** 本步总结，会写入 thread message */
  summary: z.string().min(1),
})
export type AdvanceStepArgs = z.infer<typeof AdvanceStepArgsZ>

export const advanceStepTool: ToolDef<AdvanceStepArgs, never> = {
  name: 'advance_step',
  kind: 'system',
  description:
    '声明已完成 plan 中的某一步，引擎据此推进 currentStep。在该步骤产出已写入交付或 plan 已无后续时使用。',
  inputSchema: AdvanceStepArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      step_idx: { type: 'integer', minimum: 0, description: '已完成的步骤 index' },
      summary: { type: 'string', minLength: 1, description: '本步骤总结，写入思维链' },
    },
    required: ['step_idx', 'summary'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('advance_step must be dispatched by runtime')
  },
}

// ── update_plan ─────────────────────────────────────────────
export const UpdatePlanArgsZ = z.object({
  plan: PlanZ,
  reason: z.string().min(1),
})
export type UpdatePlanArgs = z.infer<typeof UpdatePlanArgsZ>

export const updatePlanTool: ToolDef<UpdatePlanArgs, never> = {
  name: 'update_plan',
  kind: 'system',
  description:
    '更新执行计划。当发现原计划缺失步骤、顺序需调整或被用户改计划时使用；引擎据此覆写 Requirement.plan。',
  inputSchema: UpdatePlanArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['idx', 'text', 'status'],
              properties: {
                idx: { type: 'integer', minimum: 0 },
                text: { type: 'string', minLength: 1 },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done', 'skipped'],
                },
              },
            },
          },
        },
        required: ['steps'],
      },
      reason: { type: 'string', minLength: 1, description: '改计划原因，必填' },
    },
    required: ['plan', 'reason'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('update_plan must be dispatched by runtime')
  },
}

// ── emit_deliverable ────────────────────────────────────────
export const EmitDeliverableArgsZ = z.object({
  /** 交付物相对路径（attachments/<reqId>/<path>）或纯文本（短文交付） */
  contentText: z.string().optional(),
  contentRef: z.string().optional(),
  /** 给用户的一段交付说明 */
  summary: z.string().min(1),
})
export type EmitDeliverableArgs = z.infer<typeof EmitDeliverableArgsZ>

export const emitDeliverableTool: ToolDef<EmitDeliverableArgs, never> = {
  name: 'emit_deliverable',
  kind: 'system',
  description:
    '交付最终产物，将 Requirement 推进到 "待验收"。contentText 或 contentRef 至少有一个，附加一段 summary 说明。',
  inputSchema: EmitDeliverableArgsZ.refine(
    (v) => v.contentText !== undefined || v.contentRef !== undefined,
    { message: 'contentText 与 contentRef 至少有一个' },
  ),
  inputJsonSchema: {
    type: 'object',
    properties: {
      contentText: {
        type: 'string',
        description: '短文交付，直接写在这里（与 contentRef 二选一）',
      },
      contentRef: {
        type: 'string',
        description: 'attachments/<reqId>/<path> 相对路径（与 contentText 二选一）',
      },
      summary: { type: 'string', minLength: 1, description: '给用户的交付说明，必填' },
    },
    required: ['summary'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('emit_deliverable must be dispatched by runtime')
  },
}

/**
 * 全部系统级 tool 列表，registry 启动时一次注册。
 * 用 `ToolDef[]` 类型存储时各项 I/O 泛型实例化为 unknown — 数组元素只读，安全。
 */
export const SYSTEM_TOOLS: ToolDef[] = [
  askUserTool as ToolDef,
  advanceStepTool as ToolDef,
  updatePlanTool as ToolDef,
  emitDeliverableTool as ToolDef,
]

export const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOLS.map((t) => t.name))
