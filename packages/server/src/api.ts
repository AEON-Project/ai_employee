/**
 * REST API 路由 — 挂在 /api/* 下，受 tokenAuth 保护。
 *
 * 覆盖 ARCHITECTURE §14.2 的核心路由：
 *   CRUD: projects / employees / skills / requirements / conventions / memory items
 *   命令: assign / pause / resume / cancel / approve / reject / force-end / answer
 */

import { Hono } from 'hono'
import { z } from 'zod'
import {
  DEFAULT_BUDGET_CAP,
  type LLMProvider,
  type Priority,
  type SkillCategory,
} from '@ai-emp/domain'
import {
  answerClarification,
  approveRequirement,
  assignRequirement,
  cancelRequirement,
  draftClarification,
  forceEndRequirement,
  pauseRequirement,
  rejectRequirement,
  resumeRequirement,
  revertToCheckpoint,
} from '@ai-emp/core/runtime'
import type { ServerDeps } from './server.js'

export function mountApi(app: Hono, deps: ServerDeps) {
  const { services } = deps
  const { repos } = services
  const api = new Hono()

  /** 若需求状态为「进行中」则推入调度器执行；其他状态忽略 */
  function enqueueIfRunning(reqId: string) {
    if (!deps.scheduler) return
    const r = repos.requirements.findById(reqId)
    if (r?.status === '进行中') deps.scheduler.enqueue(reqId)
  }

  // ── projects ─────────────────────────────────────────────
  api.get('/projects', (c) => c.json(repos.projects.list()))
  api.post('/projects', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        workdir: z.string().nullable().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = repos.projects.create(parsed.data)
    return c.json(repos.projects.findById(id), 201)
  })
  api.get('/projects/:id', (c) => {
    const r = repos.projects.findById(c.req.param('id'))
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404)
  })
  api.patch('/projects/:id', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        workdir: z.string().nullable().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    repos.projects.update(c.req.param('id'), parsed.data)
    return c.json(repos.projects.findById(c.req.param('id')))
  })
  api.delete('/projects/:id', (c) => {
    repos.projects.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // ── employees ────────────────────────────────────────────
  api.get('/employees', (c) => c.json(repos.employees.list()))
  api.post('/employees', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().min(1),
        role: z.string().min(1),
        persona: z.string().optional(),
        modelProvider: z.enum(['anthropic', 'openai-compat']),
        modelName: z.string().min(1),
        modelKeyRef: z.string().min(1),
        modelBaseUrl: z.string().optional(),
        modelTemperature: z.number().optional(),
        modelMaxTokens: z.number().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = repos.employees.create({
      ...parsed.data,
      modelProvider: parsed.data.modelProvider as LLMProvider,
    })
    return c.json(repos.employees.findById(id), 201)
  })
  api.get('/employees/:id', (c) => {
    const r = repos.employees.findById(c.req.param('id'))
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404)
  })
  api.patch('/employees/:id', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        persona: z.string().optional(),
        modelProvider: z.enum(['anthropic', 'openai-compat']).optional(),
        modelName: z.string().min(1).optional(),
        modelKeyRef: z.string().min(1).optional(),
        modelBaseUrl: z.string().nullable().optional(),
        modelTemperature: z.number().nullable().optional(),
        modelMaxTokens: z.number().nullable().optional(),
        memoryStyleText: z.string().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = c.req.param('id')
    const { memoryStyleText, ...rest } = parsed.data
    if (Object.keys(rest).length > 0) {
      repos.employees.update(id, {
        ...rest,
        modelProvider: rest.modelProvider as LLMProvider | undefined,
      })
    }
    if (memoryStyleText !== undefined) repos.employees.updateStyle(id, memoryStyleText)
    return c.json(repos.employees.findById(id))
  })
  api.delete('/employees/:id', (c) => {
    repos.employees.archive(c.req.param('id'))
    return c.json({ ok: true })
  })

  // ── skills ───────────────────────────────────────────────
  api.get('/skills', (c) => c.json(repos.skills.list()))
  api.post('/skills', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().min(1),
        category: z.enum(['技术', '设计', '内容', '数据', '运营', '通用']),
        description: z.string(),
        promptTemplate: z.string(),
        requiredTools: z.array(z.string()).optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = repos.skills.create({
      ...parsed.data,
      category: parsed.data.category as SkillCategory,
    })
    return c.json(repos.skills.findById(id), 201)
  })

  api.get('/skills/:id', (c) => {
    const r = repos.skills.findById(c.req.param('id'))
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404)
  })
  api.patch('/skills/:id', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        name: z.string().min(1).optional(),
        category: z.enum(['技术', '设计', '内容', '数据', '运营', '通用']).optional(),
        description: z.string().optional(),
        promptTemplate: z.string().optional(),
        requiredTools: z.array(z.string()).optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    repos.skills.update(c.req.param('id'), {
      ...parsed.data,
      category: parsed.data.category as SkillCategory | undefined,
    })
    return c.json(repos.skills.findById(c.req.param('id')))
  })
  api.delete('/skills/:id', (c) => {
    repos.skills.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  api.post('/employees/:id/skills/:skillId', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const order = typeof body.order === 'number' ? body.order : 0
    repos.skills.attach(c.req.param('id'), c.req.param('skillId'), order)
    return c.json({ ok: true })
  })
  api.delete('/employees/:id/skills/:skillId', (c) => {
    repos.skills.detach(c.req.param('id'), c.req.param('skillId'))
    return c.json({ ok: true })
  })
  api.get('/employees/:id/skills', (c) => c.json(repos.skills.listForEmployee(c.req.param('id'))))

  // ── requirements ─────────────────────────────────────────
  // 查询参数：
  //   status      — 单一状态筛选（如「进行中」）
  //   projectId   — 项目内需求
  //   all=true    — 显式包含已完成/驳回/取消（默认仅活跃）
  // 行为：传 status / projectId / all=true 任一时返回全量后过滤；都没传时返回活跃
  api.get('/requirements', (c) => {
    const status = c.req.query('status')
    const projectId = c.req.query('projectId')
    const all = c.req.query('all') === 'true'
    let rows = status
      ? repos.requirements.listByStatus(status as never)
      : all || projectId
        ? repos.requirements.listAll()
        : repos.requirements.listActive()
    if (projectId) rows = rows.filter((r) => r.projectId === projectId)
    return c.json(rows)
  })
  api.post('/requirements', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        title: z.string().min(1),
        description: z.string(),
        projectId: z.string().optional(),
        priority: z.enum(['P0', 'P1', 'P2']).optional(),
        budgetCap: z
          .object({
            maxIterations: z.number().int().positive(),
            maxTokens: z.number().int().positive(),
            maxWallTimeMs: z.number().int().positive(),
          })
          .optional(),
        // V2 O5: cron 定时模板
        cronSpec: z.string().optional(),
        cronEnabled: z.boolean().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    // V2 O5: cronSpec 非空时校验语法
    if (parsed.data.cronSpec && parsed.data.cronSpec.trim().length > 0) {
      const { parseCron } = await import('@ai-emp/core/cron')
      if (!parseCron(parsed.data.cronSpec)) {
        return c.json(
          {
            error: 'invalid_cron_spec',
            message: `不识别的 cron 语法: "${parsed.data.cronSpec}"。支持: "every N minutes" / "every N hours" / "daily HH:MM" / "weekly mon|tue|... HH:MM"`,
          },
          400,
        )
      }
    }
    const id = repos.requirements.create({
      title: parsed.data.title,
      description: parsed.data.description,
      projectId: parsed.data.projectId ?? null,
      priority: (parsed.data.priority as Priority | undefined) ?? 'P1',
      budgetCap: parsed.data.budgetCap ?? DEFAULT_BUDGET_CAP,
      cronSpec: parsed.data.cronSpec ?? null,
      cronEnabled: parsed.data.cronEnabled,
    })
    return c.json(repos.requirements.findById(id), 201)
  })
  api.get('/requirements/:id', (c) => {
    const r = repos.requirements.findById(c.req.param('id'))
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404)
  })
  api.patch('/requirements/:id', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        priority: z.enum(['P0', 'P1', 'P2']).optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = c.req.param('id')
    repos.requirements.update(id, {
      ...parsed.data,
      priority: parsed.data.priority as Priority | undefined,
    })
    return c.json(repos.requirements.findById(id))
  })

  // ── 需求命令 ─────────────────────────────────────────────
  api.post('/requirements/:id/assign', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z
      .object({ employeeId: z.string().min(1), skipClarification: z.boolean().optional() })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const reqId = c.req.param('id')
    const r = assignRequirement(services, reqId, parsed.data.employeeId, {
      skipClarification: parsed.data.skipClarification,
    })
    enqueueIfRunning(reqId)
    return c.json(r)
  })

  api.post('/requirements/:id/pause', (c) => {
    pauseRequirement(services, c.req.param('id'), 'user')
    return c.json({ ok: true })
  })
  api.post('/requirements/:id/resume', (c) => {
    const reqId = c.req.param('id')
    resumeRequirement(services, reqId)
    enqueueIfRunning(reqId)
    return c.json({ ok: true })
  })
  api.post('/requirements/:id/cancel', (c) => {
    cancelRequirement(services, c.req.param('id'))
    return c.json({ ok: true })
  })
  api.post('/requirements/:id/approve', (c) => {
    approveRequirement(services, c.req.param('id'))
    return c.json({ ok: true })
  })
  api.post('/requirements/:id/reject', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason : undefined
    // V2 O4: 可选先回滚到指定 checkpoint 再 reject
    const revertCheckpointId =
      typeof body?.revertCheckpointId === 'string' ? body.revertCheckpointId : undefined
    let revertResult: { ok: boolean; backupRef: string | null; error?: string } | null = null
    if (revertCheckpointId) {
      revertResult = await revertToCheckpoint(services, revertCheckpointId)
    }
    await rejectRequirement(services, c.req.param('id'), { reason })
    return c.json({ ok: true, revertResult })
  })
  api.get('/requirements/:id/checkpoints', (c) => {
    const reqId = c.req.param('id')
    const list = services.repos.checkpoints.listByRequirement(reqId)
    return c.json(list)
  })
  api.post('/checkpoints/:id/revert', async (c) => {
    const r = await revertToCheckpoint(services, c.req.param('id'))
    return c.json(r)
  })
  api.post('/requirements/:id/force-end', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const keep = body.keep === true
    forceEndRequirement(services, c.req.param('id'), { keep })
    return c.json({ ok: true })
  })

  // ── clarifications ───────────────────────────────────────
  api.get('/requirements/:id/clarifications', (c) =>
    c.json(repos.clarifications.listByRequirement(c.req.param('id'))),
  )
  api.post('/requirements/:id/clarify/draft', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z
      .object({
        employeeUnderstanding: z.string().optional(),
        proposedPlan: z.array(z.string()).optional(),
        questions: z
          .array(
            z.object({
              question: z.string().min(1),
              answerMode: z.enum(['user', 'auto_proceed']).optional(),
            }),
          )
          .min(1),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const r = await draftClarification(services, c.req.param('id'), async () => parsed.data)
    return c.json(r, 201)
  })
  api.post('/clarifications/:id/answer', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        answers: z.array(
          z.object({
            question: z.string(),
            answer: z.string(),
            answerMode: z.enum(['user', 'auto_proceed']).optional(),
          }),
        ),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const r = answerClarification(services, c.req.param('id'), parsed.data.answers)
    enqueueIfRunning(r.reqId)
    return c.json(r)
  })

  // ── thread / messages（只读，给 UI 渲染思维链）────────────
  // 查询模式（互斥）：
  //   ① ?limit=N[&beforeSeq=X]  → 分页拉历史，返回最新 N 条（seq 倒序）+ hasMore
  //   ② ?sinceSeq=Y             → 增量，返回 seq>Y 的全部（seq 正序）
  //   ③ 无 query                → 全量（seq 正序）—— 兼容老调用方
  api.get('/requirements/:id/thread', (c) => {
    const thread = repos.threads.findByRequirement(c.req.param('id'))
    if (!thread) return c.json({ error: 'not_found' }, 404)
    const limitRaw = c.req.query('limit')
    if (limitRaw !== undefined) {
      const limit = Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50))
      const beforeRaw = c.req.query('beforeSeq')
      const beforeSeq =
        beforeRaw !== undefined && Number.isFinite(parseInt(beforeRaw, 10))
          ? parseInt(beforeRaw, 10)
          : undefined
      const { rows, hasMore } = repos.messages.pageByThread(thread.id, {
        beforeSeq,
        limit,
      })
      return c.json({ thread, messages: rows, hasMore })
    }
    const sinceSeq = parseInt(c.req.query('sinceSeq') ?? '-1', 10)
    const messages = repos.messages.listByThread(thread.id, {
      sinceSeq: sinceSeq >= 0 ? sinceSeq : undefined,
    })
    return c.json({ thread, messages })
  })

  // ── git diff（待验收页面用，展示员工真实改动）────────────
  // 需要 req.project.workdir 存在 + 该目录是 git 仓库
  api.get('/requirements/:id/git-diff', async (c) => {
    const req = repos.requirements.findById(c.req.param('id'))
    if (!req) return c.json({ error: 'not_found' }, 404)
    if (!req.projectId) return c.json({ error: 'no_project' }, 400)
    const project = repos.projects.findById(req.projectId)
    if (!project) return c.json({ error: 'project_not_found' }, 404)
    if (!project.workdir) {
      return c.json(
        { error: 'no_workdir', message: '该项目未配置 workdir（本地代码仓库根目录）' },
        400,
      )
    }
    const cwd = project.workdir
    const { spawn } = await import('node:child_process')
    const runGit = (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
      new Promise((resolve) => {
        const child = spawn('git', args, { cwd })
        let stdout = ''
        let stderr = ''
        const MAX = 200_000
        child.stdout.on('data', (b: Buffer) => {
          if (stdout.length < MAX) stdout += b.toString('utf8').slice(0, MAX - stdout.length)
        })
        child.stderr.on('data', (b: Buffer) => {
          if (stderr.length < MAX) stderr += b.toString('utf8').slice(0, MAX - stderr.length)
        })
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }, 10_000)
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ stdout: '', stderr: String(err), code: -1 })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ stdout, stderr, code: code ?? -1 })
        })
      })
    const [status, stat, diff] = await Promise.all([
      runGit(['status', '--porcelain']),
      runGit(['diff', '--stat']),
      runGit(['diff']),
    ])
    return c.json({
      workdir: cwd,
      hasChanges: status.stdout.trim().length > 0,
      status: status.stdout,
      stat: stat.stdout,
      diff: diff.stdout,
      truncated: diff.stdout.length >= 200_000,
    })
  })

  // ── conventions ──────────────────────────────────────────
  api.get('/projects/:id/conventions', (c) =>
    c.json(repos.conventions.listByProject(c.req.param('id'))),
  )
  api.post('/projects/:id/conventions', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        content: z.string().min(1),
        enforcement: z.enum(['required', 'recommended']),
        category: z.string().optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = repos.conventions.create({ ...parsed.data, projectId: c.req.param('id') })
    return c.json({ id }, 201)
  })
  api.delete('/conventions/:id', (c) => {
    repos.conventions.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // ── memory items（只读 + archive） ────────────────────────
  api.get('/memory/items', (c) => {
    const scope = c.req.query('scope') as 'project' | 'employee' | undefined
    const scopeId = c.req.query('scopeId')
    const kind = c.req.query('kind') as 'fact' | 'pitfall' | 'lesson' | 'skill' | undefined
    if (!scope || !scopeId) return c.json({ error: 'scope and scopeId required' }, 400)
    return c.json(repos.memoryItems.list({ scope, scopeId, kind }))
  })
  api.post('/memory/items', async (c) => {
    const body = await c.req.json()
    const parsed = z
      .object({
        scope: z.enum(['project', 'employee']),
        scopeId: z.string().min(1),
        kind: z.enum(['fact', 'pitfall', 'lesson', 'skill']),
        content: z.string().min(1),
        importanceScore: z.number().min(0).max(1).optional(),
      })
      .safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400)
    const id = repos.memoryItems.create(parsed.data)
    return c.json(repos.memoryItems.findById(id), 201)
  })
  api.post('/memory/items/:id/archive', (c) => {
    repos.memoryItems.archive(c.req.param('id'))
    return c.json({ ok: true })
  })

  // 挂到主 app
  app.route('/api', api)
}
