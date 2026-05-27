# GETTING_STARTED

从零到完成第一个 AI 员工需求，预计 10 分钟。

> 仅支持 macOS（Apple Silicon）和 Linux x64。Windows 暂不支持（β 阶段补）。

---

## 1. 安装运行时

```bash
brew install bun sqlite
# brew sqlite 必装：Bun 内置 sqlite 关掉了 extension loading，
# sqlite-vec 无法加载（详见 SPIKE_RESULTS §1）。
```

## 2. 装依赖 + 修 sharp + 构建 Web UI

```bash
cd ai-emp
bun install --ignore-scripts
bun run scripts/postinstall.ts        # 修 sharp 平台二进制（Bun + Rosetta 兼容）
cd packages/web && bun run build && cd ../..
```

> Web UI 嵌入到 server 静态目录；不构建也能跑 CLI，但 `http://localhost:7878` 会是占位首页。

后续命令统一用项目根的 `./ai-emp` shell wrapper（已附带可执行权限），它转发到 `bun packages/cli/src/index.ts`。也可：

- `alias ai-emp="$(pwd)/ai-emp"` 全局短化
- 或 `bun build` 出二进制（见 §7）

## 3. 首次配置

### 3.1 可选：用 `.env` 自定义

复制 `.env.example` 为 `.env` 调端口、数据目录、Telegram 白名单等：

```bash
cp .env.example .env
# 编辑 .env：
#   AIEMP_PORT=7878
#   AIEMP_DATA_DIR=./.ai-emp-data    # 开发期可指向项目内
#   AIEMP_TG_CHAT_IDS=12345678,...
```

配置优先级：**.env > `~/.ai-emp/config.toml` > 内置默认**。Bun 启动时自动加载 `.env`，无需 dotenv 库。

> 凭证（LLM key / TG bot token）**不**写 .env，一律走 keychain，详见 §4。

### 3.2 init

```bash
./ai-emp init
```

会做三件事：

1. 创建数据目录（默认 `~/.ai-emp/`；若 `.env` 设了 `AIEMP_DATA_DIR` 则用之）
2. 生成 `localhost token` 写入系统 keychain（macOS Keychain / Linux libsecret）
3. 打印浏览器登录链接

## 4. 写入你的 LLM Key

两种方式择一：

### 方式 A · `.env`（开发推荐，最快）

把 key 直接写 `.env`，员工记录用 `env://` 协议引用：

```bash
echo "AIEMP_ANTHROPIC_API_KEY=sk-ant-XXX" >> .env
```

然后创建员工时，`modelKeyRef` 字段填 `env://AIEMP_ANTHROPIC_API_KEY` 即可。

### 方式 B · OS Keychain（生产推荐，secret 永不落文件）

任选一个 keychain 名，把 secret 写进去：

```bash
# 命令行直传
./ai-emp keychain set claude-main sk-ant-XXX

# 或环境变量（避免在 shell history 留痕）
AIEMP_SECRET="sk-ant-XXX" ./ai-emp keychain set claude-main
```

员工 `modelKeyRef` 填 `claude-main`（即 keychain 中的 key 名）。

> 切换方式只需改员工的 `modelKeyRef` 一个字段；前缀 `env://` 走 .env，其他走 keychain。

## 5. 启动服务

```bash
./ai-emp serve
```

输出类似：

```
✓ ai-emp serve 启动：http://localhost:7878
  浏览器登录链接: http://localhost:7878/auth?token=XXX
  Web UI 已挂载: /path/to/packages/web/dist
  Ctrl+C 退出
```

点开浏览器登录链接（带 token 的会自动种 cookie），就进入 UI。

## 6. 跑第一个需求

UI 操作流程：

1. **员工** Tab → 招聘新员工
   - 名字：小李
   - 岗位：前端工程师
   - 人设：简洁直接，喜欢类型安全
   - Provider：`anthropic`
   - 模型 ID：`claude-opus-4-7`
   - **modelKeyRef：填刚才 `keychain set` 用的名字**（如 `claude-main`）

2. **项目** Tab → 创建项目（介绍写两段，会被向量化）

3. **新建需求**
   - 标题：写一段 React 组件代码
   - 描述：实现一个分页器，TypeScript，Tailwind 样式
   - 项目：选刚建的
   - 员工：小李
   - **不勾选**「跳过澄清」（验证澄清前置）

4. 在需求详情页：
   - 会先进入「待澄清」状态
   - 你给员工 draftClarification（α 阶段需走 API 调用 / Replay 后再做；β 阶段会有按钮）
   - 答完后进入「进行中」
   - 看思维链流式滚动
   - 完成 → 验收 ✓

## 7. 单二进制（可选）

```bash
mkdir -p dist
bun build packages/cli/src/index.ts --compile --outfile dist/ai-emp
./dist/ai-emp --version
# 把 dist/ai-emp 拷到 PATH 任意位置即可全局使用
```

> 二进制约 63MB，单文件零依赖（不含嵌入模型；首次 serve 时按需下载到 `~/.ai-emp/models/`）。

---

## 常用命令

