# 本地端到端调试（浏览器 → server → DB 全流程自动化）

环境已装 **`@playwright/mcp@latest`** MCP 服务器。AI 可直接驱动真实 Chromium 跑 e2e，配合 `curl` 看 REST 响应、`sqlite3` 直查 DB，三条交叉证据定位问题，**不只是单测和肉眼看 UI**。

> **⚡ 工程纪律：日志先行**
>
> 排查问题第一步永远是 `tail ~/.ai-emp/logs/YYYY-MM-DD.log`，不是肉眼看 UI、不是改代码加 `console.log` 调试。如果某个现象的日志当前**不存在**或**不够细**（找不到根因 / 看不懂时间线），不要绕开它继续猜——**回头补埋点**，再跑一次复现，让日志能直接指认问题。每补一条日志后，必须更新本文档 §3「日志字段速查」与 §6「按现象查日志」的对应行。
> 这条规则比"快速绕过"重要：现在多花 5 分钟补一条日志，下次同类问题省 1 小时。

---

## 1. Playwright MCP 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `mcp__playwright__browser_navigate` | 打开 URL | `url` |
| `mcp__playwright__browser_snapshot` | DOM accessibility tree（**比截图更适合做 action 定位**） | — |
| `mcp__playwright__browser_take_screenshot` | 截 png/jpeg | `filename, type, fullPage` |
| `mcp__playwright__browser_click` | 点元素 | `target=eXX` 来自 snapshot |
| `mcp__playwright__browser_type` | 输入文字 | `target, text` |
| `mcp__playwright__browser_fill_form` | 批量填表单 | — |
| `mcp__playwright__browser_select_option` | 选 `<select>` | `target, values` |
| `mcp__playwright__browser_wait_for` | 等文本出现 / 消失 / 时间 | `text` / `textGone` / `time` |
| `mcp__playwright__browser_network_requests` | 看 fetch / XHR | `filter` (regex), `static=false` |
| `mcp__playwright__browser_console_messages` | 浏览器 console | `level=error\|warning\|info` |
| `mcp__playwright__browser_evaluate` | 跑任意 JS（拿 cookie / 调用 store） | `function` |
| `mcp__playwright__browser_close` | 关 tab | — |

> AI 调用时第一次见到工具会"工具尚未加载" — 用 `ToolSearch` 关键字 `select:mcp__playwright__browser_navigate,...` 一次加载多个 schema。

---

## 2. 标准 e2e 启动模板

```bash
# A. 启 server（前台或后台）
./ai-emp serve                                        # 前台，Ctrl+C 退出
./ai-emp serve > /tmp/aiemp.log 2>&1 &                # 后台，stdout 落文件
echo $! > /tmp/aiemp.pid                              # 记 PID

# B. 取 token（macOS / Linux 二选一）
TOKEN=$(security find-generic-password -s ai-emp -a localhost-token -w)   # macOS
TOKEN=$(secret-tool lookup service ai-emp account localhost-token)        # Linux

# C. curl 健康检查
curl -s http://localhost:7878/health
# {"ok":true,...}
```

然后 AI 用 playwright 自动登录：

```
mcp__playwright__browser_navigate(
  url="http://localhost:7878/auth?token=<TOKEN>&next=/%23/"
)
```

cookie 种上后，后续路由用 hash：

```
#/                       仪表盘
#/requirements           需求列表（按状态筛选）
#/projects               项目列表
#/projects/:id           项目详情（介绍/需求/规范/项目知识）
#/employees              员工列表
#/employees/:id          员工详情（信息/技能/记忆）
#/skills                 技能管理
#/new                    新建需求
#/req/:id                需求详情（澄清卡片 + 思维链 + 控制按钮）
```

---

## 3. 四条交叉证据（日志 + 三处状态）

调试时**同一时刻四处一起看**才能下结论：

