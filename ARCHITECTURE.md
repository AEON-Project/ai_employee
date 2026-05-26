# AI 数字员工 — 技术架构文档 V1.0

> 本文是 `PRD_V1.md` 的工程落地版本。PRD 回答"做什么"，本文档回答"怎么做"。
> 所有结构性决策都已拍板；待定项在 §16 单独列出。
> 文档与 PRD 的章节对应处以 "PRD §X" 形式引用，不复述 PRD 内容。

---

## 目录

1. [产品定位与文档作用](#1-产品定位与文档作用)
2. [部署形态](#2-部署形态)
3. [技术栈](#3-技术栈)
4. [目录布局](#4-目录布局)
5. [Monorepo 与包结构](#5-monorepo-与包结构)
6. [模块依赖图](#6-模块依赖图)
7. [包对外 API 边界](#7-包对外-api-边界)
8. [数据库设计](#8-数据库设计)
9. [Agent Runtime](#9-agent-runtime)
10. [事件总线](#10-事件总线)
11. [Prompt 拼装与 RAG](#11-prompt-拼装与-rag)
12. [工具系统](#12-工具系统)
13. [Telegram Bridge](#13-telegram-bridge)
14. [HTTP / WebSocket Server 与 Web UI](#14-http--websocket-server-与-web-ui)
15. [凭证、安全与崩溃恢复](#15-凭证安全与崩溃恢复)
16. [待定项](#16-待定项)
17. [α 阶段交付边界](#17-α-阶段交付边界)

---

## 1. 产品定位与文档作用

V1.0 是**单用户本地运行的 AI 员工引擎**，验证 PRD §9.1 中"接活 → 澄清 → 执行 → 沉淀 → 下次更好"闭环。本架构文档只为 V1.0（α + β 共 8~12 周）服务，不预设 V1.1+ 演进路径。

设计原则：

- **Local-first**：DB、引擎、UI 全在用户机器上；零云组件（除 LLM 厂商 API）
- **核心层不感知通道**：Telegram、浏览器只是 view；将来加 Lark / IDE 插件不污染 core
- **状态机 + Append-only Log**：所有 mutate 走显式状态转移；思维链是 append-only 事件流，便于崩溃恢复
- **Engine-driven Agent loop**：LLM 不维护全局历史；每轮 prompt 由引擎从持久化状态重新拼装

---

## 2. 部署形态

**CLI 服务**。用户通过 `ai-emp serve` 启动单进程，进程包揽所有职责：

- HTTP/WebSocket server（伺服 React UI + REST API + 实时事件流）
- Agent Runtime（LLM loop、工具执行、Budget、Context 摘要）
- Telegram Bridge（grammY long-polling）
- SQLite 持久化层

Ctrl+C 退出 = 引擎全部停。重启时扫描 `runtime_state` 表里的 in-flight 需求，提示用户「继续 / 标记暂停」（PRD §9.3）。

> 隐含约束：**用户笔记本合盖 / 关机 = 员工停工**。这是 Local-first 的固有代价，已在 PRD §9.3 体现。

### 2.1 CLI 命令

```
ai-emp init                   首次引导：建 ~/.ai-emp/、下嵌入模型、写 config.toml、写入 keychain
ai-emp serve [--port 7878]    启动服务（前台进程）
ai-emp status                 列出 active / queued requirements
ai-emp logs <req-id> [-f]     输出 messages 表，-f 跟随
ai-emp backup [path]          SQLite 整盘 copy
ai-emp keychain set <name>    交互式写入凭证（不回显）
ai-emp models pull            重新下载嵌入模型
ai-emp recover                手动触发 in-flight 恢复流程
```

### 2.2 进程模型

- 单进程，async 池调度
- 多需求并发由 `RequirementScheduler` 控制：α 阶段 `maxConcurrent=1`（串行排队），β 阶段开放真并发
- LLM rate limit 按 provider key 维度做 token bucket，全局共享

---

## 3. 技术栈

| 用途 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Bun**（fallback Node 20+） | 内置 SQLite/WS/HTTP/test runner；`bun build --compile` 出单二进制 |
| 语言 | **TypeScript** strict | 前后端类型共享 |
| HTTP/WS | **Hono** + `@hono/ws` | 极简、Bun 原生支持 |
| Telegram | **grammY** | TS-first、long-polling 一行起 |
| SQLite | **`bun:sqlite`** + **sqlite-vec** | Bun 内置；vec 走 native binding |
| ORM | **drizzle-orm** | 类型安全 + 迁移文件 |
| 嵌入 | **`@xenova/transformers` + `bge-small-zh-v1.5`** | 纯 JS、~30MB、中文效果接近 OpenAI small；512 维 |
| LLM | **`@anthropic-ai/sdk`** + **`openai`** | Anthropic 原生；OpenAI SDK 兼容 DeepSeek/智谱/Kimi（自定义 baseURL） |
| Schema | **Zod** | tool input / API I/O / event payload 同一份 |
| 凭证 | **keytar** | macOS Keychain / Windows DPAPI / Linux libsecret |
| 日志 | **pino** | 结构化、async-friendly |
| 状态机 | **手写 enum + transition 函数** | 9 个状态，xstate 过重 |
| 前端 | **React + Vite + Tailwind + shadcn/ui + Zustand** | 主流；构建产物嵌入二进制 |

---

## 4. 目录布局

`~/.ai-emp/` 是用户数据根目录，所有可变状态都在这里：

```
~/.ai-emp/
├── config.toml              端口、TG 白名单、嵌入模型路径、默认 budget 等
├── db.sqlite + -wal + -shm  SQLite WAL 模式
├── models/
│   └── bge-small-zh-v1.5/   transformers.js 权重（init 时下载）
├── attachments/             需求附件 / 交付物文件
│   └── <req-id>/...
├── logs/
│   └── 2026-MM-DD.log       pino 日志，按天滚动
└── backups/                 手动 ai-emp backup 落点
```

`config.toml` 凭证字段只存 `keychain://<id>` 引用，实际 token 在 OS keychain。示例：

```toml
[server]
port = 7878
localhost_token_ref = "keychain://localhost-token"

[telegram]
bot_token_ref = "keychain://tg-bot-token"
allowed_chat_ids = [12345678]

[embedding]
model = "bge-small-zh-v1.5"
dim = 512

[defaults.budget]
max_iterations = 30
max_tokens = 200000
max_wall_time_ms = 1800000
```

---

## 5. Monorepo 与包结构

bun workspaces。所有 package 内部用 TypeScript path mapping，编译产物只在最终 `cli` 打包时合并。

```
ai-emp/
├── packages/
│   ├── core/            领域模型 + Agent Runtime + 记忆 + Prompt
│   │   ├── domain/      Employee/Skill/Requirement/Project/Thread/Message types + Zod
│   │   ├── runtime/     state-machine, executeRequirement, scheduler
│   │   ├── memory/      RAG, Importance Scoring, 双向沉淀
│   │   └── prompt/      PromptComposer
│   ├── storage/         drizzle schema + repos + migrations
│   ├── llm/             provider 适配（anthropic / openai-compat）
│   ├── tools/           ToolRegistry + ToolExecutor + 内置 tool
│   ├── embedding/       transformers.js 封装
│   ├── events/          类型化 EventBus
│   ├── server/          Hono HTTP + WS
│   ├── bridge-tg/       grammY long-polling
│   ├── web/             React + Vite SPA（独立构建）
│   └── cli/             入口；命令路由
├── drizzle.config.ts
├── package.json         workspaces 配置
└── ARCHITECTURE.md      （本文档）
```

---

## 6. 模块依赖图

```
                     ┌─────────┐         ┌─────────────┐
                     │   cli   │         │     web     │  独立构建
                     └────┬────┘         └──────┬──────┘
                          │                     │
              ┌───────────┴───────────┐         │ HTTP/WS
              │                       │         │
              ▼                       ▼         ▼
       ┌────────────┐         ┌──────────────────┐
       │ bridge-tg  │         │      server      │
       └─────┬──────┘         └─────────┬────────┘
             │                          │
             └────────────┬─────────────┘
                          │  命令式 API + 订阅 EventBus
                          ▼
        ┌─────────────────────────────────────────┐
        │              core/runtime               │
        └──┬──────┬──────┬──────┬──────┬──────────┘
           │      │      │      │      │
           ▼      ▼      ▼      ▼      ▼
        ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────────┐
        │mem │ │prom│ │llm │ │tool│ │embedding│
        │ory │ │pt  │ │    │ │s   │ │         │
        └─┬──┘ └─┬──┘ └────┘ └─┬──┘ └─────────┘
          │      │             │
          └──────┴─────────────┘
                 │
                 ▼
           ┌──────────┐         ┌──────────┐
           │ storage  │◀───────▶│  events  │
           └──────────┘         └──────────┘
```

**依赖规则**：

- 箭头只能向下
- `events` 是横切层，任何包都可 emit/订阅
- **`core` 永远不依赖 `server` / `bridge-tg` / `cli`**——通道层可替换
- 前端 `web` 只通过 HTTP/WS 与 `server` 通信；可 `import type` core/domain（类型零运行时开销）

---

## 7. 包对外 API 边界

### 7.1 `packages/storage`

```ts
export const db: DrizzleClient
export const repos = {
  projects, employees, skills, employeeSkills, requirements,
  threads, messages, clarifications, reports, conventions,
  memoryItems, runtimeState, tools, toolGrants,
  credentialRefs, tgMessageLinks, chunks
}
export async function migrate(): Promise<void>
```

### 7.2 `packages/events`

```ts
export const bus: TypedEventBus<EventMap>
export type EventMap = { /* §10 完整事件目录 */ }
```

### 7.3 `packages/llm`

```ts
export interface LLMClient {
  stream(req: LLMRequest): AsyncIterable<LLMChunk>      // 含 tool_call 帧
  complete(req: LLMRequest): Promise<LLMResponse>       // 非流式（澄清卡片）
}
export function createClient(modelConfig: ModelConfig): LLMClient
// providers/anthropic.ts    Anthropic 原生 SDK
// providers/openai-compat.ts  OpenAI SDK + 自定义 baseURL
```

### 7.4 `packages/tools`

```ts
export const registry: ToolRegistry           // register / listFor(employee) / toolSchemas
export const executor: ToolExecutor           // invoke(call): Promise<ToolResult>
// 内置工具：
//   系统级（不进 tool_grants）：ask_user, advance_step, update_plan, emit_deliverable
//   普通（需 tool_grants）：     web_search, read_file, write_file
```

### 7.5 `packages/embedding`

```ts
export interface EmbeddingService {
  ready(): Promise<void>                      // 首次启动等模型加载完成
  embed(texts: string[]): Promise<Float32Array[]>
  readonly dim: number                         // 512
}
```

### 7.6 `packages/core/runtime`

```ts
export async function executeRequirement(reqId: string): Promise<void>
export async function draftClarification(reqId: string): Promise<Clarification>
export async function answerClarification(clarificationId: string, answers: AnswerMap): Promise<void>
export async function pauseRequirement(reqId: string, reason: PauseReason): Promise<void>
export async function resumeRequirement(reqId: string, opts?: { extendBudget?: BudgetDelta }): Promise<void>
export async function cancelRequirement(reqId: string): Promise<void>
export async function forceEnd(reqId: string, opts: { keep: boolean }): Promise<void>
export async function recoverInflight(): Promise<{ recovered: string[] }>
```

### 7.7 `packages/core/memory`

```ts
export const memory: {
  recall(args: { scope: 'project'|'employee'; scopeId: string; query: string;
                 kinds: MemoryKind[]; k: number }): Promise<MemoryItem[]>
  persistFromReport(reqId: string, reportMd: string): Promise<{ persisted: number; pending: number }>
  updateImportance(itemId: string, signal: Signal): Promise<void>
  archiveLowScore(): Promise<number>            // 周批
  reindexSource(sourceType: SourceType, sourceId: string): Promise<void>
}
```

### 7.8 `packages/core/prompt`

```ts
export const PromptComposer: {
  compose(ctx: PromptContext): { prompt: PromptPayload; tokensEstimate: number; debug?: object }
}
```

### 7.9 `packages/server`

```ts
export function createServer(opts: { port: number; dataDir: string }): { start(): Promise<void>; stop(): Promise<void> }
// REST：CRUD（项目/员工/技能/需求）+ 命令（pause/resume/cancel/approve/reject）
// WS /ws/req/:id   订阅单需求事件流
// WS /ws/global    订阅全局（state_changed / scheduler / budget.warning）
// 所有请求需带 localhost_token（cookie 或 Authorization header）
```

### 7.10 `packages/bridge-tg`

```ts
export function createBridge(opts: { tokenRef: string; allowedChatIds: number[] }): {
  start(): Promise<void>; stop(): Promise<void>
}
// 内部订阅 EventBus 推 TG；解析命令/Reply 调 core/runtime
```

### 7.11 `packages/cli`

详见 §2.1。

---

## 8. 数据库设计

### 8.1 表清单

| 表 | 用途 |
|---|---|
| `projects` | 项目（知识容器） |
| `employees` | 员工档案（含 `memory_style_text` 单段，非数组） |
| `skills` | 技能（含预置） |
| `employee_skills` | 多对多挂载，`order=0` 为主技能 |
| `requirements` | 需求主表 |
| `threads` | 1:1 关联需求 |
| `messages` | 思维链事件流，append-only，高频写 |
| `clarifications` | 澄清记录，按 round 单调递增 |
| `reports` | 需求完成/驳回总结，1:1 关联需求 |
| `conventions` | 项目规范（含来源标记） |
| `memory_items` | facts / pitfalls / lessons 三合一（含 `pending_review`） |
| `runtime_state` | 崩溃恢复快照，每需求一行 |
| `tools` | 工具元数据 |
| `tool_grants` | 员工 ↔ 工具授权 M2M |
| `credential_refs` | 凭证引用（keychain key 映射） |
| `tg_message_links` | TG 消息 ↔ 领域实体映射，bridge 自有 |
| `chunks` | 向量化分块元数据 |
| `vec_chunks` | sqlite-vec 虚拟表（raw SQL migration） |
| `schema_migrations` | drizzle 自管 |

### 8.2 完整 schema 代码

四张高频/有 trick 的表见下；其余表的字段集在 PRD §5 + §6 已定，按 8.3 模板生成。

```ts
// packages/storage/src/schema.ts
import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex }
  from 'drizzle-orm/sqlite-core'

export const requirements = sqliteTable('requirements', {
  id:             text('id').primaryKey(),
  title:          text('title').notNull(),
  description:    text('description').notNull(),
  projectId:      text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  assigneeId:     text('assignee_id').references(() => employees.id),
  priority:       text('priority', { enum: ['P0','P1','P2'] }).notNull().default('P1'),
  status:         text('status', { enum: [
                    '待分派','待澄清','进行中','等待回答','已暂停',
                    '待验收','已完成','已驳回','已取消'] }).notNull(),
  planJson:       text('plan_json', { mode: 'json' }).$type<Plan>(),
  deliverableRef: text('deliverable_ref'),
  budgetCapJson:  text('budget_cap_json', { mode: 'json' }).$type<BudgetCap>().notNull(),
  createdAt:      integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt:    integer('completed_at', { mode: 'timestamp_ms' }),
}, t => ({
  byProj:     index('req_proj').on(t.projectId),
  byAssignee: index('req_assignee').on(t.assigneeId),
  byStatus:   index('req_status').on(t.status),
}))

export const messages = sqliteTable('messages', {
  id:          text('id').primaryKey(),
  threadId:    text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  seq:         integer('seq').notNull(),
  role:        text('role', { enum: ['system','user','assistant','tool'] }).notNull(),
  type:        text('type', { enum: [
                 'text','thinking','tool_call','tool_result',
                 'clarification_request','clarification_answer',
                 'plan_update','error'] }).notNull(),
  contentJson: text('content_json', { mode: 'json' }).notNull(),
  tokensJson:  text('tokens_json',  { mode: 'json' }).$type<TokenUsage>(),
  createdAt:   integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => ({
  byThreadSeq: uniqueIndex('msg_thread_seq').on(t.threadId, t.seq),
}))

export const memoryItems = sqliteTable('memory_items', {
  id:                  text('id').primaryKey(),
  scope:               text('scope', { enum: ['project','employee'] }).notNull(),
  scopeId:             text('scope_id').notNull(),
  kind:                text('kind',  { enum: ['fact','pitfall','lesson'] }).notNull(),
  content:             text('content').notNull(),
  sourceRequirementId: text('source_requirement_id')
                         .references(() => requirements.id, { onDelete: 'set null' }),
  hitCount:            integer('hit_count').notNull().default(0),
  lastHitAt:           integer('last_hit_at', { mode: 'timestamp_ms' }),
  importanceScore:     real('importance_score').notNull().default(0.5),
  userFeedback:        text('user_feedback', { enum: ['none','positive','negative'] })
                         .notNull().default('none'),
  pendingReview:       integer('pending_review', { mode: 'boolean' }).notNull().default(false),
  archived:            integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt:           integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => ({
  byScope: index('mem_scope').on(t.scope, t.scopeId, t.kind, t.archived),
}))

export const runtimeState = sqliteTable('runtime_state', {
  requirementId:   text('requirement_id').primaryKey()
                     .references(() => requirements.id, { onDelete: 'cascade' }),
  currentStep:     integer('current_step').notNull().default(0),
  historySummary:  text('history_summary').notNull().default(''),
  budgetUsedJson:  text('budget_used_json', { mode: 'json' }).$type<BudgetUsed>().notNull(),
  lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp_ms' }).notNull(),
})
```

### 8.3 JSON 类型契约

写在 `packages/core/domain/types.ts`，storage 通过 `$type<>()` 引用；前后端共享同一份。

```ts
export type BudgetCap   = { maxIterations: number; maxTokens: number; maxWallTimeMs: number }
export type BudgetUsed  = { iterations: number; tokensIn: number; tokensOut: number; wallTimeMs: number }
export type Plan        = { steps: { idx: number; text: string; status: 'pending'|'doing'|'done' }[] }
export type TokenUsage  = { input: number; output: number; cached?: number }
export type ClarificationQuestion = { question: string; answer?: string; answerMode: 'user'|'auto_proceed' }
export type MessageContent =
  | { type: 'text', text: string }
  | { type: 'thinking', text: string }
  | { type: 'tool_call', name: string, args: unknown, callId: string }
  | { type: 'tool_result', callId: string, ok: boolean, value?: unknown, error?: string }
  | { type: 'plan_update', plan: Plan, reason: string }
  | { type: 'error', message: string, fatal: boolean }
```

### 8.4 向量层

```sql
-- migrations/0002_vec.sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[512],
  chunk_id  text
);
```

RAG 检索：

```sql
SELECT c.* FROM vec_chunks v
  JOIN chunks c ON c.id = v.chunk_id
WHERE v.embedding MATCH ? AND k = 10
ORDER BY distance;
```

随后在应用层用 Importance Scoring 重排（`相似度 × importance_score`，PRD §6.1）。

### 8.5 SQLite PRAGMA

启动时执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

---

## 9. Agent Runtime

### 9.1 Requirement 主状态机（对外可见）

9 个状态。所有转移走 `packages/core/runtime/state-machine.ts` 的 `transition(req, event)` 纯函数；非法转移抛 `IllegalTransition`。任何 mutate 同时 emit `requirement.state_changed`。

```
                          ┌──── 用户取消 ─────┐
                          │                  │
                          ▼                  │
                       已取消               │
                          ▲                  │
                          │                  │
   [创建] ─▶ 待分派 ─assign─▶ 待澄清 ─(simple/手动跳过)─▶ ┐
                │                  │                      │
                │ assign+simple    │ 用户确认澄清            │
                ▼                  ▼                      │
              进行中 ◀──────────────────────────────────── ┘
                │  ▲    ▲     ▲
                │  │    │     └────── 用户继续 ────── 已暂停
                │  │    │                              ▲   │
                │  │    └─ 用户回答 ─── 等待回答 ◀──┐   │   │
                │  │                       ▲       │   │   │
                │  │  ask_user(tool)       │       │   │   │
                │  ├──────────────────────┘       │   │   │
                │  │                                │   │   │
                │  │   budget触达/LLM错误/暂停 ───▶  ┼───┘   │
                │  │                                │       │
                │  │   在等待回答里直接暂停 ─────▶ ┘       │
                │  │                                       │
                │  └─── 用户继续（含增加 budget）──────────┘
                │
                │ emit_deliverable
                ▼
              待验收 ── 验收 ──▶ 已完成 ─▶ [双向沉淀]
                  │
                  └── 驳回 ──▶ 已驳回 ──▶ [纠错复盘]

   强制结束（来自进行中/暂停）：保留产出 → 已完成；丢弃 → 已取消
```

### 9.2 Runtime 子状态机（`进行中` 内部）

```
                        ┌─────────────────────────────────┐
                        │              IDLE               │◀──────────┐
                        │  准备开新一轮，state 已落盘       │           │
                        └────────────┬────────────────────┘           │
                                     │                                │
                ┌────────────────────┼────────────────────┐           │
                │                    │                    │           │
       (budget gate fail)    (ctx > 80% cap)        (一切正常)        │
                │                    │                    │           │
                ▼                    ▼                    ▼           │
            ╔══════╗        ┌──────────────────┐  ┌──────────────┐   │
            ║PAUSED║◀──┐    │COMPACTING_CONTEXT│  │COMPOSING_PROMPT│ │
            ╚══════╝   │    └──────┬───────────┘  └──────┬────────┘   │
                       │           └──────────────┐      │            │
                       │                          ▼      ▼            │
                       │                  ┌─────────────────────┐    │
                       │                  │   STREAMING_LLM     │    │
                       │                  │ 消费 chunks 直到    │    │
                       │  ┌───────────────┤  tool_call 出现     │    │
                       │  │               └────────┬────────────┘    │
                       │  │                        │                  │
                       │  │  stream error/timeout  │ tool_call frame  │
                       │  └────────────────────────┤                  │
                       │                            ▼                  │
                       │                  ┌────────────────┐          │
                       │ (3 连续失败)      │   DISPATCH     │          │
                       │◀─────────────────┤  按 tool name   │          │
                       │                  └───┬──────┬──────┘          │
                       │                      │      │                 │
                       │       系统级 tool   ▼      ▼  普通 tool       │
                       │                ┌────────┐ ┌──────────────┐   │
                       │                │ inline │ │EXECUTING_TOOL│   │
                       │                │ apply  │ │(重试/超时/检) │   │
                       │                └───┬────┘ └──────┬───────┘   │
                       │                    │             │            │
                       │   advance_step /   │   ok / err  │            │
                       │   update_plan ─────┼─────────────┘────────────┘ 回 IDLE
                       │                    │
                       │   ask_user ────────┼──▶ AWAITING_USER → main: 等待回答
                       │                    │
                       │   emit_deliverable ┘──▶ DELIVERED      → main: 待验收
                       │
                       └─ runtime fatal → main: 已暂停
```

### 9.3 关键不变量

1. **IDLE 是唯一的快照一致点**：`runtime_state` 只在 IDLE → 下一状态之间写。
2. **STREAMING_LLM 不写 runtime_state**，只 append `messages`（崩溃只丢"正在 stream 的 thinking 片段"，可接受）。
3. **AWAITING_USER / PAUSED 是干净中止**：runtime 协程退出；用户回答或 `resumeRequirement()` 触发新一次 `executeRequirement()`，从 IDLE 重入。

### 9.4 主循环伪代码

```ts
async function executeRequirement(reqId: string) {
  const ctx = await StateStore.load(reqId)   // { plan, currentStep, historySummary, budget, recentMsgs }

  while (req.status === '进行中') {
    // ① 闸门
    if (ctx.budget.iterations >= cap.iterations) return pause('iterations')
    if (ctx.budget.tokens     >= cap.tokens)     return pause('tokens')
    if (ctx.budget.wallTime   >= cap.wallTime)   return pause('wallTime')

    // ② Context 摘要触发（β）
    if (ctx.recentTokens > model.contextWindow * 0.8) {
      ctx.historySummary = await summarizer.compact(ctx)
    }

    // ③ 拼装 prompt（顺序见 §11）
    const prompt = await PromptComposer.compose({ ...ctx })

    // ④ LLM 流式
    const stream = llm.stream({ prompt, tools: registry.toolSchemas(employee) })

    // ⑤ 消费 stream 直到 tool_call 或 message_stop
    let decision: ToolCall | null = null
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'thinking_delta': throttledAppend('thinking', chunk.text); break
        case 'text_delta':     throttledAppend('text',     chunk.text); break
        case 'usage':          ctx.budget.add(chunk);                    break
        case 'tool_use_stop':  decision = chunk; break // 立即结束消费
        case 'message_stop':
          if (chunk.reason === 'end_turn' && !decision) {
            decision = { name: 'advance_step', args: { summary: lastText } }
          }
          break
        case 'error':          return pause('llm_error', chunk.error)
      }
      if (decision) break
    }

    // ⑥ Dispatch
    switch (decision.name) {
      case 'advance_step':       ctx.currentStep++; break
      case 'update_plan':        ctx.plan = decision.args.plan; break
      case 'ask_user':           return enterAwaitingUser(reqId, decision.args)
      case 'emit_deliverable':   return enterDelivered(reqId, decision.args)
      default: {
        const result = await ToolExecutor.invoke(decision)  // 含权限/校验/超时/循环检测
        await appendMessage('tool_result', result)
        if (consecutiveFailures(ctx) >= 3) return pause('tool_fatal')
      }
    }

    // ⑦ 持久化 + 广播
    await StateStore.persist(reqId, ctx)
    bus.emit('requirement.frame', { reqId, currentStep: ctx.currentStep, budgetUsed: ctx.budget })
  }
}
```

### 9.5 LLMChunk 统一抽象

屏蔽 Anthropic / OpenAI 差异；provider adapter 把原生 SDK 事件归一化为：

```ts
type LLMChunk =
  | { type: 'thinking_delta',   text: string }
  | { type: 'text_delta',       text: string }
  | { type: 'tool_use_start',   id: string, name: string }
  | { type: 'tool_use_delta',   id: string, argsPartial: string }
  | { type: 'tool_use_stop',    id: string, name: string, args: unknown }
  | { type: 'message_stop',     reason: 'end_turn'|'tool_use'|'max_tokens'|'stop_seq' }
  | { type: 'usage',            input: number, output: number, cached?: number }
  | { type: 'error',            error: LLMError }
```

### 9.6 Budget 软警告 vs 硬触达

- 每轮 IDLE 前算 `used/cap` 比值，任一 ≥ 80% → emit `budget.warning`（UI / TG 提示），不中断
- 任一 ≥ 100% → 直接 PAUSED，emit `budget.exceeded`
- LLM 自评的 `cost_alert`（β 阶段，PRD §5.4）走 `ask_user` 路径，不是这套硬触达

### 9.7 进程崩溃恢复

启动时 `recoverInflight()` 流程：

1. 查 `requirements WHERE status IN ('进行中','等待回答')`
2. 对 `等待回答` 的需求：保持原状（无活跃协程，不需恢复）
3. 对 `进行中` 的需求：
   - 若 `runtime_state.lastHeartbeatAt` 距今 < 60s：认为有其他实例在跑（异常），中止启动
   - 否则提示用户 `继续 / 标记暂停`；继续 = 调 `executeRequirement(reqId)` 从 IDLE 重入

---

## 10. 事件总线

`packages/events` 提供进程内 `TypedEventBus`。所有事件携带足够信息让订阅者无需回查 DB 即可决策（除非内容过大）。

### 10.1 领域事件（core emit，server / bridge-tg 订阅）

```
requirement.created                  { req }
requirement.state_changed            { reqId, from, to, reason }
requirement.clarification_ready      { reqId, clarificationId, round }
requirement.clarification_answered   { reqId, clarificationId }
requirement.frame                    { reqId, currentStep, budgetUsed }
requirement.deliverable_ready        { reqId, deliverableRef }
requirement.completed                { reqId, reportId }
requirement.rejected                 { reqId, reportId }
requirement.cancelled                { reqId }
requirement.paused                   { reqId, reason }

message.appended                     { threadId, message }     高频，流式 thinking
tool.invoked                         { reqId, tool, input }
tool.result                          { reqId, tool, result, ok }
tool.failed                          { reqId, tool, error, retryCount }

budget.warning                       { reqId, gate, used, cap }
budget.exceeded                      { reqId, gate }

context.compacted                    { reqId, savedTokens, keptMessages }
memory.recalled                      { reqId, scope, items }
memory.persisted                     { items }
memory.pending_review                { item, confidence }      β 阶段
```

### 10.2 运行时事件（runtime 内部）

```
runtime.heartbeat        { reqId, ts }
runtime.recovered        { reqIds }
runtime.scheduler_state  { active, queued, max }
```

### 10.3 通道事件（bridge 自用）

```
tg.message_received      { chatId, raw }
tg.message_sent          { chatId, msgId, kind, refId }
tg.error                 { ... }
```

**设计要点**：领域层不知道 TG 存在。Bridge 订阅领域事件 → 转 TG 消息；TG 消息进来 → bridge 调 core 命令式 API（不通过事件，避免环回）。

---

## 11. Prompt 拼装与 RAG

### 11.1 拼装顺序（对应 PRD §6.5）

```
[employee.persona]
[employee.memory.style]
[main_skill.prompt_template]
[project.conventions WHERE enforcement='required']  全量
[project.conventions WHERE enforcement='recommended'] RAG Top-K
[project.facts]                                       RAG Top-K
[project.pitfalls]                                    RAG Top-K
[employee.lessons]                                    RAG Top-K
[runtime: plan + currentStep]
[runtime: historySummary]
[runtime: recentMessages last N]
[requirement.description]
```

硬约束在前（LLM 注意力更强），软提示在后。

### 11.2 Prompt Cache（β 阶段）

前缀 `[persona] + [style] + [main_skill] + [required conventions]` 保持稳定，启用 Anthropic / OpenAI prompt cache，输入 token 成本降至 ~10%。

实现：在 `PromptComposer.compose` 输出中标记 `cacheBreakpoints: number[]`（字节偏移），LLM adapter 据此设置 `cache_control: ephemeral`。

### 11.3 RAG

- 查询时 embed query → vec_chunks 检索 Top-K（K=10 默认）
- join chunks 表拿原文 + source 引用
- 应用层用 `相似度 × importance_score` 重排（PRD §6.1）
- 取 Top-K' 注入（K'=3~5 视 token budget）
- 每命中一次：`memory_items.hitCount++ + lastHitAt=now`（async batch update）

### 11.4 双向沉淀（PRD §6.2）

需求完成 / 驳回时：

```ts
memory.persistFromReport(reqId, reportMd):
  1. LLM 把 reportMd 分流为五类候选 + 置信度
     → { facts, pitfalls, conventions, style, lessons }
  2. 按 §6.1 置信度规则：
     ≥ 0.8  → 直接写入 memory_items / conventions
     0.5~0.8 → pending_review=true 暂存
     < 0.5  → 丢弃 + emit message
  3. 新条目 embed → 写 chunks + vec_chunks
  4. 同主题去重（embedding ≥ 0.92 → LLM 二次判定，P1）
```

---

## 12. 工具系统

### 12.1 ToolRegistry

```ts
type ToolDef = {
  id: string
  name: string                  // LLM 看到的名字
  description: string
  inputSchema: ZodSchema         // 同时校验 + 生成 JSON Schema
  requiresAuth: boolean          // false=系统级
  invoke: (args, ctx) => Promise<ToolResult>
}
```

`registry.listFor(employee)` 返回：

- 所有 `requiresAuth=false` 的系统级 tool（`ask_user` / `advance_step` / `update_plan` / `emit_deliverable`）
- 该员工在 `tool_grants` 表中授权的普通 tool
- ∩ 主技能 `required_tools` 中存在的 tool（未授权的标注降级，PRD §5.2）

### 12.2 ToolExecutor 三道闸

```
ToolExecutor.invoke(call):
  ① 权限校验   call.name 在 registry.listFor(employee) 内？否 → error('unauthorized')
  ② Schema 校验 call.args 通过 inputSchema？否 → error('invalid_args')
  ③ 循环检测   (name, hash(args)) 在最近 6 次 tool_call 出现 ≥ 3？是 → error('loop_detected') + 注入提示
  ④ 调用       AbortController + 30s 超时 + 指数退避（30/60/120s）2 次
  ⑤ 返回 ToolResult，引擎 append message，回 IDLE
```

系统级 tool 不经 ToolExecutor，由 dispatcher inline 处理。

### 12.3 V1.0 自带工具

| 工具 | 类别 | α | β |
|---|---|---|---|
| `ask_user` | 系统级 | ✓ | ✓ |
| `advance_step` | 系统级 | ✓ | ✓ |
| `update_plan` | 系统级 | ✓ | ✓ |
| `emit_deliverable` | 系统级 | ✓ | ✓ |
| `web_search` | 普通 | — | ✓ |
| `read_file` | 普通（沙箱限定到用户指定目录） | — | ✓ |
| `write_file` | 普通（沙箱） | — | ✓ |

---

## 13. Telegram Bridge

### 13.1 入站命令（最小集）

```
/new <员工名> <描述>      创建需求 + 触发澄清
/list [filter]            列出我的需求
/req <#>                  查看一条需求当前状态
/pause <#>  /resume <#>   状态控制
/cancel <#>
/approve <#>  /reject <#> 验收 / 驳回
/who                      列出员工
/help
```

**澄清回答 = 回复 bot 的提问消息**。Bridge 用 `reply_to_message.message_id` 查 `tg_message_links` 表，定位到 `clarification + round`，调 `answerClarification()`。

未回复直接发文本 → 拒绝并提示"请 reply 上方提问消息回答"。

### 13.2 出站流式策略

| 帧 | 处理 |
|---|---|
| 思维链 `thinking` | 单条"💭 思考中..."消息，每 1.5s `editMessageText`；超 3000 字符滚新消息 |
| 工具调用 | 关键节点直接发新消息（"🔧 调用 web_search…"） |
| 等待回答 | 立即发，等用户 reply；落 `tg_message_links` |
| 交付物 | 发文件 + inline button `[验收✓] [驳回✗] [浏览器查看]` |
| 状态变更 | 发简短消息（"⏸ 已暂停: budget_exhausted"） |

所有消息底部带 `[在浏览器查看]` 跳 `http://localhost:7878/req/<id>`。

### 13.3 白名单

`config.toml.allowed_chat_ids` 之外的 chat 全部丢弃 + log warn，不回应（避免 bot 被扫到滥用）。

### 13.4 Rate Limit

Telegram 限制 ~1 msg/sec/chat、~30 msg/sec/全局。Bridge 内置 token bucket，超限排队。

---

## 14. HTTP / WebSocket Server 与 Web UI

### 14.1 鉴权

`ai-emp init` 生成 `localhost_token` 写入 keychain。所有 HTTP 请求需带：

```
Authorization: Bearer <token>
```

或同名 cookie（UI 首次访问 `/auth?token=...` 后种 cookie）。

防 DNS rebinding：仅接受 `Host: localhost:<port>` 或 `127.0.0.1:<port>`。

### 14.2 REST 路由

```
POST   /api/projects                  CRUD
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id              级联删 + 30s 撤销窗口

POST   /api/employees                  CRUD
... 同上模式（skills / requirements）

POST   /api/requirements/:id/assign
POST   /api/requirements/:id/clarify/answer
POST   /api/requirements/:id/pause
POST   /api/requirements/:id/resume
POST   /api/requirements/:id/cancel
POST   /api/requirements/:id/approve
POST   /api/requirements/:id/reject
POST   /api/requirements/:id/force-end { keep: boolean }

GET    /api/memory/items?scope=&scopeId=&kind=
PATCH  /api/memory/items/:id           编辑 / archive
POST   /api/conventions/:projectId
...
```

### 14.3 WebSocket

```
/ws/req/:id      订阅单需求事件（含高频 message.appended）
/ws/global       订阅全局（state_changed / scheduler / budget.warning）
```

协议：JSON over WS，每条消息 Zod 校验：

```ts
type WSMessage =
  | { kind: 'event', name: keyof EventMap, payload: ... }
  | { kind: 'ping' }
  | { kind: 'pong' }
```

### 14.4 Web UI

- React + Vite + Tailwind + shadcn/ui + Zustand
- Vite 构建产物 `dist/` 嵌入 server 二进制（`Bun.embeddedFiles` 或 `Hono.serveStatic`）
- 关键页面：
  - 仪表（员工列表 + 需求列表）
  - 项目详情（介绍 / 知识 / 规范 / 需求 Tab）
  - 员工详情（基本信息 / 技能 / 模型 / 记忆 Tab）
  - 需求详情（澄清卡片 → 思维链三栏 → 交付物）
  - 系统设置（LLM Key / TG token / Budget 默认值）

---

## 15. 凭证、安全与崩溃恢复

### 15.1 凭证

- 所有 token / key 走 `keytar`，DB 只存 `keychain://<id>` 引用
- 类别：`llm_key` / `tg_bot` / `embedding_key` / `localhost_token`
- 撤销：`ai-emp keychain delete <name>` → 同时清 `credential_refs` 行

### 15.2 数据安全

- DB 文件权限 `0600`，model/log/attachments 目录 `0700`
- 备份命令产物默认 `0600`，提示用户自行加密

### 15.3 崩溃恢复

见 §9.7。核心是：`runtime_state.lastHeartbeatAt` 心跳 + 启动时 `recoverInflight()` 扫描。

### 15.4 关停

`SIGINT` / `SIGTERM`：

1. 停止接受新的 `executeRequirement` 调用
2. 当前 in-flight 协程：等待到下一个 IDLE 边界，写完 `runtime_state` 退出（最长 30s）
3. 关闭 WS / HTTP / TG long-poll
4. close SQLite

强制 `SIGKILL`：依赖 §9.7 恢复流程。

---

## 16. 待定项

下列细节在实现到对应模块时再决，不阻塞总体设计。

| # | 议题 | 当前倾向 |
|---|---|---|
| 1 | runtime_state 写入频率 | 每轮 IDLE 一次（事件驱动） |
| 2 | 嵌入模型权重托管 | 首次启动从 HuggingFace 镜像下载，离线场景手动放入 `~/.ai-emp/models/` |
| 3 | 长文 deliverable 的存储 | 文件系统（attachments/），DB 只存路径 |
| 4 | Web UI 状态管理 | Zustand + WS 推送增量更新 |
| 5 | drizzle migration 工具 | `drizzle-kit generate` + `drizzle-kit migrate` |
| 6 | 多 LLM provider 并发跨 key 限流 | bucket by `provider:keyRef` |
| 7 | 思维链节流 flush 阈值 | 200ms 或 500 字符，取先到者 |
| 8 | TG bot 多群组路由 | V1.0 不做，单 chat_id 绑定单实例 |

---

## 17. α 阶段交付边界

对应 PRD §13 P0-α 的 14 项。α 阶段（4 周）的实现范围严格限定为：

### α 必做

- 基础 CRUD（项目 / 员工 / 技能 / 需求）
- 澄清前置 + 思维链三栏 + 用户控制权
- `ask_user` 工具调用
- 执行中再澄清 2 种触发（方案分歧 + 信息缺失）
- 状态实时落库 + 会话恢复
- Budget Cap 三道闸
- 工具错误处理（仅超时重试）
- 项目介绍自动 RAG（最小可用）
- 项目规范 `required` 全量注入
- 双向沉淀 + 记忆条目自动注入
- 工具注册地基（registry + `ask_user` 一个工具）
- Token 累计 + 成本估算
- Thread / Message 模型
- LLM Key OS 凭证加密

### α 不做（β 再补）

- 多需求真并发（α 串行排队，`maxConcurrent=1`）
- 复杂度阈值（α 所有需求走完整澄清）
- 再澄清扩到 5 种
- Context 摘要
- Prompt Cache
- `recommended` conventions RAG（α 全部按 `required` 处理）
- AGENTS.md / CLAUDE.md / .cursorrules 文件读取
- Importance Scoring（α 用 LRU + hit_count）
- 分类置信度 + pending_review
- Onboarding 样板项目
- Governance 完整（α 仅 Key 加密 + 直接删）
- 自带工具扩展（web_search / read_file / write_file）
- Replay & Debug

### α 验收线（PRD §12 #1-#6）

1. 基础配置端到端跑通
2. 澄清前置跑通
3. 思维链透明
4. 执行中再澄清
5. 记忆沉淀可见
6. 纠错学习闭环

α 全过 = 进入 β；任一不过 = 暂停 β，回到产品方向重估（PRD §12 判定线）。

---

> 任何对本文档结构性内容的修改需走变更评审；细节级实现差异在对应 package 的 README 中说明即可。
