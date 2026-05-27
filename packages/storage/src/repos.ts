/**
 * Repos 层 — 按聚合根组织的 CRUD 封装。
 *
 * 业务层（runtime / server / bridge-tg）应通过 repos 操作 DB，不直接 db.select/insert，
 * 保证表迁移、索引调整、约束变化时只需改一处。
 *
 * 设计要点：
 *   - 所有 id 由调用方传入或这里 crypto.randomUUID() 生成
 *   - 时间字段统一 new Date() 注入，drizzle 自动转 timestamp_ms
 *   - 复杂查询（带 join / 排序）暴露为方法；简单 CRUD 用 base 模板
 */

import { and, asc, desc, eq, lt, max } from 'drizzle-orm'
import type {
  BudgetCap,
  BudgetUsed,
  ClarificationQuestion,
  ClarificationTrigger,
  ConventionEnforcement,
  ConventionSource,
  EmployeeStats,
  LLMProvider,
  MemoryKind,
  MemoryScope,
  MessageContent,
  MessageRole,
  MessageType,
  Plan,
  Priority,
  ReportMetrics,
  RequirementStatus,
  SkillCategory,
  SkillExample,
  TokenUsage,
} from '@ai-emp/domain'
import type { DB } from './db.js'
import {
  checkpoints,
  chunks,
  clarifications,
  conventions,
  employeeSkills,
  employees,
  memoryItems,
  messages,
  projects,
  reports,
  requirements,
  runtimeState,
  threads,
} from './schema.js'

const newId = () => crypto.randomUUID()
const now = () => new Date()

// ──────────────────────────────────────────────────────────────
// Projects
// ──────────────────────────────────────────────────────────────
export class ProjectsRepo {
  constructor(private readonly db: DB) {}

  create(input: { name: string; description?: string; workdir?: string | null }): string {
    const id = newId()
    this.db
      .insert(projects)
      .values({
        id,
        name: input.name,
        description: input.description ?? '',
        workdir: input.workdir ?? null,
        createdAt: now(),
      })
      .run()
    return id
  }

  list() {
    return this.db.select().from(projects).orderBy(asc(projects.createdAt)).all()
  }

  findById(id: string) {
    return this.db.select().from(projects).where(eq(projects.id, id)).all()[0] ?? null
  }

  update(
    id: string,
    patch: Partial<{ name: string; description: string; workdir: string | null }>,
  ) {
    this.db.update(projects).set(patch).where(eq(projects.id, id)).run()
  }

  archive(id: string) {
    this.db
      .update(projects)
      .set({ status: 'archived', archivedAt: now() })
      .where(eq(projects.id, id))
      .run()
  }

  /** 级联删除 — DB 已配 ON DELETE CASCADE */
  delete(id: string) {
    this.db.delete(projects).where(eq(projects.id, id)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// Employees
// ──────────────────────────────────────────────────────────────
export class EmployeesRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    name: string
    role: string
    persona?: string
    modelProvider: LLMProvider
    modelName: string
    modelKeyRef: string
    modelBaseUrl?: string | undefined
    modelTemperature?: number | undefined
    modelMaxTokens?: number | undefined
  }): string {
    const id = newId()
    this.db
      .insert(employees)
      .values({
        id,
        name: input.name,
        role: input.role,
        persona: input.persona ?? '',
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        modelKeyRef: input.modelKeyRef,
        modelBaseUrl: input.modelBaseUrl ?? null,
        modelTemperature: input.modelTemperature ?? null,
        modelMaxTokens: input.modelMaxTokens ?? null,
        createdAt: now(),
      })
      .run()
    return id
  }

  findById(id: string) {
    return this.db.select().from(employees).where(eq(employees.id, id)).all()[0] ?? null
  }

  list() {
    return this.db.select().from(employees).orderBy(asc(employees.createdAt)).all()
  }

  updateStyle(id: string, style: string) {
    this.db.update(employees).set({ memoryStyleText: style }).where(eq(employees.id, id)).run()
  }

  update(
    id: string,
    patch: Partial<{
      name: string
      role: string
      persona: string
      modelProvider: LLMProvider
      modelName: string
      modelKeyRef: string
      modelBaseUrl: string | null
      modelTemperature: number | null
      modelMaxTokens: number | null
    }>,
  ) {
    if (Object.keys(patch).length === 0) return
    this.db.update(employees).set(patch).where(eq(employees.id, id)).run()
  }

