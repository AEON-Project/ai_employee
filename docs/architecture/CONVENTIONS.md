# 工程约定与决策

本文件汇总"必须遵守"的约定 + 已踩过的坑 + 关键架构决策。

更细的状态机 / 事件目录 / DB schema 等见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. Engine-driven Agent loop

LLM **不**维护全局历史。每轮 prompt 由 `packages/core/src/prompt/composer.ts` 从持久化状态（`runtime_state` + `messages` 表）**现拼**。LLM 用 tool calls 表达决策：

- `advance_step` — 当前步完成，推进 plan
- `update_plan` — 调整执行计划
- `ask_user` — 暂停发问（5 种 trigger）
- `emit_deliverable` — 提交交付物，进 待验收

引擎根据 tool name 驱动状态机。完整循环：`packages/core/src/runtime/execute.ts`。状态机 9 状态 + 子状态机：[ARCHITECTURE §9](./ARCHITECTURE.md#9-agent-runtime)。

---

## 2. 三层覆盖配置

`packages/cli/src/config.ts:loadConfig` 实现：

```
.env  >  ~/.ai-emp/config.toml  >  内置 DEFAULT_CONFIG
```

Bun 自动加载 `.env`，**不需要** dotenv 库。`AIEMP_DATA_DIR` 还能覆盖数据目录路径（默认 `~/.ai-emp/`），开发期可指向项目内。

---

## 3. `env://` 凭证引用协议

员工的 `modelKeyRef` / `modelName` / `modelBaseUrl` 字段可写 `env://AIEMP_XXX`，runtime 解析到 `process.env`。实现在 `packages/storage/src/env-ref.ts`，由 `executeRequirement` 调 LLM 前解析。

意义：**"开发用 .env、生产用 keychain"切换只改员工一个字段**，员工/项目数据不动。

---

## 4. 凭证不进 DB

- DB 只存 `keychainKey` 引用（字符串）
- macOS / Linux 用 `security` CLI / `secret-tool`（**不用 keytar**，避开 Bun + arm64 native binding 坑）
- 实现：`packages/storage/src/{keychain,credentials,env-ref}.ts`

---

## 5. 事件总线 26 个事件

`packages/events/src/event-map.ts` 是单一真相源。WS / TG bridge 通过订阅它把内部事件外推。

**新加事件必须同时**：
- 加 EventMap 条目（`event-map.ts`）
- 加 Zod schema（`schemas.ts`）
- 跨进程边界（WS / HTTP / TG）用 `parsePayload()` 校验

---

## 6. 状态机硬规则

任何 Requirement 状态变更必须过 `packages/core/src/runtime/state-machine.ts:transition` 纯函数，非法转移抛 `IllegalTransition`。

**不允许**：
- 直接 `repos.requirements.setStatus(id, newStatus)` 绕过
- 给 `setStatus` 改签名让它接受任意状态

---

## 7. messages 表 append-only

思维链事件流 append-only，`seq` 在 `thread_id` 内单调递增（事务取 `MAX(seq)+1`）。

崩溃只会丢"正在 stream 的 thinking 片段"，runtime 从最近 IDLE 边界恢复（`runtime_state` 表心跳，60s 内有心跳视为活跃实例）。

---

## 8. Monorepo 单向洋葱依赖

11 个 workspace 包：

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

**core 永远不依赖 server / bridge-tg / cli** —— 加新通道（如 Lark / Slack / IDE 插件）必须做成 EventBus 订阅者。

依赖关系**必查** `packages/*/tsconfig.json` 的 `references`，加新跨包 import 前先在 references 里登记。

---

## 9. 工程坑（已踩过的）

| 现象 | 根因 + 修法 |
|---|---|
| `This build of sqlite3 does not support dynamic extension loading` | Bun 内置 sqlite 关了 extension loading。**必须** `Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib')`（已在 `packages/storage/src/db.ts` 处理） |
| `Cannot find module '../build/Release/sharp-darwin-arm64v8.node'` | sharp 0.32 在 Bun + Rosetta 下装错 arch。跑 `bun run postinstall`，会用 Bun runtime 拉 arm64 binary |
| `rollup native module not found`（仅 web build 时） | rollup native binding 不兼容 Bun isolated install。`packages/web/package.json` 的 build 脚本用 `bun --bun vite build` 绕过 |
| `z.unknown()` 在 zod object 推为 optional | 与 `EventMap` 的 required 字段不对齐。要么字段标 optional，要么改 `z.any()`（已在 `events/schemas.ts` 处理） |
| 跨包循环依赖 | `domain` 抽出来独立包后解决；**core/storage 不能反向依赖 cli/server** |
| `setCustomSQLite` 进程级只能调一次 | 加模块级 flag `customSqliteApplied` 守卫；测试单元中复用进程时多次 `openDatabase()` 不会再触发 |
| `seed --reset` 旧实现只 archive 不真删 | 用 raw SQL transaction：DELETE projects（cascade） + nullify requirements.assignee_id + DELETE employees（cascade）+ DELETE skills |

---

## 10. 其他重要约定

- **修 schema** 必须加 migration 文件到 `packages/storage/migrations/NNNN_*.sql`（按文件名字典序应用），不允许 hot patch DB
- 测试用 `:memory:` SQLite + `InMemoryKeychainStore` + scripted mock LLM；模板见 `packages/server/src/e2e.test.ts`
- TG bridge 是 EventBus 订阅者 + grammY long-polling，**core 不感知它**；加新通道参考此模式
- 测试文件命名 `*.test.ts`；每个 package 的 `tsconfig.json` 的 `exclude` 必须含 `src/**/*.test.ts`，防止 tsc 把测试编译进 dist 后被 bun test 重复执行
