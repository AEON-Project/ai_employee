# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

单用户本地运行的 **AI 数字员工引擎**：把"对话/指令"换成"组织 + 岗位 + 工单"心智模型。详见 [PRD_V1.md](./PRD_V1.md) 与 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 产品需求

### 当前版本：V1.0（引擎验证版 — 已完成）

**目标**：验证"配置过技能和人设的 AI 员工，接到项目内的需求，能否在『澄清前置 + 过程透明 + 记忆沉淀 + 纠错学习』机制下完成任务，且下次同类任务做得更好"。

**核心机制**：
1. **澄清前置**：员工接单先复述理解 + 列拆解 + 提问，确认后才动手
2. **过程透明**：思维链 + 当前步骤 + 下一步计划三栏实时可见
3. **纠错沉淀**：失败 / 返工 / 差评自动复盘，写入个人教训 + 项目踩坑库

**V1.0 范围（已交付）**：
- 单用户本地 CLI；用户自带 LLM Key；不商业化
- 四大实体：员工 / 技能 / 需求 / 项目 + Report 沉淀产物
- 三种入口：浏览器 UI / Telegram bot / CLI
- Anthropic + OpenAI 兼容协议双 provider

**V1.0 验收线**：PRD §12 #1–#6 端到端通过（已 ✅，6/6）+ 4 个量化指标采样工具就位（待真实数据采集）。

**V1.0 明确不做**（见 PRD §11）：
- 商业化 / 多用户 / 团队协作 / 计费
- 仪表盘 / 日报周报
- Trigger 事件驱动 / Integration 第三方 SaaS / MCP
- 完整 codebase 索引 / Git/PR 集成 / Computer Use
- 跨项目共享 Brain
- 移动端 / 多模态 / 国际化

如发现以上任何一项是"必须做"的，需走变更评审，不能直接加。

### 已知 V1.1+ 候选（按 [ALPHA_TASKS.md §13](./ALPHA_TASKS.md#13-后续路线)）

- Replay 批量 + LLM-as-judge 自动评分
- 跨项目共享 Brain
- Trigger 事件驱动（邮件 / 定时器 / Webhook 触发员工自主工作）
- Integration 生态（Gmail / Slack / HubSpot / OAuth）
- 完整 codebase 索引 / AST 解析 / Git/PR/CI 集成
- 多模态（图像 / 语音）

---

## 当前开发任务进度

### 已交付（按 git commit 时间正序）

| commit | 内容 | 对应文档 |
|---|---|---|
| `b584234` | initial: V1.0 引擎验证版（α + β + W0–W4 共 45 个工单一次性落地） | ALPHA_TASKS §0–7 |
| `824382c` | docs(alpha-tasks): 标记开发状态 | — |
| `f3aefa7` | docs(readme): 重写 README | — |
| `11b812b` | fix(cli): `backup` 命令父目录缺失 | — |
| `65ff4ae` | feat(config): 支持 `.env` 配置（Bun 自动加载，三层覆盖） | README §3.1 |
| `1900da7` | feat(credentials): `env://` 引用协议（modelKeyRef） | — |
| `1ad538c` | feat(env-ref): `env://` 扩展到 model/baseUrl 字段 | .env.example |
| `527153e` | feat(cli): `./ai-emp` shell wrapper | README |
| `67581e6` | docs(readme): 快速开始改走 .env 路径 | — |
| `f69a6f6` | feat(cli/init): 下一步提示上下文感知 | — |
| `663d4cc` | feat(seed): 5 员工角色（后端/前端/测试/产品/UI 设计）+ 输出清晰化 | — |
| `dcf573b` | fix(seed): `--reset` 真删（不是 archive） | — |
| `f0d8f43` | docs(claude): 加 CLAUDE.md | 本文件 |
| `6ade242` | docs(claude): CLAUDE.md 加产品需求 + 进度状态 + AI 协作工作流 | 本文件 |
| `d644706` | docs(claude): 回填 6ade242 到"已交付"表（吃自己狗粮验证闭环） | 本文件 |
| `11a36ec` | docs(claude): 加"本地端到端调试（浏览器自动化）"段 — browser_navigate MCP | 本文件 |

### 进行中

_无_

### 待办（含新需求）