  updateStats(id: string, stats: EmployeeStats) {
    this.db.update(employees).set({ statsJson: stats }).where(eq(employees.id, id)).run()
  }

  archive(id: string) {
    this.db
      .update(employees)
      .set({ status: 'archived', archivedAt: now() })
      .where(eq(employees.id, id))
      .run()
  }
}

// ──────────────────────────────────────────────────────────────
// Skills + EmployeeSkills
// ──────────────────────────────────────────────────────────────
export class SkillsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    name: string
    category: SkillCategory
    description: string
    promptTemplate: string
    requiredTools?: string[]
    examples?: SkillExample[]
    builtin?: boolean
  }): string {
    const id = newId()
    this.db
      .insert(skills)
      .values({
        id,
        name: input.name,
        category: input.category,
        description: input.description,
        promptTemplate: input.promptTemplate,
        requiredToolsJson: input.requiredTools ?? [],
        examplesJson: input.examples ?? null,
        builtin: input.builtin ?? false,
        createdAt: now(),
      })
      .run()
    return id
  }

  findById(id: string) {
    return this.db.select().from(skills).where(eq(skills.id, id)).all()[0] ?? null
  }

  list() {
    return this.db.select().from(skills).orderBy(asc(skills.createdAt)).all()
  }

  /** 给员工挂技能；order=0 表示主技能 */
  attach(employeeId: string, skillId: string, order = 0) {
    this.db
      .insert(employeeSkills)
      .values({ employeeId, skillId, order })
      .onConflictDoNothing()
      .run()
  }

  detach(employeeId: string, skillId: string) {
    this.db
      .delete(employeeSkills)
      .where(and(eq(employeeSkills.employeeId, employeeId), eq(employeeSkills.skillId, skillId)))
      .run()
  }

  /** 返回员工技能列表，order 升序（主技能在前） */
  listForEmployee(employeeId: string) {
    return this.db
      .select({ skill: skills, order: employeeSkills.order })
      .from(employeeSkills)
      .innerJoin(skills, eq(skills.id, employeeSkills.skillId))
      .where(eq(employeeSkills.employeeId, employeeId))
      .orderBy(asc(employeeSkills.order))
      .all()
  }

  update(
    id: string,
    patch: Partial<{
      name: string
      category: SkillCategory
      description: string
      promptTemplate: string
      requiredTools: string[]
      examples: SkillExample[]
    }>,
  ) {
    const dbPatch: Partial<typeof skills.$inferInsert> = {}
    if (patch.name !== undefined) dbPatch.name = patch.name
    if (patch.category !== undefined) dbPatch.category = patch.category
    if (patch.description !== undefined) dbPatch.description = patch.description
    if (patch.promptTemplate !== undefined) dbPatch.promptTemplate = patch.promptTemplate
    if (patch.requiredTools !== undefined) dbPatch.requiredToolsJson = patch.requiredTools
    if (patch.examples !== undefined) dbPatch.examplesJson = patch.examples
    if (Object.keys(dbPatch).length === 0) return
    this.db.update(skills).set(dbPatch).where(eq(skills.id, id)).run()
  }

  delete(id: string) {
    this.db.delete(skills).where(eq(skills.id, id)).run()
  }
}
// 兼容 `import { skills }` 用法（drizzle table）
import { skills } from './schema.js'

