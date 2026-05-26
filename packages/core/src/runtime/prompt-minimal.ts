/**
 * 最小 PromptComposer（T3.1 会做完整版本）。
 *
 * 当前只拼装：persona / memory_style / plan / 最近 N 条 messages / 需求描述。
 * 复杂的 RAG（facts/pitfalls/lessons/conventions）等 T3.x 补。
 */

import type { Repos } from '@ai-emp/storage'
// 上面 import 在 core 依赖 storage 后可用

export interface MinimalPromptInput {
  reqId: string
  employeeId: string
  threadId: string
  recentMessageCount?: number
}

export interface MinimalPrompt {
  system: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

const DEFAULT_RECENT = 10

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
  for (const m of recent) {
    const text = extractText(m.contentJson)
    if (!text) continue
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: text })
    } else if (m.role === 'tool') {
      messages.push({ role: 'assistant', content: `[tool] ${text}` })
    }
  }

  return { system, messages }
}

function extractText(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null
  const o = c as { type?: string; text?: string; summary?: string; reason?: string }
  if (o.type === 'text' || o.type === 'thinking') return o.text ?? null
  if (o.type === 'plan_update') return `plan_update: ${o.reason ?? ''}`
  if (o.type === 'tool_result') return `tool_result`
  return null
}
