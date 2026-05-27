import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Project } from '../lib/types'
import { navigate } from '../store/router'

type Tab = 'basic' | 'conventions' | 'knowledge'

interface Convention {
  id: string
  projectId: string
  content: string
  enforcement: 'required' | 'recommended'
  category: string | null
  source: 'ui' | 'agents_md' | 'cursor_rules'
  filePath: string | null
  createdAt: string
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

export function ProjectDetailPage({ id }: { id: string }) {
  const [proj, setProj] = useState<Project | null>(null)
  const [tab, setTab] = useState<Tab>('basic')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const p = await api.get<Project>(`/api/projects/${id}`)
      setProj(p)
    } catch (ex) {
      setErr(String(ex))
    }
  }, [id])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (err) return <p className="text-red-600">{err}</p>
  if (!proj) return <p className="text-muted">加载中…</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <a
          href="#/projects"
          className="text-sm text-slate-500 hover:text-accent"
          onClick={(e) => {
            e.preventDefault()
            navigate('/projects')
          }}
        >
          ← 项目
        </a>
        <h1 className="font-semibold text-lg">{proj.name}</h1>
        <span className="tag">{proj.status}</span>
        <span className="tag">知识库 · {proj.knowledgeStatus}</span>
      </div>

      <nav className="flex gap-1 border-b border-border text-sm">
        <TabBtn active={tab === 'basic'} onClick={() => setTab('basic')}>
          介绍
        </TabBtn>
        <TabBtn active={tab === 'conventions'} onClick={() => setTab('conventions')}>
          规范
        </TabBtn>
        <TabBtn active={tab === 'knowledge'} onClick={() => setTab('knowledge')}>
          项目知识
        </TabBtn>
      </nav>

      {tab === 'basic' && <BasicTab proj={proj} onSaved={refresh} />}
      {tab === 'conventions' && <ConventionsTab projectId={proj.id} />}
      {tab === 'knowledge' && <KnowledgeTab projectId={proj.id} />}
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

