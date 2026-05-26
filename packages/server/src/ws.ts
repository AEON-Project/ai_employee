/**
 * WebSocket 端点：
 *   /ws/req/:id    订阅某需求的事件流（message.appended / state_changed / frame / ...）
 *   /ws/global     订阅全局事件
 *
 * 协议：JSON over WS。每条消息形如：
 *   { kind: 'event', name: 'requirement.frame', payload: {...} }
 *
 * Bun 的 WS：通过 server.upgrade(req, { data }) 完成升级；
 * 各 WS 在 open/close 内订阅/取消订阅 EventBus，关闭时清理。
 *
 * 实现注意：这一版用一个独立的 Bun.serve 注册 websocket handler；
 * createServer 仍用 Hono 处理 HTTP，WS 通过共享 server 由 buildApp 决定 path 路由。
 * 为了简化首版，WS 升级在 buildApp(fetch) 内直接处理 —— Bun.serve 把 fetch 返回 undefined
 * 视为已升级。
 */

import type { Hono, Context } from 'hono'
import type { EventName } from '@ai-emp/events'
import type { ServerDeps } from './server.js'

interface WsSession {
  id: string
  ws: WebSocket
  filterReqId?: string
  unsub: (() => void)[]
}

// 进程内会话表（用于 close 时清理）
const sessions = new Map<string, WsSession>()

export function mountWs(app: Hono, deps: ServerDeps) {
  app.get('/ws/req/:id', (c) => upgrade(c, c.req.param('id'), deps))
  app.get('/ws/global', (c) => upgrade(c, undefined, deps))
}

function upgrade(c: Context, filterReqId: string | undefined, deps: ServerDeps): Response {
  const server = (c.env as { server?: { upgrade?: (req: Request, opts?: unknown) => boolean } })
    ?.server
  // Hono on Bun：c.req.raw 是底层 Request；Bun.serve 实例由 createServer 中持有
  // 简化版：用 globalThis.__aiempServer__ 暴露 server 实例
  const bunServer = (globalThis as unknown as { __aiempServer__?: { upgrade: Function } })
    .__aiempServer__
  if (!bunServer || typeof bunServer.upgrade !== 'function') {
    return new Response('ws upgrade unavailable', { status: 500 })
  }
  const id = crypto.randomUUID()
  const ok = bunServer.upgrade(c.req.raw, {
    data: { sessionId: id, filterReqId, deps },
  })
  if (!ok) return new Response('upgrade failed', { status: 400 })
  void server
  // 返回响应被忽略（已升级）；返回一个 placeholder
  return new Response(null, { status: 101 })
}

/**
 * 给 Bun.serve websocket handler 用的工厂。
 * createServer 在初始化时把它作为 server.websocket 注入。
 */
export function makeWsHandlers() {
  return {
    open(ws: WebSocket & { data: { sessionId: string; filterReqId?: string; deps: ServerDeps } }) {
      const { sessionId, filterReqId, deps } = ws.data
      const session: WsSession = { id: sessionId, ws, filterReqId, unsub: [] }
      sessions.set(sessionId, session)
      const subscribed: EventName[] = [
        'requirement.created',
        'requirement.state_changed',
        'requirement.clarification_ready',
        'requirement.clarification_answered',
        'requirement.frame',
        'requirement.deliverable_ready',
        'requirement.completed',
        'requirement.rejected',
        'requirement.cancelled',
        'requirement.paused',
        'message.appended',
        'tool.invoked',
        'tool.result',
        'tool.failed',
        'budget.warning',
        'budget.exceeded',
        'context.compacted',
        'memory.recalled',
        'memory.persisted',
        'memory.pending_review',
        'runtime.heartbeat',
        'runtime.scheduler_state',
        'runtime.recovered',
      ]
      for (const name of subscribed) {
        const off = deps.services.bus.on(name, (payload) => {
          if (filterReqId && (payload as { reqId?: string }).reqId) {
            if ((payload as { reqId: string }).reqId !== filterReqId) return
          }
          try {
            ws.send(JSON.stringify({ kind: 'event', name, payload }))
          } catch {
            /* WS 可能已关，忽略 */
          }
        })
        session.unsub.push(off)
      }
      try {
        ws.send(JSON.stringify({ kind: 'hello', sessionId, filterReqId }))
      } catch {
        /* ignore */
      }
    },
    message(ws: WebSocket & { data: { sessionId: string } }, msg: string | Buffer) {
      // 当前 ping/pong 用 native；JSON 入站可作为扩展
      try {
        const text = typeof msg === 'string' ? msg : msg.toString('utf8')
        const obj = JSON.parse(text) as { kind?: string }
        if (obj.kind === 'ping') ws.send(JSON.stringify({ kind: 'pong' }))
      } catch {
        /* ignore */
      }
    },
    close(ws: WebSocket & { data: { sessionId: string } }) {
      const s = sessions.get(ws.data.sessionId)
      if (!s) return
      for (const off of s.unsub) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      sessions.delete(ws.data.sessionId)
    },
  }
}
