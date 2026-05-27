import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Employee, Skill } from '../lib/types'
import { navigate } from '../store/router'

type Tab = 'basic' | 'skills' | 'memory'

interface EmployeeSkillRow {
  skill: Skill
  order: number
}

interface MemoryItem {
  id: string
  scope: 'project' | 'employee'
  scopeId: string
  kind: 'fact' | 'pitfall' | 'lesson'
  content: string
  importanceScore: number
  hitCount: number
  pendingReview: boolean
  archived: boolean
  createdAt: string
}

export function EmployeeDetailPage({ id }: { id: string }) {
  const [emp, setEmp] = useState<Employee | null>(null)
  const [tab, setTab] = useState<Tab>('basic')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const e = await api.get<Employee>(`/api/employees/${id}`)
      setEmp(e)
    } catch (ex) {
      setErr(String(ex))
    }
  }, [id])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (err) return <p className="text-red-600">{err}</p>
  if (!emp) return <p className="text-muted">加载中…</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <a
          href="#/employees"
          className="text-sm text-slate-500 hover:text-accent"
          onClick={(e) => {
            e.preventDefault()
            navigate('/employees')
          }}
        >
          ← 员工
        </a>
        <h1 className="font-semibold text-lg">{emp.name}</h1>
        <span className="tag">{emp.role}</span>
        <span className="tag">
          {emp.modelProvider} · {emp.modelName}
        </span>
      </div>

      <nav className="flex gap-1 border-b border-border text-sm">
        <TabBtn active={tab === 'basic'} onClick={() => setTab('basic')}>
          基本信息
        </TabBtn>
        <TabBtn active={tab === 'skills'} onClick={() => setTab('skills')}>
          技能
        </TabBtn>
        <TabBtn active={tab === 'memory'} onClick={() => setTab('memory')}>
          记忆
        </TabBtn>
      </nav>

      {tab === 'basic' && <BasicTab emp={emp} onSaved={refresh} />}
      {tab === 'skills' && <SkillsTab employeeId={emp.id} />}
      {tab === 'memory' && <MemoryTab emp={emp} onSaved={refresh} />}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`px-3 py-2 -mb-px border-b-2 ${
        active ? 'border-accent text-accent' : 'border-transparent text-slate-500 hover:text-accent'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function BasicTab({ emp, onSaved }: { emp: Employee; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: emp.name,
    role: emp.role,
    persona: emp.persona,
    modelProvider: emp.modelProvider,
    modelName: emp.modelName,
    modelKeyRef: emp.modelKeyRef,
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function save() {
    setSaving(true)
    setMsg('')
    try {
      await api.patch(`/api/employees/${emp.id}`, form)
      setMsg('已保存')
      onSaved()
    } catch (ex) {
      setMsg(String(ex))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="名字" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Field label="岗位" value={form.role} onChange={(v) => setForm({ ...form, role: v })} />
      </div>
      <div>
        <label className="label">人设</label>
        <textarea
          className="input min-h-[100px]"
          value={form.persona}
          onChange={(e) => setForm({ ...form, persona: e.target.value })}
        />
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <label className="label">Provider</label>
          <select
            className="input"
            value={form.modelProvider}
            onChange={(e) =>
              setForm({ ...form, modelProvider: e.target.value as Employee['modelProvider'] })
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
          label="modelKeyRef（keychain key 或 env://NAME）"
          value={form.modelKeyRef}
          onChange={(v) => setForm({ ...form, modelKeyRef: v })}
        />
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={saving} onClick={save}>
          保存
        </button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
    </section>
  )
}

function SkillsTab({ employeeId }: { employeeId: string }) {
  const [mine, setMine] = useState<EmployeeSkillRow[]>([])
  const [all, setAll] = useState<Skill[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([
        api.get<EmployeeSkillRow[]>(`/api/employees/${employeeId}/skills`),
        api.get<Skill[]>('/api/skills'),
      ])
      setMine(m)
      setAll(a)
    } catch (ex) {
      setErr(String(ex))
    }
  }, [employeeId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const mineIds = new Set(mine.map((r) => r.skill.id))
  const available = all.filter((s) => !mineIds.has(s.id))

  async function attach(skillId: string) {
    setBusy(true)
    try {
      const nextOrder = mine.length
      await api.post(`/api/employees/${employeeId}/skills/${skillId}`, { order: nextOrder })
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  async function detach(skillId: string) {
    setBusy(true)
    try {
      await api.del(`/api/employees/${employeeId}/skills/${skillId}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  async function setOrder(skillId: string, order: number) {
    setBusy(true)
    try {
      await api.post(`/api/employees/${employeeId}/skills/${skillId}`, { order })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (err) return <p className="text-red-600">{err}</p>

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <section className="card">
        <h3 className="font-semibold mb-2">
          已挂载{' '}
          <span className="text-xs text-muted">({mine.length}) · order 升序，0 为主技能</span>
        </h3>
        {mine.length === 0 && <p className="text-sm text-muted">暂无</p>}
        <ul className="space-y-2">
          {mine.map((row) => (
            <li
              key={row.skill.id}
              className="flex items-start justify-between gap-2 border border-border rounded p-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="tag">order {row.order}</span>
                  <span className="font-medium">{row.skill.name}</span>
                  <span className="text-xs text-muted">{row.skill.category}</span>
                </div>
                <p className="text-xs text-muted mt-1 line-clamp-2">{row.skill.description}</p>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <input
                  type="number"
                  className="input w-16 py-0.5"
                  value={row.order}
                  min={0}
                  disabled={busy}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!Number.isNaN(v)) setOrder(row.skill.id, v)
                  }}
                />
                <button
                  className="btn-danger text-xs px-2"
                  disabled={busy}
                  onClick={() => detach(row.skill.id)}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3 className="font-semibold mb-2">
          可选技能 <span className="text-xs text-muted">({available.length})</span>
        </h3>
        {available.length === 0 && <p className="text-sm text-muted">全部已挂载</p>}
        <ul className="space-y-2">
          {available.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-2 border border-border rounded p-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-muted">{s.category}</span>
                </div>
                <p className="text-xs text-muted mt-1 line-clamp-2">{s.description}</p>
              </div>
              <button
                className="btn text-xs px-2 shrink-0"
                disabled={busy}
                onClick={() => attach(s.id)}
              >
                挂载
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function MemoryTab({ emp, onSaved }: { emp: Employee; onSaved: () => void }) {
  const [style, setStyle] = useState(emp.memoryStyleText)
  const [lessons, setLessons] = useState<MemoryItem[]>([])
  const [newLesson, setNewLesson] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    const items = await api.get<MemoryItem[]>(
      `/api/memory/items?scope=employee&scopeId=${emp.id}&kind=lesson`,
    )
    setLessons(items)
  }, [emp.id])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    setStyle(emp.memoryStyleText)
  }, [emp.memoryStyleText])

  async function saveStyle() {
    setBusy(true)
    setMsg('')
    try {
      await api.patch(`/api/employees/${emp.id}`, { memoryStyleText: style })
      setMsg('已保存 style')
      onSaved()
    } catch (ex) {
      setMsg(String(ex))
    } finally {
      setBusy(false)
    }
  }
  async function addLesson() {
    if (!newLesson.trim()) return
    setBusy(true)
    try {
      await api.post('/api/memory/items', {
        scope: 'employee',
        scopeId: emp.id,
        kind: 'lesson',
        content: newLesson.trim(),
      })
      setNewLesson('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  async function archive(id: string) {
    setBusy(true)
    try {
      await api.post(`/api/memory/items/${id}/archive`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h3 className="font-semibold">个人风格（style）</h3>
        <p className="text-xs text-muted">
          员工写作/沟通的自我画像。系统会从历史复盘自动追加，也可手动编辑。
        </p>
        <textarea
          className="input min-h-[120px]"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={busy} onClick={saveStyle}>
            保存 style
          </button>
          {msg && <span className="text-sm text-muted">{msg}</span>}
        </div>
      </section>

      <section className="card space-y-2">
        <h3 className="font-semibold">个人教训（lessons）</h3>
        <p className="text-xs text-muted">
          员工层面踩坑沉淀，按 importance 降序展示；系统在派单时自动召回。
        </p>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="新增一条教训…"
            value={newLesson}
            onChange={(e) => setNewLesson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addLesson()
            }}
          />
          <button className="btn" disabled={busy || !newLesson.trim()} onClick={addLesson}>
            添加
          </button>
        </div>
        <ul className="space-y-1 mt-2">
          {lessons.length === 0 && <p className="text-sm text-muted">暂无</p>}
          {lessons.map((l) => (
            <li
              key={l.id}
              className="flex items-start justify-between gap-2 border border-border rounded p-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <p>{l.content}</p>
                <p className="text-xs text-muted mt-1">
                  importance {l.importanceScore.toFixed(2)} · hit {l.hitCount}
                </p>
              </div>
              <button
                className="btn-danger text-xs px-2 shrink-0"
                disabled={busy}
                onClick={() => archive(l.id)}
              >
                归档
              </button>
            </li>
          ))}
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