// ──────────────────────────────────────────────────────────────
// Requirements
// ──────────────────────────────────────────────────────────────
export class RequirementsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    title: string
    description: string
    projectId?: string | null
    assigneeId?: string | null
    priority?: Priority
    budgetCap: BudgetCap
    /** V2 O3 sub-agent: 父需求 id；通过 spawn_employee 派生的子工单填这里 */
    parentRequirementId?: string | null
    /** V2 O5 cron: 定时模板表达式（"every 5 minutes" / "daily 09:00" / "weekly mon 09:00"） */
    cronSpec?: string | null
    cronEnabled?: boolean
  }): string {
    const id = newId()
    this.db
      .insert(requirements)
      .values({
        id,
        title: input.title,
        description: input.description,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
        priority: input.priority ?? 'P1',
        status: '待分派',
        budgetCapJson: input.budgetCap,
        parentRequirementId: input.parentRequirementId ?? null,
        cronSpec: input.cronSpec ?? null,
        cronEnabled: input.cronEnabled ?? true,
        createdAt: now(),
      })
      .run()
    return id
  }

  /** V2 O5: 列出所有 cronSpec 非空 + cronEnabled 的模板工单 */
  listCronTemplates() {
    return this.db
      .select()
      .from(requirements)
      .where(and(eq(requirements.cronEnabled, true)))
      .all()
      .filter((r) => r.cronSpec !== null && r.cronSpec.trim().length > 0)
  }

  /** V2 O5: 模板触发完一次 child 后回写 lastRunAt */
  setCronLastRun(id: string, at: Date) {
    this.db.update(requirements).set({ cronLastRunAt: at }).where(eq(requirements.id, id)).run()
  }

  findById(id: string) {
    return this.db.select().from(requirements).where(eq(requirements.id, id)).all()[0] ?? null
  }

  listByStatus(status: RequirementStatus) {
    return this.db
      .select()
      .from(requirements)
      .where(eq(requirements.status, status))
      .orderBy(asc(requirements.createdAt))
      .all()
  }

  listAll() {
    return this.db.select().from(requirements).orderBy(desc(requirements.createdAt)).all()
  }

  listByProject(projectId: string) {
    return this.db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, projectId))
      .orderBy(desc(requirements.createdAt))
      .all()
  }

  listActive() {
    // status NOT IN ('已完成','已驳回','已取消')
    return this.db
      .select()
      .from(requirements)
      .orderBy(asc(requirements.createdAt))
      .all()
      .filter((r) => r.status !== '已完成' && r.status !== '已驳回' && r.status !== '已取消')
  }

  setStatus(id: string, status: RequirementStatus, opts: { completedAt?: Date } = {}) {
    const patch: Partial<typeof requirements.$inferInsert> = { status }
    if (opts.completedAt) patch.completedAt = opts.completedAt
    this.db.update(requirements).set(patch).where(eq(requirements.id, id)).run()
  }

  update(id: string, patch: Partial<{ title: string; description: string; priority: Priority }>) {
    if (Object.keys(patch).length === 0) return
    this.db.update(requirements).set(patch).where(eq(requirements.id, id)).run()
  }

  assign(id: string, employeeId: string) {
    this.db
      .update(requirements)
      .set({ assigneeId: employeeId })
      .where(eq(requirements.id, id))
      .run()
  }

  setPlan(id: string, plan: Plan) {
    this.db.update(requirements).set({ planJson: plan }).where(eq(requirements.id, id)).run()
  }

  setDeliverable(id: string, ref: string) {
    this.db.update(requirements).set({ deliverableRef: ref }).where(eq(requirements.id, id)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// Threads + Messages
// ──────────────────────────────────────────────────────────────
export class ThreadsRepo {
  constructor(private readonly db: DB) {}

  createForRequirement(requirementId: string): string {
    const id = newId()
    this.db.insert(threads).values({ id, requirementId, createdAt: now() }).run()
    return id
  }

  findByRequirement(requirementId: string) {
    return (
      this.db.select().from(threads).where(eq(threads.requirementId, requirementId)).all()[0] ??
      null
    )
  }
}

export class MessagesRepo {
  constructor(private readonly db: DB) {}

  append(input: {
    threadId: string
    role: MessageRole
    type: MessageType
    content: MessageContent
    tokens?: TokenUsage
  }): { id: string; seq: number } {
    // 在事务内取下一个 seq 防止并发冲突
    let id = ''
    let seq = 0
    this.db.transaction((tx) => {
      const lastSeq = tx
        .select({ s: max(messages.seq) })
        .from(messages)
        .where(eq(messages.threadId, input.threadId))
        .all()[0]?.s as number | null | undefined
      seq = (lastSeq ?? -1) + 1
      id = newId()
      tx.insert(messages)
        .values({
          id,
          threadId: input.threadId,
          seq,
          role: input.role,
          type: input.type,
          contentJson: input.content,
          tokensJson: input.tokens ?? null,
          createdAt: now(),
        })
        .run()
    })
    return { id, seq }
  }

  listByThread(threadId: string, opts: { sinceSeq?: number; limit?: number } = {}) {
    const where =
      opts.sinceSeq !== undefined
        ? and(eq(messages.threadId, threadId))
        : eq(messages.threadId, threadId)
    const q = this.db.select().from(messages).where(where).orderBy(asc(messages.seq))
    const rows = q.all()
    const filtered = opts.sinceSeq !== undefined ? rows.filter((r) => r.seq > opts.sinceSeq!) : rows
    return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered
  }

  /** 最新 N 条（按 seq 倒序取，再反转回正序） */
  tailByThread(threadId: string, n: number) {
    const rows = this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.seq))
      .limit(n)
      .all()
    return rows.reverse()
  }

  /**
   * 按 seq 倒序分页（UI 思维链滚动加载历史用）。
   *   - 无 beforeSeq：最新 limit 条
   *   - 有 beforeSeq：seq < beforeSeq 的最新 limit 条
   *   - hasMore 通过查询 limit+1 条判断
   */
  pageByThread(
    threadId: string,
    opts: { beforeSeq?: number; limit: number },
  ): { rows: (typeof messages.$inferSelect)[]; hasMore: boolean } {
    const where =
      opts.beforeSeq !== undefined
        ? and(eq(messages.threadId, threadId), lt(messages.seq, opts.beforeSeq))
        : eq(messages.threadId, threadId)
    const rows = this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.seq))
      .limit(opts.limit + 1)
      .all()
    const hasMore = rows.length > opts.limit
    return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore }
  }
}

