# AI 数字员工 — α 阶段工单（4 周）

> 对应 PRD §13 P0-α 共 14 项 + ARCHITECTURE 模块边界。
> 任务粒度：每张工单 ≤ 1.5 人日，可单独开 PR。
> 估时按 1 名 mid-senior 全栈 TS 工程师 / 1 人日 = 6h 有效编码。
> 验收线：PRD §12 #1–#6 端到端通过。

---

## 0. 当前开发状态（最近更新：2026-05-26）

**α + β 两阶段全部完成**。仓库已 git push 到 `git@github.com:AEON-Project/ai_employee.git`（main, commit `b584234`）。

| 阶段 | 任务范围 | 状态 |
|---|---|---|
| **W0 底座** | T0.1–T0.4（monorepo / events / schema / domain） | ✅ 4/4 |
| **W1 底层服务** | T1.1–T1.6（keychain / embedding / LLM / tools / builtin / repos） | ✅ 6/6 |
| **W2 引擎** | T2.1–T2.11（状态机 / Budget / executeRequirement / commands / scheduler / recover / heartbeat） | ✅ 11/11 |
| **W3 入口与 UI** | T3.1–T3.16（PromptComposer / RAG / 沉淀 / Server / WS / TG bridge / CLI / Web UI） | ✅ 16/16 |
| **W4 集成验收** | T4.1–T4.4（e2e §12 #1–#6 / bun compile / 量化采样 / GETTING_STARTED） | ✅ 4/4 |
| **β 延后项** | TG bridge / 复杂度阈值 / Importance Scoring / Replay / Prompt Cache / Context 摘要 / 5 种再澄清 / Onboarding seed | ✅ 8/8 |

### 关键数字

- **11 个 package**：events / domain / storage / core (runtime/memory/prompt/metrics) / llm / tools / embedding / server / bridge-tg / web / cli
- **12,904 行**非测试 TS/TSX 源码
- **172 tests pass / 1 skip / 0 fail**（23 文件，458 expect 调用）
- **单二进制 63MB**（`bun build --compile` 出 `dist/ai-emp`）
- **CLI 子命令 13 个**：init / serve / status / logs / keychain (set|get|delete) / recover / metrics / seed / backup / models pull / version / help

### PRD §12 端到端验收（#1–#6 全部 pass）

1. ✅ 基础配置（项目向量化 + 员工创建）
2. ✅ 澄清前置（待澄清 → draft → answer → 进行中）
3. ✅ 思维链透明（thinking / text / tool_call / tool_result 落 message 表）
4. ✅ 执行中再澄清（ask_user → 等待回答 → answer → 进行中 → 待验收）
5. ✅ 记忆沉淀可见（persistFromReport → facts / pitfalls / lessons + style）
6. ✅ 纠错学习闭环（驳回 → 写教训 → 同类需求 PromptComposer 显式引用）

### 待发布前手工执行

- **T4.3 真实 LLM 量化采样**：自跑 20 次需求采集 PRD §12 四项指标（`ai-emp metrics` 命令已就位，需真实 API key 跑数据）
- **跨平台二进制**：Linux x64 / Windows 暂未编译验证

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
| ✅ **T0.1** | — | Monorepo 初始化：bun workspaces + tsconfig paths + lint + prettier | — | 0.5 | `bun install` 通过；空包 build 通过 |
| ✅ **T0.2** | L1 | `packages/events`：TypedEventBus + Zod schema 化事件 | T0.1 | 0.5 | 单测：emit/on 类型推导正确；非法 payload 编译错 |
| ✅ **T0.3** | L1 | `packages/storage`：drizzle 全表 schema + migrations + raw SQL 建 vec_chunks | T0.1 | 1.5 | `bun run db:migrate` 成功；建出全部表 + 虚拟表 |
| ✅ **T0.4** | L1 | `packages/core/domain` (独立包 `@ai-emp/domain`)：types + Zod | T0.3 | 0.5 | storage `$type<>()` 引用通过；Zod parse 通过测试样例 |

---

