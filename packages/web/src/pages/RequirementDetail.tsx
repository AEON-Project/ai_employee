import { useEffect, useMemo, useState } from 'react'
import { api, wsConnect } from '../lib/api'
import type { Clarification, Message, Requirement, ThreadResponse } from '../lib/types'
import { StatusBadge } from '../components/StatusBadge'

export function RequirementDetailPage({ reqId }: { reqId: string }) {
  const [req, setReq] = useState<Requirement | null>(null)
  const [thread, setThread] = useState<ThreadResponse | null>(null)
  const [clarifications, setClarifications] = useState<Clarification[]>([])
  const [tab, setTab] = useState<'thread' | 'plan'>('thread')

  async function refreshAll() {
    const [r, c] = await Promise.all([
      api.get<Requirement>(`/api/requirements/${reqId}`),
      api.get<Clarification[]>(`/api/requirements/${reqId}/clarifications`),
    ])
    setReq(r)
    setClarifications(c)
    try {
      const t = await api.get<ThreadResponse>(`/api/requirements/${reqId}/thread`)
      setThread(t)
    } catch {
      setThread(null)
    }
  }

  useEffect(() => {
    refreshAll()
    const ws = wsConnect(`/ws/req/${reqId}`, (msg) => {
      if (msg.kind !== 'event') return
      void refreshAll()
    })
    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqId])

  if (!req) return <p className="text-sm text-muted">加载中...</p>

  return (
    <div className="space-y-4">
      <header className="card flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">#{req.id.slice(0, 8)}</span>
            <h1 className="text-lg font-semibold">{req.title}</h1>
            <StatusBadge status={req.status} />
            <span className="tag">{req.priority}</span>
          </div>
          <p className="text-sm text-muted mt-2 whitespace-pre-wrap">{req.description}</p>
        </div>
        <Controls req={req} onChanged={refreshAll} />
      </header>

      {/* 澄清卡片 */}
      {clarifications
        .filter((c) => !c.resolvedAt)
        .map((c) => (
          <ClarificationCard key={c.id} clar={c} onAnswered={refreshAll} />
        ))}

      {/* 思维链三栏 */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3">
          <TabBtn active={tab === 'thread'} onClick={() => setTab('thread')}>
            思维链
          </TabBtn>
          <TabBtn active={tab === 'plan'} onClick={() => setTab('plan')}>
            Plan
          </TabBtn>
        </div>
        {tab === 'thread' ? (
          <ThreadView messages={thread?.messages ?? []} />
        ) : (
          <PlanView req={req} />
        )}
      </div>

      {req.status === '待验收' && <ApprovePanel reqId={req.id} onChanged={refreshAll} />}
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
      className={`text-sm px-3 py-1 rounded-md ${active ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Controls({ req, onChanged }: { req: Requirement; onChanged: () => void }) {
  async function call(path: string, body?: unknown) {
    await api.post(path, body)
    onChanged()
  }
  return (
    <div className="flex flex-wrap gap-2">
      {req.status === '进行中' && (
        <button className="btn" onClick={() => call(`/api/requirements/${req.id}/pause`)}>
          ⏸ 暂停
        </button>
      )}
      {req.status === '已暂停' && (
        <button className="btn" onClick={() => call(`/api/requirements/${req.id}/resume`)}>
          ▶ 继续
        </button>
      )}
      {(req.status === '已暂停' || req.status === '进行中') && (
        <button
          className="btn"
          onClick={() => call(`/api/requirements/${req.id}/force-end`, { keep: true })}
        >
          ⏹ 强制结束（保留）
        </button>
      )}
      {req.status !== '已完成' && req.status !== '已驳回' && req.status !== '已取消' && (
        <button className="btn-danger" onClick={() => call(`/api/requirements/${req.id}/cancel`)}>
          取消
        </button>
      )}
    </div>
  )
}

function ApprovePanel({ reqId, onChanged }: { reqId: string; onChanged: () => void }) {
  async function call(action: 'approve' | 'reject') {
    await api.post(`/api/requirements/${reqId}/${action}`)
    onChanged()
  }
  return (
    <div className="card flex items-center justify-between bg-purple-50 border-purple-200">
      <span className="text-sm">交付物已准备就绪，请确认</span>
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => call('approve')}>
          验收 ✓
        </button>
        <button className="btn-danger" onClick={() => call('reject')}>
          驳回 ✗
        </button>
      </div>
    </div>
  )
}

function ClarificationCard({ clar, onAnswered }: { clar: Clarification; onAnswered: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    try {
      await api.post(`/api/clarifications/${clar.id}/answer`, {
        answers: clar.questionsJson.map((q) => ({
          question: q.question,
          answer: answers[q.question] ?? '',
        })),
      })
      onAnswered()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="card border-amber-200 bg-amber-50">
      <h3 className="font-semibold mb-2">
        📋 澄清 #{clar.round} <span className="text-xs text-muted ml-2">{clar.trigger}</span>
      </h3>
      {clar.employeeUnderstanding && (
        <p className="text-sm bg-white p-3 rounded mb-3">
          <span className="font-medium">我理解的需求：</span>
          {clar.employeeUnderstanding}
        </p>
      )}
      {clar.proposedPlanJson && clar.proposedPlanJson.length > 0 && (
        <div className="text-sm bg-white p-3 rounded mb-3">
          <span className="font-medium">拆解步骤：</span>
          <ol className="list-decimal pl-5 mt-1">
            {clar.proposedPlanJson.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="space-y-2">
        {clar.questionsJson.map((q) => (
          <div key={q.question}>
            <label className="label">❓ {q.question}</label>
            <input
              className="input"
              value={answers[q.question] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <button className="btn-primary mt-3" disabled={submitting} onClick={submit}>
        提交回答，继续执行
      </button>
    </div>
  )
}

function ThreadView({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return <p className="text-sm text-muted">无消息</p>
  return (
    <div className="space-y-2 max-h-[600px] overflow-auto">
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} />
      ))}
    </div>
  )
}

function MessageItem({ m }: { m: Message }) {
  const text = useMemo(() => {
    const c = m.contentJson as Record<string, unknown>
    if (c.type === 'text' || c.type === 'thinking') return c.text as string
    if (c.type === 'plan_update') return `plan_update: ${c.reason as string}`
    if (c.type === 'tool_call') return `→ tool_call: ${c.name as string}(${JSON.stringify(c.args)})`
    if (c.type === 'tool_result')
      return c.ok
        ? `← tool_result: ${JSON.stringify(c.value)}`
        : `× tool_error: ${c.error as string}`
    if (c.type === 'error') return `❌ ${c.message as string}`
    return JSON.stringify(c)
  }, [m])

  const icon =
    m.type === 'thinking'
      ? '💭'
      : m.type === 'tool_call'
        ? '🔧'
        : m.type === 'tool_result'
          ? '📥'
          : m.type === 'clarification_request'
            ? '❓'
            : m.role === 'user'
              ? '👤'
              : '🤖'

  return (
    <div className="flex gap-2 text-sm">
      <span className="text-base">{icon}</span>
      <div className="flex-1">
        <div className="text-xs text-muted">
          #{m.seq} · {m.role}/{m.type}
        </div>
        <pre className="whitespace-pre-wrap font-sans">{text}</pre>
      </div>
    </div>
  )
}

function PlanView({ req }: { req: Requirement }) {
  if (!req.planJson) return <p className="text-sm text-muted">尚无 plan</p>
  return (
    <ol className="space-y-2">
      {req.planJson.steps.map((s) => (
        <li key={s.idx} className="text-sm flex items-center gap-2">
          <span className="tag">{s.status}</span>
          <span>
            {s.idx}. {s.text}
          </span>
        </li>
      ))}
    </ol>
  )
}