// ──────────────────────────────────────────────────────────────
// Clarifications
// ──────────────────────────────────────────────────────────────
export class ClarificationsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    requirementId: string
    trigger: ClarificationTrigger
    employeeUnderstanding?: string
    proposedPlan?: string[]
    questions: ClarificationQuestion[]
  }): { id: string; round: number } {
    let id = ''
    let round = 0
    this.db.transaction((tx) => {
      const last = tx
        .select({ r: max(clarifications.round) })
        .from(clarifications)
        .where(eq(clarifications.requirementId, input.requirementId))
        .all()[0]?.r as number | null | undefined
      round = (last ?? -1) + 1
      id = newId()
      tx.insert(clarifications)
        .values({
          id,
          requirementId: input.requirementId,
          round,
          trigger: input.trigger,
          employeeUnderstanding: input.employeeUnderstanding ?? null,
          proposedPlanJson: input.proposedPlan ?? null,
          questionsJson: input.questions,
          createdAt: now(),
        })
        .run()
    })
    return { id, round }
  }

  findById(id: string) {
    return this.db.select().from(clarifications).where(eq(clarifications.id, id)).all()[0] ?? null
  }

  listByRequirement(requirementId: string) {
    return this.db
      .select()
      .from(clarifications)
      .where(eq(clarifications.requirementId, requirementId))
      .orderBy(asc(clarifications.round))
      .all()
  }

  resolve(id: string, questions: ClarificationQuestion[]) {
    this.db
      .update(clarifications)
      .set({ questionsJson: questions, resolvedAt: now() })
      .where(eq(clarifications.id, id))
      .run()
  }
}

// ──────────────────────────────────────────────────────────────
// RuntimeState（崩溃恢复快照）
// ──────────────────────────────────────────────────────────────
export class RuntimeStateRepo {
  constructor(private readonly db: DB) {}

  upsert(input: {
    requirementId: string
    currentStep: number
    historySummary: string
    budgetUsed: BudgetUsed
  }): void {
    const existing = this.find(input.requirementId)
    if (existing) {
      this.db
        .update(runtimeState)
        .set({
          currentStep: input.currentStep,
          historySummary: input.historySummary,
          budgetUsedJson: input.budgetUsed,
          lastHeartbeatAt: now(),
        })
        .where(eq(runtimeState.requirementId, input.requirementId))
        .run()
    } else {
      this.db
        .insert(runtimeState)
        .values({
          requirementId: input.requirementId,
          currentStep: input.currentStep,
          historySummary: input.historySummary,
          budgetUsedJson: input.budgetUsed,
          lastHeartbeatAt: now(),
        })
        .run()
    }
  }

  find(requirementId: string) {
    return (
      this.db
        .select()
        .from(runtimeState)
        .where(eq(runtimeState.requirementId, requirementId))
        .all()[0] ?? null
    )
  }

  /** 心跳：仅更新 lastHeartbeatAt */
  heartbeat(requirementId: string): void {
    this.db
      .update(runtimeState)
      .set({ lastHeartbeatAt: now() })
      .where(eq(runtimeState.requirementId, requirementId))
      .run()
  }

