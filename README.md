# ai-emp · AI 数字员工

> 让个人和小团队用「招人 + 派活」的方式管理 AI，把零散的 Agent 调用沉淀成一支可复用的数字团队。

## 这是什么

一个**单用户本地运行**的 AI 员工引擎。和市面上的 AI 助手不同，它把"对话/指令"的心智模型换成"组织 + 岗位"：

| 维度 | 主流 AI 助手 | ai-emp |
|---|---|---|
| 心智模型 | 对话 / 指令 | **组织 + 岗位** |
| 复用单元 | Prompt / Agent 配置 | **员工档案**（岗位 + 技能 + 记忆 + 履历） |
| 工作流入口 | 用户主动提问 | **工单制**：澄清前置 → 执行 → 验收 |
| 沉淀资产 | 散落的会话记录 | 员工成长档案 / 项目知识库 / 需求闭环 |

核心机制：
- **澄清前置**：员工接单先复述理解 + 列拆解 + 提问，确认后才动手
- **过程透明**：思维链 + 当前步骤 + 下一步计划三栏实时可见
- **纠错沉淀**：失败 / 返工 / 差评自动复盘，写入个人教训 + 项目踩坑库

数据在本地（SQLite + sqlite-vec），LLM Key 在 OS keychain，凭证不落库。

---

## 快速开始（5 分钟）

```bash
# 1. 装运行时（macOS）
brew install bun sqlite

# 2. 装依赖 + 修 sharp 平台二进制
bun install --ignore-scripts
bun run scripts/postinstall.ts

# 3. 构建 Web UI
cd packages/web && bun run build && cd ../..

# 4. 首次配置
bun packages/cli/src/index.ts init

# 5. 写入你的 LLM Key
bun packages/cli/src/index.ts keychain set claude-main sk-ant-xxxx

# 6. 启动服务
bun packages/cli/src/index.ts serve
```

启动后会打印浏览器登录链接 `http://localhost:7878/auth?token=XXX`，点开就能用。

**完整步骤、命令清单、排错** → [GETTING_STARTED.md](./GETTING_STARTED.md)

---

## 三种使用方式

### 1. 浏览器 UI（主战场）

启动 `serve` 后访问 `localhost:7878`：
- 仪表：活跃需求 / 员工 / 项目一览
- 项目 / 员工 CRUD
- 新建需求 → 澄清卡片 → 思维链三栏 → 验收
- 通过 WebSocket 实时刷新思维链

### 2. Telegram bot（手机端遥控）

把 bot token 写入 keychain + 配置白名单 chat id，serve 时自动启动 bridge：

```bash
ai-emp keychain set tg-bot-token <bot-token>
AIEMP_TG_CHAT_IDS=12345678 ai-emp serve
```

支持的命令：
```
/new <员工名> <描述>    新建需求 + 触发澄清
/list                  我的活跃需求
/req <id 前缀>          单条需求状态
/pause /resume /cancel
/approve /reject       验收 / 驳回
/who /help

回复 bot 的澄清提问消息 = 自动答澄清
```

思维链以"💭 思考中..."节流 edit 推送，关键节点单条新消息。

### 3. CLI（脚本 / debug）

```bash
ai-emp status                 列出活跃需求
ai-emp logs <req-id> [-f]     看思维链（-f 跟随）
ai-emp recover                列出 in-flight 需求
ai-emp metrics                PRD §12 量化指标采样
ai-emp seed                   导入 3 项目 + 5 员工 + 8 技能样板
ai-emp backup [path]          DB 整盘备份
```

完整命令列表见 `ai-emp help`。

---

## 项目布局

```
ai-emp/
├── packages/                     11 个 workspace 包
│   ├── events/                   类型化 EventBus（26 事件 + Zod schema）
│   ├── domain/                   领域类型 + Zod schema（单一真实源）
│   ├── storage/                  drizzle schema + repos + sqlite-vec + keychain
│   ├── core/                     Agent Runtime + 状态机 + Memory + Prompt + Metrics
│   │   ├── runtime/              executeRequirement / Budget / Scheduler / Recover / Replay / Complexity / Summarizer
│   │   ├── memory/               RAG recall / 双向沉淀 / Importance Scoring
│   │   ├── prompt/               PromptComposer (按 §11.1 顺序 + cacheBreakpoints)
│   │   └── metrics/              PRD §12 量化采样器
│   ├── llm/                      Anthropic + OpenAI 兼容 adapter（LLMChunk 抽象）
│   ├── tools/                    ToolRegistry + ToolExecutor + 4 个系统级 tool
│   ├── embedding/                transformers.js + bge-small-zh-v1.5（512 维）
│   ├── server/                   Hono HTTP + WebSocket + auth + 静态资源
│   ├── bridge-tg/                grammY Telegram bot + 流式节流
│   ├── web/                      React + Vite + Tailwind SPA
│   └── cli/                      ai-emp 入口（13 个子命令）
├── scripts/
│   └── postinstall.ts            sharp arm64 native 修复脚本
├── spikes/                       W0 技术验证保留（sqlite-vec / transformers.js / LLM SDK）
└── dist/ai-emp                   单二进制（bun build --compile）
```

