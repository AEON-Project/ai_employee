# 本地端到端调试（浏览器 → server → DB 全流程自动化）

环境已装 **`@playwright/mcp@latest`** MCP 服务器。AI 可直接驱动真实 Chromium 跑 e2e，配合 `curl` 看 REST 响应、`sqlite3` 直查 DB，三条交叉证据定位问题，**不只是单测和肉眼看 UI**。

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

## 3. 三条交叉证据

调试时**同一时刻三处一起看**才能下结论：

```
┌─ 浏览器 UI ───┐   ┌─ REST API ────┐   ┌─ SQLite DB ───┐
│ snapshot      │   │ curl 看响应   │   │ sqlite3 直查  │
│ console_msgs  │   │ 看 status     │   │ runtime_state │
│ network_reqs  │   │ 看 thread     │   │ messages      │
└───────────────┘   └───────────────┘   └───────────────┘
```

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

## 6. 常见 pitfall（已踩过）

| 现象 | 原因 / 解法 |
|---|---|
| `/` 返回纯文本 "ai-emp server is running" | Web dist 没 build；`cd packages/web && bun run build` |
| `/auth?token=...` 401 | token 错；从 keychain 重新取 |
| WS 连不上 | 浏览器 Console 看错；多半是 cookie 没种（先走 `/auth?token=`） |
| 改了 UI 浏览器看不到 | 没重 build；或缓存（Cmd+Shift+R 硬刷） |
| **改了 server 代码不生效** | server 进程没重启；`ps aux \| grep ai-emp serve` 找 PID 后 kill 再起 |
| **点继续按钮"无响应"** | 状态机其实正确转「进行中」，是 LLM stream 卡住或 401；按 §3 三处交叉看 |
| `messages` 表 0 条但状态在变 | 早期 `systemPause` 没 append error message（`0a00156` 已修） |
| OpenAI/Anthropic 401 | 员工 `modelKeyRef` 引用的 `env://AIEMP_*` 变量没在 `.env` 里设；或 modelProvider 协议错配（如 openai-compat 配 anthropic key） |
| `heartbeat` 长时间不更新 | LLM 在 stream 还没出 chunk；或 `composeFullPrompt` 阻塞（embedding 卡） |

---

## 7. AI 自动化的注意事项

- **`browser_snapshot` 优先于 `browser_take_screenshot`**：snapshot 输出 yaml accessibility tree 含 `ref=eXX`，能直接喂给 `browser_click(target=eXX)`。screenshot 只能给人看。
- **wait_for 用 text 优于 time**：`wait_for(text="待验收")` 比 `wait_for(time=30)` 精确，也省时。
- **截图存在 `.playwright-mcp/`**（已在 `.gitignore`），文件名带 timestamp，不要 commit。
- **每次 e2e 跑完关 tab**：`browser_close()`，否则 Chromium 进程留着占内存。
- **不要把 playwright 视作 unit test 替代品**：fast feedback 还是 `bun test`，playwright 走真实浏览器只为验证渲染 / 交互 / WS 实时性。
- **失败时三件套**：snapshot + `browser_console_messages(level="error")` + `browser_network_requests(static=false)`，配合 server 端 `tail -f /tmp/aiemp.log` 通常 30 秒定位根因。
