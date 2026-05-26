/**
 * Telegram Bridge — grammY long-polling + 命令路由 + 流式推送。
 *
 * 设计要点：
 *   - 单 bot 代表整个员工团队；通过 `/new <员工名> ...` 路由到具体员工
 *   - 白名单 chat_id 之外的消息全部丢弃
 *   - 思维链 thinking/text 走节流 edit；状态变更 / 澄清 / 交付走新消息
 *   - 用户 reply bot 提问消息 → 自动答澄清（reply_to_message.message_id 反查 tg_message_links）
 */

import { Bot, type Context } from 'grammy'
import type { EventMap, TypedEventBus } from '@ai-emp/events'
import type { Repos } from '@ai-emp/storage'
import {
  answerClarification,
  approveRequirement,
  assignRequirement,
  cancelRequirement,
  pauseRequirement,
  rejectRequirement,
  resumeRequirement,
  type RuntimeServices,
} from '@ai-emp/core/runtime'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { HELP_TEXT, matchReqIdPrefix, parseUpdate, type Intent } from './router.js'
import { MessageStreamer } from './throttle.js'

export interface BridgeOptions {
  /** TG bot token */
  token: string
  /** 白名单 chat id（仅这些 chat 的消息会被处理） */
  allowedChatIds: number[]
  /** 浏览器查看链接前缀（如 http://localhost:7878） */
  webUrlBase?: string
}

