/**
 * drizzle schema — V1.0 全部 18 张表。
 *
 * 对应 ARCHITECTURE §8.1 表清单 + §8.2 完整代码。
 * 虚拟表 vec_chunks 不在 drizzle 里描述（无法表达），见 migrations/0001_vec.sql。
 *
 * JSON 字段类型契约统一从 @ai-emp/core/domain 导入。
 */

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type {
  BudgetCap,
  BudgetUsed,
  ClarificationQuestion,
  EmployeeStats,
  MessageContent,
  Plan,
  ReportMetrics,
  SkillExample,
  TokenUsage,
} from '@ai-emp/domain'

// ──────────────────────────────────────────────────────────────
// projects
// ──────────────────────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // V1.1: 本地代码仓库根目录绝对路径；用于「待验收」时跑 git diff 展示员工真实改动
  workdir: text('workdir'),
  knowledgeStatus: text('knowledge_status', {
    enum: ['idle', 'indexing', 'ready', 'error'],
  })
    .notNull()
    .default('idle'),
  status: text('status', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
})

// ──────────────────────────────────────────────────────────────
// employees
// ──────────────────────────────────────────────────────────────
export const employees = sqliteTable('employees', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  role: text('role').notNull(),
  persona: text('persona').notNull().default(''),
  modelProvider: text('model_provider', { enum: ['anthropic', 'openai-compat'] }).notNull(),
  modelName: text('model_name').notNull(),
  modelBaseUrl: text('model_base_url'),
  modelKeyRef: text('model_key_ref').notNull(),
  modelTemperature: real('model_temperature').default(1.0),
  modelMaxTokens: integer('model_max_tokens'),
  // memory.style 是单段 text，非数组，单独存在这里
  memoryStyleText: text('memory_style_text').notNull().default(''),
  statsJson: text('stats_json', { mode: 'json' }).$type<EmployeeStats>(),
  status: text('status', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
})

// ──────────────────────────────────────────────────────────────
// skills + employee_skills
// ──────────────────────────────────────────────────────────────
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  promptTemplate: text('prompt_template').notNull(),
  requiredToolsJson: text('required_tools_json', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  examplesJson: text('examples_json', { mode: 'json' }).$type<SkillExample[]>(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const employeeSkills = sqliteTable(
  'employee_skills',
  {
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id),
    order: integer('order').notNull().default(0), // 0 = 主技能
  },
  (t) => ({
    pk: primaryKey({ columns: [t.employeeId, t.skillId] }),
    byEmp: index('emp_skills_emp').on(t.employeeId),
  }),
)

// ──────────────────────────────────────────────────────────────
// requirements
// ──────────────────────────────────────────────────────────────
export const requirements = sqliteTable(
  'requirements',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    assigneeId: text('assignee_id').references(() => employees.id),
    priority: text('priority', { enum: ['P0', 'P1', 'P2'] })
      .notNull()
      .default('P1'),
    status: text('status', {
      enum: [
        '待分派',
        '待澄清',
        '进行中',
        '等待回答',
        '已暂停',
        '待验收',
        '已完成',
        '已驳回',
        '已取消',
      ],
    }).notNull(),
    planJson: text('plan_json', { mode: 'json' }).$type<Plan>(),
    deliverableRef: text('deliverable_ref'),
    budgetCapJson: text('budget_cap_json', { mode: 'json' }).$type<BudgetCap>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    // V2 O3: 父需求引用 — 通过 spawn_employee 派生的子工单记录父；
    // null = 顶层工单。引擎用它防递归（spawn 链深度 ≤ 1）。
    parentRequirementId: text('parent_requirement_id').references((): any => requirements.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    byProj: index('req_proj').on(t.projectId),
    byAssignee: index('req_assignee').on(t.assigneeId),
    byStatus: index('req_status').on(t.status),
    byParent: index('req_parent').on(t.parentRequirementId),
  }),
)

// ──────────────────────────────────────────────────────────────
// threads + messages
// ──────────────────────────────────────────────────────────────
export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byReq: uniqueIndex('threads_req_unique').on(t.requirementId),
  }),
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    type: text('type', {
      enum: [
        'text',
        'thinking',
        'tool_call',
        'tool_result',
        'clarification_request',
        'clarification_answer',
        'plan_update',
        'error',
      ],
    }).notNull(),
    contentJson: text('content_json', { mode: 'json' }).$type<MessageContent>().notNull(),
    tokensJson: text('tokens_json', { mode: 'json' }).$type<TokenUsage>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byThreadSeq: uniqueIndex('msg_thread_seq').on(t.threadId, t.seq),
  }),
)

