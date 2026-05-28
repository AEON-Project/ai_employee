/**
 * 最小 PromptComposer（T3.1 会做完整版本）。
 *
 * 当前只拼装：persona / memory_style / plan / 最近 N 条 messages / 需求描述。
 * 复杂的 RAG（facts/pitfalls/lessons/conventions）等 T3.x 补。
 */

import type { Repos } from '@ai-emp/storage'
import type { RuntimeLLMContentBlock } from './services.js'
// 上面 import 在 core 依赖 storage 后可用

export interface MinimalPromptInput {
  reqId: string
  employeeId: string
  threadId: string
  recentMessageCount?: number
}

export interface MinimalPrompt {
  system: string
  messages: {
    role: 'user' | 'assistant'
    content: string | RuntimeLLMContentBlock[]
  }[]
}

// V2 调优：从 10 → 30，对齐 composer.ts；理由见 composer.ts DEFAULT_RECENT 注释
const DEFAULT_RECENT = 30

export function composeMinimalPrompt(repos: Repos, input: MinimalPromptInput): MinimalPrompt {
  const req = repos.requirements.findById(input.reqId)
  if (!req) throw new Error(`requirement not found: ${input.reqId}`)
  const emp = repos.employees.findById(input.employeeId)
  if (!emp) throw new Error(`employee not found: ${input.employeeId}`)

  const skills = repos.skills.listForEmployee(emp.id)
  const mainSkill = skills[0]?.skill
  const otherSkills = skills.slice(1).map((s) => s.skill)

  const systemParts: string[] = []
  systemParts.push(`# 你是一个 AI 员工`, `## 角色\n${emp.role}`)
  if (emp.persona) systemParts.push(`## 人设\n${emp.persona}`)
  if (emp.memoryStyleText) systemParts.push(`## 工作风格\n${emp.memoryStyleText}`)
  if (mainSkill) {
    systemParts.push(
      `## 主技能：${mainSkill.name}\n${mainSkill.promptTemplate || mainSkill.description}`,
    )
  }
  if (otherSkills.length > 0) {
    systemParts.push(
      `## 额外能力（参考使用）\n${otherSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`,
    )
  }
  if (req.planJson) {
    const stepsTxt = req.planJson.steps.map((s) => `  ${s.idx}. [${s.status}] ${s.text}`).join('\n')
    systemParts.push(`## 当前 Plan\n${stepsTxt}`)
  }
  systemParts.push(
    [
      '## 协作规则',
      '- 你可以调用以下系统工具：',
      '  - `advance_step`：完成 plan 中一步后调用',
      '  - `update_plan`：当需要调整计划时调用',
      '  - `ask_user`：方案分歧 / 关键信息缺失时调用',
      '  - `emit_deliverable`：交付最终产物，进入 待验收 状态',
      '- 默认行为：当本步骤产出已写入交付，**必须** 调用 advance_step',
    ].join('\n'),
  )

  const system = systemParts.join('\n\n')

  // 最近 N 条 messages 转 chat 历史
  const recent = repos.messages.tailByThread(
    input.threadId,
    input.recentMessageCount ?? DEFAULT_RECENT,
  )
  const messages: MinimalPrompt['messages'] = []
  // 需求描述作为第一条 user message
  messages.push({ role: 'user', content: `# 需求\n${req.title}\n\n${req.description}` })
  // V2 P0 bug 4 修复：输出结构化 LLMContentBlock，让 provider 翻译 tool_use/tool_result
  for (const m of recent) {
    const block = extractBlock(m.contentJson)
    if (!block) continue
    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: [block] })
    } else if (m.role === 'tool' || m.role === 'user') {
      messages.push({ role: 'user', content: [block] })
    }
  }

  return { system, messages }
}

function extractBlock(c: unknown): RuntimeLLMContentBlock | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const ty = typeof o.type === 'string' ? o.type : ''
  if (ty === 'text' || ty === 'thinking') {
    return typeof o.text === 'string' ? { type: 'text', text: o.text } : null
  }
  if (ty === 'plan_update') {
    return {
      type: 'text',
      text: `plan_update: ${typeof o.reason === 'string' ? o.reason : ''}`,
    }
  }
  if (ty === 'tool_call') {
    const name = typeof o.name === 'string' ? o.name : '?'
    const callId = typeof o.callId === 'string' ? o.callId : ''
    if (!callId) return null
    return { type: 'tool_call', callId, name, args: o.args ?? {} }
  }
  if (ty === 'tool_result') {
    const callId = typeof o.callId === 'string' ? o.callId : ''
    if (!callId) return null
    const ok = o.ok
    const value = o.value
    const error = typeof o.error === 'string' ? o.error : null
    if (ok === false) {
      return {
        type: 'tool_result',
        callId,
        output: `error: ${error ?? 'unknown'}`,
        isError: true,
      }
    }
    if (typeof value === 'string') {
      return { type: 'tool_result', callId, output: value.slice(0, 2000) }
    }
    return {
      type: 'tool_result',
      callId,
      output: JSON.stringify(value ?? null).slice(0, 2000),
    }
  }
  return null
}
