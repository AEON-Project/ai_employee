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

// ── emit_skill ──────────────────────────────────────────────
//
// V2 O1 Skills 自演化（参考 hermes-agent agentskills.io）。
// LLM 在完成任务后觉得"这套路值得记下来给未来同员工的同类任务用"时主动调用。
// runtime 写入 memory_items(kind='skill', scope='employee') + 走 RAG 索引；
// 下次同员工接到相似需求时，composer 按相似度 Top-K 自动注入到 system prompt。
export const EmitSkillArgsZ = z.object({
  name: z.string().min(1).max(80),
  /** 1-2 句话说明何时复用这个 skill */
  whenToUse: z.string().min(1),
  /** 多步骤的可复用做法 */
  steps: z.array(z.string().min(1)).min(1),
  /** 关键词（供 LLM 自己写，帮 RAG 检索时命中率高） */
  triggers: z.array(z.string().min(1)).optional(),
})
export type EmitSkillArgs = z.infer<typeof EmitSkillArgsZ>

export const emitSkillTool: ToolDef<EmitSkillArgs, never> = {
  name: 'emit_skill',
  kind: 'system',
  description: [
    '沉淀一个可复用的"做法套路"到当前员工的长期记忆，未来同员工接到相似任务时引擎会自动注入。',
    '何时调用：',
    '  - 任务完成后，回顾整个执行过程，识别出"这是一类可复用的解决套路"',
    '  - 例子："Java 项目添加枚举值"、"修复 React useEffect 死循环"、"诊断 mvn 缺少依赖"',
    '  - 反例：纯一次性的具体修改（"把 main.ts 第 23 行的 foo 改成 bar"）不要 emit_skill',
    '推荐在 emit_deliverable 之前调（先沉淀经验，再交付），但不强制顺序。',
    '若你对当前任务没把握有"套路价值"，不要调；引擎不强制 emit_skill。',
  ].join('\n'),
  inputSchema: EmitSkillArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: '一个简短的 skill 名称，未来在 RAG 里展示。如"Java 枚举新增值"',
      },
      whenToUse: {
        type: 'string',
        minLength: 1,
        description: '1-2 句话说明触发场景与适用条件',
      },
      steps: {
        type: 'array',
        minItems: 1,
        description: '具体可复用的多步骤做法（每步 1 句话即可，不要塞整段命令）',
        items: { type: 'string', minLength: 1 },
      },
      triggers: {
        type: 'array',
        description: '可选：关键词列表，帮未来检索命中（如 ["enum", "java", "枚举"]）',
        items: { type: 'string', minLength: 1 },
      },
    },
    required: ['name', 'whenToUse', 'steps'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('emit_skill must be dispatched by runtime')
  },
}

// ── emit_lesson ─────────────────────────────────────────────
//
// V2 O2 memory 闭环强化（PRD §3「纠错沉淀」核心机制）。
// LLM 在察觉到错误 / 反复失败 / 即将被反馈不满意时主动调用沉淀教训；
// runtime 写入 memory_items(kind='lesson') + 走 RAG 索引；
// 下次同员工或同项目接到相似需求时，composer 按相似度 Top-K 自动注入到 system prompt。
//
// 与 emit_skill 的差异：
//   - skill 是「成功套路」（积极经验），lesson 是「失败教训」（消极经验）
//   - skill 默认 scope=employee；lesson 可选 employee（个人教训）或 project（项目踩坑）
//   - skill 在交付完成后调；lesson 在任何时刻察觉错误时即可调
export const EmitLessonArgsZ = z.object({
  content: z.string().min(1).max(500),
  scope: z.enum(['employee', 'project']),
  /** 可选：1-2 句话说明触发场景，帮 RAG 检索命中率高 */
  context: z.string().optional(),
})
export type EmitLessonArgs = z.infer<typeof EmitLessonArgsZ>

