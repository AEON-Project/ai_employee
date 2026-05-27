# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 📍 项目定位

单用户本地运行的 **AI 数字员工引擎**：把"对话/指令"换成"组织 + 岗位 + 工单"心智模型。

三种入口：**浏览器 UI** / **Telegram bot** / **CLI**。详见 [README.md](./README.md)。

---

## 📦 产品需求

**当前版本：V1.0 引擎验证版** — 已交付。

**目标**：验证"配置过技能和人设的 AI 员工，能否在『澄清前置 + 过程透明 + 记忆沉淀 + 纠错学习』机制下完成任务，且下次同类任务做得更好"。

**核心机制**：
1. 澄清前置：员工接单先复述理解 + 列拆解 + 提问
2. 过程透明：思维链 + 当前步骤 + 下一步计划三栏
3. 纠错沉淀：失败/返工/差评自动写入个人教训 + 项目踩坑库

**完整产品需求** → [docs/product/PRD_V1.md](./docs/product/PRD_V1.md)
**V1.0 明确不做的清单** → [PRD §11](./docs/product/PRD_V1.md#十一v10-明确不做重要)
**V1.1+ 候选** → [ALPHA_TASKS §13](./docs/progress/ALPHA_TASKS.md#13-后续路线)

---

## 📊 当前开发任务

### 进行中

_无_

### 待办（含新需求）

_无；接到新需求请按 [WORKFLOW §A](./docs/ai/WORKFLOW.md#a-接到新需求) 加到这里_

### 已交付（最近 5 条 / 完整见 CHANGELOG）

> 最近：`4e0aa4e` feat(mcp-client): V2 O6 MCP client — 接入 Model Context Protocol 工具生态；stdio MCP 协议极简实现 + McpManager 多 server + 自动注册到 ToolRegistry (mcp_<server>_<tool>)
> 完整提交记录 → [docs/progress/CHANGELOG.md](./docs/progress/CHANGELOG.md)

---

## 🤝 AI 协作工作流（必读）

CLAUDE.md 是 AI 协作的入口。**每次完成开发后必须**：

1. 跑 `bun run typecheck && bun test`，全 pass
2. `bun run format`
3. `git commit + push`，message 用 `feat:` / `fix:` / `docs:` 等前缀
4. `git rev-parse --short HEAD` 拿 hash
5. **回写 [docs/progress/CHANGELOG.md](./docs/progress/CHANGELOG.md)**（不是 CLAUDE.md 本身），带 commit hash

完整工作流 → [docs/ai/WORKFLOW.md](./docs/ai/WORKFLOW.md)（A–G 章节：接需求 / 开始 / 完成 / 验证 / 变更 PRD / 不允许的捷径 / 文档维护层级）

UI / WS / API 改动必走视觉验证 → [docs/ai/DEBUGGING.md](./docs/ai/DEBUGGING.md)（playwright MCP + 浏览器 / curl / sqlite3 / 日志四件套）

**日志先行**：排查问题第一步永远是 `tail ~/.ai-emp/logs/YYYY-MM-DD.log`，不是肉眼看 UI 或加 `console.log`。日志缺时**回头补埋点 + 同步更新 DEBUGGING.md §4.5 §6**（详见该文顶部「⚡ 工程纪律」段）。

---

## ⚡ 运行时硬规则

**必须用 Bun，不用 Node**：
- `bun <file>` 不是 `node <file>` 或 `ts-node`
- `bun:sqlite` 不是 `better-sqlite3`
- `bun test` 不是 jest/vitest
- Bun 自动加载 `.env`，**不用引 dotenv**
- 安装依赖用 `bun install --ignore-scripts`，再跑 `bun run postinstall` 修 sharp 平台二进制

---

## 🛠 常用命令

```bash
# Setup
brew install bun sqlite                  # brew sqlite 必装
bun install --ignore-scripts
bun run postinstall                      # 修 sharp arm64 native
cd packages/web && bun run build && cd ../..

# 开发
bun run typecheck                        # tsc -b 增量
bun test                                 # 全部测试
bun test packages/core                   # 单包测试
bun test packages/server/src/e2e.test.ts # PRD §12 #1-#6 端到端
bun run format
bun run build:cli                        # dist/ai-emp 单二进制

# CLI（四种等价调用）
./ai-emp <cmd>                           # shell wrapper（推荐）
bun run ai-emp -- <cmd>
bun packages/cli/src/index.ts <cmd>
./dist/ai-emp <cmd>
```

---

## 🏗 关键架构（速览）

11 个 workspace 包，**单向洋葱依赖**：

```
cli  →  server / bridge-tg          ← 入口层
              ↓
            core                    ← runtime + memory + prompt + metrics
              ↓
    storage / llm / tools / embedding
              ↓
        domain / events             ← 最底层（零依赖）
```

**core 永远不依赖 server / cli / bridge-tg**（加新通道做成 EventBus 订阅者）。

详细架构决策 + 工程坑 → [docs/architecture/CONVENTIONS.md](./docs/architecture/CONVENTIONS.md)（10 节）
完整技术架构 → [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md)

---

## 💬 回复风格

- **简体中文**回复，包括代码解释和方案描述
- 技术术语保留英文原词（API、Token、Hook、Bun、PRD）
- 代码块保持英文，注释中英文皆可
- 简洁直接，不重复用户已说过的内容

---

## 📚 文档导航

```
/                            ← 根目录（用户/AI 入口）
├── README.md                ← 项目介绍（GitHub 首页）
├── CLAUDE.md                ← 本文件（AI 入口摘要）
├── GETTING_STARTED.md       ← 新用户向导
└── docs/
    ├── product/
    │   ├── PRD_V1.md        ← 当前 V1.0 产品需求
    │   └── PRD.md           ← 历史 PRD 归档
    ├── architecture/
    │   ├── ARCHITECTURE.md  ← 技术架构（模块边界 / 状态机 / 事件 / DB schema）
    │   ├── CONVENTIONS.md   ← 工程约定 + 决策 + 已踩坑
    │   └── SPIKE_RESULTS.md ← W0 技术验证
    ├── progress/
    │   ├── ALPHA_TASKS.md   ← α/β 工单清单 + 状态
    │   └── CHANGELOG.md     ← 每次开发的 commit hash 流水
    └── ai/
        ├── WORKFLOW.md      ← AI 协作工作流（A–G）
        └── DEBUGGING.md     ← 浏览器自动化端到端调试
```
