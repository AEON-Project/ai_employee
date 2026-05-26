import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Employee, Project, Requirement } from '../lib/types'
import { navigate } from '../store/router'

export function NewRequirementPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [form, setForm] = useState({
    title: '',
    description: '',
    projectId: '',
    employeeId: '',
    skipClarification: false,
  })
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get<Project[]>('/api/projects').then(setProjects)
    api.get<Employee[]>('/api/employees').then(setEmployees)
  }, [])

  async function submit() {
    setErr('')
    if (!form.title) return setErr('标题必填')
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        title: form.title,
        description: form.description,
      }
      if (form.projectId) body.projectId = form.projectId
      const r = await api.post<Requirement>('/api/requirements', body)
      if (form.employeeId) {
        await api.post(`/api/requirements/${r.id}/assign`, {
          employeeId: form.employeeId,
          skipClarification: form.skipClarification,
        })
      }
      navigate(`/req/${r.id}`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <section className="card">
        <h2 className="font-semibold mb-3">新建需求</h2>
        <div className="space-y-3">
          <div>
            <label className="label">标题</label>
            <input
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label">描述</label>
            <textarea
              className="input min-h-[120px]"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">归属项目</label>
              <select
                className="input"
                value={form.projectId}
                onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              >
                <option value="">— 无 —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">指派员工</label>
              <select
                className="input"
                value={form.employeeId}
                onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
              >
                <option value="">— 不指派 —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.role}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.skipClarification}
              onChange={(e) => setForm({ ...form, skipClarification: e.target.checked })}
            />
            跳过澄清，直接执行
          </label>
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary" disabled={creating} onClick={submit}>
            创建并指派
          </button>
        </div>
      </section>
    </div>
  )
}
