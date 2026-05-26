# AI 数字员工 — α 阶段工单（4 周）

> 对应 PRD §13 P0-α 共 14 项 + ARCHITECTURE 模块边界。
> 任务粒度：每张工单 ≤ 1.5 人日，可单独开 PR。
> 估时按 1 名 mid-senior 全栈 TS 工程师 / 1 人日 = 6h 有效编码。
> 验收线：PRD §12 #1–#6 端到端通过。

---

## 1. 编号与状态约定

- **W0~W4**：所处周次
- **L1~L4**：并行 lane
  - L1 = Storage / Data
  - L2 = LLM / Tools / Embedding
  - L3 = Runtime / Memory / Prompt
  - L4 = Server / Bridge / Web UI
- **依赖**：必须先完成的工单 ID
- **估时**：人日（0.5 / 1 / 1.5）

总工作量约 **45 人日**。两人并行下 4 周（22 人日 × 2 = 44）刚好达成；单人需要 9~10 周。

---

## 2. 依赖总图

```
W0 底座（必须串行）
T0.1 monorepo ─▶ T0.2 events ─▶ T0.3 schema ─▶ T0.4 domain types
                                    │              │
                                    ▼              ▼
W1 底层服务（L1/L2 并行）
        ┌────────────┬────────────┬─────────────┐
        ▼            ▼            ▼             ▼
   T1.1 keytar   T1.2 emb    T1.3 LLM     T1.4 tools
        │            │       adapter      registry
        └────────────┴───┬────┴──────┬─────┘
                         │           │
W2 核心引擎              ▼           ▼
                  T2.1 state-machine ───▶ T2.2 budget
                         │
                         ▼
                  T2.3 executeRequirement
                  ├─ T2.4 draftClarification
                  ├─ T2.5 answerClarification
                  ├─ T2.6 toolExec 超时重试
                  └─ T2.7 recoverInflight

W3 入口、RAG、UI（L3/L4 并行）
   ┌────────────────────┬────────────────────┐
   ▼                    ▼                    ▼
T3.1 PromptComposer  T3.4 Hono server   T3.6 Web 脚手架
T3.2 RAG recall      T3.5 TG bridge     T3.7 Web 思维链三栏
T3.3 双向沉淀         T3.8 CLI init/serve  T3.9 Web 控制权
T3.10 conventions
注入

W4 集成与验收
T4.1 e2e #1~#6  ─▶  T4.2 bun compile  ─▶  T4.3 量化采样  ─▶  T4.4 验收 / 修复
```

---

## 3. W0 — 底座（必须串行，约 3 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T0.1** | — | Monorepo 初始化：bun workspaces + tsconfig paths + lint + prettier | — | 0.5 | `bun install` 通过；空包 build 通过 |
| **T0.2** | L1 | `packages/events`：TypedEventBus + Zod schema 化事件 | T0.1 | 0.5 | 单测：emit/on 类型推导正确；非法 payload 编译错 |
| **T0.3** | L1 | `packages/storage`：drizzle 全表 schema + migrations + raw SQL 建 vec_chunks | T0.1 | 1.5 | `bun run db:migrate` 成功；建出全部表 + 虚拟表 |
| **T0.4** | L1 | `packages/core/domain`：types.ts（BudgetCap / Plan / TokenUsage / MessageContent / …）+ Zod | T0.3 | 0.5 | storage `$type<>()` 引用通过；Zod parse 通过测试样例 |

---

