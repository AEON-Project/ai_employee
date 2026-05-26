/**
 * 极简 REST 客户端 — 复用 cookie token；提供 wsConnect 订阅事件。
 */

async function jsonReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`${method} ${path} → ${r.status}: ${t}`)
  }
  return (await r.json()) as T
}

export const api = {
  get: <T>(p: string) => jsonReq<T>('GET', p),
  post: <T>(p: string, body?: unknown) => jsonReq<T>('POST', p, body),
  patch: <T>(p: string, body?: unknown) => jsonReq<T>('PATCH', p, body),
  del: <T>(p: string) => jsonReq<T>('DELETE', p),
}

export function wsConnect(path: string, onEvent: (msg: WsMessage) => void): WebSocket {
  const url = new URL(path, location.href)
  url.protocol = url.protocol.replace('http', 'ws')
  const ws = new WebSocket(url.toString())
  ws.addEventListener('message', (e) => {
    try {
      const obj = JSON.parse(e.data as string) as WsMessage
      onEvent(obj)
    } catch {
      /* ignore */
    }
  })
  return ws
}

export type WsMessage =
  | { kind: 'hello'; sessionId: string; filterReqId?: string }
  | { kind: 'event'; name: string; payload: Record<string, unknown> }
  | { kind: 'pong' }
