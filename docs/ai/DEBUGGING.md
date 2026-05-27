# 本地端到端调试（浏览器自动化）

环境已配置 **`browser_navigate`** 等浏览器自动化 MCP 工具。AI 可直接打开 `http://localhost:7878` 验证真实渲染，不只是依赖单测和 curl。

---

## 典型调试动作

```bash
# 1. 启动 server（前台 / 后台）
./ai-emp serve                                        # 前台，Ctrl+C 退出
./ai-emp serve > /tmp/aiemp.log 2>&1 &                # 后台，记 PID

# 2. 取 token（macOS）
security find-generic-password -a localhost-token -s ai-emp -w
# Linux：secret-tool lookup service ai-emp account localhost-token

# 3. 自动登录种 cookie
browser_navigate("http://localhost:7878/auth?token=<TOKEN>&next=/")

# 4. 后续路由用 hash
#    #/                       仪表
#    #/projects               项目列表
#    #/employees              员工列表
#    #/new                    新建需求
#    #/req/<requirement-id>   需求详情（澄清卡片 + 思维链 + 控制按钮）
```

---

## 验收清单（每次改 UI / WS / API 前后必跑）

| 场景 | 验证点 |
|---|---|
| 项目列表 / 员工列表 | navigate `#/projects` / `#/employees`，截图看条目 + 状态徽章 |
| 新建需求 | navigate `#/new`，填表单 → 跳详情页 |
| 思维链流式 | navigate `#/req/<id>`，看 WebSocket 推送下 thinking/text 逐步 append |
| 澄清卡片 | 派需求后看 amber 卡片渲染 + 答完澄清 → 状态变 "进行中" |
| 控制按钮 | 暂停 / 继续 / 强制结束 / 验收 / 驳回 按钮各自触发 REST + 状态机转移 |
| 验收面板 | 状态进 "待验收" 时 purple 面板出现 |

---

## 提示

- **改 UI 后必须 `cd packages/web && bun run build`**：Web UI dist 嵌入到 server 静态资源；不重 build 看不到改动
- **dev 模式联调**：`packages/web` 内跑 `bun run dev`（Vite 起 5173 端口，proxy `/api` `/ws` 到 7878）
- 浏览器自动化**不替代** [e2e 单测](../../packages/server/src/e2e.test.ts)，后者跑得快、CI 友好；浏览器 navigate 是"我改的 UI 在真实浏览器里到底什么样"的最终视觉验证
- 调试完**必须** `kill` 后台 server，避免端口占用：

  ```bash
  ps aux | grep "ai-emp serve" | grep -v grep
  kill <PID>
  ```

---

## 常见排错

| 现象 | 原因 / 解法 |
|---|---|
| `/` 返回纯文本 "ai-emp server is running" | Web dist 没 build；`cd packages/web && bun run build` |
| `/auth?token=...` 一直 401 | token 错；从 keychain 取最新值 |
| WS 连不上 | 检查浏览器 Console；可能 token cookie 未种好（先走 `/auth?token=`） |
| 改了 UI 浏览器看不到 | 没重 build；或浏览器缓存（Cmd+Shift+R 硬刷） |
| 改了 server 路由要重启 | `kill <PID>` 后重新 `./ai-emp serve` |
