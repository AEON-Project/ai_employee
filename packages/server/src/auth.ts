/**
 * Server 鉴权中间件：
 *   - Host 必须为 localhost / 127.0.0.1（防 DNS rebinding）
 *   - 请求带 Bearer token 或 cookie aiemp_token；token 与启动时注入的一致
 *   - GET /auth?token=... 允许种 cookie（仅 localhost）
 */

import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export interface AuthOptions {
  /** 启动时注入的 localhost token */
  token: string
  /** cookie 名 */
  cookieName?: string
  /** 允许跳过鉴权的路径（如静态资源 / / favicon） */
  publicPaths?: string[]
}

const DEFAULT_COOKIE = 'aiemp_token'

/** Host 校验：仅接受 localhost / 127.0.0.1（防止 DNS rebinding 攻击） */
export function hostGuard(): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase()
    const hostname = host.split(':')[0] ?? ''
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return c.json({ error: 'host_not_allowed', host }, 403)
    }
    await next()
    return
  }
}

/** Token 鉴权 */
export function tokenAuth(opts: AuthOptions): MiddlewareHandler {
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE
  const publicPaths = new Set(opts.publicPaths ?? ['/auth', '/health'])
  return async (c, next) => {
    if (publicPaths.has(c.req.path)) {
      await next()
      return undefined
    }
    const auth = c.req.header('authorization') ?? ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const cookie = getCookie(c, cookieName) ?? ''
    const provided = bearer || cookie
    if (provided !== opts.token) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
    return
  }
}

/** GET /auth?token=... 种 cookie 后跳首页（用于首次浏览器登录） */
export function authHandler(opts: AuthOptions): MiddlewareHandler {
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE
  return async (c) => {
    const t = c.req.query('token') ?? ''
    if (t !== opts.token) return c.json({ error: 'unauthorized' }, 401)
    setCookie(c, cookieName, t, {
      httpOnly: true,
      sameSite: 'Strict',
      // localhost 没法 secure；保持 false
      secure: false,
      maxAge: 60 * 60 * 24 * 30, // 30d
      path: '/',
    })
    const next = c.req.query('next') ?? '/'
    return c.redirect(next)
  }
}