_无；接到新需求请按下方"AI 协作工作流"§ A 加到这里_

---

## AI 协作工作流（**重要**：未来 AI 实例必读）

CLAUDE.md 是项目"知识沉淀 + 进度状态"的单一真相源。每次有需求 / 完成开发后，**必须更新本文件**对应段。

### A. 接到新需求

加到上方"待办"区，格式：

```markdown
- **<需求标题>** （来源：<用户原话日期>）
  - 描述：1-2 句说清楚做什么、为什么
  - 验收：可观测的产出（如 "ai-emp seed --reset 后 active=5, archived=0"）
  - 影响范围：列出预计涉及的包 / 文件
```

需求 ≠ 一定要做。先评估是否在 V1.0 范围内：
- 在范围 → 加到待办，按优先级排序
- 超 V1.0 / 命中"明确不做" → 回复用户解释，请用户决策"现做 / 推 V1.1 / 不做"
- 紧急 bug → 直接做，事后归档到"已交付"

### B. 开始开发任务

1. 把任务从"待办"移到"进行中"
2. 在条目里写"开始日期 + 计划影响范围"
3. 同时考虑是否要更新 [PRD_V1.md](./PRD_V1.md) 或 [ARCHITECTURE.md](./ARCHITECTURE.md)（结构性变化必须更新）

### C. 完成开发

每个**有意义的工作单元**（功能 / bug 修复 / 重构）必须：

1. **跑全套**：`bun run typecheck && bun test`，全 pass 才提交
2. **跑 format**：`bun run format`
3. **git commit + push**：用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `style:` 前缀
4. **拿到 commit hash**：`git rev-parse --short HEAD`
5. **回写 CLAUDE.md**：把任务从"进行中"挪到"已交付"，必须带 `<commit hash>` 列

### D. 完成示例

```markdown
| `abc1234` | feat(memory): 双向沉淀加 LLM-as-judge 置信度（PRD §6.1） | ARCHITECTURE §11.4 |
```

如果工作跨多个 commit，列最后一个收口的 hash 即可，多个 commit 用 `abc1234..def5678` 表示范围。

### E. 变更产品需求

修改 PRD 范围时（罕见，需用户明确同意）：
- 更新 [PRD_V1.md](./PRD_V1.md) 对应段
- 在本文件"V1.0 范围 / 明确不做"段同步
- commit message 用 `docs(prd):` 前缀

### F. 不允许的捷径

- **不允许**绕过状态机 / 事件总线（见下方"架构决策"）
- **不允许**改 DB schema 不写 migration
- **不允许**为图省事把 secret 写进 DB
- **不允许**让 `core` 反向依赖 `server` / `cli` / `bridge-tg`
- **不允许**在 git commit message 里写中文以外的占位（如 `WIP`），必须有可追溯的具体描述

---

## 运行时与工具链

**必须用 Bun，不用 Node**：
- `bun <file>` 不是 `node <file>` 或 `ts-node`
- `bun:sqlite` 不是 `better-sqlite3`
- `bun test` 不是 jest/vitest
- Bun 自动加载 `.env`，**不用引 dotenv**
- 安装依赖用 `bun install`；首次必须加 `--ignore-scripts`，因 sharp 在 Bun + arm64 + Rosetta 环境下需手动修复 native binary（见 `scripts/postinstall.ts`）

## 常用命令

```bash
# 一次性 setup
brew install bun sqlite                  # brew sqlite 必装（Bun 内置 sqlite 关了 extension loading）
bun install --ignore-scripts
bun run postinstall                      # 修 sharp arm64 native binary
cd packages/web && bun run build && cd ../..   # 用 bun --bun vite build，绕过 rollup native binding 坑

# 全局
bun run typecheck                        # tsc -b project references 增量编译
bun test                                 # 全部包测试
bun run format / format:check
bun run build:cli                        # 编 dist/ai-emp 单二进制（~63MB）

# 单包测试
bun test packages/core
bun test packages/server/src/e2e.test.ts        # PRD §12 #1-#6 端到端

# CLI 入口（四种等价调用）
./ai-emp <cmd>                           # shell wrapper（项目根，推荐）
bun run ai-emp -- <cmd>                  # npm script alias
bun packages/cli/src/index.ts <cmd>      # 原始长形式
./dist/ai-emp <cmd>                      # 编译后二进制
```