## 4. W1 — 底层服务（L1/L2 并行，约 8 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T1.1** | L1 | `keytar` 封装 + credential_refs 表 CRUD + `ai-emp keychain set/delete` | T0.3 | 1.0 | 写入 / 读取 / 删除三种凭证；DB 只见引用不见明文 |
| **T1.2** | L2 | `packages/embedding`：transformers.js + bge-small-zh-v1.5 加载 + `embed(texts)` | T0.1 | 1.5 | `ai-emp models pull` 下载到 `~/.ai-emp/models/`；ready() 后 `embed(["你好"])` 返回 512 维向量 |
| **T1.3** | L2 | `packages/llm`：LLMChunk 抽象 + Anthropic adapter + OpenAI 兼容 adapter（含自定义 baseURL） | T0.4, T1.1 | 1.5 | mock 后端测：两个 provider 都能产出统一 LLMChunk 流；tool_use 帧正确解析 |
| **T1.4** | L2 | `packages/tools`：ToolRegistry + ToolExecutor 三道闸（仅权限 + schema + 超时重试，α 不做循环检测） | T0.4 | 1.5 | 单测：未授权拒绝；schema 不合法拒绝；超时指数退避 2 次 |
| **T1.5** | L2 | 内置工具 `ask_user` + 三个系统级 tool（advance_step / update_plan / emit_deliverable）；写入 `tools` 表种子数据 | T1.4 | 1.0 | registry.listFor(emp) 返回 4 个系统级 tool；inputSchema 通过 LLM tool_use 路径 |
| **T1.6** | L1 | repos 层：projects / employees / skills / requirements / threads / messages / clarifications / runtime_state | T0.3 | 1.0 | CRUD 测试覆盖；messages 表 append-only 写性能 > 5k/s |

---

## 5. W2 — 核心引擎（L3 串行为主，约 12 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T2.1** | L3 | `packages/core/runtime/state-machine.ts`：9 状态 + transition 纯函数 + IllegalTransition 异常 | T0.4 | 1.0 | 单测覆盖全部合法/非法转移；emit 事件 |
| **T2.2** | L3 | Budget Cap 三道闸（iterations / tokens / wall_time）+ 80% 警告 + 100% PAUSED | T2.1 | 1.0 | 单测：三种触达分别正确进 PAUSED；warning 事件按 80% 边界发 |
| **T2.3** | L3 | `executeRequirement` 主循环骨架（IDLE → COMPOSING → STREAMING → DISPATCH → IDLE） | T2.1, T2.2, T1.3, T1.4 | 1.5 | 集成测：mock LLM 返回 advance_step → 推进 currentStep；返回 emit_deliverable → 进 待验收 |
| **T2.4** | L3 | `draftClarification`：非流式 LLM 调用 → 生成澄清卡片 → 写 clarifications 表 + 转 待澄清 | T1.3, T2.1 | 1.0 | 集成测：mock LLM 返回 understanding/plan/questions → DB 落数据 |
| **T2.5** | L3 | `answerClarification`：写回 answers → 转 进行中 → 触发 executeRequirement | T2.3, T2.4 | 0.5 | 测试：调用后 req.status='进行中'；scheduler 收到 enqueue |
| **T2.6** | L3 | `ask_user` 路径：tool_use_stop=ask_user → 中断 stream → 写 clarifications round++ → 转 等待回答 | T2.3, T1.5 | 1.0 | 集成测：mock LLM tool_use(ask_user) → DB 看到 round=1 clarification + 状态正确 |
| **T2.7** | L3 | `pauseRequirement` / `resumeRequirement` / `cancelRequirement` / `forceEnd` | T2.1 | 1.0 | 单测：状态转移正确；resume 调用 executeRequirement |
| **T2.8** | L3 | `recoverInflight()`：启动扫 进行中 + 等待回答；prompt 用户选择继续/暂停 | T2.7 | 1.0 | 杀进程后重启：CLI 列出 in-flight，选择继续 = 状态正常推进 |
| **T2.9** | L3 | `RequirementScheduler`（α 阶段 maxConcurrent=1，FIFO 队列） | T2.3 | 1.0 | 测试：派 3 个需求 → 1 个 active 2 个 queued；前者完成后下一个自动开始 |
| **T2.10** | L3 | Token 累计 + 成本估算（按 provider × model 静态价格表） | T2.3 | 1.0 | 集成测：3 轮 LLM 后 budget_used.tokensIn/Out 正确；UI 拿到 USD 估算 |
| **T2.11** | L3 | `runtime.heartbeat` 心跳 + runtime_state 写盘（每 IDLE 一次） | T2.3 | 0.5 | 测试：runtime_state.lastHeartbeatAt 每轮更新；崩溃后心跳 > 60s 触发 recover 提示 |

---

## 6. W3 — Prompt、RAG、入口层（L3/L4 并行，约 14 人日）

