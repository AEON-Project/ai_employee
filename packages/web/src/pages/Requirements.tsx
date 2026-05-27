import { useEffect, useMemo, useState } from 'react'
import { api, wsConnect } from '../lib/api'
import type { Employee, Project, Requirement, RequirementStatus } from '../lib/types'
import { StatusBadge } from '../components/StatusBadge'
import { navigate } from '../store/router'

const STATUSES: { key: 'active' | 'all' | RequirementStatus; label: string }[] = [
  { key: 'active', label: '活跃' },
  { key: 'all', label: '全部' },
  { key: '待分派', label: '待分派' },
  { key: '待澄清', label: '待澄清' },
  { key: '进行中', label: '进行中' },
  { key: '等待回答', label: '等待回答' },
  { key: '已暂停', label: '已暂停' },
  { key: '待验收', label: '待验收' },
  { key: '已完成', label: '已完成' },
  { key: '已驳回', label: '已驳回' },
  { key: '已取消', label: '已取消' },
]

export function RequirementsPage() {
  const [filter, setFilter] = useState<(typeof STATUSES)[number]['key']>('active')
  const [reqs, setReqs] = useState<Requirement[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])

  const projectMap = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])) as Record<string, Project>,
    [projects],
  )
  const employeeMap = useMemo(
    () => Object.fromEntries(employees.map((e) => [e.id, e])) as Record<string, Employee>,
    [employees],
  )

  async function refresh() {
    const url =
      filter === 'active'
        ? '/api/requirements'
        : filter === 'all'
          ? '/api/requirements?all=true'
          : `/api/requirements?status=${encodeURIComponent(filter)}`
    const [r, p, e] = await Promise.all([
      api.get<Requirement[]>(url),
      projects.length ? Promise.resolve(projects) : api.get<Project[]>('/api/projects'),
      employees.length ? Promise.resolve(employees) : api.get<Employee[]>('/api/employees'),
    ])
    setReqs(r)
    if (!projects.length) setProjects(p)
    if (!employees.length) setEmployees(e)
  }

  useEffect(() => {
    refresh()
    const ws = wsConnect('/ws/global', (msg) => {
      if (msg.kind === 'event' && msg.name.startsWith('requirement.')) {
        void refresh()
      }
    })
    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-lg">需求</h1>
        <a
          href="#/new"
          className="btn-primary text-sm"
          onClick={(e) => {
            e.preventDefault()
            navigate('/new')
          }}
        >
          + 新建需求
        </a>
      </div>

      <nav className="flex gap-1 flex-wrap text-sm border-b border-border pb-1">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            className={`px-3 py-1 rounded-md ${
              filter === s.key ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
            onClick={() => setFilter(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <section className="card overflow-x-auto">
        {reqs.length === 0 ? (
          <p className="text-sm text-muted">该筛选下无需求</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted text-left">
              <tr>
                <th className="py-2 pr-3">标题</th>
                <th className="py-2 pr-3">项目</th>
                <th className="py-2 pr-3">员工</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2 pr-3">优先级</th>
                <th className="py-2 pr-3">创建</th>
              </tr>
            </thead>
            <tbody>
              {reqs.map((r) => {
                const proj = r.projectId ? projectMap[r.projectId] : null
                const emp = r.assigneeId ? employeeMap[r.assigneeId] : null
                return (
                  <tr
                    key={r.id}
                    className="border-t border-border hover:bg-slate-50 cursor-pointer"
                    onClick={() => navigate(`/req/${r.id}`)}
                  >
                    <td className="py-2 pr-3 font-medium truncate max-w-[280px]">{r.title}</td>
                    <td className="py-2 pr-3 text-muted">{proj?.name ?? '—'}</td>
                    <td className="py-2 pr-3 text-muted">
                      {emp ? `${emp.name} · ${emp.role}` : '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2 pr-3">
                      <span className="tag">{r.priority}</span>
                    </td>
                    <td className="py-2 pr-3 text-muted text-xs">
                      {new Date(r.createdAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