## 本地端到端调试（浏览器自动化）

环境已配置 **`browser_navigate`** 等浏览器自动化 MCP 工具，AI 可直接打开 `http://localhost:7878` 验证真实渲染，不只是依赖单测和 curl。

### 典型调试动作

1. **启动 server**：`./ai-emp serve`（后台运行：`./ai-emp serve > /tmp/aiemp.log 2>&1 &`）
2. **取 token**：`security find-generic-password -a localhost-token -s ai-emp -w`
3. **登录跳转**：`browser_navigate("http://localhost:7878/auth?token=<TOKEN>&next=/")` —— 自动种 cookie 进首页
4. 后续路由用 hash：`#/req/<id>` / `#/projects` / `#/employees` / `#/new`

### 验收清单（每次改 UI / WS / API 前后必跑）

| 场景 | 验证点 |
|---|---|
| 项目列表 / 员工列表 | navigate `#/projects` `#/employees`，截图看条目 + 状态徽章 |
| 新建需求 | navigate `#/new`，填表单 → 跳详情页 |
| 思维链流式 | navigate `#/req/<id>`，看 WebSocket 推送下 thinking/text 逐步 append |
| 澄清卡片 | 派需求后看 amber 卡片渲染 + 答完澄清 → 状态变 "进行中" |
| 控制按钮 | 暂停 / 继续 / 强制结束 / 验收 / 驳回 按钮各自触发 REST + 状态机转移 |
| 验收面板 | 状态进 "待验收" 时 purple 面板出现 |

### 提示

- **改 UI 后必须 `bun run build` 重启 server**（dist 嵌入到 server 静态资源）；vite dev 模式与 server proxy 联调走 `bun run dev`（packages/web 内）
- 浏览器自动化不替代 e2e 单测（`packages/server/src/e2e.test.ts`），后者跑得快、CI 友好；浏览器 navigate 是"我改的 UI 在真实浏览器里到底什么样"的最终视觉验证
- 跑完调试**必须** `kill` 后台 server，避免端口占用：`ps aux | grep ai-emp` → `kill <PID>`

## Monorepo 结构

11 个 workspace 包，依赖**单向洋葱**（箭头向下，不能反向）：

```
cli  →  server / bridge-tg          ← 入口层（HTTP/WS/TG/CLI）
              ↓
            core                    ← runtime + memory + prompt + metrics
              ↓
    storage / llm / tools / embedding
              ↓
        domain / events             ← 最底层（零依赖）
web                                 ← 独立构建（Vite），通过 HTTP/WS 连 server
```

**core 永远不依赖 server / bridge-tg / cli** —— 这是硬规则，加新通道（如 Lark）时不能破。

依赖关系**必查** `packages/*/tsconfig.json` 的 `references`，加新跨包 import 前必须先在 references 里登记。

## 关键架构决策（reading multiple files 才能理解的）

### 1. Engine-driven Agent loop