```bash
ai-emp init                          首次引导
ai-emp serve [--port 7878]           启动服务
ai-emp status                        列出活跃需求
ai-emp logs <req-id> [-f]            看思维链（-f 跟随）
ai-emp keychain set/get/delete <name>
ai-emp recover                       列出 in-flight 需求
ai-emp backup [path]                 DB 整盘备份
ai-emp models pull                   手动下载嵌入模型
ai-emp trajectory <req-id> [--jsonl] 导出工单 thread 为 OpenAI chat 格式 (V2)
```

---

## V2 新能力速览

V2 在 V1 基础上对照三方对比补齐了 11 项能力（详见 [PRD_V2](./docs/product/PRD_V2.md)）。下面是最常用的几项怎么用。

### 让员工"成长"：Skills 自演化 + memory 闭环

不需要配置。员工完成任务后会主动调 `emit_skill` 沉淀做法；被驳回时引擎自动写 `lesson`。下次同员工接到相似需求时 composer 自动 RAG 注入到 prompt。

驳回时**记得填原因** — Web UI 会弹窗收原因，原因越具体下次员工避免重蹈覆辙的概率越高。

### 子任务派给另一员工：Sub-agent

LLM 在 prompt 里看到 `spawn_employee` 工具说明，会按需调用。无需用户额外配置。仅顶层工单可用，子工单内不能再 spawn（防递归）。

### 工单不慎搞砸：Checkpoint 回滚

工单接单时自动建 baseline（git 项目用 HEAD sha，非 git 项目用 tar.gz）。Web UI 驳回时会询问"是否回滚到 baseline"。回滚前会先做 preRevert 备份到 `<dataDir>/checkpoints/<reqId>/preRevert-<ts>.tar.gz`。

### 定时工单（日报 / 巡检 / 周清理）

Web UI 新建需求时填「定时（可选）」字段：

```
every 5 minutes
every 1 hour
daily 09:00
weekly mon 09:00
```

填了之后这条工单是「模板」（不会被直接 dispatch），scheduler 每 60s 扫一次到期就创建副本派给指定员工执行。

### MCP server 接入：工具生态一夜十倍

在 `~/.ai-emp/mcp.json` 加 MCP server 配置：

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    }
  ]
}
```

`ai-emp serve` 启动时自动连接，工具自动注册到 ToolRegistry，命名 `mcp_<server>_<tool>` 默认对所有员工授权。

### 长命令 + tty 命令：pty 参数

LLM 调 Bash 时可传 `pty: true`，让 mvn / gradlew / 部分 npm install 等检测 isTTY 的命令正常输出（用 macOS/Linux 自带的 `script` 命令包装伪 tty，不需要 native binding）。

### 危险命令拦截

Bash tool 会自动拦截 `rm -rf /` / `sudo` / `curl|sh` / `dd` 写块设备 / `mkfs` / `chmod 777 ~` / `shutdown` 等高危命令，返回 exitCode=126 + `DANGEROUS_COMMAND_BLOCKED` 错误。LLM 会自然调 `ask_user` 拿用户授权后改命令。

如确实要让它跑（自负风险）：

```bash
AIEMP_ALLOW_DANGEROUS=1 ./ai-emp serve
```

### 工单 thread 导出（调试 / 备份）

```bash
# JSON 美化（默认）
./ai-emp trajectory <req-id>

# JSONL（每行一条 message，便于流式处理）
./ai-emp trajectory <req-id> --jsonl > trajectory.jsonl
```

返回 OpenAI chat 格式（system / user / assistant / tool messages + tool_calls 数组）。

---

## 排错

| 问题                                                               | 解决                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `This build of sqlite3 does not support dynamic extension loading` | 装 brew sqlite：`brew install sqlite`                 |
| `Cannot find module '../build/Release/sharp-darwin-arm64v8.node'`  | 跑 `bun run scripts/postinstall.ts`                   |
| Rollup native module 错（仅 web build 时）                         | 用 `bun --bun vite build`（已在 web/package.json 里） |
| 401 unauthorized 浏览器访问                                        | 用 `/auth?token=XXX` 链接登录而不是直接打首页         |
| 启动时提示有 in-flight 需求                                        | `ai-emp recover` 查看，按需 cancel / resume           |

---

## 数据位置

| 路径                                  | 用途                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `~/.ai-emp/db.sqlite`                 | 所有数据（WAL 模式）                                 |
| `~/.ai-emp/config.toml`               | 端口、token 引用、Telegram 配置、默认 budget         |
| `~/.ai-emp/mcp.json`                  | V2 O6 MCP server 配置（servers 数组）                |
| 项目根 `.env`                         | 开发期 / 容器化覆盖配置（最高优先级）                |
| `~/.ai-emp/models/`                   | bge-small-zh-v1.5 嵌入模型权重                       |
| `~/.ai-emp/attachments/<req-id>/`     | 需求附件与交付物                                     |
| `~/.ai-emp/checkpoints/<req-id>/`     | V2 O4 工单快照（baseline + manual + preRevert 备份） |
| `~/.ai-emp/logs/YYYY-MM-DD.log`       | 服务日志                                             |
| `~/.ai-emp/backups/`                  | `ai-emp backup` 落点                                 |
| macOS Keychain / Linux Secret Service | LLM Key / TG token / localhost token                 |

DB 文件可以直接 `cp` 备份；keychain 凭证需要在新机器上重新 `keychain set`。