## 4. W1 — 底层服务（L1/L2 并行，约 8 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T1.1** | L1 | 凭证封装（OS keychain 改用 `security`/`secret-tool` CLI，避开 keytar native binding）+ credential_refs CRUD + `ai-emp keychain` | T0.3 | 1.0 | 写入 / 读取 / 删除三种凭证；DB 只见引用不见明文 |
| ✅ **T1.2** | L2 | `packages/embedding`：transformers.js + bge-small-zh-v1.5 加载 + `embed(texts)` | T0.1 | 1.5 | `ai-emp models pull` 下载到 `~/.ai-emp/models/`；ready() 后 `embed(["你好"])` 返回 512 维向量 |
| ✅ **T1.3** | L2 | `packages/llm`：LLMChunk 抽象 + Anthropic adapter + OpenAI 兼容 adapter（含自定义 baseURL） | T0.4, T1.1 | 1.5 | mock 后端测：两个 provider 都能产出统一 LLMChunk 流；tool_use 帧正确解析 |
| ✅ **T1.4** | L2 | `packages/tools`：ToolRegistry + ToolExecutor 三道闸（权限 + schema + 超时重试） | T0.4 | 1.5 | 单测：未授权拒绝；schema 不合法拒绝；超时指数退避 2 次 |
| ✅ **T1.5** | L2 | 内置工具 `ask_user` + `advance_step` + `update_plan` + `emit_deliverable`；`registerSystemTools()` 启动注册 | T1.4 | 1.0 | registry.listFor(emp) 返回 4 个系统级 tool；inputSchema 通过 LLM tool_use 路径 |
| ✅ **T1.6** | L1 | repos 层：projects / employees / skills / requirements / threads / messages / clarifications / runtime_state / conventions / memoryItems / reports / chunks / tgMessageLinks | T0.3 | 1.0 | CRUD 测试覆盖；messages 表 append-only 写性能 > 5k/s |

---

## 5. W2 — 核心引擎（L3 串行为主，约 12 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T2.1** | L3 | `packages/core/runtime/state-machine.ts`：9 状态 + transition 纯函数 + IllegalTransition 异常 | T0.4 | 1.0 | 单测覆盖全部合法/非法转移；emit 事件 |
| ✅ **T2.2** | L3 | Budget Cap 三道闸（iterations / tokens / wall_time）+ 80% 警告 + 100% PAUSED | T2.1 | 1.0 | 单测：三种触达分别正确进 PAUSED；warning 事件按 80% 边界发 |
| ✅ **T2.3** | L3 | `executeRequirement` 主循环骨架（IDLE → COMPOSING → STREAMING → DISPATCH → IDLE） | T2.1, T2.2, T1.3, T1.4 | 1.5 | 集成测：mock LLM 返回 advance_step → 推进 currentStep；返回 emit_deliverable → 进 待验收 |
| ✅ **T2.4** | L3 | `draftClarification`：非流式 LLM 调用 → 生成澄清卡片 → 写 clarifications 表 + 转 待澄清 | T1.3, T2.1 | 1.0 | 集成测：mock LLM 返回 understanding/plan/questions → DB 落数据 |
| ✅ **T2.5** | L3 | `answerClarification`：写回 answers → 转 进行中 → 触发 executeRequirement | T2.3, T2.4 | 0.5 | 测试：调用后 req.status='进行中'；scheduler 收到 enqueue |
| ✅ **T2.6** | L3 | `ask_user` 路径：tool_use_stop=ask_user → 中断 stream → 写 clarifications round++ → 转 等待回答 | T2.3, T1.5 | 1.0 | 集成测：mock LLM tool_use(ask_user) → DB 看到 round=1 clarification + 状态正确 |
| ✅ **T2.7** | L3 | `pauseRequirement` / `resumeRequirement` / `cancelRequirement` / `forceEnd` / `approve` / `reject` | T2.1 | 1.0 | 单测：状态转移正确；resume 调用 executeRequirement |
| ✅ **T2.8** | L3 | `scanInflight()`：启动扫 进行中 + 等待回答；CLI / runtime 决定继续/暂停 | T2.7 | 1.0 | 杀进程后重启：CLI 列出 in-flight，选择继续 = 状态正常推进 |
| ✅ **T2.9** | L3 | `RequirementScheduler`（α 阶段 maxConcurrent=1，FIFO 队列） | T2.3 | 1.0 | 测试：派 3 个需求 → 1 个 active 2 个 queued；前者完成后下一个自动开始 |
| ✅ **T2.10** | L3 | Token 累计（input/output/cached）+ budget snapshot 持久化 | T2.3 | 1.0 | 集成测：LLM usage chunk 累计写入 runtime_state.budget_used_json；UI 拿到 token 数 |
| ✅ **T2.11** | L3 | `runtime.heartbeat` 心跳 + runtime_state 写盘（每 IDLE 一次） | T2.3 | 0.5 | 测试：runtime_state.lastHeartbeatAt 每轮更新；崩溃后心跳 > 60s 触发 recover 提示 |