function BasicTab({ proj, onSaved }: { proj: Project; onSaved: () => void }) {
  const [name, setName] = useState(proj.name)
  const [description, setDescription] = useState(proj.description)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setName(proj.name)
    setDescription(proj.description)
  }, [proj.name, proj.description])

  async function save() {
    setSaving(true)
    setMsg('')
    try {
      await api.patch(`/api/projects/${proj.id}`, { name, description })
      setMsg('已保存（描述变更会重新向量化）')
      onSaved()
    } catch (ex) {
      setMsg(String(ex))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card space-y-3">
      <div>
        <label className="label">名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label">介绍 / 项目知识背景（Markdown，保存后向量化）</label>
        <textarea
          className="input min-h-[200px] font-mono text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
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

function ConventionsTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Convention[]>([])
  const [content, setContent] = useState('')
  const [enforcement, setEnforcement] = useState<'required' | 'recommended'>('required')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      setItems(await api.get<Convention[]>(`/api/projects/${projectId}/conventions`))
    } catch (ex) {
      setErr(String(ex))
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function add() {
    if (!content.trim()) return
    setBusy(true)
    try {
      await api.post(`/api/projects/${projectId}/conventions`, {
        content: content.trim(),
        enforcement,
        category: category.trim() || undefined,
      })
      setContent('')
      setCategory('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  async function del(id: string) {
    setBusy(true)
    try {
      await api.del(`/api/conventions/${id}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (err) return <p className="text-red-600">{err}</p>

  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h3 className="font-semibold">新增规范</h3>
        <p className="text-xs text-muted">
          required 规范全量注入派单 prompt；recommended 仅在 RAG 命中时召回。
        </p>
        <div className="grid md:grid-cols-3 gap-2">
          <div>
            <label className="label">类别（可选）</label>
            <input
              className="input"
              placeholder="如 编码规范 / 命名约定"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>
          <div>
            <label className="label">强制级别</label>
            <select
              className="input"
              value={enforcement}
              onChange={(e) => setEnforcement(e.target.value as 'required' | 'recommended')}
            >
              <option value="required">required（硬约束）</option>
              <option value="recommended">recommended（建议）</option>
            </select>
          </div>
        </div>
        <textarea
          className="input min-h-[80px]"
          placeholder="规范内容…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <button className="btn-primary" disabled={busy || !content.trim()} onClick={add}>
          添加规范
        </button>
      </section>

      <section className="card">
        <h3 className="font-semibold mb-2">规范列表 ({items.length})</h3>
        {items.length === 0 && <p className="text-sm text-muted">暂无</p>}
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-2 border border-border rounded p-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`tag ${
                      c.enforcement === 'required' ? 'bg-red-50 text-red-700' : ''
                    }`}
                  >
                    {c.enforcement}
                  </span>
                  {c.category && <span className="tag">{c.category}</span>}
                  <span className="text-xs text-muted">来源 · {c.source}</span>
                  {c.filePath && <span className="text-xs text-muted">{c.filePath}</span>}
                </div>
                <p className="whitespace-pre-wrap mt-1">{c.content}</p>
              </div>
              {c.source === 'ui' && (
                <button
                  className="btn-danger text-xs px-2 shrink-0"
                  disabled={busy}
                  onClick={() => del(c.id)}
                >
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function KnowledgeTab({ projectId }: { projectId: string }) {
  const [facts, setFacts] = useState<MemoryItem[]>([])
  const [pitfalls, setPitfalls] = useState<MemoryItem[]>([])
  const [newItem, setNewItem] = useState('')
  const [kind, setKind] = useState<'fact' | 'pitfall'>('fact')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [f, p] = await Promise.all([
        api.get<MemoryItem[]>(`/api/memory/items?scope=project&scopeId=${projectId}&kind=fact`),
        api.get<MemoryItem[]>(`/api/memory/items?scope=project&scopeId=${projectId}&kind=pitfall`),
      ])
      setFacts(f)
      setPitfalls(p)
    } catch (ex) {
      setErr(String(ex))
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function add() {
    if (!newItem.trim()) return
    setBusy(true)
    try {
      await api.post('/api/memory/items', {
        scope: 'project',
        scopeId: projectId,
        kind,
        content: newItem.trim(),
      })
      setNewItem('')
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

  if (err) return <p className="text-red-600">{err}</p>

  return (
    <div className="space-y-4">
      <section className="card space-y-2">
        <h3 className="font-semibold">手动追加项目知识</h3>
        <p className="text-xs text-muted">
          facts = 项目背景事实；pitfalls =
          项目踩坑。系统执行完需求后会自动沉淀，这里支持人工补条目。
        </p>
        <div className="flex gap-2">
          <select
            className="input w-32"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'fact' | 'pitfall')}
          >
            <option value="fact">fact</option>
            <option value="pitfall">pitfall</option>
          </select>
          <input
            className="input flex-1"
            placeholder="内容…"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <button className="btn-primary" disabled={busy || !newItem.trim()} onClick={add}>
            添加
          </button>
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <KnowledgeList title="Facts" items={facts} busy={busy} onArchive={archive} />
        <KnowledgeList title="Pitfalls" items={pitfalls} busy={busy} onArchive={archive} />
      </div>
    </div>
  )
}

function KnowledgeList({
  title,
  items,
  busy,
  onArchive,
}: {
  title: string
  items: MemoryItem[]
  busy: boolean
  onArchive: (id: string) => void
}) {
  return (
    <section className="card">
      <h3 className="font-semibold mb-2">
        {title} <span className="text-xs text-muted">({items.length})</span>
      </h3>
      {items.length === 0 && <p className="text-sm text-muted">暂无</p>}
      <ul className="space-y-1">
        {items.map((it) => (
          <li
            key={it.id}
            className="flex items-start justify-between gap-2 border border-border rounded p-2 text-sm"
          >
            <div className="flex-1 min-w-0">
              <p>{it.content}</p>
              <p className="text-xs text-muted mt-1">
                importance {it.importanceScore.toFixed(2)} · hit {it.hitCount}
                {it.pendingReview && ' · 待审'}
              </p>
            </div>
            <button
              className="btn-danger text-xs px-2 shrink-0"
              disabled={busy}
              onClick={() => onArchive(it.id)}
            >
              归档
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