**依赖方向**：`cli → server / bridge-tg → core → storage / llm / tools / embedding → domain / events`

---

## 文档导航

| 文档 | 内容 | 谁该看 |
|---|---|---|
| [**PRD_V1.md**](./PRD_V1.md) | 完整产品需求：四大实体 / 记忆模型 / 流程 / 验收 / α / β 范围 | **产品** / 决策者 |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | 技术架构：模块边界 / 数据库 schema / Runtime 状态机 / 事件总线 / API 边界 | **工程** / 二次开发 |
| [**ALPHA_TASKS.md**](./ALPHA_TASKS.md) | α + β 工单清单、当前进度状态、后续路线 | 跟进开发进度 |
| [**SPIKE_RESULTS.md**](./SPIKE_RESULTS.md) | W0 技术 spike 结果（sqlite-vec / transformers.js / LLM SDK 兼容性） | 排错 / 平台移植 |
| [**GETTING_STARTED.md**](./GETTING_STARTED.md) | 从 brew install 到完成首个需求的 quickstart + 排错表 | **新用户** |

---

## 项目状态

α + β 两阶段交付完成：

- **172 tests pass** / 1 skip / 0 fail（23 文件，458 expect 调用）
- **12,904 行**非测试源代码（TS/TSX）
- **PRD §12 端到端验收 #1–#6 全部 pass**
- **单二进制 63MB**（`bun build --compile`，macOS arm64 已验证）
- 仓库：[AEON-Project/ai_employee](https://github.com/AEON-Project/ai_employee)

详细状态见 [ALPHA_TASKS.md §0](./ALPHA_TASKS.md#0-当前开发状态最近更新2026-05-26)。

---

## 技术栈

| 用途 | 选型 |
|---|---|
| 运行时 | **Bun 1.3+**（内置 SQLite / WS / HTTP / test runner） |
| 语言 | **TypeScript** strict |
| 数据 | **SQLite + WAL + sqlite-vec**（向量虚表，512 维），**drizzle-orm** 类型安全 |
| 嵌入 | **`@xenova/transformers` + bge-small-zh-v1.5**（纯 JS，~23MB，512 维） |
| LLM | **Anthropic SDK** + **OpenAI SDK**（兼容 DeepSeek / 智谱 / Kimi 等） |
| HTTP/WS | **Hono** + Bun.serve |
| Telegram | **grammY**（long-polling，零云端依赖） |
| 凭证 | macOS `security` CLI / Linux `secret-tool`（避开 native binding 坑） |
| 前端 | React + Vite + Tailwind + Zustand（shadcn 风格自写组件） |
| Schema | **Zod**（运行时校验 + 类型推导） |

完整选型理由 + 选型时的 trade-off 见 [ARCHITECTURE.md §3](./ARCHITECTURE.md#3-技术栈)。

---

## 平台支持

- **macOS arm64**：✅ 完整验证（开发主平台）
- **macOS x64**：⚠️ 未验证；理论可工作（sqlite-vec 有 darwin-x64 binary）
- **Linux x64**：⚠️ 未验证；sqlite-vec / sharp / keychain (`secret-tool`) 选型都支持
- **Windows**：❌ 暂不支持（keychain CLI 还未实现 Credential Manager 路径）

详细见 [SPIKE_RESULTS.md](./SPIKE_RESULTS.md) 的工程注意点。

---

## 开发

```bash
# 全局 typecheck
bun run typecheck

# 全部测试
bun test

# 格式化
bun run format

# 编译单二进制
bun build packages/cli/src/index.ts --compile --outfile dist/ai-emp
```

包级测试：
```bash
bun test packages/core
bun test packages/server
bun test packages/bridge-tg
# 等等
```

---

## License

待定（α 阶段未发布）。

---

## Roadmap

- **α + β（已完成）**：单用户本地引擎，浏览器 + TG 双入口，PRD §12 #1-#6 端到端
- **β 反馈循环**：根据真实使用调整 PromptComposer / 复杂度阈值 / Importance Scoring 权重
- **V1.1+**（PRD §11 标注）：Replay 批量评分 / 跨项目 Brain / Trigger 事件驱动 / Integration 生态 / Git/PR/CI 集成 / 多模态

完整路线见 [ALPHA_TASKS.md §13](./ALPHA_TASKS.md#13-后续路线)。
