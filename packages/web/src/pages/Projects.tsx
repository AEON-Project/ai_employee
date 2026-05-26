import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Project } from '../lib/types'
import { navigate } from '../store/router'

export function ProjectsPage() {
  const [items, setItems] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  async function refresh() {
    setItems(await api.get<Project[]>('/api/projects'))
  }
  useEffect(() => {
    refresh()
  }, [])

  async function create() {
    if (!name) return
    setCreating(true)
    try {
      const p = await api.post<Project>('/api/projects', { name, description })
      setName('')
      setDescription('')
      await refresh()
      navigate(`/projects/${p.id}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="card">
        <h2 className="font-semibold mb-3">创建项目</h2>
        <div className="space-y-3">
          <div>
            <label className="label">名称</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">介绍（保存后自动向量化）</label>
            <textarea
              className="input min-h-[100px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <button className="btn-primary" disabled={creating || !name} onClick={create}>
            创建
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold mb-3">项目列表</h2>
        <ul className="space-y-2">
          {items.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between hover:bg-slate-50 px-2 py-1 rounded cursor-pointer"
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted text-sm ml-2">{p.description.slice(0, 60)}</span>
              </span>
              <span className="tag">{p.status}</span>
            </li>
          ))}
          {items.length === 0 && <p className="text-sm text-muted">暂无项目</p>}
        </ul>
      </section>
    </div>
  )
}
