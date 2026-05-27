# AI 数字员工 — V2 优化扩展（基于 OpenClaw + hermes-agent 三方对比）

> 本文档承接 [PRD_V1](./PRD_V1.md) 「V1.0 引擎验证版」之后的 V2 优化。
> V1 的产品定位、四大实体、记忆模型、流程不变，本文只描述新增能力。
> V2 优化的工程实现明细 → [ALPHA_TASKS §14](../progress/ALPHA_TASKS.md#14-v2-优化清单--三方对比终版2026-05-27)

---

## 背景与定位

V1 完成后，跟两个同类项目做了三方对比：

- [OpenClaw](https://github.com/openclaw/openclaw)（personal AI assistant，多通道聊天）
- [hermes-agent](https://github.com/NousResearch/hermes-agent)（self-improving agent，自学习闭环）

对比凸显了 V1 引擎的几个差距：员工"成长"不闭环、单员工接单不能协作、非 git 项目改坏数据没救、工单不能定时跑、工具生态封闭等。V2 围绕这些差距补齐能力。

**V2 保留 V1 的护城河**（三方对比下我们独有）：

- 9 态工单状态机 + 系统 tool 驱动（ask_user / advance_step / update_plan / emit_deliverable）
- 澄清前置（强制 ask_user 后才进入"进行中"）
- 待验收 + Git Diff 双重验收（员工提交 → 用户判断 → 同意/驳回）

---

## V2 新增能力（11 项 / 全部落地）

### 一、PRD §1「下次更好」+ §3「纠错沉淀」核心机制闭环

#### O1 · Skills 自演化（参考 hermes agentskills.io）

LLM 完成任务后主动调 `emit_skill` 沉淀「可复用做法套路」到员工长期记忆；下次同员工接到相似任务时 composer 按相似度 Top-K 自动注入到 system prompt。

- 新增系统 tool: `emit_skill(name, whenToUse, steps[], triggers?)`
- 复用 `memory_items` 表（`kind='skill'` 新增）+ 现有 RAG 链路
- composer 协作规则告诉 LLM 何时调（"一类可复用套路" vs "一次性具体修改"）

#### O2 · memory 闭环强化（PRD §3「纠错沉淀」最后一环）

两条沉淀路径：

1. **LLM 主动**：`emit_lesson(content, scope='employee'|'project', context?)` 系统 tool — 察觉错误 / 反复失败 / 用户指出错 / 弯路警觉时主动写
2. **用户被动**：`rejectRequirement(reason)` 自动写 `employee.lesson("用户驳回时反馈：X 来自工单 T")` + thread 留 system text

下次同员工接相似需求 → composer §③ lessons RAG 自动 Top-K 注入。

### 二、PRD「组织+岗位」心智完整性

#### O3 · Sub-agent 协作

父员工把子任务派给另一员工，引擎同步执行子工单后把子员工 deliverable 作为 tool_result 回传。"组织"心智第一次能跑起来。

- 新增系统 tool: `spawn_employee(targetEmployeeId, taskTitle, taskDescription)`
- `requirements` 加 `parent_requirement_id`（self-reference，防递归深度 ≤ 1）
- 子员工独立 BudgetTracker；子的 token 不计父；防自环

### 三、安全网

#### O4 · Checkpoint 回滚

工单接单时自动建 baseline 快照（git: HEAD sha / 非 git: tar.gz 归档）；LLM 可在风险高的步骤前主动调 `checkpoint(label)`；用户驳回时 UI 一键回滚（先做 preRevert 备份再恢复，硬恢复 = git reset --hard + clean -fd 或 tar 解压覆盖）。

非 git 项目（数据文件 / 配置文件）改坏也能救回。

#### O10 · 危险命令拦截

Bash tool 黑名单匹配（`rm -rf` 根/系统/家目录 / `sudo`-class / `curl|sh` / `dd` 块设备 / `mkfs` 格式化 / `chmod 777` / fork bomb / `shutdown|reboot`）→ exitCode=126 + stderr 含 `DANGEROUS_COMMAND_BLOCKED` 详情。LLM 看到自然调 `ask_user` 拿授权或改命令。`env AIEMP_ALLOW_DANGEROUS=1` 全局放开（不推荐）。

### 四、场景扩展

#### O5 · Cron 定时工单（"日报 / 巡检 / 周清理"自动化）

`requirements.cron_spec` 字段（cronSpec 非空 = 模板，scheduler 永不直接 dispatch）。scheduler 每 60s 扫一次到期就 createReq(parentRequirementId=tpl.id, cronSpec=null) + assign + enqueue。

简化语法（不实现完整 5-field crontab）：

- `every N minutes` / `every N hours`
- `daily HH:MM`
- `weekly mon|tue|wed|thu|fri|sat|sun HH:MM`

#### O6 · MCP client 接入（工具生态一夜十倍）

新包 `@ai-emp/mcp-client` 极简实现 stdio MCP 协议（initialize 握手 + tools/list + tools/call，不实现 resources/prompts/sampling）。`dataDir/mcp.json` 配置 MCP servers，启动时连接并自动注册到 ToolRegistry（命名 `mcp_<server>_<tool>` 防冲突）。

可接入：GitHub MCP / Slack MCP / Filesystem MCP / 浏览器 MCP 等社区生态。

### 五、工程实战

#### O7 · PTY 支持

Bash 工具 `pty: true` 走 `script` 命令包装的伪 tty（macOS / Linux），让 mvn / gradlew / npm install 等检测 isTTY 的命令能正常输出。避开 node-pty native binding 兼容性问题。

#### O8 · Prompt cache 精细化

把 system prompt 切成「平台 / 项目 / 需求」三段独立缓存：

- 切换需求 → 平台 + 项目层命中
- 切换项目 → 平台层命中
- 同需求多轮 → 三段都命中

Anthropic provider buildSystemBlocks 支持多 bp（上限 4 段 ephemeral 符合规范）。原 1 段升级为 1-3 段。

#### O9 · Process notify-on-exit

后台 Bash 进程 close 时自动写 system message 到 thread + 状态"进行中"时 `scheduler.enqueue` 重新唤醒 LLM。让 LLM 不需要 sleep+轮询 `Process read` 也能知道 mvn/npm install 结束。

### 六、研究 / 调试

#### O11 · Trajectory dump

`GET /requirements/:id/trajectory` + `ai-emp trajectory <reqId> [--jsonl]` 把工单完整 thread 导出为 OpenAI chat 格式（messages 数组 + tool_calls + tool_call_id）。用于：调试 / 备份 / 分享。

**不做**：hermes 风格的训练数据生成管道。我们是「本地数字员工」不是研究项目。

---

## V2 不做（明确边界）

继承 [V1 §11 「明确不做」](./PRD_V1.md#十一v10-明确不做重要) 全部，再加：

- ❌ **不要变成 hermes** — 不抄 trajectory 训练数据生成 / 6 种远端 backend / serverless 部署。我们是「本地数字员工」，单用户本地是定位。
- ❌ **不要变成 OpenClaw** — 不接 27 个 IM 通道 / 不做 Gateway 控制平面。TG 是触达通道不是核心产品。
- ❌ **不学 hermes 拆 40+ 细分 tool** — 单一 Bash 透传 + Process 已经够用，让 LLM 用 shell 命令完成。
- ❌ **不做完整 5-field crontab 语法** — V2 简化语法（every/daily/weekly）覆盖 90% 个人场景。
- ❌ **不实现完整 MCP 协议** — 只做 tools/list + tools/call 子集，resources/prompts/sampling/elicitation 跳过。
- ❌ **不做完整 PTY**（stdin 交互）— 当前 PTY 是单向（命令能看见 tty，但不能读用户输入）。

---

## 三方对比剩余项（P3 / 按需做）

| ID  | 项                                         | 状态    | 原因                                                      |
| --- | ------------------------------------------ | ------- | --------------------------------------------------------- |
| O12 | 多 backend（远程 Docker/SSH/Modal）        | ❌ 不做 | 与"单用户本地引擎"定位冲突；V2 §不做边界明确禁止          |
| O13 | ACP 协议（VSCode/Cursor 把我们当 backend） | ⏳ 按需 | 边界未禁，但工程量大且 IDE 集成不是核心；用户有真需求再做 |

---

## V2 工程统计

| 指标             | V1 → V2                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| 测试数           | 250 → 306 (+56)                                                                                  |
| expect 调用      | 650 → 883 (+233)                                                                                 |
| 新增 migration   | 3 个（0003 parent / 0004 checkpoints / 0005 cron）                                               |
| 新增系统 tool    | 6 个（emit_skill / emit_lesson / spawn_employee / checkpoint / 危险命令检查 / 其他工具增强字段） |
| 新增 core 子模块 | 3 个（cron / checkpoint / trajectory + mcp-client 整包）                                         |
| 改动 commit      | 13 个（O1 `0e1431e` → O11 `46b9c83`）                                                            |

详细 commit 列表 → [CHANGELOG](../progress/CHANGELOG.md) `0e1431e..46b9c83`。

---

## 验收方式

V2 没有像 V1 §12 那样的"27 条 e2e 验收清单"。每个 O 项有：

- 单元测试覆盖（runtime / cron / checkpoint / trajectory / mcp-client / file-tools）
- 数据层 migration 测试
- typecheck 全过

**用户验收**通过端到端真实使用：派一个工单，验证 Skills / memory / sub-agent / Cron / Checkpoint 的实际行为。可执行验证清单 → [docs/ai/V2_E2E_VERIFICATION.md](../ai/V2_E2E_VERIFICATION.md)（11 项能力对应 11 个验证场景，含 SQL 查询和命令行验证步骤）。
