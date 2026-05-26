/**
 * TG 消息路由 — 把 grammY ctx 解析为意图（command / reply / unknown）。
 *
 * 把"协议解析"与"业务调用"分开，方便单测：
 *   parseUpdate(text, replyTo?) → Intent
 *   handleIntent(intent, ctx)   → 调 core/runtime + 回复 TG
 */

export type Intent =
  | { kind: 'new'; employeeName: string; description: string }
  | { kind: 'list'; filter?: string }
  | { kind: 'req'; reqIdPrefix: string }
  | { kind: 'pause'; reqIdPrefix: string }
  | { kind: 'resume'; reqIdPrefix: string }
  | { kind: 'cancel'; reqIdPrefix: string }
  | { kind: 'approve'; reqIdPrefix: string }
  | { kind: 'reject'; reqIdPrefix: string }
  | { kind: 'who' }
  | { kind: 'help' }
  | { kind: 'answer'; replyToMsgId: number; answer: string }
  | { kind: 'unknown'; text: string }

export function parseUpdate(text: string, replyToMsgId?: number): Intent {
  const trimmed = text.trim()

  // reply 优先：用户回复某条 bot 消息 → 视作 answer
  if (replyToMsgId != null && !trimmed.startsWith('/')) {
    return { kind: 'answer', replyToMsgId, answer: trimmed }
  }

  if (!trimmed.startsWith('/')) {
    return { kind: 'unknown', text: trimmed }
  }

  const [head, ...rest] = trimmed.slice(1).split(/\s+/)
  const args = rest.join(' ').trim()

  switch (head?.toLowerCase()) {
    case 'new': {
      // /new <员工名> <描述...>
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args)
      if (!m) return { kind: 'help' }
      return { kind: 'new', employeeName: m[1]!, description: m[2]!.trim() }
    }
    case 'list':
      return { kind: 'list', filter: args || undefined }
    case 'req':
      return { kind: 'req', reqIdPrefix: args }
    case 'pause':
      return { kind: 'pause', reqIdPrefix: args }
    case 'resume':
      return { kind: 'resume', reqIdPrefix: args }
    case 'cancel':
      return { kind: 'cancel', reqIdPrefix: args }
    case 'approve':
      return { kind: 'approve', reqIdPrefix: args }
    case 'reject':
      return { kind: 'reject', reqIdPrefix: args }
    case 'who':
      return { kind: 'who' }
    case 'help':
    case 'start':
      return { kind: 'help' }
    default:
      return { kind: 'unknown', text: trimmed }
  }
}

/** 把 reqId 前缀 → 完整 reqId（最少 6 字符） */
export function matchReqIdPrefix(
  prefix: string,
  ids: string[],
): { reqId: string } | { error: string } {
  const p = prefix.trim()
  if (p.length < 4) return { error: 'reqId 前缀至少 4 字符' }
  const matches = ids.filter((id) => id.startsWith(p))
  if (matches.length === 0) return { error: `未找到 reqId 前缀 ${p}` }
  if (matches.length > 1) return { error: `前缀歧义：匹配到 ${matches.length} 条，请用更长的前缀` }
  return { reqId: matches[0]! }
}

export const HELP_TEXT = `📋 ai-emp 命令

/new <员工名> <描述>           新建需求 + 触发澄清
/list                          列出活跃需求
/req <reqId 前缀>              查看一条需求当前状态
/pause <reqId>  /resume <id>   暂停 / 继续
/cancel <reqId>                取消
/approve <reqId>  /reject <id> 验收 / 驳回
/who                           列出员工
/help                          本帮助

💡 回复 bot 的提问消息可直接回答澄清。`