```
┌─ server 日志 ─┐   ┌─ 浏览器 UI ───┐   ┌─ REST API ────┐   ┌─ SQLite DB ───┐
│ NDJSON tail   │   │ snapshot      │   │ curl 看响应   │   │ sqlite3 直查  │
│ scheduler     │   │ console_msgs  │   │ 看 status     │   │ runtime_state │
│ llm.call.*    │   │ network_reqs  │   │ 看 thread     │   │ messages      │
│ system_pause  │   │               │   │               │   │               │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

### 3.1 日志速查（先开这个）

```bash
# 看实时所有事件
tail -f ~/.ai-emp/logs/$(date -u +%Y-%m-%d).log | jq .

# 按 reqId 过滤
tail -f ~/.ai-emp/logs/$(date -u +%Y-%m-%d).log | jq 'select(.reqId=="<rid>")'

# 仅看 LLM 调用
tail -f ~/.ai-emp/logs/$(date -u +%Y-%m-%d).log | jq 'select(.scope|startswith("runtime.execute"))'

# 仅看错误
tail -f ~/.ai-emp/logs/$(date -u +%Y-%m-%d).log | jq 'select(.level=="error")'
```

控制日志详细度：

```bash
# .env 或 export
AIEMP_LOG_LEVEL=info     # 默认；记 audit（HTTP / 状态变更 / LLM start/end）
AIEMP_LOG_LEVEL=debug    # 加 SQL 全文 + LLM prompt 入参 + LLM 完整响应
AIEMP_LOG_LEVEL=warn     # 只看 warn/error
AIEMP_LOG_LEVEL=error    # 静音 audit
```

日志写到 stdout（开发期可见）+ 文件（`~/.ai-emp/logs/YYYY-MM-DD.log`，按 UTC 天滚动）；secret 字段（`apiKey/token/secret/password/authorization`）会自动脱敏成 `sk-ant…1234` 形态。

**示例**：用户点「继续」按钮，state 没变？

```bash
# 1. 浏览器视角
mcp__playwright__browser_network_requests(filter="/api/.*resume", static=false)
# → POST /resume returns 200/400/500

# 2. REST 端看状态
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:7878/api/requirements/<rid> | python3 -m json.tool
# → status / planJson

# 3. DB 端看运行时状态 + 消息
sqlite3 ~/.ai-emp/db.sqlite \
  "SELECT current_step, datetime(last_heartbeat_at/1000,'unixepoch','localtime') \
   FROM runtime_state WHERE requirement_id='<rid>';"

sqlite3 ~/.ai-emp/db.sqlite \
  "SELECT seq, role, type, substr(content_json,1,200) FROM messages \
   WHERE thread_id=(SELECT id FROM threads WHERE requirement_id='<rid>') \
   ORDER BY seq;"
```

如果三处一致（API 200 + DB 状态变 + heartbeat 在动 + messages 增长）→ 正常工作。
任何一处不动，就在那一层挖。

---

## 4. 完整全流程 e2e 模板（创建 → 派单 → 执行 → 验收）

```bash
TOKEN=$(security find-generic-password -s ai-emp -a localhost-token -w)
H="Authorization: Bearer $TOKEN"

# ── 1. 创建项目 ──
PID=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"name":"e2e测试项目","description":"自动化 e2e"}' \
  http://localhost:7878/api/projects | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# ── 2. 创建员工（用 .env 里有效的 key）──
EID=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" -d '{
  "name":"e2e员工","role":"测试","persona":"严格按 PRD 执行",
  "modelProvider":"openai-compat",
  "modelName":"env://AIEMP_OPENAI_MODEL",
  "modelKeyRef":"env://AIEMP_OPENAI_API_KEY"
}' http://localhost:7878/api/employees | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# ── 3. 创建需求 ──
RID=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  -d "{\"title\":\"e2e 测试\",\"description\":\"hello\",\"projectId\":\"$PID\"}" \
  http://localhost:7878/api/requirements | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# ── 4. 派单（skipClarification=true 直接进进行中）──
curl -s -X POST -H "$H" -H "Content-Type: application/json" \
  -d "{\"employeeId\":\"$EID\",\"skipClarification\":true}" \
  http://localhost:7878/api/requirements/$RID/assign