export const emitLessonTool: ToolDef<EmitLessonArgs, never> = {
  name: 'emit_lesson',
  kind: 'system',
  description: [
    '沉淀一条教训到长期记忆，下次同类任务时引擎会自动注入。PRD §3「纠错沉淀」核心机制。',
    '何时调用：',
    '  - 察觉自己犯了可避免的错误（路径搞错 / 工具选错 / 漏掉前置检查）',
    '  - 反复 3 次以上某种失败模式（如"先 sed 后 find"导致 ENOENT）',
    '  - 用户在澄清里指出你之前的做法不对',
    '  - 即将 emit_deliverable，但回顾过程觉得"这次走了弯路，记下来下次不要犯"',
    'scope 选择：',
    '  - employee：个人教训（如"我容易先动手后探索"）',
    '  - project：项目踩坑（如"本项目的 maven 必须先 ./mvnw 而不是全局 mvn"）',
    '如果你对当前任务进行很顺利，不要 emit_lesson；引擎不强制。',
  ].join('\n'),
  inputSchema: EmitLessonArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: '教训正文，一句话总结"下次别再这样"或"下次该这样"',
      },
      scope: {
        type: 'string',
        enum: ['employee', 'project'],
        description:
          'employee = 个人教训（跟员工走） / project = 项目踩坑（跟项目走，需求必须挂在某项目）',
      },
      context: {
        type: 'string',
        description: '可选：1-2 句话补充触发场景，帮未来 RAG 检索命中',
      },
    },
    required: ['content', 'scope'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('emit_lesson must be dispatched by runtime')
  },
}

// ── spawn_employee ──────────────────────────────────────────
//
// V2 O3 sub-agent 协作（PRD「组织+岗位」心智完整性）。
// 父员工把子任务派给另一员工，引擎同步执行子工单后把子员工的 deliverable
// 回传作为父员工的 tool_result，父员工拿到结果继续干。
//
// 防递归：父工单深度 ≤ 1，即子员工不可再 spawn（runtime 检查 parentRequirementId）。
export const SpawnEmployeeArgsZ = z.object({
  /** 目标员工 id */
  targetEmployeeId: z.string().min(1),
  /** 子任务标题 */
  taskTitle: z.string().min(1).max(120),
  /** 子任务详情；将作为子工单 description 直接给子员工看 */
  taskDescription: z.string().min(1),
})
export type SpawnEmployeeArgs = z.infer<typeof SpawnEmployeeArgsZ>

export const spawnEmployeeTool: ToolDef<SpawnEmployeeArgs, never> = {
  name: 'spawn_employee',
  kind: 'system',
  description: [
    '把一个子任务派给另一员工（同项目），引擎同步执行直至子员工交付或暂停，',
    '然后把子员工的 deliverable 作为本 tool 的 result 返回给你。',
    '何时调用：',
    '  - 子任务超出你当前岗位的擅长范围（例如：前端员工遇到后端 SQL 优化子任务）',
    '  - 需要并行视角（例如让测试员工跑一遍 e2e 报告问题）',
    '  - 大任务需要分工（你只做规划，把实施分给执行员工）',
    '注意：',
    '  - 仅能在顶层工单调用；从子工单内再 spawn 会被引擎拒绝（防递归）',
    '  - targetEmployeeId 必须是已存在的员工 id；引擎找不到会写 system/error 不暂停',
    '  - 子员工跑完后 tool_result 含其 deliverable（contentText / summary 摘要）',
    '不要把整个工单都 spawn 出去 — 那只是把责任甩给别人，你自己什么也没干。',
  ].join('\n'),
  inputSchema: SpawnEmployeeArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      targetEmployeeId: {
        type: 'string',
        minLength: 1,
        description: '接活的员工 id（可通过 list_employees 或团队上下文中获取）',
      },
      taskTitle: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: '子任务的简短标题',
      },
      taskDescription: {
        type: 'string',
        minLength: 1,
        description: '子任务详情；写清楚目标 / 约束 / 输入 / 期望产出',
      },
    },
    required: ['targetEmployeeId', 'taskTitle', 'taskDescription'],
    additionalProperties: false,
  },
  invoke: async () => {
    throw new Error('spawn_employee must be dispatched by runtime')
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
  emitSkillTool as ToolDef,
  emitLessonTool as ToolDef,
  spawnEmployeeTool as ToolDef,
]

export const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOLS.map((t) => t.name))
