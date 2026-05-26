import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Employee } from '../lib/types'
import { navigate } from '../store/router'

export function EmployeesPage() {
  const [items, setItems] = useState<Employee[]>([])
  const [form, setForm] = useState({
    name: '',
    role: '',
    persona: '',
    modelProvider: 'anthropic' as 'anthropic' | 'openai-compat',
    modelName: 'claude-opus-4-7',
    modelKeyRef: '',
    modelBaseUrl: '',
  })
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string>('')

  async function refresh() {
    setItems(await api.get<Employee[]>('/api/employees'))
  }
  useEffect(() => {
    refresh()
  }, [])

  async function create() {
    setErr('')
    if (!form.name || !form.role || !form.modelKeyRef) {
      setErr('名字、角色、modelKeyRef（keychain key）必填')
      return
    }
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        role: form.role,
        persona: form.persona,
        modelProvider: form.modelProvider,
        modelName: form.modelName,
        modelKeyRef: form.modelKeyRef,
      }
      if (form.modelBaseUrl) body.modelBaseUrl = form.modelBaseUrl
      const e = await api.post<Employee>('/api/employees', body)
      await refresh()
      navigate(`/employees/${e.id}`)
    } catch (ex) {
      setErr(String(ex))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="font-semibold mb-3">招聘员工</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="名字" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field label="岗位" value={form.role} onChange={(v) => setForm({ ...form, role: v })} />
          <div className="md:col-span-2">
            <label className="label">人设</label>
            <textarea
              className="input min-h-[80px]"
              value={form.persona}
              onChange={(e) => setForm({ ...form, persona: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Provider</label>
            <select
              className="input"
              value={form.modelProvider}
              onChange={(e) =>
                setForm({ ...form, modelProvider: e.target.value as 'anthropic' | 'openai-compat' })
              }
            >
              <option value="anthropic">anthropic</option>
              <option value="openai-compat">openai-compat</option>
            </select>
          </div>
          <Field
            label="模型 ID"
            value={form.modelName}
            onChange={(v) => setForm({ ...form, modelName: v })}
          />
          <Field
            label="modelKeyRef（先在 CLI keychain set 写入凭证后填此处的 key 名）"
            value={form.modelKeyRef}
            onChange={(v) => setForm({ ...form, modelKeyRef: v })}
          />
          <Field
            label="baseUrl（仅 openai-compat 用）"
            value={form.modelBaseUrl}
            onChange={(v) => setForm({ ...form, modelBaseUrl: v })}
          />
        </div>
        {err && <p className="text-red-600 text-sm mt-2">{err}</p>}
        <button className="btn-primary mt-3" disabled={creating} onClick={create}>
          创建
        </button>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-3">员工列表</h2>
        <ul className="space-y-2">
          {items.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between hover:bg-slate-50 px-2 py-1 rounded cursor-pointer"
              onClick={() => navigate(`/employees/${e.id}`)}
            >
              <span>
                <span className="font-medium">{e.name}</span>
                <span className="text-muted text-sm ml-2">{e.role}</span>
              </span>
              <span className="tag">
                {e.modelProvider} · {e.modelName}
              </span>
            </li>
          ))}
          {items.length === 0 && <p className="text-sm text-muted">暂无员工</p>}
        </ul>
      </section>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
