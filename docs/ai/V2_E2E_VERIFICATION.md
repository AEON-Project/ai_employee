# V2 端到端真实验证 Playbook

> 单元测试只验"代码逻辑"，端到端要在真实 LLM 上跑才能发现工程化 bug。
> 本文是 V2 新能力（O1-O11）的可执行验证清单，按场景从浅到深。
>
> 跑这个清单需要：① 真实 LLM API key（建议 Anthropic claude-opus-4-7 或 OpenAI gpt-4o）② 1-2 小时
>
> 每条验证一项 V2 能力，跑前先 `bun test` 确保单测都过；跑后填实际观察到的现象。

---

## 前置：环境准备

```bash
# 1. 拉最新代码
git pull origin main
git log --oneline -1   # 应至少到 commit 46b9c83 (V2 O11)

# 2. 装依赖 + 构建
bun install --ignore-scripts
bun run scripts/postinstall.ts
cd packages/web && bun run build && cd ../..

# 3. 全量测试 pass
bun test  # 应 306 pass / 1 skip / 0 fail

# 4. 配 LLM key（.env 或 keychain 二选一）
# 推荐 .env 方式快：
echo "AIEMP_ANTHROPIC_API_KEY=sk-ant-XXX" >> .env

# 5. 数据隔离 — 用临时数据目录跑验证，不污染你的真实工作数据
mkdir -p ./.v2-verify-data
export AIEMP_DATA_DIR=$(pwd)/.v2-verify-data

# 6. init + seed + serve
./ai-emp init
./ai-emp seed --reset   # 3 项目 / 5 员工 / 8 技能
./ai-emp serve
# 另开终端继续后面验证（保持 serve 进程跑着）
```

---

## 验证 1 · O2 Memory 闭环（驳回沉淀 lesson + RAG 注入）

**目标**：驳回工单时填的 reason 自动写入员工 lesson；下次同员工接到相似需求时 composer 注入 prompt 头部。

**步骤**：

1. 浏览器开 `http://localhost:7878/auth?token=XXX`
2. 派一个明显会失败 / 模糊的需求给"小李"：
   - 标题：写个登录页
   - 描述：（故意写一句话）做一个登录页
3. 等员工 ask_user → 用户答（随便答个"用 Tailwind"）→ 继续 → 进 待验收
4. 驳回时输入原因："**下次接到含 '登录页' 描述的需求，必须先问鉴权方式（OAuth/密码/SSO/...）后再动手**"

**验证点**：

```bash
# 查看自动写入的 lesson
sqlite3 ./.v2-verify-data/db.sqlite "SELECT kind, scope, content FROM memory_items WHERE scope='employee' AND kind='lesson' ORDER BY created_at DESC LIMIT 3;"
# 应有一条 content 含 "用户驳回时反馈：下次接到含 '登录页' 描述的需求..."
```

5. **再派同员工一个相似需求**：
   - 标题：写个登录页 V2
   - 描述：做一个新的登录页
6. 看员工 ask_user 时是不是会问鉴权方式

**通过判定**：员工的澄清问题里出现「鉴权方式 / OAuth / 密码」等字眼（来自上次驳回的 lesson 通过 RAG 注入 prompt）。

---

## 验证 2 · O1 Skills 自演化（emit_skill + 下次注入）

**目标**：让员工完成一类任务后主动调 `emit_skill` 沉淀套路；下次同员工接到相似任务自动注入。

**步骤**：

1. 准备一个 git 项目目录作为 workdir（避免污染主项目）：
   ```bash
   mkdir -p /tmp/v2-test-java-project && cd /tmp/v2-test-java-project
   git init && echo "public enum Color { RED, GREEN }" > Color.java
   git add . && git commit -m init
   cd -
   ```
2. 在 Web UI 把"小李"的项目 workdir 改成 `/tmp/v2-test-java-project`
3. 派工单：
   - 标题：给 Color 枚举加 BLUE
   - 描述：在 /tmp/v2-test-java-project/Color.java 的 Color 枚举里加一个 BLUE 值，保持其他不变
4. 等员工完成

**验证点**：

```bash
# 看是否调了 emit_skill
sqlite3 ./.v2-verify-data/db.sqlite "SELECT content FROM memory_items WHERE kind='skill' ORDER BY created_at DESC LIMIT 1;"
# 应有 "**Skill: Java 枚举新增值**" 之类内容（如果 LLM 主动调了；不调也正常 — 不强制）
```

5. 再派第二个工单：
   - 标题：给 Color 加 YELLOW
   - 描述：同 Color.java 再加 YELLOW

**通过判定**：检查第二轮 LLM 的 prompt（看 thread / messages 表 / `ai-emp trajectory <reqId>`）— system prompt 头部应有「## 你过往沉淀的可复用 Skills」段含上一轮 skill 内容。

---

## 验证 3 · O3 Sub-agent 协作（员工召唤员工）

**目标**：父员工调 `spawn_employee` 派子任务给另一员工，子员工完成后结果回传父员工。

**步骤**：