export interface BridgeHandle {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface BridgeDeps {
  services: RuntimeServices
  bus: TypedEventBus<EventMap>
  repos: Repos
}

/** 每个需求一个 thinking streamer */
interface ReqStreamSession {
  reqId: string
  chatId: number
  thinkingStreamer: MessageStreamer | null
}

export function createBridge(deps: BridgeDeps, opts: BridgeOptions): BridgeHandle {
  const bot = new Bot(opts.token)
  const allowed = new Set(opts.allowedChatIds)
  const sessions = new Map<string, ReqStreamSession>()
  const unsubs: (() => void)[] = []

  // ── 白名单中间件 ────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (chatId == null || !allowed.has(chatId)) return // 静默丢弃
    await next()
  })

  // ── 入站消息路由 ────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    const replyTo = ctx.message.reply_to_message?.message_id
    const intent = parseUpdate(text, replyTo)
    try {
      await handleIntent(intent, ctx, deps, opts, sessions)
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`).catch(() => {})
    }
  })

  // ── EventBus 订阅 → 推送 TG ─────────────────────────────────
  unsubs.push(
    deps.bus.on('requirement.state_changed', async (p) => {
      const s = sessions.get(p.reqId)
      if (!s) return
      if (s.thinkingStreamer) await s.thinkingStreamer.reset()
      s.thinkingStreamer = null
      await bot.api
        .sendMessage(s.chatId, `状态：${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`)
        .catch(() => {})
    }),
  )

  unsubs.push(
    deps.bus.on('message.appended', async (p) => {
      const session = findSessionByThreadId(deps.repos, sessions, p.threadId)
      if (!session) return
      if (p.message.type !== 'thinking' && p.message.type !== 'text') return

      // 反查 message content_json 取文本
      const all = deps.repos.messages.listByThread(p.threadId, { sinceSeq: p.message.seq - 1 })
      const m = all.find((x) => x.id === p.message.id)
      const text = extractMessageText(m?.contentJson)
      if (!text) return

      if (!session.thinkingStreamer) {
        session.thinkingStreamer = new MessageStreamer(
          {
            send: async (txt) => {
              const r = await bot.api.sendMessage(session.chatId, txt)
              deps.repos.tgMessageLinks.insert({
                chatId: session.chatId,
                messageId: r.message_id,
                kind: 'thinking',
                refId: session.reqId,
              })
              return r.message_id
            },
            edit: async (mid, txt) => {
              await bot.api.editMessageText(session.chatId, mid, txt).catch(() => {})
            },
          },
          { prefix: '💭 ', editIntervalMs: 1500, maxChars: 3000 },
        )
      }
      session.thinkingStreamer.append(text)
    }),
  )

  unsubs.push(
    deps.bus.on('requirement.clarification_ready', async (p) => {
      const session = sessions.get(p.reqId)
      if (!session) return
      if (session.thinkingStreamer) await session.thinkingStreamer.reset()
      session.thinkingStreamer = null
      const c = deps.repos.clarifications.findById(p.clarificationId)
      if (!c) return
      const lines: string[] = [`📋 澄清 #${p.round}（${c.trigger}）`]
      if (c.employeeUnderstanding) lines.push(`我理解：${c.employeeUnderstanding}`)
      if (c.proposedPlanJson && c.proposedPlanJson.length > 0) {
        lines.push(`拆解：\n${c.proposedPlanJson.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`)
      }
      lines.push(`❓ 问题：\n${c.questionsJson.map((q) => `- ${q.question}`).join('\n')}`)
      lines.push(`💬 直接 reply 此消息回答`)
      const r = await bot.api.sendMessage(session.chatId, lines.join('\n\n')).catch(() => null)
      if (r) {
        deps.repos.tgMessageLinks.insert({
          chatId: session.chatId,
          messageId: r.message_id,
          kind: `clarification:${p.round}`,
          refId: p.clarificationId,
        })
      }
    }),
  )

  unsubs.push(
    deps.bus.on('requirement.deliverable_ready', async (p) => {
      const session = sessions.get(p.reqId)
      if (!session) return
      if (session.thinkingStreamer) await session.thinkingStreamer.reset()
      session.thinkingStreamer = null
      const short = p.reqId.slice(0, 8)
      const lines = [
        `📦 交付完成！`,
        `ref: ${p.deliverableRef}`,
        opts.webUrlBase ? `👀 ${opts.webUrlBase}/#/req/${p.reqId}` : '',
        '',
        `/approve ${short}   或   /reject ${short}`,
      ].filter(Boolean)
      const r = await bot.api.sendMessage(session.chatId, lines.join('\n')).catch(() => null)
      if (r) {
        deps.repos.tgMessageLinks.insert({
          chatId: session.chatId,
          messageId: r.message_id,
          kind: 'delivery',
          refId: p.reqId,
        })
      }
    }),
  )

  unsubs.push(
    deps.bus.on('requirement.paused', async (p) => {
      const session = sessions.get(p.reqId)
      if (!session) return
      if (session.thinkingStreamer) await session.thinkingStreamer.reset()
      session.thinkingStreamer = null
      await bot.api.sendMessage(session.chatId, `⏸ 已暂停：${p.reason}`).catch(() => {})
    }),
  )

  unsubs.push(
    deps.bus.on('budget.warning', async (p) => {
      const session = sessions.get(p.reqId)
      if (!session) return
      await bot.api
        .sendMessage(session.chatId, `⚠️ Budget 警告：${p.gate} ${p.used}/${p.cap}`)
        .catch(() => {})
    }),
  )

  return {
    async start() {
      void bot.start({ drop_pending_updates: true })
    },
    async stop() {
      for (const u of unsubs) u()
      await bot.stop()
    },
  }
}