---

## 6. W3 — Prompt、RAG、入口层（L3/L4 并行，约 14 人日）

### L3 — Prompt / Memory（约 4.5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T3.1** | L3 | `PromptComposer.compose`：按 §11.1 顺序拼装；返回 prompt + tokensEstimate + cacheBreakpoints | T0.4, T1.6 | 1.0 | 单测：persona/style/skill/conventions/facts/pitfalls/lessons/plan/desc 顺序正确 |
| ✅ **T3.2** | L3 | `memory.recall`：向量检索 + Importance Scoring 重排 | T0.3, T1.2, T1.6 | 1.5 | 集成测：插 20 条 memory_items + 4 个 query → Top-K 命中率 100% |
| ✅ **T3.3** | L3 | `memory.persistFromReport`：分流 facts/pitfalls/lessons/style | T1.3, T1.6 | 1.5 | 完成需求后 facts/pitfalls/style/lessons 各有新增条目 |
| ✅ **T3.4** | L3 | 项目介绍 reindex：description 写入时 chunk + embed + 写 vec_chunks | T1.2, T1.6 | 0.5 | 测试：update description → chunks 表行数变化；检索能找到内容 |
| ✅ **T3.5** | L3 | conventions 注入：required 全量 + recommended 全量（α 简化） | T3.1, T1.6 | 0.5 | e2e：项目加 required 规范 → 思维链中能看到注入 |

### L4 — Server / Bridge / CLI（约 4.5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T3.6** | L4 | `packages/server`：Hono 脚手架 + localhost_token 鉴权 + 静态资源伺服 + Host 校验 | T0.3, T1.1 | 1.0 | curl 带 token 通过；不带 token 401；非 localhost host 403 |
| ✅ **T3.7** | L4 | REST CRUD（projects/employees/skills/requirements）+ 命令（assign/pause/resume/approve/reject/force-end/clarify） | T3.6, T1.6, T2.7 | 1.5 | 10 个 server 集成测全 pass |
| ✅ **T3.8** | L4 | WS `/ws/req/:id` + `/ws/global`：订阅 EventBus → JSON 推送 | T3.6, T0.2 | 1.0 | 浏览器订阅一个需求 → 收到 message.appended + state_changed |
| ✅ **T3.9** | L4 | `packages/bridge-tg`：grammY long-poll + 白名单 + 命令路由 `/new` `/list` `/req` `/pause` `/resume` `/cancel` `/approve` `/reject` `/who` `/help` | T1.1, T2.* | 1.5 | router parseUpdate 单测覆盖 |
| ✅ **T3.10** | L4 | TG 入站 reply 匹配 + 出站节流流式（MessageStreamer）+ tg_message_links | T3.9, T2.6 | 1.0 | reply 澄清提问 → answerClarification 触发；思维链 throttled edit 正确 |
| ✅ **T3.11** | L4 | CLI 命令：`init` / `serve` / `status` / `logs` / `keychain` / `models pull` / `recover` / `metrics` / `seed` / `backup` | T1.1, T1.2, T3.6 | 1.0 | 全 10 个命令端到端通过 |

### L4 — Web UI（约 5 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T3.12** | L4 | Web 脚手架：Vite + React + Tailwind + Zustand + WS 客户端 (shadcn 风格自写组件) | T3.6 | 1.0 | 启动后访问 localhost → 首页加载；WS 连接成功 |
| ✅ **T3.13** | L4 | 项目列表 / 创建项目（详情页留β细化） | T3.7, T3.12 | 1.0 | CRUD UI 跑通；最小版聚焦验收线 |
| ✅ **T3.14** | L4 | 员工列表 / 创建员工（含 modelKeyRef 输入；详情页留β细化） | T3.7, T3.12 | 1.0 | CRUD UI 跑通；填 LLM Key 走 keychain 引用 |
| ✅ **T3.15** | L4 | 需求新建表单 + 列表 + 仪表首页 | T3.7, T3.12 | 0.5 | 新建需求 → assign → 进入详情页 |
| ✅ **T3.16** | L4 | 需求详情：澄清卡片 → 思维链 → 交付物 + 验收/驳回 + 控制按钮 | T3.7, T3.8, T3.15 | 1.5 | e2e：派需求 → UI 看完整流程 → 验收触发沉淀 |

---

## 7. W4 — 集成与验收（约 8 人日）