1. 看下你的员工列表（UI / `sqlite3 ... "SELECT id, name, role FROM employees;"`），记下两个员工 id：A（父，前端）/ B（子，后端）
2. 派一个组合工单给前端员工 A：
   - 标题：找出项目里所有 Java enum 文件
   - 描述：让后端员工 B（id=...）找 /tmp/v2-test-java-project 下所有 \*.java 文件并列出。**目标员工 id: <B id>**
3. 等工单完成

**验证点**：

- 应创建一个子工单（`SELECT * FROM requirements WHERE parent_requirement_id IS NOT NULL`）
- 子工单 assigneeId = B id
- 父工单 thread 应有 tool_call 类型 = 'spawn_employee' + tool_result 含 subRequirementId + subDeliverable

**通过判定**：父员工的 deliverable 引用了子员工的产出（"后端员工已确认有 1 个 \*.java 文件: Color.java"等）。

---

## 验证 4 · O4 Checkpoint 回滚

**目标**：工单接单时自动建 baseline；驳回时可一键回滚 workdir。

**步骤**：

1. workdir 同验证 2（`/tmp/v2-test-java-project`，已是 git 仓库）
2. 派工单：
   - 标题：把 Color 全删了换成 Direction
   - 描述：把 /tmp/v2-test-java-project/Color.java 整个删了，改成 Direction 枚举（UP/DOWN/LEFT/RIGHT）
3. 等员工完成进 待验收

**验证点（执行前）**：

```bash
# 应有 baseline checkpoint
sqlite3 ./.v2-verify-data/db.sqlite "SELECT kind, label, backend_kind, ref FROM checkpoints WHERE requirement_id='<reqId>';"
# 应有 1 行 kind='baseline', backend_kind='git', ref=<HEAD sha>

# workdir 当前状态应是改后的（Color.java 被改 / 删）
cat /tmp/v2-test-java-project/Color.java
```

4. UI 点驳回，原因里写"撤回"，**勾选**"回滚到 baseline"

**验证点（执行后）**：

```bash
# 文件应恢复到 baseline
cat /tmp/v2-test-java-project/Color.java
# 应该是 "public enum Color { RED, GREEN }"

# 应有 preRevert 备份
ls ./.v2-verify-data/checkpoints/<reqId>/
# 应有 preRevert-<ts>.tar.gz
```

**通过判定**：workdir 文件回到 baseline 状态 + preRevert 备份文件存在。

---

## 验证 5 · O5 Cron 定时工单

**目标**：cronSpec 非空的工单作为模板，scheduler 到期创建 child 派给同员工。

**步骤**：

1. Web UI 新建需求：
   - 标题：每分钟问候
   - 描述：在思维链里打印一句 "hello from cron"
   - 员工：选小李
   - **跳过澄清**：✓
   - **定时（可选）**：`every 1 minutes`
2. 创建后立即 Tab 切到主页

**验证点**：

```bash
# 模板工单应有 cron_spec, cron_enabled=true
sqlite3 ./.v2-verify-data/db.sqlite "SELECT id, title, cron_spec, cron_enabled, cron_last_run_at FROM requirements WHERE cron_spec IS NOT NULL;"

# 等 2 分钟后再查
sleep 120
sqlite3 ./.v2-verify-data/db.sqlite "SELECT id, title, parent_requirement_id, status FROM requirements ORDER BY created_at DESC LIMIT 3;"
# 应有 1-2 个 parent_requirement_id 非空的子工单（标题含"定时触发"）
```

**通过判定**：模板存在 + 至少 1 个子工单被自动创建并跑完。

---

## 验证 6 · O6 MCP client

**目标**：MCP server 配置好后启动时自动连接 + 工具注册到 ToolRegistry + LLM 能调。

**步骤**：

1. 在 `./.v2-verify-data/mcp.json` 加配置（用 npm 的 filesystem MCP server 作示例）：
   ```json
   {
     "servers": [
       {
         "name": "fs",
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/v2-test-java-project"]
       }
     ]
   }
   ```
2. 重启 serve（Ctrl+C → 再 `./ai-emp serve`）

**验证点（启动时）**：

- 启动日志应有 `MCP servers 就绪 (1/1): fs`
- `tail ./.v2-verify-data/logs/<today>.log | grep mcp-client` 应见 connect/initialized/tools.listed

3. 派工单给小李：
   - 标题：用 MCP filesystem 列文件
   - 描述：用 mcp_fs_list_directory 工具列出根目录所有文件

**通过判定**：员工调到 `mcp_fs_*` 工具 + 返回了文件列表。

> 如果 npm install 太慢，跳过此验证。功能由 mcp-client 单测已覆盖（7 个 test）。

---

## 验证 7 · O7 PTY 支持

**目标**：Bash tool 加 `pty: true` 让 isTTY 命令正常输出。

直接命令行验证（无需 LLM）：

