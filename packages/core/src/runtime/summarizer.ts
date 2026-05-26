/**
 * Context 长度超限自动摘要（PRD §9.5）。
 *
 * 触发条件：runtime 累计 tokens 接近 model.contextWindow * 0.8 时调 compact()，
 * 把"早期 N 条 messages"压缩成 1-2 段摘要，写入 runtime_state.history_summary。
 *
 * 实现简化：让 LLM 用一个单独 complete() 调用生成摘要文本；
 * 不动 messages 表（保留 append-only），只把 historySummary 注入到下一次 prompt。
 */

import type { Repos } from '@ai-emp/storage'

export interface CompactInput {
  threadId: string
  /** 保留尾部最近 N 条原文，前面的统统压成摘要 */
  keepRecent: number
  /** LLM summarize 函数（runtime 注入；可用 mock 测试） */
  summarize: (text: string) => Promise<string>
}

export interface CompactResult {
  /** 新生成的摘要文本 */
  summary: string
  /** 被压缩的 messages 数量 */
  compactedCount: number
  /** 估算压缩前/后字符数 */
  savedChars: number
}

const PROMPT_TEMPLATE = `请把以下对话压缩为 1-2 段简洁的摘要（≤ 300 字），
保留：决策、关键事实、被用户认可/否定的内容；丢弃：闲聊、重复表达。

对话历史：
---
{HISTORY}
---

摘要：`

export async function compactThreadHistory(
  repos: Repos,
  input: CompactInput,
): Promise<CompactResult> {
  const all = repos.messages.listByThread(input.threadId)
  if (all.length <= input.keepRecent) {
    return { summary: '', compactedCount: 0, savedChars: 0 }
  }
  const toCompact = all.slice(0, all.length - input.keepRecent)
  const text = toCompact
    .map((m) => {
      const c = m.contentJson as { type?: string; text?: string }
      const body = c.text ?? JSON.stringify(c)
      return `[${m.role}/${m.type}] ${body}`
    })
    .join('\n')

  const before = text.length
  const summary = await input.summarize(PROMPT_TEMPLATE.replace('{HISTORY}', text))
  return {
    summary: summary.trim(),
    compactedCount: toCompact.length,
    savedChars: before - summary.length,
  }
}

/** 估算 messages 总 tokens（粗略：字符数 / 2，留 safety factor 1.2） */
export function estimateTokens(messages: { content?: string; text?: string }[]): number {
  let total = 0
  for (const m of messages) {
    const t = m.content ?? m.text ?? ''
    total += t.length / 2
  }
  return Math.round(total * 1.2)
}

/** 判定是否触发摘要：累计 tokens > contextWindow * threshold */
export function shouldCompact(
  totalTokens: number,
  contextWindow: number,
  threshold = 0.8,
): boolean {
  return totalTokens > contextWindow * threshold
}