| ID | Lane | 标题 | 依赖 | 估时 | 验收 |
|---|---|---|---|---|---|
| ✅ **T4.1** | — | e2e 测试套：PRD §12 #1~#6 自动化（用 fetch + mock LLM；不用 Playwright，过重） | 全部 W3 | 2.0 | 6 条主路径全 pass |
| ✅ **T4.2** | — | `bun build --compile` 单二进制（macOS arm64 63MB） | T4.1 | 1.0 | `./dist/ai-emp --version` / `help` 通过；Linux/Windows 待跑 |
| ⏳ **T4.3** | — | `ai-emp metrics` 工具已就位；20 次需求真实采样待手工执行 | T4.2 | 2.0 | 4 指标数据待真实 API key 跑 |
| ✅ **T4.4** | — | 缺陷修复 + 边界打磨 + 文档（README + GETTING_STARTED） | T4.3 | 3.0 | 全部 P0 bug 关闭；GETTING_STARTED 覆盖 install→首个需求 |

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

## 12. β 阶段延后项（已交付）

α 阶段砍单的 TG bridge 与 P0-β / P1 全部功能在 α 收官后追加完成：

| 项 | 实现位置 | 测试 |
|---|---|---|
| ✅ TG bridge | `packages/bridge-tg/{router,throttle,bridge}.ts` | 16 测试 |
| ✅ 复杂度阈值 simple/standard/complex | `packages/core/src/runtime/complexity.ts` | 9 测试 |
| ✅ Importance Scoring 完整公式 | `packages/core/src/memory/scoring.ts`（0.4*hit + 0.3*feedback + 0.2*recency + 0.1*source + 周批归档） | 6 测试 |
| ✅ Replay & Debug | `packages/core/src/runtime/replay.ts` | 4 测试 |
| ✅ Prompt Cache（Anthropic ephemeral） | `packages/llm/src/providers/anthropic.ts` + composer `cacheBreakpoints[]` | 1 测试 |
| ✅ Context 摘要 | `packages/core/src/runtime/summarizer.ts` | 4 测试 |
| ✅ 5 种再澄清触发（decision_split / missing_info / judgment / pitfall_hit / cost_alert） | PromptComposer 协作规则 + Clarification.trigger enum | 集成测覆盖 |
| ✅ 量化采样工具 | `packages/core/src/metrics/sampler.ts` + `ai-emp metrics` CLI | 待真实数据采样 |
| ✅ Onboarding 样板 | `packages/cli/src/seed.ts`（3 项目 / 5 员工 / 8 技能 / 7 conventions）+ `ai-emp seed` | 4 测试 |

---

## 13. 后续路线

### β 阶段反馈循环（视真实使用调整）

- PromptComposer 拼装顺序 / 字数权衡（按真实 token 成本）
- 复杂度阈值的 simple 判定规则（启发式 → LLM evaluator 切换）
- Importance Scoring 权重（实测 hit 分布后再调）
- TG bridge 流式 edit 频率（Telegram 1 msg/sec 限速实测）
- Web UI 详情页（项目 / 员工细化 Tab）

### V1.1 路线（PRD §11 标注）

- Replay 批量 + LLM-as-judge 自动评分
- 跨项目共享 Brain
- Trigger / 事件驱动入口（邮件 / 定时器）
- Integration 生态（OAuth + 第三方 SaaS）
- 完整 codebase 索引 / AST / Git/PR 集成
- 多模态输入

---

## 14. V2 优化清单（OpenClaw 对比后整理 — 2026-05-27）