```bash
bun -e '
import { bashTool } from "@ai-emp/tools/file-tools";
const r1 = await bashTool.invoke({ command: "[ -t 1 ] && echo TTY_YES || echo TTY_NO" }, {requirementId:"t",employeeId:"t",threadId:"t",signal:new AbortController().signal});
const r2 = await bashTool.invoke({ command: "[ -t 1 ] && echo TTY_YES || echo TTY_NO", pty: true }, {requirementId:"t",employeeId:"t",threadId:"t",signal:new AbortController().signal});
console.log("pty=false →", r1.stdout.trim());
console.log("pty=true  →", r2.stdout.trim());
'
```

**通过判定**：第一行 `TTY_NO`，第二行 `TTY_YES`。

---

## 验证 8 · O8 Prompt cache 三段切点

**目标**：composer 输出 1-3 个 cacheBreakpoints；anthropic provider 切多段。

```bash
# 派一个工单 + 等它跑完几轮 LLM → 看实际命中
# 跑完后看 thread 的 system prompt 切分情况：
sqlite3 ./.v2-verify-data/db.sqlite "SELECT content_json FROM messages WHERE thread_id='<tid>' AND role='system' LIMIT 1;"
# 或更直接 — 看 logs 里 llm.call.request 的 system 内容
grep "llm.call.request" ./.v2-verify-data/logs/<today>.log | head -1 | jq
```

**通过判定**：cacheBreakpoints 数组长度 >= 2（说明三段切了 2 次以上）。

---

## 验证 9 · O9 Process notify-on-exit

**目标**：后台进程退出时自动写 system message 到 thread + 工单进行中时唤醒 LLM。

**步骤**：

1. 派工单：
   - 标题：跑一个长命令
   - 描述：用 Bash tool 调 `sleep 5; echo done` 并设 `yield_ms=1000` 让它转后台，**不要主动 Process read，直接等**
2. 观察思维链流

**通过判定**：5 秒后 thread 自动出现一条 "⏱️ 后台进程 XXX 已结束 — 状态=completed exitCode=0" 消息，并且 LLM 被自动唤醒继续干（不是 LLM 主动 read 来的）。

---

## 验证 10 · O10 危险命令拦截

**目标**：黑名单命令被拦截，返回 exitCode=126 + BLOCKED 错误。

```bash
bun -e '
import { bashTool } from "@ai-emp/tools/file-tools";
const r = await bashTool.invoke({ command: "sudo rm -rf /tmp/anything" }, {requirementId:"t",employeeId:"t",threadId:"t",signal:new AbortController().signal});
console.log("exitCode:", r.exitCode);
console.log("stderr:", r.stderr.slice(0, 200));
'
```

**通过判定**：exitCode=126；stderr 含 `DANGEROUS_COMMAND_BLOCKED` 和"提权命令"。

---

## 验证 11 · O11 Trajectory dump

**目标**：导出工单完整 thread 为 OpenAI chat 格式。

```bash
# 取一个已完成的工单 id
REQID=$(sqlite3 ./.v2-verify-data/db.sqlite "SELECT id FROM requirements WHERE status='已完成' LIMIT 1;")

# JSON 美化
./ai-emp trajectory $REQID | head -50

# JSONL 流式
./ai-emp trajectory $REQID --jsonl | wc -l

# server endpoint
curl -s -H "Accept: application/x-ndjson" -H "Cookie: localhost_token=$(./ai-emp keychain get localhost-token)" \
  "http://localhost:7878/api/requirements/$REQID/trajectory" | head -10
```

**通过判定**：

- 输出含 `__meta__` 行 + 多条 `{role: ..., content: ...}` / `tool_calls: [...]`
- JSONL 行数 = thread messages 数 + 1（meta 行）

---

## 收尾

跑完所有验证后：

```bash
# 关掉 serve（Ctrl+C）
# 看测试统计有没有偏差
bun test 2>&1 | tail -5

# 如果发现 V2 任何 bug，记到 ALPHA_TASKS 新章节，按"日志先行"原则定位根因
# 完整日志：tail -200 ./.v2-verify-data/logs/<today>.log

# 清理临时数据
rm -rf ./.v2-verify-data /tmp/v2-test-java-project
unset AIEMP_DATA_DIR
```

---

## 验证结果记录模板

| 验证                     | 通过 | 备注 / 实际现象 |
| ------------------------ | ---- | --------------- |
| 1 · O2 Memory 闭环       | ⬜   |                 |
| 2 · O1 Skills 自演化     | ⬜   |                 |
| 3 · O3 Sub-agent 协作    | ⬜   |                 |
| 4 · O4 Checkpoint 回滚   | ⬜   |                 |
| 5 · O5 Cron 定时         | ⬜   |                 |
| 6 · O6 MCP client        | ⬜   |                 |
| 7 · O7 PTY               | ⬜   |                 |
| 8 · O8 Prompt cache      | ⬜   |                 |
| 9 · O9 Process notify    | ⬜   |                 |
| 10 · O10 危险命令拦截    | ⬜   |                 |
| 11 · O11 Trajectory dump | ⬜   |                 |

跑下来如果有 bug，把发现的现象 + reqId 贴给 Claude，按"日志先行"工程纪律定位根因。