LLM **不**维护全局历史。每轮 prompt 由 `packages/core/src/prompt/composer.ts` 从持久化状态（runtime_state + thread messages）**现拼**。LLM 用 tool calls 表达决策（`advance_step` / `update_plan` / `ask_user` / `emit_deliverable`），引擎根据 tool name 驱动状态机。完整循环见 `packages/core/src/runtime/execute.ts`，状态机 9 状态 + 子状态机见 [ARCHITECTURE §9](./ARCHITECTURE.md#9-agent-runtime)。

### 2. 三层覆盖配置

`packages/cli/src/config.ts:loadConfig`：**.env > `~/.ai-emp/config.toml` > 内置默认**。

### 3. `env://` 凭证引用协议

员工的 `modelKeyRef` / `modelName` / `modelBaseUrl` 字段可写 `env://AIEMP_XXX`，runtime 解析到 process.env。实现在 `packages/storage/src/env-ref.ts`，由 `executeRequirement` 在调 LLM 前解析。这让"开发用 .env、生产用 keychain"切换只改一个字段。

### 4. 凭证存放

- **secret 不进 DB**：DB 只存 `keychainKey` 引用（字符串）
- macOS / Linux 用 `security` CLI / `secret-tool`（**不用 keytar**，避开 Bun + arm64 native binding 坑）
- 实现：`packages/storage/src/{keychain,credentials,env-ref}.ts`

### 5. 事件总线 26 个事件

`packages/events/src/event-map.ts` 是单一真相源。WS / TG bridge 通过订阅它把内部事件外推。新加事件必须同时加 EventMap 条目 + Zod schema（`packages/events/src/schemas.ts`）。

### 6. 状态机硬规则

任何 Requirement 状态变更必须过 `packages/core/src/runtime/state-machine.ts:transition` 纯函数，非法转移抛 `IllegalTransition`。**不允许**直接 `repos.requirements.setStatus(id, newStatus)` 绕过。

### 7. messages 表 append-only

思维链事件流 append-only，`seq` 在 `thread_id` 内单调递增（事务取 max+1）。崩溃只会丢"正在 stream 的 thinking 片段"，runtime 从最近 IDLE 边界恢复（`runtime_state` 表心跳）。

## 工程坑（已踩过的）

| 现象 | 根因 + 修法 |
|---|---|
| `This build of sqlite3 does not support dynamic extension loading` | Bun 内置 sqlite 关了 extension loading。**必须** `Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib')`（已在 `packages/storage/src/db.ts` 处理） |
| `Cannot find module '../build/Release/sharp-darwin-arm64v8.node'` | sharp 0.32 在 Bun + Rosetta 下装错 arch。跑 `bun run postinstall`，它会用 Bun runtime 拉 arm64 binary |
| `rollup native module not found`（仅 web build 时） | rollup native binding 不兼容 Bun isolated install。`packages/web/package.json` 的 build 脚本用 `bun --bun vite build` 绕过 |
| `z.unknown()` 在 zod object 推为 optional | 与 `EventMap` 的 required 字段不对齐。要么字段标 optional，要么改 `z.any()`（已在 `events/schemas.ts` 处理） |
| 跨包循环依赖 | `domain` 抽出来独立包后解决；**core/storage 不能反向依赖 cli/server** |

## 重要约定

- **添加新功能前**：检查上方"已交付"清单和 [ALPHA_TASKS.md §0](./ALPHA_TASKS.md) 看是否已做，避免重复
- **修 schema** 必须加 migration 文件到 `packages/storage/migrations/NNNN_*.sql`（按文件名字典序应用），不允许 hot patch DB
- **不要**给 `RequirementsRepo.setStatus` 改签名绕过状态机
- 测试用 `:memory:` SQLite + `InMemoryKeychainStore` + scripted mock LLM；模板见 `packages/server/src/e2e.test.ts`
- TG bridge 是 EventBus 订阅者 + grammY long-polling，**core 不感知它**；加新通道（Lark/Slack）参考此模式
- `seed --reset` 用 raw SQL 真删（不是 archive），实现见 `packages/cli/src/seed.ts`

## 回复风格

- **简体中文**回复，包括代码解释和方案描述
- 技术术语保留英文原词（API、Token、Hook、Bun、PRD）
- 代码块保持英文，注释中英文皆可
- 简洁直接，不重复用户已说过的内容

## 参考文档

| 文件 | 用途 | 谁该读 |
|---|---|---|
| [PRD_V1.md](./PRD_V1.md) | 产品需求、数据模型、流程、验收线 | 产品决策 / 改 V1 范围时 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 技术架构、模块边界、状态机、事件目录、DB schema | 二次开发 / 改结构时 |
| [ALPHA_TASKS.md](./ALPHA_TASKS.md) | 工单清单 + α/β 状态 + 后续路线 | 详细进度 / 任务依赖 |
| [SPIKE_RESULTS.md](./SPIKE_RESULTS.md) | W0 技术验证（sqlite-vec / transformers.js / LLM SDK 兼容性） | 排错 / 平台移植 |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | 用户向导：install → 完成首个需求 | 新用户 |
| [README.md](./README.md) | 项目对外介绍 + 三种入口 | 项目入门 |

> **CLAUDE.md（本文件）是 AI 协作的入口**：含产品需求摘要 + 进度状态 + 工作流约定。每次完成开发必须更新"已交付"段。
