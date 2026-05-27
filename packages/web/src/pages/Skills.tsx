import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

type Category = '技术' | '设计' | '内容' | '数据' | '运营' | '通用'
const CATEGORIES: Category[] = ['技术', '设计', '内容', '数据', '运营', '通用']

interface Skill {
  id: string
  name: string
  category: Category
  description: string
  promptTemplate: string
  requiredToolsJson: string[]
  examplesJson: { input: string; output: string }[] | null
  builtin: boolean
  createdAt: string
}

const EMPTY_FORM = {
  name: '',
  category: '通用' as Category,
  description: '',
  promptTemplate: '',
  requiredTools: '',
}

export function SkillsPage() {
  const [items, setItems] = useState<Skill[]>([])
  const [selected, setSelected] = useState<Skill | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [mode, setMode] = useState<'create' | 'edit'>('create')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    const r = await api.get<Skill[]>('/api/skills')
    setItems(r)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function startCreate() {
    setMode('create')
    setSelected(null)
    setForm(EMPTY_FORM)
    setMsg('')
  }
  function startEdit(s: Skill) {
    setMode('edit')
    setSelected(s)
    setForm({
      name: s.name,
      category: s.category,
      description: s.description,
      promptTemplate: s.promptTemplate,
      requiredTools: (s.requiredToolsJson ?? []).join(','),
    })
    setMsg('')
  }

  async function save() {
    setBusy(true)
    setMsg('')
    const body = {
      name: form.name,
      category: form.category,
      description: form.description,
      promptTemplate: form.promptTemplate,
      requiredTools: form.requiredTools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    }
    try {
      if (mode === 'create') {
        await api.post('/api/skills', body)
        setMsg('已创建')
        startCreate()
      } else if (selected) {
        await api.patch(`/api/skills/${selected.id}`, body)
        setMsg('已保存')
      }
      await refresh()
    } catch (ex) {
      setMsg(String(ex))
    } finally {
      setBusy(false)
    }
  }
  async function del(s: Skill) {
    if (!confirm(`删除技能「${s.name}」？挂载此技能的员工会失去该能力。`)) return
    setBusy(true)
    try {
      await api.del(`/api/skills/${s.id}`)
      if (selected?.id === s.id) startCreate()
      await refresh()
    } catch (ex) {
      setMsg(String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid md:grid-cols-[280px_1fr] gap-4">
      <section className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">技能列表</h2>
          <button className="btn text-xs px-2" onClick={startCreate}>
            + 新建
          </button>
        </div>
        <ul className="space-y-1">
          {items.map((s) => (
            <li key={s.id}>
              <button
                className={`w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 ${
                  selected?.id === s.id ? 'bg-slate-100' : ''
                }`}
                onClick={() => startEdit(s)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{s.name}</span>
                  {s.builtin && <span className="tag text-xs">预置</span>}
                </div>
                <p className="text-xs text-muted">{s.category}</p>
              </button>
            </li>
          ))}
          {items.length === 0 && <p className="text-sm text-muted">暂无技能</p>}
        </ul>
      </section>

      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            {mode === 'create' ? '新建技能' : `编辑：${selected?.name ?? ''}`}
          </h2>
          {mode === 'edit' && selected && (
            <button
              className="btn-danger text-xs px-2"
              disabled={busy}
              onClick={() => del(selected)}
            >
              删除
            </button>
          )}
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <div>
            <label className="label">类别</label>
            <select
              className="input"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">描述</label>
          <textarea
            className="input min-h-[60px]"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div>
          <label className="label">
            Prompt 模板（主技能时全量注入；非主技能仅注入名称 + 描述）
          </label>
          <textarea
            className="input min-h-[200px] font-mono text-xs"
            value={form.promptTemplate}
            onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })}
          />
        </div>
        <Field
          label="所需工具（逗号分隔，如 web_search,read_file）"
          value={form.requiredTools}
          onChange={(v) => setForm({ ...form, requiredTools: v })}
        />
        <div className="flex items-center gap-3">
          <button
            className="btn-primary"
            disabled={busy || !form.name || !form.description}
            onClick={save}
          >
            {mode === 'create' ? '创建' : '保存'}
          </button>
          {msg && <span className="text-sm text-muted">{msg}</span>}
        </div>
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
