# AI 协作工作流

**未来 AI 实例必读**。本文档定义"接需求 → 开发 → 完成 → 回写"的标准流程。

[CLAUDE.md](../../CLAUDE.md) 是入口；详细规则在本文件。

---

## A. 接到新需求

加到 [CLAUDE.md "待办"](../../CLAUDE.md#待办含新需求) 区，格式：

```markdown
- **<需求标题>** （来源：<用户原话日期>）
  - 描述：1-2 句说清楚做什么、为什么
  - 验收：可观测的产出（如 "ai-emp seed --reset 后 active=5, archived=0"）
  - 影响范围：列出预计涉及的包 / 文件
```

需求 ≠ 一定要做。先评估是否在 V1.0 范围内：

| 判定 | 处置 |
|---|---|
| 在 V1.0 范围 | 加到待办，按优先级排序 |
| 超 V1.0 / 命中 PRD §11 "明确不做" | 回复用户解释，请用户决策"现做 / 推 V1.1 / 不做" |
| 紧急 bug | 直接做，事后归档到 [CHANGELOG](../progress/CHANGELOG.md) |

V1.0 明确不做的清单见 [PRD_V1.md §11](../product/PRD_V1.md#十一v10-明确不做重要)。

---

## B. 开始开发任务

1. 把任务从 CLAUDE.md "待办" 移到 "进行中"
2. 在条目里写"开始日期 + 计划影响范围"
3. 评估是否要更新 [PRD_V1.md](../product/PRD_V1.md) 或 [ARCHITECTURE.md](../architecture/ARCHITECTURE.md)（结构性变化必须更新）

---

## C. 完成开发

每个**有意义的工作单元**（功能 / bug 修复 / 重构）必须依次完成：

```bash
# 1. 跑全套，全 pass 才能提交
bun run typecheck
bun test

# 2. 格式化
bun run format

# 3. 提交
git add <文件>
git commit -m "feat(...): xxx"  # 用 feat / fix / docs / refactor / chore / style 前缀
git push

# 4. 拿到 commit hash
git rev-parse --short HEAD

# 5. 把任务从 CLAUDE.md "进行中" 挪到
#    docs/progress/CHANGELOG.md 末尾，带 hash
```

### 完成示例

```markdown
| `abc1234` | feat(memory): 双向沉淀加 LLM-as-judge 置信度（PRD §6.1） | [ARCHITECTURE §11.4](../architecture/ARCHITECTURE.md#114-双向沉淀prd-62) |
```

如果工作跨多个 commit，列最后一个收口的 hash 即可，多个 commit 用 `abc1234..def5678` 表示范围。

---

## D. 验证开发结果（UI 类改动）

环境已配 `browser_navigate` MCP，UI / WS / API 改动必走视觉验证。详见 [DEBUGGING.md](./DEBUGGING.md)。

---

## E. 变更产品需求

修改 PRD 范围时（罕见，需用户明确同意）：

1. 更新 [PRD_V1.md](../product/PRD_V1.md) 对应段
2. 在 [CLAUDE.md "产品需求"](../../CLAUDE.md#产品需求) 段同步摘要
3. commit message 用 `docs(prd):` 前缀

---

## F. 不允许的捷径

| ❌ 不允许 | 为什么 / 替代方案 |
|---|---|
| 绕过状态机改 Requirement.status | 必须过 `transition()` 纯函数，非法转移抛 IllegalTransition。见 [CONVENTIONS §6](../architecture/CONVENTIONS.md#6-状态机硬规则) |
| 改 DB schema 不写 migration | 加 SQL 文件到 `packages/storage/migrations/NNNN_*.sql`，按文件名字典序应用 |
| 把 secret 写进 DB | DB 只存 `keychainKey` 引用；secret 走 keychain 或 `env://` |
| 让 `core` 反向依赖 `server` / `cli` / `bridge-tg` | 单向洋葱依赖。新通道（Lark/Slack）做成 EventBus 订阅者 |
| 在 events 包加 EventMap 条目不同步 Zod schema | 跨进程边界靠 schema 校验，缺一不可 |
| git commit message 写 `WIP` / `update` 等占位 | 必须有可追溯的具体描述，便于 CHANGELOG 回填 |
| 跳过 typecheck 或 test 失败的 commit | CI 出错优先修，不允许 push 红的 |

---

## G. 文档维护层级

| 文档 | 何时写 |
|---|---|
| [CLAUDE.md](../../CLAUDE.md) | AI 入口；每次完成开发后回写"已交付"摘要 |
| [CHANGELOG.md](../progress/CHANGELOG.md) | 每个 commit 都要记，含 hash + 对应文档链接 |
| [PRD_V1.md](../product/PRD_V1.md) | 改产品范围时同步 |
| [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) | 改架构 / 加新模块 / 改依赖图时同步 |
| [ALPHA_TASKS.md](../progress/ALPHA_TASKS.md) | α/β 工单粒度的进度（已凝固，新功能直接进 CHANGELOG） |
| [CONVENTIONS.md](../architecture/CONVENTIONS.md) | 发现新的"必须遵守"约定或工程坑时补充 |