**背景**：跟 [OpenClaw](https://github.com/openclaw/openclaw)（personal AI assistant，多频道聊天）对比后梳理出"明显缺陷 + 高价值优化"。详见 commit `ff02d3e` 之后的对话上下文。

**已验证的护城河**：工单状态机 + 待验收 + Git Diff 验收 + advance_step.blocked / LLM retry 等引擎层防御 — OpenClaw 没有，是我们工程交付场景的核心优势，**不要动**。

### 14.1 明显缺陷（按价值 ROI 排序）

| ID | 缺陷 | 影响 | OpenClaw 怎么做的 | 修复成本 | 优先级 |
|---|---|---|---|---|---|
| D1 | **没有真 PTY** | mvn / vim / npm run dev / 任何 tty-required CLI 跑不动 | DSR + node-pty | 半天 | P1 |
| D2 | **没有 sub-agent / 员工互调** | "小后写完代码召唤小测跑测试"做不到；违反 PRD"组织+岗位"心智 | ACP 协议 + spawnSubagent tool + SubagentRegistry | 1-2 天 | **P0** |
| D3 | **prompt cache 利用率低** | composer 只设 1 个 cacheBreakpoint，token 消耗高 | pi-ai 上游库多级切点 | 半天 | P1 |
| D4 | **后台进程无主动通知** | mvn compile 跑完 LLM 不知道，要主动 `Process read` 轮询 | notify-on-exit 事件 + 心跳唤醒 | 半天 | P2 |
| D5 | **memory 闭环弱** | facts/pitfalls/lessons 表存在，但 LLM 没"被 reject 后自动写教训"的强约束（PRD §3 核心机制） | OpenClaw 也没（互补关系，但我们要补） | 1 天 | **P0** |
| D6 | **无危险命令审批** | `sudo rm -rf /` 直接跑；单机可关闭，但默认应有警告 | exec-approvals socket | 中（UI 弹窗 + WS 双向） | P2 |
| D7 | **无 exec host 抽象** | 全本地；OpenClaw 支持 docker sandbox / 远端 node | host: 'local' / 'docker' / 'remote' | 大 | P3 |

### 14.2 高价值优化（按工程量/价值比）

| 优先级 | ID | 项 | 工程量 | 用户体验提升 |
|---|---|---|---|---|
| 🥇 **P0** | O1 | **sub-agent 协作**（修复 D2）：新加 `spawn_employee` 系统 tool，让员工召唤另一个员工接子任务；子员工独立 sessionKey + 状态机，完成后回传 deliverable 给父员工。**真"组织"心智** | 1-2 天 | 跨员工分工，PRD 心智完整 |
| 🥇 **P0** | O2 | **memory 闭环强化**（修复 D5）：加 `emit_lesson` 系统 tool —— 员工被 reject 时自动调用沉淀教训到 employee lessons；下次同类任务 composer 自动 RAG 注入 prompt 头部 | 1 天 | 真"会成长"的员工，PRD §3 核心机制闭环 |
| 🥈 P1 | O3 | **真 PTY 支持**（修复 D1）：接 `node-pty`，Bash tool 加 `pty: true` 走 PTY 路径；fallback 失败时 child_process.spawn | 半天 | mvn / vim 等能跑 |
| 🥈 P1 | O4 | **prompt cache 精细化**（修复 D3）：把 system block 切成 `[平台层 / 项目层 / 需求层]` 三段独立 breakpoint，命中率从 1 段提到 3 段 | 半天 | 省 token 钱 + 首 chunk 加速 |
| 🥉 P2 | O5 | **Process notify-on-exit**（修复 D4）：后台命令 close 时 bus.emit 一个 message，runtime 收到后唤醒 LLM 接着干（不再轮询） | 半天 | mvn 长命令体验顺滑 |
| 🥉 P2 | O6 | **危险命令审批**（修复 D6）：黑名单（rm -rf / / sudo / curl pipe sh / dd 等）触发"待用户确认"半状态；WS 推到 UI 弹窗 + 用户 approve/deny；可在 employee 配置全开放跳过 | 1-2 天 | 安全感 + 防误操作 |

### 14.3 不做（明确边界）

- ❌ **去掉工单状态机改成纯聊天** — 这是我们的护城河，不去掉
- ❌ **抄 pi-agent-core 替换 runtime.execute** — 我们自造 runtime 已经织入工单状态机 + V1.2/V1.4 防御，OpenClaw 黑盒库套不进来
- ❌ **接入 20+ IM 频道** — 当前 web + telegram 够用，不为多渠道而多渠道
- ❌ **LanceDB 替换 sqlite-vec** — 单用户场景 sqlite-vec 够用，迁移成本高

### 14.4 推进建议（按"补足 PRD 核心机制 + 能跑通真实工程任务"排）

1. **O2（memory 闭环）** — PRD §3 三大核心机制之一（"纠错沉淀"），目前只完成了 1/3
2. **O1（sub-agent）** — PRD 心智完整性（"组织 + 岗位"），目前一个工单只能挂一个员工
3. **O3（PTY）** — 实战能跑 mvn / gradle，工程交付场景刚需
4. **O4（prompt cache）** — 成本优化，可与 O2/O1 并行
5. **O5（notify-on-exit）** — O3 之后做
6. **O6（危险命令审批）** — 可选，单用户单机默认可不开

---

> 任务卡推进过程中如发现新依赖或拆分需求，更新本文件而非另开新文档。