// ──────────────────────────────────────────────────────────────
// clarifications
// ──────────────────────────────────────────────────────────────
export const clarifications = sqliteTable(
  'clarifications',
  {
    id: text('id').primaryKey(),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    trigger: text('trigger', {
      enum: ['initial', 'decision_split', 'missing_info', 'pitfall_hit', 'cost_alert', 'judgment'],
    }).notNull(),
    employeeUnderstanding: text('employee_understanding'),
    proposedPlanJson: text('proposed_plan_json', { mode: 'json' }).$type<string[]>(),
    questionsJson: text('questions_json', { mode: 'json' })
      .$type<ClarificationQuestion[]>()
      .notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byReqRound: uniqueIndex('clar_req_round').on(t.requirementId, t.round),
  }),
)

// ──────────────────────────────────────────────────────────────
// reports
// ──────────────────────────────────────────────────────────────
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    contentMd: text('content_md').notNull(),
    metricsJson: text('metrics_json', { mode: 'json' }).$type<ReportMetrics>().notNull(),
    generatedBy: text('generated_by', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byReq: uniqueIndex('report_req').on(t.requirementId),
  }),
)

// ──────────────────────────────────────────────────────────────
// conventions
// ──────────────────────────────────────────────────────────────
export const conventions = sqliteTable(
  'conventions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    enforcement: text('enforcement', { enum: ['required', 'recommended'] }).notNull(),
    category: text('category'),
    source: text('source', {
      enum: ['ui', 'agents_md', 'claude_md', 'cursor_rules'],
    })
      .notNull()
      .default('ui'),
    filePath: text('file_path'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byProj: index('conv_proj').on(t.projectId),
  }),
)

// ──────────────────────────────────────────────────────────────
// memory_items（facts / pitfalls / lessons 三合一；style 不在此表）
// ──────────────────────────────────────────────────────────────
export const memoryItems = sqliteTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['project', 'employee'] }).notNull(),
    scopeId: text('scope_id').notNull(),
    kind: text('kind', { enum: ['fact', 'pitfall', 'lesson', 'skill'] }).notNull(),
    content: text('content').notNull(),
    sourceRequirementId: text('source_requirement_id').references(() => requirements.id, {
      onDelete: 'set null',
    }),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: integer('last_hit_at', { mode: 'timestamp_ms' }),
    importanceScore: real('importance_score').notNull().default(0.5),
    userFeedback: text('user_feedback', { enum: ['none', 'positive', 'negative'] })
      .notNull()
      .default('none'),
    pendingReview: integer('pending_review', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    byScope: index('mem_scope').on(t.scope, t.scopeId, t.kind, t.archived),
  }),
)

// ──────────────────────────────────────────────────────────────
// runtime_state（崩溃恢复快照）
// ──────────────────────────────────────────────────────────────
export const runtimeState = sqliteTable('runtime_state', {
  requirementId: text('requirement_id')
    .primaryKey()
    .references(() => requirements.id, { onDelete: 'cascade' }),
  currentStep: integer('current_step').notNull().default(0),
  historySummary: text('history_summary').notNull().default(''),
  budgetUsedJson: text('budget_used_json', { mode: 'json' }).$type<BudgetUsed>().notNull(),
  lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp_ms' }).notNull(),
})

// ──────────────────────────────────────────────────────────────
// tools + tool_grants
// ──────────────────────────────────────────────────────────────
export const tools = sqliteTable('tools', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  inputSchemaJson: text('input_schema_json', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  requiresAuth: integer('requires_auth', { mode: 'boolean' }).notNull().default(false),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(true),
})

export const toolGrants = sqliteTable(
  'tool_grants',
  {
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.employeeId, t.toolId] }),
  }),
)

// ──────────────────────────────────────────────────────────────
// credential_refs
// ──────────────────────────────────────────────────────────────
export const credentialRefs = sqliteTable('credential_refs', {
  id: text('id').primaryKey(),
  kind: text('kind', {
    enum: ['llm_key', 'tg_bot', 'embedding_key', 'localhost_token'],
  }).notNull(),
  keychainKey: text('keychain_key').notNull().unique(),
  label: text('label'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

// ──────────────────────────────────────────────────────────────
// tg_message_links（bridge 自有）
// ──────────────────────────────────────────────────────────────
export const tgMessageLinks = sqliteTable(
  'tg_message_links',
  {
    chatId: integer('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    kind: text('kind').notNull(),
    refId: text('ref_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.messageId] }),
    byKindRef: index('tg_kind_ref').on(t.kind, t.refId),
  }),
)

// ──────────────────────────────────────────────────────────────
// chunks（向量化元数据；向量本体在 vec_chunks 虚拟表，见 0001_vec.sql）
// ──────────────────────────────────────────────────────────────
export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type', {
      enum: ['project_desc', 'convention', 'memory_item'],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    chunkIdx: integer('chunk_idx').notNull(),
    content: text('content').notNull(),
    tokens: integer('tokens').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    bySource: index('chunks_source').on(t.sourceType, t.sourceId),
  }),
)
