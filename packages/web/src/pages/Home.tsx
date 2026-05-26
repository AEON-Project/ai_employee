import { useEffect, useState } from 'react'
import { api, wsConnect } from '../lib/api'
import type { Employee, Project, Requirement } from '../lib/types'
import { StatusBadge } from '../components/StatusBadge'
import { navigate } from '../store/router'

export function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [reqs, setReqs] = useState<Requirement[]>([])

  async function refresh() {
    const [p, e, r] = await Promise.all([
      api.get<Project[]>('/api/projects'),
      api.get<Employee[]>('/api/employees'),
      api.get<Requirement[]>('/api/requirements'),
    ])
    setProjects(p)
    setEmployees(e)
    setReqs(r)
  }

  useEffect(() => {
    refresh()
    const ws = wsConnect('/ws/global', (msg) => {
      if (msg.kind === 'event' && msg.name.startsWith('requirement.')) {
        void refresh()
      }
    })
    return () => ws.close()
  }, [])

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <section className="card">
        <h2 className="font-semibold mb-3">📋 活跃需求</h2>
        {reqs.length === 0 ? (
          <p className="text-sm text-muted">
            还没有需求。{' '}
            <a href="#/new" className="text-accent">
              新建一个 →
            </a>
          </p>
        ) : (
          <ul className="space-y-2">
            {reqs.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between hover:bg-slate-50 px-2 py-1 rounded cursor-pointer"
                onClick={() => navigate(`/req/${r.id}`)}
              >
                <span className="text-sm truncate">{r.title}</span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="font-semibold mb-3">👥 员工</h2>
        {employees.length === 0 ? (
          <p className="text-sm text-muted">还没有员工，先在 /employees 创建。</p>
        ) : (
          <ul className="space-y-2">
            {employees.map((e) => (
              <li
                key={e.id}
                className="text-sm hover:bg-slate-50 px-2 py-1 rounded cursor-pointer"
                onClick={() => navigate(`/employees/${e.id}`)}
              >
                <span className="font-medium">{e.name}</span>
                <span className="text-muted ml-2">{e.role}</span>
                <span className="tag ml-2">{e.modelProvider}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card md:col-span-2">
        <h2 className="font-semibold mb-3">📁 项目</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted">还没有项目，先在 /projects 创建。</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className="text-sm hover:bg-slate-50 px-2 py-1 rounded cursor-pointer flex items-center justify-between"
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <span>
                  <span className="font-medium">{p.name}</span>
                  {p.description && (
                    <span className="text-muted ml-2 truncate">{p.description.slice(0, 80)}</span>
                  )}
                </span>
                <span className="tag">{p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
