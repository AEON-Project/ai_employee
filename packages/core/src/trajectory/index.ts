/**
 * V2 O11 Trajectory dump — 把工单的完整 thread 导出为 OpenAI chat 格式。
 *
 * 目的：调试 / 备份 / 分享 — 不是为了训练 LLM（§14.5 边界明确不抄
 * hermes trajectory_compressor 训练管道，只做基础导出）。
 *
 * 输出格式（OpenAI chat 兼容）：
 *   { role: 'system'   | 'user' | 'assistant' | 'tool',
 *     content?: string,
 *     tool_calls?: [{ id, type: 'function', function: { name, arguments } }],
 *     tool_call_id?: string }
 *
 * 简化规则：
 *   - thinking / text / clarification_* / plan_update / error 都映射成 string content
 *   - tool_call → assistant 角色 + tool_calls 字段
 *   - tool_result → tool 角色 + tool_call_id + content（JSON-stringify 的 value/error）
 */

import type { Repos } from '@ai-emp/storage'

export interface TrajectoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface TrajectoryDump {
  requirementId: string
  title: string
  description: string
  status: string
  createdAt: string
  completedAt: string | null
  messages: TrajectoryMessage[]
}

export function extractTrajectory(repos: Repos, reqId: string): TrajectoryDump {
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  const thread = repos.threads.findByRequirement(reqId)

  const messages: TrajectoryMessage[] = []
  // 首条：把 title + description 作为 user prompt
  messages.push({ role: 'user', content: `# ${req.title}\n\n${req.description}` })

  if (!thread) {
    return {
      requirementId: reqId,
      title: req.title,
      description: req.description,
      status: req.status,
      createdAt: req.createdAt.toISOString(),
      completedAt: req.completedAt ? req.completedAt.toISOString() : null,
      messages,
    }
  }

  const rows = repos.messages.listByThread(thread.id)
  for (const m of rows) {
    const c = m.contentJson as Record<string, unknown>
    if (!c || typeof c !== 'object') continue
    const ct = c.type as string | undefined

    if (m.role === 'user' && ct === 'clarification_answer') {
      const answers = (c.answers ?? []) as Array<{ question?: string; answer?: string }>
      const text = answers.map((a) => `Q: ${a.question ?? ''}\nA: ${a.answer ?? ''}`).join('\n\n')
      messages.push({ role: 'user', content: text })
      continue
    }
    if (m.role === 'user' && (ct === 'text' || ct === 'thinking')) {
      messages.push({ role: 'user', content: String(c.text ?? '') })
      continue
    }

    if (m.role === 'assistant') {
      if (ct === 'tool_call') {
        messages.push({
          role: 'assistant',
          tool_calls: [
            {
              id: String(c.callId ?? ''),
              type: 'function',
              function: {
                name: String(c.name ?? ''),
                arguments: JSON.stringify(c.args ?? {}),
              },
            },
          ],
        })
        continue
      }
      if (ct === 'plan_update') {
        messages.push({
          role: 'assistant',
          content: `[plan_update] ${String(c.reason ?? '')}\n${JSON.stringify(c.plan ?? {})}`,
        })
        continue
      }
      if (ct === 'clarification_request') {
        messages.push({ role: 'assistant', content: `[ask_user] ${String(c.text ?? '')}` })
        continue
      }
      if (ct === 'text' || ct === 'thinking') {
        const prefix = ct === 'thinking' ? '[thinking] ' : ''
        messages.push({ role: 'assistant', content: prefix + String(c.text ?? '') })
        continue
      }
    }

    if (m.role === 'tool' && ct === 'tool_result') {
      const value = c.value
      const error = c.error
      const ok = c.ok
      let content: string
      if (ok === false) {
        content = `[error] ${String(error ?? 'unknown')}`
      } else if (typeof value === 'string') {
        content = value
      } else {
        content = JSON.stringify(value ?? null)
      }
      messages.push({
        role: 'tool',
        tool_call_id: String(c.callId ?? ''),
        content,
      })
      continue
    }

    if (m.role === 'system') {
      if (ct === 'text') {
        messages.push({ role: 'system', content: String(c.text ?? '') })
      } else if (ct === 'error') {
        messages.push({ role: 'system', content: `[error] ${String(c.message ?? '')}` })
      }
      continue
    }
  }

  return {
    requirementId: reqId,
    title: req.title,
    description: req.description,
    status: req.status,
    createdAt: req.createdAt.toISOString(),
    completedAt: req.completedAt ? req.completedAt.toISOString() : null,
    messages,
  }
}

/** JSONL 序列化（每条 message 一行） */
export function toJsonl(dump: TrajectoryDump): string {
  const lines: string[] = []
  // 第一行 metadata
  lines.push(
    JSON.stringify({
      __meta__: {
        requirementId: dump.requirementId,
        title: dump.title,
        status: dump.status,
        createdAt: dump.createdAt,
        completedAt: dump.completedAt,
      },
    }),
  )
  for (const m of dump.messages) {
    lines.push(JSON.stringify(m))
  }
  return lines.join('\n') + '\n'
}
