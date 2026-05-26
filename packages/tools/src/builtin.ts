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
  description:
    '向用户发起澄清提问，立即暂停当前执行直到用户回答。仅在方案分歧 / 关键信息缺失等场景使用。',
  inputSchema: AskUserArgsZ,
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
