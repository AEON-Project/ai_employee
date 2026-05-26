# ai-emp

AI 数字员工 — 单用户本地引擎。

> 见 [PRD_V1.md](./PRD_V1.md) / [ARCHITECTURE.md](./ARCHITECTURE.md) / [ALPHA_TASKS.md](./ALPHA_TASKS.md) / [SPIKE_RESULTS.md](./SPIKE_RESULTS.md)。

## 快速开始

```bash
# 安装运行时（macOS）
brew install bun sqlite

# 装依赖（首次会跑 sharp 平台 native 修复脚本）
bun install --ignore-scripts
bun run scripts/postinstall.ts

# 类型检查
bun run typecheck

# 试跑 CLI 骨架
bun packages/cli/src/index.ts --version
```

## 项目布局

```
ai-emp/
├── packages/
│   ├── events/       类型化 EventBus
│   ├── core/         领域 + Runtime + 记忆 + Prompt
│   ├── storage/      drizzle schema + repos + sqlite-vec
│   ├── llm/          Anthropic + OpenAI 兼容 adapter
│   ├── tools/        ToolRegistry + Executor + 内置 tool
│   ├── embedding/    transformers.js + bge-small-zh-v1.5
│   ├── server/       Hono HTTP + WebSocket
│   ├── bridge-tg/    grammY Telegram long-poll
│   ├── web/          React + Vite + shadcn/ui
│   └── cli/          ai-emp 入口
├── spikes/           W0 技术验证（保留作复跑参考）
├── PRD_V1.md
├── ARCHITECTURE.md
├── ALPHA_TASKS.md
└── SPIKE_RESULTS.md
```

依赖方向：`cli → server / bridge-tg → core / storage / events → llm / tools / embedding`。

## 平台备注

- **macOS / Linux**：必须装 brew/系统 sqlite（含 extension loading 能力）。Bun 内置 sqlite 关闭了 `loadExtension`。
- **arm64**：sharp 0.32 在 arm64 + Rosetta 环境下需要手动修复（见 `scripts/postinstall.ts`）。
- **Windows**：未在 α 阶段验证。
