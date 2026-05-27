/**
 * Hono Server 主入口 — Bun.serve + Hono fetch + Bun WebSocket。
 *
 * 路由：
 *   GET  /health                      公开
 *   GET  /auth?token=...&next=...     种 cookie
 *   *    /api/*                       受 token 保护的 REST（见 api.ts）
 *   GET  /ws/req/:id  /ws/global      WebSocket（见 ws.ts）
 *   GET  /                            占位首页（α 阶段无 UI 时）
 */

import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { Hono } from 'hono'
import { authHandler, hostGuard, tokenAuth } from './auth.js'
import type { RuntimeServices } from '@ai-emp/core/runtime'
import { mountApi } from './api.js'
import { makeWsHandlers, mountWs } from './ws.js'

/** 调度器接口（运行时实际是 RequirementScheduler；这里只暴露 enqueue 给 api 用，避免循环依赖） */
export interface SchedulerLike {
  enqueue(reqId: string): void
}

export interface ServerDeps {
  services: RuntimeServices
  token: string
  dataDir: string
  /** Web UI dist 目录的绝对路径；缺省走占位首页 */
  webDistDir?: string
  /** 调度器；不传则 HTTP 派单不会触发 executeRequirement（仅 e2e 测试场景） */
  scheduler?: SchedulerLike
}

export interface CreateServerOptions extends ServerDeps {
  port: number
}

export function buildApp(deps: ServerDeps) {
  const app = new Hono()
  app.use('*', hostGuard())
  app.get('/health', (c) => c.json({ ok: true, version: '0.0.0' }))
  app.get('/auth', authHandler({ token: deps.token }))
  app.use('*', tokenAuth({ token: deps.token, publicPaths: ['/auth', '/health'] }))
  mountApi(app, deps)
  mountWs(app, deps)
  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    mountStatic(app, deps.webDistDir)
  } else {
    app.get('/', (c) =>
      c.text('ai-emp server is running. REST 见 /api/*；WS 见 /ws/req/:id /ws/global。'),
    )
  }
  return app
}

/** 简易静态资源 handler — 防路径穿越 + SPA fallback 到 index.html */
function mountStatic(app: Hono, distRoot: string) {
  const root = resolve(distRoot)
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
      return c.notFound()
    }
    const safePath = normalize(c.req.path).replace(/^\/+/, '')
    let filePath = join(root, safePath)
    if (!filePath.startsWith(root)) return c.text('forbidden', 403)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback
      filePath = join(root, 'index.html')
      if (!existsSync(filePath)) return c.notFound()
    }
    const file = Bun.file(filePath)
    return new Response(file)
  })
}

export interface ServerHandle {
  start(): Promise<{ port: number }>
  stop(): Promise<void>
  /** 测试 / 内省用：当前 server 端口 */
  readonly port: number | null
}

export function createServer(opts: CreateServerOptions): ServerHandle {
  const app = buildApp(opts)
  let server: ReturnType<typeof Bun.serve> | null = null
  return {
    get port() {
      return server ? Number(server.port) : null
    },
    async start() {
      const wsHandlers = makeWsHandlers()
      server = Bun.serve({
        port: opts.port,
        fetch: app.fetch,
        websocket: wsHandlers as never,
      })
      ;(globalThis as unknown as Record<string, unknown>).__aiempServer__ = server
      return { port: Number(server.port) }
    },
    async stop() {
      server?.stop(true)
      server = null
      ;(globalThis as unknown as Record<string, unknown>).__aiempServer__ = undefined
    },
  }
}