```

然后 AI 切 playwright 验证 UI：

```
mcp__playwright__browser_navigate(url="http://localhost:7878/#/req/<RID>")
mcp__playwright__browser_snapshot()          # 看状态徽章 + 按钮组
mcp__playwright__browser_wait_for(time=10)   # 等 LLM stream
mcp__playwright__browser_take_screenshot(filename="step1.png", type="png")
```

或断言关键文本出现：

```
mcp__playwright__browser_wait_for(text="emit_deliverable")     # 等交付
mcp__playwright__browser_wait_for(text="待验收")               # 等状态
```

---

## 4.5 日志字段速查（按 scope 分类）

每条 NDJSON 都有 `ts/level/scope/msg`，下面是各 scope 的扩展字段：

| scope | msg | level | 关键字段 | 何时看 |
|---|---|---|---|---|
| `server.http` | `req` | info | `method, path, status, ms, query` | HTTP 路由谁、返回多快、什么状态码 |
| `scheduler` | `enqueue` | info | `reqId, queueSize, active` | 派单后 scheduler 收到没 |
| `scheduler` | `enqueue.skip` | debug | `reqId, reason` | 同一 req 重复 enqueue（active/queued） |
| `scheduler` | `run.start` / `run.end` | info | `reqId, ms` | execute 一次跑了多久 |
| `scheduler` | `run.unexpected` | error | `reqId, error, stack, ms` | execute 抛了未捕获的错（应该排查） |
| `runtime.execute` | `llm.call.start` | info | `reqId, model, provider, systemBlocks, messages, tools, iteration` | LLM 调用启动元数据 |
| `runtime.execute` | `llm.call.request` | **debug** | `reqId, system, messages, toolNames` | 完整 prompt（含项目知识 RAG），调 prompt 时开 |
| `runtime.execute` | `llm.call.first_chunk` | info | `reqId, firstChunkMs, chunkType` | LLM 首 chunk 延迟（≥ 5s 说明卡） |
| `runtime.execute` | `llm.call.end` | info | `reqId, ms, firstChunkMs, chunks, decision, textLen` | 一次 LLM 调用总耗时 + 决策 |
| `runtime.execute` | `llm.call.response` | **debug** | `reqId, decision, textBuf` | LLM 返回的完整内容 |
| `runtime.execute` | `llm.call.error` | error | `reqId, error, ms, chunks` | LLM 抛错（401 / 网络） |
| `runtime.execute` | `system_pause` | warn | `reqId, from, reason, detail` | execute 主动 system_pause（含原因详情） |
| `storage.sql` | `query` | **debug** | `sql, params` | drizzle 全部 SQL（默认关，debug 才开） |

> **黑体 = `debug` 级别**：默认不写盘。要看 prompt / SQL / 完整响应时设 `AIEMP_LOG_LEVEL=debug` 后重启 server。

---

## 5. 收尾

```bash
# 停后台 server
kill $(cat /tmp/aiemp.pid) 2>/dev/null

# 清测试数据（可选）
sqlite3 ~/.ai-emp/db.sqlite \
  "DELETE FROM projects WHERE name LIKE 'e2e%'; \
   DELETE FROM employees WHERE name LIKE 'e2e%';"