  delete(requirementId: string): void {
    this.db.delete(runtimeState).where(eq(runtimeState.requirementId, requirementId)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// Conventions
// ──────────────────────────────────────────────────────────────
export class ConventionsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    projectId: string
    content: string
    enforcement: ConventionEnforcement
    category?: string
    source?: ConventionSource
    filePath?: string
  }): string {
    const id = newId()
    const t = now()
    this.db
      .insert(conventions)
      .values({
        id,
        projectId: input.projectId,
        content: input.content,
        enforcement: input.enforcement,
        category: input.category ?? null,
        source: input.source ?? 'ui',
        filePath: input.filePath ?? null,
        createdAt: t,
        updatedAt: t,
      })
      .run()
    return id
  }

  listByProject(projectId: string) {
    return this.db
      .select()
      .from(conventions)
      .where(eq(conventions.projectId, projectId))
      .orderBy(asc(conventions.createdAt))
      .all()
  }

  delete(id: string) {
    this.db.delete(conventions).where(eq(conventions.id, id)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// MemoryItems
// ──────────────────────────────────────────────────────────────
export class MemoryItemsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    scope: MemoryScope
    scopeId: string
    kind: MemoryKind
    content: string
    sourceRequirementId?: string | null
    importanceScore?: number
    pendingReview?: boolean
  }): string {
    const id = newId()
    this.db
      .insert(memoryItems)
      .values({
        id,
        scope: input.scope,
        scopeId: input.scopeId,
        kind: input.kind,
        content: input.content,
        sourceRequirementId: input.sourceRequirementId ?? null,
        importanceScore: input.importanceScore ?? 0.5,
        pendingReview: input.pendingReview ?? false,
        createdAt: now(),
      })
      .run()
    return id
  }

  findById(id: string) {
    return this.db.select().from(memoryItems).where(eq(memoryItems.id, id)).all()[0] ?? null
  }

  list(opts: {
    scope: MemoryScope
    scopeId: string
    kind?: MemoryKind
    includeArchived?: boolean
  }) {
    let rows = this.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.scope, opts.scope), eq(memoryItems.scopeId, opts.scopeId)))
      .orderBy(desc(memoryItems.importanceScore))
      .all()
    if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind)
    if (!opts.includeArchived) rows = rows.filter((r) => !r.archived)
    return rows
  }

  incrementHit(id: string) {
    const row = this.findById(id)
    if (!row) return
    this.db
      .update(memoryItems)
      .set({ hitCount: row.hitCount + 1, lastHitAt: now() })
      .where(eq(memoryItems.id, id))
      .run()
  }

  setImportance(id: string, score: number) {
    this.db.update(memoryItems).set({ importanceScore: score }).where(eq(memoryItems.id, id)).run()
  }

  archive(id: string) {
    this.db.update(memoryItems).set({ archived: true }).where(eq(memoryItems.id, id)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// Reports
// ──────────────────────────────────────────────────────────────
export class ReportsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    requirementId: string
    contentMd: string
    metrics: ReportMetrics
    generatedBy?: 'auto' | 'manual'
  }): string {
    const id = newId()
    this.db
      .insert(reports)
      .values({
        id,
        requirementId: input.requirementId,
        contentMd: input.contentMd,
        metricsJson: input.metrics,
        generatedBy: input.generatedBy ?? 'auto',
        createdAt: now(),
      })
      .run()
    return id
  }

  findByRequirement(requirementId: string) {
    return (
      this.db.select().from(reports).where(eq(reports.requirementId, requirementId)).all()[0] ??
      null
    )
  }
}

// ──────────────────────────────────────────────────────────────
// Chunks（向量化元数据，向量本体由 memory 层操作 vec_chunks）
// ──────────────────────────────────────────────────────────────
export class ChunksRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    sourceType: 'project_desc' | 'convention' | 'memory_item'
    sourceId: string
    chunkIdx: number
    content: string
    tokens: number
  }): string {
    const id = newId()
    this.db
      .insert(chunks)
      .values({
        id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        chunkIdx: input.chunkIdx,
        content: input.content,
        tokens: input.tokens,
        createdAt: now(),
      })
      .run()
    return id
  }

  findByIds(ids: string[]) {
    if (ids.length === 0) return []
    // SQLite 没有 ANY(array)，简单逐条查（n 通常 <= 20）
    return ids
      .map((id) => this.db.select().from(chunks).where(eq(chunks.id, id)).all()[0])
      .filter((r): r is NonNullable<typeof r> => r != null)
  }

  deleteBySource(sourceType: string, sourceId: string) {
    this.db
      .delete(chunks)
      .where(and(eq(chunks.sourceType, sourceType as never), eq(chunks.sourceId, sourceId)))
      .run()
  }
}

