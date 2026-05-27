/**
 * 极简 hash 路由 — 避免 react-router 依赖。
 *   #/                       Dashboard
 *   #/req/:id                Requirement detail
 *   #/projects               Projects list
 *   #/projects/:id           Project detail
 *   #/employees              Employees list
 *   #/employees/:id          Employee detail
 *   #/skills                 Skills management
 *   #/requirements           Requirements list (按状态筛选)
 *   #/new                    New requirement
 */

import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'req'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'employees' }
  | { name: 'employee'; id: string }
  | { name: 'skills' }
  | { name: 'requirements' }
  | { name: 'new' }
  | { name: 'unknown' }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '').replace(/^\//, '')
  if (h === '' || h === 'home') return { name: 'home' }
  if (h === 'projects') return { name: 'projects' }
  if (h === 'employees') return { name: 'employees' }
  if (h === 'skills') return { name: 'skills' }
  if (h === 'requirements') return { name: 'requirements' }
  if (h === 'new') return { name: 'new' }
  const m1 = /^req\/([\w-]+)$/.exec(h)
  if (m1) return { name: 'req', id: m1[1]! }
  const m2 = /^projects\/([\w-]+)$/.exec(h)
  if (m2) return { name: 'project', id: m2[1]! }
  const m3 = /^employees\/([\w-]+)$/.exec(h)
  if (m3) return { name: 'employee', id: m3[1]! }
  return { name: 'unknown' }
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const onChange = () => {
      const h = location.hash
      // diff2html 用 #d2h-xxxxx 做文件锚点跳转，与我们的 hash router 冲突 — 忽略
      if (h.startsWith('#d2h-') || h.startsWith('#') === false) return
      setR(parseHash(h))
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return r
}

export function navigate(to: string): void {
  location.hash = to.startsWith('#') ? to : `#${to}`
}