# 关浏览器 tab
mcp__playwright__browser_close()
```

---

## 6. 按现象查日志（最常用）

| 现象 | 第一时间看的日志 | 可能根因 |
|---|---|---|
| 点继续按钮"无响应" | `server.http req POST /resume status=?` + `scheduler enqueue` + `runtime.execute llm.call.*` | 见下「LLM 链路一条龙」 |
| 思维链一直空 | `runtime.execute llm.call.start/first_chunk` 有没有 | 没 start → scheduler 没 enqueue；有 start 无 first_chunk → LLM stream 卡 |
| 状态一直"进行中"不动 | `scheduler run.start` 有 `run.end` 吗 | run 没结束 → execute 抛错被吞（看 `run.unexpected`）/ LLM stream 卡 |
| 派单后 status 转「已暂停」 | `runtime.execute system_pause reason=?` | `llm_error` → 看上一条 `llm.call.error`；`budget_*` → 看 budget |
| LLM 调用一直 timeout / 慢 | `llm.call.first_chunk firstChunkMs` | > 10s 多半是 prompt 太长 / 网络问题，开 debug 看 `llm.call.request` 字符数 |
| `/auth?token=` 401 | `server.http req GET /auth status=401` | token 不对，重新 `security find-generic-password ...` 取 |
| API 500 但前端没显示 | `server.http req ... status=500` + 路由对应的 scope error | 翻 stack 找根因；前端 Controls 的错误吞掉了 |
| SQL 查询慢 / 返回意外 | 设 `AIEMP_LOG_LEVEL=debug` 重启 → 看 `storage.sql query` | drizzle 全 SQL 含参 |

### LLM 链路一条龙（"点继续按钮无响应"标准排查）

```bash
RID="<requirement-id>"
LOG=~/.ai-emp/logs/$(date -u +%Y-%m-%d).log
jq "select(.reqId==\"$RID\") | [.ts,.scope,.msg,.status,.ms,.error] | @tsv" $LOG
```

健康链路看起来：

```
ts  server.http   req           POST /resume status=200 ms=12
ts  scheduler     enqueue       queueSize=1 active=0
ts  scheduler     run.start
ts  runtime.execute llm.call.start    systemBlocks=N messages=M
ts  runtime.execute llm.call.first_chunk firstChunkMs=850
ts  runtime.execute llm.call.end  ms=3200 decision=advance_step
ts  scheduler     run.end       ms=3400
```

如果链路断在某一行后没下一条 → 那一步就是问题点。**断在哪步，就回头补哪步的日志**（按 §"日志先行"）。

---

## 7. 常见 pitfall（已踩过）

| 现象 | 原因 / 解法 |
|---|---|
| `/` 返回纯文本 "ai-emp server is running" | Web dist 没 build；`cd packages/web && bun run build` |
| `/auth?token=...` 401 | token 错；从 keychain 重新取 |
| WS 连不上 | 浏览器 Console 看错；多半是 cookie 没种（先走 `/auth?token=`） |
| 改了 UI 浏览器看不到 | 没重 build；或缓存（Cmd+Shift+R 硬刷） |
| **改了 server 代码不生效** | server 进程没重启；`ps aux \| grep ai-emp serve` 找 PID 后 kill 再起 |
| **点继续按钮"无响应"** | 状态机其实正确转「进行中」，是 LLM stream 卡住或 401；先看 §6 LLM 链路一条龙 |
| `messages` 表 0 条但状态在变 | 早期 `systemPause` 没 append error message（`0a00156` 已修）；同时看日志 `system_pause` |
| OpenAI/Anthropic 401 | 员工 `modelKeyRef` 引用的 `env://AIEMP_*` 变量没在 `.env` 里设；或 modelProvider 协议错配（如 openai-compat 配 anthropic key） |
| `heartbeat` 长时间不更新 | LLM 在 stream 还没出 chunk；或 `composeFullPrompt` 阻塞（embedding 卡）；看 `llm.call.first_chunk` 是否出过 |

---

## 8. AI 自动化的注意事项

- **排查永远从日志开始**：先 `tail -f ~/.ai-emp/logs/$(date -u +%Y-%m-%d).log | jq .`，再开浏览器。
- **`browser_snapshot` 优先于 `browser_take_screenshot`**：snapshot 输出 yaml accessibility tree 含 `ref=eXX`，能直接喂给 `browser_click(target=eXX)`。screenshot 只能给人看。
- **wait_for 用 text 优于 time**：`wait_for(text="待验收")` 比 `wait_for(time=30)` 精确，也省时。
- **截图存在 `.playwright-mcp/`**（已在 `.gitignore`），文件名带 timestamp，不要 commit。
- **每次 e2e 跑完关 tab**：`browser_close()`，否则 Chromium 进程留着占内存。
- **不要把 playwright 视作 unit test 替代品**：fast feedback 还是 `bun test`，playwright 走真实浏览器只为验证渲染 / 交互 / WS 实时性。
- **失败时四件套**：日志 `tail+jq` + snapshot + `browser_console_messages(level="error")` + `browser_network_requests(static=false)`，通常 30 秒定位根因。
- **补日志即时更新文档**：在 `logger` 上加新 `msg`/`scope` 后，**同一 PR** 内更新 §4.5「日志字段速查」+ §6「按现象查日志」对应行；日志和文档不同步是技术债。
