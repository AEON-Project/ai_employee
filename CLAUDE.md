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

> 最近：`562207c` docs: ALPHA_TASKS §16 — V2 第二轮端到端验证（openai-compat+gpt-5.3-chat-latest 7 轮迭代 + 3 个 P0 引擎修复 + LLM 真改代码突破）
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

## 🛡 改动前必读（修 BUG / 加功能）

**动手之前必须先理解，不得"看到症状就改"**：

1. **先读架构和历史**
   - 看 [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) + [CONVENTIONS.md](./docs/architecture/CONVENTIONS.md) 了解模块边界
   - 看 [docs/progress/CHANGELOG.md](./docs/progress/CHANGELOG.md) + `git log -p <相关文件>` 了解这块代码的演进
   - 看 [PRD_V1.md](./docs/product/PRD_V1.md) / [PRD_V2.md](./docs/product/PRD_V2.md) 了解功能背后的产品意图

2. **理解"为什么是现在这样"**
   - 现有代码不是凭空写的——找到当初的 commit message、CHANGELOG 条目、PRD 章节，看清楚**它当时解决的是什么问题**
   - 看不出来就 `git blame` + `git show <hash>`，仍看不出来 → **问用户**，不要凭猜测覆盖
   - 特别注意防御性代码 / 看似冗余的分支 / 奇怪的兜底——大概率是踩过坑后补的，删之前必须确认那个坑已经不存在

3. **评估影响面**
   - 改动落在哪几个 workspace 包？是否跨越洋葱依赖层？
   - 是否影响：**框架契约**（核心抽象 / 事件 / DB schema / 工具协议）/ **用户可见行为**（UI 文案、CLI 输出、API 响应、Telegram 消息）/ **流程**（澄清 → 拆解 →执行 → 沉淀的任一环节）
   - 是否影响现有数据（迁移、历史工单回放、记忆库读取）

4. **评估方案是否合理**（动手写代码前先在脑子里过一遍）
   - **用户使用场景**：真实用户在 UI / Telegram / CLI 三种入口下怎么用到这块？正常路径 + 异常路径都想清楚（网络抖、LLM 超时、工具失败、用户中途取消、跨会话回放）；是否引入新的认知负担或破坏现有交互直觉
   - **系统稳定性**：失败时怎么降级？是否引入新的死锁 / 竞态 / 资源泄漏 / 长事务？是否破坏已有的幂等性、事务边界、事件顺序？Runtime 状态机是否仍能被驱动到终态？
   - **代码复用**：项目里是否已有同类抽象可直接用（EventBus / Memory / Metrics / Prompt composer / Tool 协议 / storage 层）？不要重复造轮子；若新写的能力多处可用，考虑下沉到 core 而非堆在入口层
   - **方案最小性**：是不是解决当前问题最简单的写法？不为假想的未来需求做抽象、不顺手扩边界（参考 CLAUDE.md 顶部 "Doing tasks" 段——不加多余 fallback / validation / 抽象）
   - **可观测性**：失败路径有没有日志埋点（`~/.ai-emp/logs/`）让下次能"日志先行"定位？关键状态变化有没有 metric / event？

5. **影响框架/用户/流程 → 必须先问，不得擅自改**
   - 命中以下任一项，**先停下来向用户确认方案再动手**：
     - 改动核心抽象（EventBus / Runtime 状态机 / Memory 接口 / Tool 协议 / Prompt composer）
     - 改动 DB schema 或需要数据迁移
     - 改动用户可见文案、UI 交互、API/WS 契约、CLI 子命令语义
     - 改动 PRD 已定义的核心流程（澄清前置 / 三栏透明 / 纠错沉淀）
     - 涉及 [PRD §11 "V1.0 明确不做"](./docs/product/PRD_V1.md#十一v10-明确不做重要) 边界
   - 只是局部 bug 修复 / 内部重构 / 加测试 / 补日志埋点 → 可以直接做

6. **不允许的捷径**
   - ❌ 看到测试挂了直接改测试断言迁就实现
   - ❌ 看到防御分支碍事直接删掉
   - ❌ 看到旧逻辑"不优雅"顺手重构（即便看似无害）
   - ❌ 用 `--no-verify` / 跳过 typecheck / 注释掉测试绕过失败

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

## 🧰 技能 vs 工单描述（V3 规范）

**核心原则**：能沉淀到「员工技能」里的，绝不重复写到工单描述里。工单描述只讲"做什么 / 为什么"，不讲"怎么做的工程细节"。

### 工单描述写什么

- 业务目标（一两句话）
- 验收标准（怎么算完成）
- 必须知道的项目级事实（路径、外部依赖、约束条件）

### 工单描述**不**写什么

- 通用工具用法（如"Bash 没有 apply_patch，写文件用 cat heredoc"）→ 沉淀到 `Bash 工具规范` 技能
- 编程语言/框架的标准做法（如 Spring Boot 分层、Lombok @Data、APIResponse 返回包装）→ 沉淀到岗位技能（如 `Java Spring Boot 后端开发`）
- 编译/构建工具的判定方法（如"看 `BUILD SUCCESS` 字符串"、"区分 WARNING 和 ERROR"、"-U 强制刷新"）→ 沉淀到 `Maven 编译验证` 技能
- 命令模板（如"`cd module && JAVA_HOME=... mvn compile`"）→ 沉淀到对应技能
- 反复出现的硬规则（如"路径不臆造 / 不要 ask_user / exit≠0 不 advance_step"）→ 沉淀到员工 `persona` 或 `Bash 工具规范` 技能

### 怎么沉淀技能

- 出现"plan 描述里塞了一堆通用规则才能跑通"——说明缺技能
- 出现"换个员工就要重写一遍 plan"——说明该写技能
- 加技能用 `skills` 表 + `employee_skills` 绑定；技能的 `prompt_template` 被 prompt composer 自动注入 system prompt
- 同一规则在多个工单里重复 ≥2 次 → 必须提取成技能

### 失败案例

> V3 自动化测试 trial 4：工单描述塞了 JDK 路径、mvn 命令模板、`-U` 重试技巧、stdout 判定方法——结果小后照搬命令跑出 BUILD SUCCESS 但**误判 stdout 没识别**。这些应该是 `Maven 编译验证` 技能的标准内容，而不是塞 plan。

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
├── GETTING_STARTED.md       ← 新用户向导（含 V2 新能力速览）
└── docs/
    ├── product/
    │   ├── PRD_V1.md        ← V1.0 产品需求（四大实体 / 记忆 / 流程 / 验收）
    │   ├── PRD_V2.md        ← V2 优化扩展（三方对比补齐 11 项 + 边界）
    │   └── PRD.md           ← 历史 PRD 归档
    ├── architecture/
    │   ├── ARCHITECTURE.md  ← 技术架构（模块边界 / 状态机 / 事件 / DB schema）
    │   ├── CONVENTIONS.md   ← 工程约定 + 决策 + 已踩坑
    │   └── SPIKE_RESULTS.md ← W0 技术验证
    ├── progress/
    │   ├── ALPHA_TASKS.md   ← α / β / V2 工单清单（§14 三方对比终版）
    │   └── CHANGELOG.md     ← 每次开发的 commit hash 流水
    └── ai/
        ├── WORKFLOW.md      ← AI 协作工作流（A–G）
        ├── DEBUGGING.md     ← 浏览器自动化端到端调试
        └── V2_E2E_VERIFICATION.md ← V2 11 项能力的端到端验证 playbook
```
