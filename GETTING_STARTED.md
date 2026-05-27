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
ai-emp init                    首次引导
ai-emp serve [--port 7878]     启动服务
ai-emp status                  列出活跃需求
ai-emp logs <req-id> [-f]      看思维链（-f 跟随）
ai-emp keychain set/get/delete <name>
ai-emp recover                 列出 in-flight 需求
ai-emp backup [path]           DB 整盘备份
ai-emp models pull             手动下载嵌入模型
```

---

## 排错

| 问题 | 解决 |
|---|---|
| `This build of sqlite3 does not support dynamic extension loading` | 装 brew sqlite：`brew install sqlite` |
| `Cannot find module '../build/Release/sharp-darwin-arm64v8.node'` | 跑 `bun run scripts/postinstall.ts` |
| Rollup native module 错（仅 web build 时） | 用 `bun --bun vite build`（已在 web/package.json 里） |
| 401 unauthorized 浏览器访问 | 用 `/auth?token=XXX` 链接登录而不是直接打首页 |
| 启动时提示有 in-flight 需求 | `ai-emp recover` 查看，按需 cancel / resume |

---

## 数据位置

| 路径 | 用途 |
|---|---|
| `~/.ai-emp/db.sqlite` | 所有数据（WAL 模式） |
| `~/.ai-emp/config.toml` | 端口、token 引用、Telegram 配置、默认 budget |
| 项目根 `.env` | 开发期 / 容器化覆盖配置（最高优先级） |
| `~/.ai-emp/models/` | bge-small-zh-v1.5 嵌入模型权重 |
| `~/.ai-emp/attachments/<req-id>/` | 需求附件与交付物 |
| `~/.ai-emp/logs/YYYY-MM-DD.log` | 服务日志 |
| `~/.ai-emp/backups/` | `ai-emp backup` 落点 |
| macOS Keychain / Linux Secret Service | LLM Key / TG token / localhost token |

DB 文件可以直接 `cp` 备份；keychain 凭证需要在新机器上重新 `keychain set`。