// ──────────────────────────────────────────────────────────────
// Intent 分发
// ──────────────────────────────────────────────────────────────
async function handleIntent(
  intent: Intent,
  ctx: Context,
  deps: BridgeDeps,
  opts: BridgeOptions,
  sessions: Map<string, ReqStreamSession>,
): Promise<void> {
  const chatId = ctx.chat!.id

  switch (intent.kind) {
    case 'help':
      await ctx.reply(HELP_TEXT)
      return
    case 'who': {
      const emps = deps.repos.employees.list()
      if (emps.length === 0) return void (await ctx.reply('暂无员工'))
      await ctx.reply(emps.map((e) => `${e.name} · ${e.role}`).join('\n'))
      return
    }
    case 'list': {
      const reqs = deps.repos.requirements.listActive()
      if (reqs.length === 0) return void (await ctx.reply('暂无活跃需求'))
      await ctx.reply(reqs.map((r) => `[${r.status}] ${r.id.slice(0, 8)} · ${r.title}`).join('\n'))
      return
    }
    case 'req': {
      const all = deps.repos.requirements.listActive().map((r) => r.id)
      const m = matchReqIdPrefix(intent.reqIdPrefix, all)
      if ('error' in m) return void (await ctx.reply(m.error))
      const r = deps.repos.requirements.findById(m.reqId)!
      const link = opts.webUrlBase ? `\n${opts.webUrlBase}/#/req/${r.id}` : ''
      await ctx.reply(`${r.title}\n状态：${r.status}\n员工：${r.assigneeId ?? '-'}${link}`)
      return
    }
    case 'new': {
      const emp = deps.repos.employees.list().find((e) => e.name === intent.employeeName)
      if (!emp) {
        const list = deps.repos.employees
          .list()
          .map((e) => `- ${e.name}`)
          .join('\n')
        return void (await ctx.reply(`未找到员工 "${intent.employeeName}"。可用员工：\n${list}`))
      }
      const reqId = deps.repos.requirements.create({
        title: intent.description.split('\n')[0]!.slice(0, 50),
        description: intent.description,
        assigneeId: emp.id,
        budgetCap: DEFAULT_BUDGET_CAP,
      })
      assignRequirement(deps.services, reqId, emp.id, { skipClarification: false })
      sessions.set(reqId, { reqId, chatId, thinkingStreamer: null })
      await ctx.reply(`✓ 创建需求 ${reqId.slice(0, 8)}，分派给 ${emp.name}，进入待澄清。`)
      return
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      const all = deps.repos.requirements.listActive().map((r) => r.id)
      const m = matchReqIdPrefix(intent.reqIdPrefix, all)
      if ('error' in m) return void (await ctx.reply(m.error))
      if (intent.kind === 'pause') pauseRequirement(deps.services, m.reqId, 'user')
      else if (intent.kind === 'resume') resumeRequirement(deps.services, m.reqId)
      else cancelRequirement(deps.services, m.reqId)
      const map = { pause: '⏸ 已暂停', resume: '▶ 已继续', cancel: '❌ 已取消' }
      await ctx.reply(`${map[intent.kind]} ${m.reqId.slice(0, 8)}`)
      return
    }
    case 'approve':
    case 'reject': {
      const all = deps.repos.requirements.listByStatus('待验收').map((r) => r.id)
      const m = matchReqIdPrefix(intent.reqIdPrefix, all)
      if ('error' in m) return void (await ctx.reply(m.error))
      if (intent.kind === 'approve') approveRequirement(deps.services, m.reqId)
      else rejectRequirement(deps.services, m.reqId)
      await ctx.reply(
        `${intent.kind === 'approve' ? '✓ 已验收' : '✗ 已驳回'} ${m.reqId.slice(0, 8)}`,
      )
      return
    }
    case 'answer': {
      const link = deps.repos.tgMessageLinks.find(chatId, intent.replyToMsgId)
      if (!link || !link.kind.startsWith('clarification')) {
        await ctx.reply('请 reply bot 的澄清提问消息再回答。')
        return
      }
      const c = deps.repos.clarifications.findById(link.refId)
      if (!c) return void (await ctx.reply('澄清记录已失效'))
      const firstQ = c.questionsJson[0]
      if (!firstQ) return
      answerClarification(deps.services, c.id, [
        { question: firstQ.question, answer: intent.answer },
      ])
      await ctx.reply('✓ 已记录，继续执行')
      return
    }
    case 'unknown':
      await ctx.reply(`未识别的指令。${HELP_TEXT}`)
      return
  }
}

// ──────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────
function findSessionByThreadId(
  repos: Repos,
  sessions: Map<string, ReqStreamSession>,
  threadId: string,
): ReqStreamSession | null {
  for (const s of sessions.values()) {
    const t = repos.threads.findByRequirement(s.reqId)
    if (t && t.id === threadId) return s
  }
  return null
}

function extractMessageText(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null
  const o = c as { type?: string; text?: string }
  if (o.type === 'text' || o.type === 'thinking') return o.text ?? null
  return null
}