### L3 — Prompt / Memory（约 4.5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T3.1** | L3 | `PromptComposer.compose`：按 §11.1 顺序拼装；返回 prompt + tokensEstimate | T0.4, T1.6 | 1.0 | 单测：persona/style/skill/conventions/facts/pitfalls/lessons/plan/desc 顺序正确 |
| **T3.2** | L3 | `memory.recall`：向量检索 + Importance Scoring 重排（α 用 hit_count 简化） | T0.3, T1.2, T1.6 | 1.5 | 集成测：插 20 条 memory_items + 4 个 query → Top-K 命中率 100% |
| **T3.3** | L3 | `memory.persistFromReport`：LLM 分流五类（α 无置信度，直接写入） | T1.3, T1.6 | 1.5 | 完成需求后 facts/pitfalls/style/lessons 各有新增条目 |
| **T3.4** | L3 | 项目介绍 reindex：description 写入时 chunk + embed + 写 vec_chunks | T1.2, T1.6 | 0.5 | 测试：update description → chunks 表行数变化；检索能找到内容 |
| **T3.5** | L3 | conventions 注入：required 全量 + 软依赖检索（α required 优先） | T3.1, T1.6 | 0.5 | e2e：项目加 required 规范 → 思维链中能看到注入 |

### L4 — Server / Bridge / CLI（约 4.5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T3.6** | L4 | `packages/server`：Hono 脚手架 + localhost_token 鉴权 + 静态资源伺服 | T0.3, T1.1 | 1.0 | curl 带 token 通过；不带 token 403；非 localhost host 403 |
| **T3.7** | L4 | REST CRUD（projects/employees/skills/requirements）+ 命令（assign/pause/resume/approve/reject/force-end） | T3.6, T1.6, T2.7 | 1.5 | Postman / 自动化测试全路由通过 |
| **T3.8** | L4 | WS `/ws/req/:id` + `/ws/global`：订阅 EventBus → JSON 推送 | T3.6, T0.2 | 1.0 | 浏览器订阅一个需求 → 收到 message.appended + state_changed |
| **T3.9** | L4 | `packages/bridge-tg`：grammY long-poll + 白名单 + 命令路由 `/new` `/list` `/req` `/pause` `/resume` `/cancel` `/approve` `/reject` | T1.1, T2.* | 1.5 | 真实 TG bot：/new 派需求 → 收到澄清卡片消息 |
| **T3.10** | L4 | TG 入站 reply 匹配 + 出站节流流式 + tg_message_links | T3.9, T2.6 | 1.0 | reply 澄清提问 → answerClarification 触发；思维链 throttled edit 正确 |
| **T3.11** | L4 | CLI 命令：`init` / `serve` / `status` / `logs` / `keychain` / `models pull` / `recover` | T1.1, T1.2, T3.6 | 1.0 | 全 7 个命令端到端通过 |

### L4 — Web UI（约 5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T3.12** | L4 | Web 脚手架：Vite + React + Tailwind + shadcn + Zustand + WS 客户端 | T3.6 | 1.0 | 启动后访问 localhost:7878 → 首页加载；WS 连接成功 |
| **T3.13** | L4 | 项目列表 / 详情（含介绍编辑、规范 Tab、知识 Tab、需求 Tab） | T3.7, T3.12 | 1.0 | CRUD UI 全跑通；保存项目介绍触发 T3.4 reindex |
| **T3.14** | L4 | 员工列表 / 详情（含技能挂载、模型配置、记忆 Tab） | T3.7, T3.12 | 1.0 | CRUD UI 全跑通；填 LLM Key 走 keychain 引用 |
| **T3.15** | L4 | 需求新建 + 列表 | T3.7, T3.12 | 0.5 | 新建需求 → assign → 进入详情页 |
| **T3.16** | L4 | 需求详情：澄清卡片 → 思维链三栏 → 交付物 + 验收/驳回 | T3.7, T3.8, T3.15 | 1.5 | e2e：派一个需求 → UI 看完整流程 → 验收触发沉淀 |

---