// ──────────────────────────────────────────────────────────────
// TgMessageLinks — bridge-tg 自有映射表
// ──────────────────────────────────────────────────────────────
import { tgMessageLinks } from './schema.js'

export class TgMessageLinksRepo {
  constructor(private readonly db: DB) {}

  insert(input: { chatId: number; messageId: number; kind: string; refId: string }): void {
    this.db
      .insert(tgMessageLinks)
      .values({
        chatId: input.chatId,
        messageId: input.messageId,
        kind: input.kind,
        refId: input.refId,
        createdAt: now(),
      })
      .onConflictDoNothing()
      .run()
  }

  find(
    chatId: number,
    messageId: number,
  ): {
    chatId: number
    messageId: number
    kind: string
    refId: string
  } | null {
    return (
      this.db
        .select()
        .from(tgMessageLinks)
        .where(and(eq(tgMessageLinks.chatId, chatId), eq(tgMessageLinks.messageId, messageId)))
        .all()[0] ?? null
    )
  }

  findByRef(kind: string, refId: string) {
    return this.db
      .select()
      .from(tgMessageLinks)
      .where(and(eq(tgMessageLinks.kind, kind), eq(tgMessageLinks.refId, refId)))
      .all()
  }
}

// ──────────────────────────────────────────────────────────────
// CheckpointsRepo — V2 O4
// ──────────────────────────────────────────────────────────────
export type CheckpointKind = 'baseline' | 'manual'
export type CheckpointBackendKind = 'git' | 'tar' | 'none'

export class CheckpointsRepo {
  constructor(private readonly db: DB) {}

  create(input: {
    requirementId: string
    kind: CheckpointKind
    label: string
    backendKind: CheckpointBackendKind
    ref?: string | null
    workdir?: string | null
  }): string {
    const id = newId()
    this.db
      .insert(checkpoints)
      .values({
        id,
        requirementId: input.requirementId,
        kind: input.kind,
        label: input.label,
        backendKind: input.backendKind,
        ref: input.ref ?? null,
        workdir: input.workdir ?? null,
        createdAt: now(),
      })
      .run()
    return id
  }

  findById(id: string) {
    return this.db.select().from(checkpoints).where(eq(checkpoints.id, id)).all()[0] ?? null
  }

  listByRequirement(requirementId: string) {
    return this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.requirementId, requirementId))
      .orderBy(asc(checkpoints.createdAt))
      .all()
  }

  findBaseline(requirementId: string) {
    return (
      this.db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.requirementId, requirementId), eq(checkpoints.kind, 'baseline')))
        .orderBy(asc(checkpoints.createdAt))
        .all()[0] ?? null
    )
  }

  /** snapshot 完成后回填 backendKind + ref（internal use；下划线表示非公开 API） */
  _setBackendRef(id: string, backendKind: CheckpointBackendKind, ref: string | null) {
    this.db.update(checkpoints).set({ backendKind, ref }).where(eq(checkpoints.id, id)).run()
  }
}

// ──────────────────────────────────────────────────────────────
// 聚合 Repos
// ──────────────────────────────────────────────────────────────
export interface Repos {
  projects: ProjectsRepo
  employees: EmployeesRepo
  skills: SkillsRepo
  requirements: RequirementsRepo
  threads: ThreadsRepo
  messages: MessagesRepo
  clarifications: ClarificationsRepo
  runtimeState: RuntimeStateRepo
  conventions: ConventionsRepo
  memoryItems: MemoryItemsRepo
  reports: ReportsRepo
  chunks: ChunksRepo
  tgMessageLinks: TgMessageLinksRepo
  checkpoints: CheckpointsRepo
}

export function createRepos(db: DB): Repos {
  return {
    projects: new ProjectsRepo(db),
    employees: new EmployeesRepo(db),
    skills: new SkillsRepo(db),
    requirements: new RequirementsRepo(db),
    threads: new ThreadsRepo(db),
    messages: new MessagesRepo(db),
    clarifications: new ClarificationsRepo(db),
    runtimeState: new RuntimeStateRepo(db),
    conventions: new ConventionsRepo(db),
    memoryItems: new MemoryItemsRepo(db),
    reports: new ReportsRepo(db),
    chunks: new ChunksRepo(db),
    tgMessageLinks: new TgMessageLinksRepo(db),
    checkpoints: new CheckpointsRepo(db),
  }
}
