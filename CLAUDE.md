# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

单用户本地运行的 **AI 数字员工引擎**：把"对话/指令"换成"组织 + 岗位 + 工单"心智模型。详见 [PRD_V1.md](./PRD_V1.md) 与 [ARCHITECTURE.md](./ARCHITECTURE.md)。α + β 两阶段已交付（见 [ALPHA_TASKS.md §0](./ALPHA_TASKS.md)）。

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

- **添加新功能前**：检查 [ALPHA_TASKS.md §0](./ALPHA_TASKS.md) 看 α + β 已交付 / 已延后到 V1.1+ 的清单，避免重复工作
- **修 schema** 必须加 migration 文件到 `packages/storage/migrations/NNNN_*.sql`（按文件名字典序应用），不允许 hot patch DB
- **不要**给 `RequirementsRepo.setStatus` 改签名为绕过状态机
- 测试用 `:memory:` SQLite + `InMemoryKeychainStore` + scripted mock LLM；模板见 `packages/server/src/e2e.test.ts`
- TG bridge 是 EventBus 订阅者 + grammY long-polling，**core 不感知它**；加新通道（Lark/Slack）参考此模式
- `seed --reset` 用 raw SQL 真删（不是 archive），实现见 `packages/cli/src/seed.ts`

## 回复风格

- **简体中文**回复，包括代码解释和方案描述
- 技术术语保留英文原词（API、Token、Hook、Bun、PRD）
- 代码块保持英文，注释中英文皆可
- 简洁直接，不重复用户已说过的内容

## 参考文档

| 文件 | 用途 |
|---|---|
| [PRD_V1.md](./PRD_V1.md) | 产品需求、数据模型、流程、验收线 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 技术架构、模块边界、状态机、事件目录、DB schema |
| [ALPHA_TASKS.md](./ALPHA_TASKS.md) | 工单清单 + 当前开发状态 + 后续路线 |
| [SPIKE_RESULTS.md](./SPIKE_RESULTS.md) | W0 技术验证（sqlite-vec / transformers.js / LLM SDK 兼容性） |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | 用户向导：install → 完成首个需求 |
| [README.md](./README.md) | 项目对外介绍 + 三种入口（浏览器 / TG / CLI） |