## 7. W4 — 集成与验收（约 8 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| **T4.1** | — | e2e 测试套：PRD §12 #1~#6 自动化（用 Playwright + mock LLM） | 全部 W3 | 2.0 | 6 条主路径全 pass |
| **T4.2** | — | `bun build --compile` 单二进制（含 Web dist 嵌入） | T4.1 | 1.0 | macOS / Linux 各出一份；裸机运行通过 init + serve |
| **T4.3** | — | 真实 LLM 自跑 20 次需求 + 量化指标采样（手工） | T4.2 | 2.0 | PRD §12 量化表四个指标采到数据（α 阶段不要求达标） |
| **T4.4** | — | 缺陷修复 + 边界打磨 + 文档（README + getting-started） | T4.3 | 3.0 | 全部 P0 bug 关闭；新用户从 `ai-emp init` 到完成首个需求 < 30 分钟 |

---

## 8. 关键里程碑

| 时间 | 里程碑 | 判定信号 |
|---|---|---|
| W0 末 | 底座可编译 | `bun run db:migrate` 成功 + 全部包 `bun run build` 通过 |
| W1 末 | 能调通 LLM 流式 | 命令行 demo 跑通 Anthropic + OpenAI 兼容两条路径 |
| W2 末 | 引擎跑通 mock 闭环 | 集成测：派需求 → 澄清 → 执行 → 交付 → 沉淀（mock LLM） |
| W3 末 | UI + TG 端到端连通 | 浏览器派需求 + TG 派需求都能进入详情页并完成 |
| W4 末 | α 验收 | PRD §12 #1~#6 全 pass；可发布给少量 dogfood 用户 |

---

## 9. 两人并行建议（推荐 lane 划分）

- **Engineer A**：L1 + L3（数据 + 引擎核心）
  - W0：T0.1 → T0.2 → T0.3 → T0.4
  - W1：T1.1 / T1.6
  - W2：T2.1 → T2.2 → T2.3 → T2.4 → T2.5 → T2.6 → T2.7 → T2.8 → T2.9 → T2.10 → T2.11
  - W3：T3.1 → T3.2 → T3.3 → T3.4 → T3.5

- **Engineer B**：L2 + L4（适配层 + 入口 UI）
  - W0：（等 A 完成 T0.4）
  - W1：T1.2 → T1.3 → T1.4 → T1.5
  - W2：（等 A 输出 runtime API）— 期间可先做 T3.12 Web 脚手架 + T3.6 Server 鉴权
  - W3：T3.6~T3.16 全部

- **W4**：两人合并冲刺 e2e + 打磨

> A 在 W2 是关键路径，B 在 W3 是关键路径。若进度落后，**优先砍 T3.9~T3.10 的 TG bridge**，保浏览器侧 α 验收线 #1~#6。TG 移到 W5 补。

---

## 10. 砍单优先级（若进度紧张）

按"不做也能 α 验收通过"的优先级：

1. **可砍**：T3.9 + T3.10 TG bridge（验收线不依赖 TG，浏览器够用）
2. **可降级**：T2.10 成本估算（α 可只显示 token 数，不做美元换算）
3. **可降级**：T3.2 Importance Scoring（α 可纯向量相似度 Top-K，hit_count 都不算）
4. **可砍**：T4.3 量化采样工具化（手工统计也能交 α 验收）

**不可砍**：T0.* / T2.1~T2.8 / T3.1 / T3.7 / T3.16 —— 这些直接对应 PRD §12 #1~#6。

---

## 11. 风险点

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| transformers.js 在 Bun 下兼容问题 | 中 | T1.2 卡住 → 整个 RAG 链卡 | W0 立即做技术 spike；fallback：fastembed-js 或本机 ollama |
| sqlite-vec 的 Bun native binding | 中 | T0.3 卡住 → 全堵 | 提前 spike；fallback：纯 cosine in TS（数据量小） |
| LLM tool_use 流式语义在两个 provider 间差异 | 中 | T1.3 时间翻倍 | LLMChunk 抽象层多写几个集成测；不依赖 SDK 升级 |
| 思维链高频写 SQLite 锁竞争 | 低 | T2.3 性能下降 | WAL + busy_timeout=5000；批 flush 200ms |
| TG bridge reply 链匹配复杂 | 中 | T3.10 时间翻倍 | tg_message_links 表设计提前 review |

---

> 任务卡推进过程中如发现新依赖或拆分需求，更新本文件而非另开新文档。
