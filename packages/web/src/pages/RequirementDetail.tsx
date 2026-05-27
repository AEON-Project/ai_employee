import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, wsConnect } from '../lib/api'
import type { Clarification, Message, Requirement, ThreadResponse } from '../lib/types'
import { StatusBadge } from '../components/StatusBadge'

export function RequirementDetailPage({ reqId }: { reqId: string }) {
  const [req, setReq] = useState<Requirement | null>(null)
  const [clarifications, setClarifications] = useState<Clarification[]>([])
  const [tab, setTab] = useState<'thread' | 'plan'>('thread')
  // bump 让 ThreadView 内部在 WS 事件 / 操作完成时重新拉最新一页
  const [threadRefreshTick, setThreadRefreshTick] = useState(0)

  async function refreshAll() {
    const [r, c] = await Promise.all([
      api.get<Requirement>(`/api/requirements/${reqId}`),
      api.get<Clarification[]>(`/api/requirements/${reqId}/clarifications`),
    ])
    setReq(r)
    setClarifications(c)
    setThreadRefreshTick((n) => n + 1)
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
          <ThreadView reqId={reqId} refreshTick={threadRefreshTick} />
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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function call(path: string, body?: unknown) {
    setBusy(true)
    setErr('')
    try {
      await api.post(path, body)
      onChanged()
    } catch (ex) {
      setErr(String(ex))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-2">
        {req.status === '进行中' && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => call(`/api/requirements/${req.id}/pause`)}
          >
            ⏸ 暂停
          </button>
        )}
        {req.status === '已暂停' && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => call(`/api/requirements/${req.id}/resume`)}
          >
            ▶ 继续
          </button>
        )}
        {(req.status === '已暂停' || req.status === '进行中') && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => call(`/api/requirements/${req.id}/force-end`, { keep: true })}
          >
            ⏹ 强制结束（保留）
          </button>
        )}
        {req.status !== '已完成' && req.status !== '已驳回' && req.status !== '已取消' && (
          <button
            className="btn-danger"
            disabled={busy}
            onClick={() => call(`/api/requirements/${req.id}/cancel`)}
          >
            取消
          </button>
        )}
      </div>
      {err && <p className="text-xs text-red-600 max-w-md text-right">{err}</p>}
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

const THREAD_PAGE_SIZE = 50

/**
 * 思维链：seq 倒序展示（最新在顶），向下滚动到底部触发加载更早历史。
 *   - refreshTick 变化：重拉最新一页，覆盖头部（合并并去重已加载的更早历史）
 *   - sentinel + IntersectionObserver：滚到底部 200px 内 → loadMore
 */
function ThreadView({ reqId, refreshTick }: { reqId: string; refreshTick: number }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 用 ref 持有当前 messages，避免 loadMore 闭包过期
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

  // 拉最新一页，合并已加载的更早消息（按 id 去重，保持 seq desc 顺序）
  const loadLatest = useCallback(async () => {
    try {
      setError(null)
      const r = await api.get<ThreadResponse>(
        `/api/requirements/${reqId}/thread?limit=${THREAD_PAGE_SIZE}`,
      )
      const latest = r.messages // seq desc
      const minLatestSeq = latest.length > 0 ? latest[latest.length - 1]!.seq : Infinity
      const older = messagesRef.current.filter((m) => m.seq < minLatestSeq)
      setMessages([...latest, ...older])
      // 只在初次加载时设置 hasMore；后续以 older.length>0 || r.hasMore 推断
      setHasMore((prev) => (older.length > 0 ? prev : (r.hasMore ?? false)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [reqId])

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    const cur = messagesRef.current
    if (cur.length === 0) return
    const earliestSeq = cur[cur.length - 1]!.seq
    setLoading(true)
    try {
      const r = await api.get<ThreadResponse>(
        `/api/requirements/${reqId}/thread?limit=${THREAD_PAGE_SIZE}&beforeSeq=${earliestSeq}`,
      )
      setMessages((prev) => [...prev, ...r.messages])
      setHasMore(r.hasMore ?? false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [reqId, loading, hasMore])

  // refreshTick 变化（初次挂载 / WS 事件 / 操作后）→ 拉最新一页
  useEffect(() => {
    void loadLatest()
  }, [loadLatest, refreshTick])

  // sentinel 进入视口 → loadMore
  useEffect(() => {
    const node = sentinelRef.current
    const root = containerRef.current
    if (!node || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '200px 0px' },
    )
    io.observe(node)
    return () => io.disconnect()
  }, [loadMore])

  if (messages.length === 0 && !error) return <p className="text-sm text-muted">无消息</p>

  return (
    <div ref={containerRef} className="space-y-2 max-h-[600px] overflow-auto">
      {error && <p className="text-xs text-danger">加载失败：{error}</p>}
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} />
      ))}
      {hasMore ? (
        <div ref={sentinelRef} className="text-xs text-muted text-center py-2">
          {loading ? '加载中...' : '向下滚动加载更早历史'}
        </div>
      ) : (
        messages.length >= THREAD_PAGE_SIZE && (
          <p className="text-xs text-muted text-center py-2">— 已到最早 —</p>
        )
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour12: false })
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
          #{m.seq} · {m.role}/{m.type} · {formatTime(m.createdAt)}
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
