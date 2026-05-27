# AI 数字员工 — W0 技术 Spike 结果

> 在正式开工 α 阶段前，先验证 3 个高风险选型。
> 测试环境：macOS Darwin 24.3.0 / Apple Silicon arm64 / Bun 1.3.14
> 测试代码在 `spikes/` 目录，可随时复跑。

| Spike | 结果 | 关键发现 |
|---|---|---|
| 1. sqlite-vec | **PASS** | 必须用 brew sqlite；Bun 内置 sqlite 关了 extension loading |
| 2. transformers.js + bge-small-zh | **PASS** | 需要 sharp 的 darwin-arm64 native binary 手动到位 |
| 3. Anthropic + OpenAI SDK 流式 | **PASS** | 两 SDK 在 Bun 下正常；LLMChunk 抽象成立 |

**总体结论：技术栈选型保留不变**。所有 spike 均通过；需要把 §4 的 3 条工程注意点写进 `ai-emp init` 流程。

---

## Spike 1 — sqlite-vec

### 验证内容
- `bun:sqlite` + sqlite-vec 0.1.9 (vec0 虚拟表)
- 4 维测试向量 KNN 查询正确性
- 1000 条 512 维向量插入与 Top-10 查询性能

### 结果

```
✓ sqlite-vec 版本: v0.1.9
✓ 4D KNN 查询结果: 猫(0.00) → 幼猫(0.14)  排序正确
✓ 插入 1000 条 512 维向量耗时: 32ms
✓ 1000 条 512D KNN Top-10 耗时: 0ms（< 1ms）

=== PASS in 290ms ===
```

### 关键发现 + 工程注意点

**Bun 内置 SQLite 编译时关掉了 `enable_load_extension`**。直接 `db.loadExtension()` 会抛：

```
error: This build of sqlite3 does not support dynamic extension loading
```

**解决**：用 `Database.setCustomSQLite(path)` 切换到 brew 装的 sqlite：

```ts
Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
const db = new Database(':memory:');
sqliteVec.load(db);
```

### 落到 `ai-emp init` 的影响

- macOS：检测 `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` 是否存在；缺失则提示 `brew install sqlite`
- Linux：检测系统 libsqlite3；ubuntu 通常 `apt install libsqlite3-dev`（系统默认带 extension loading）
- Windows：检测 sqlite3.dll；未测，预留 spike

### 性能结论

512 维 × 1000 条规模 KNN < 1ms。V1.0 单用户场景预计单项目 conventions/facts/pitfalls/lessons 总条目 < 5000，性能远超需求。

---

## Spike 2 — transformers.js + bge-small-zh-v1.5

### 验证内容
- `@xenova/transformers` 2.17.2 在 Bun 下加载
- 从 HuggingFace 拉 `Xenova/bge-small-zh-v1.5`（~23MB）
- 4 条中文句子 embed
- 验证 512 维输出；验证同义/无关相似度区分

### 结果

```
✓ 模型加载耗时: 9924ms（首次含下载）
✓ 4 条文本 embed 耗时: 15ms
✓ 输出维度: [4, 512]
✓ 相似度矩阵:
  A-B (同义: 前端) = 0.7307
  C-D (同义: 天气) = 0.7111
  A-C (无关)       = 0.2577
  B-D (无关)       = 0.2199

模型大小：23M
=== PASS in 9940ms ===
```

同义句 vs 无关句的相似度差 ≈ 0.5，区分度优秀，足以支撑 RAG Top-K 检索。

### 关键发现 + 工程注意点

`@xenova/transformers` 依赖 `sharp@^0.32`（用于图像处理）。即使我们只做文本 embedding，`transformers.js` 主入口 `export * from './utils/image.js'` 会强制加载 sharp。

sharp 0.32 的 install 流程：
1. `node install/libvips` 下载 libvips prebuilt 二进制
2. `prebuild-install` 拉 sharp native `.node` 文件

**Bun 默认不跑 npm postinstall**（安全策略）。即使 `bun pm trust --all` 之后，sharp 的 install script 也不会再补跑（lifecycle 已经过期）。

**在用户机器上 sharp x64/arm64 不匹配的根因**：如果机器上同时有 x86_64 Node（Rosetta）和 arm64 Bun，sharp install 脚本以哪个 runtime 跑就装哪个平台的 native binary，导致跨平台错位。

**解决（在 spike 里采用的步骤）**：

```bash
# 1) bun add @xenova/transformers
# 2) 进 node_modules/sharp 用 bun 跑 install script（bun 是 arm64，会拉 arm64 libvips）
cd node_modules/sharp
bun install/libvips
npm_config_arch=arm64 npm_config_platform=darwin npx --yes prebuild-install --arch=arm64 --platform=darwin
```

### 工程对策（落到 `ai-emp init`）

两个方案择一：

**方案 A（推荐）**：在 init 阶段自动处理 sharp。逻辑：
1. 检测 `node_modules/sharp/build/Release/sharp-<platform>-<arch>.node` 是否存在
2. 不存在 → 自动跑 sharp 的 install/libvips + prebuild-install，指定当前 Bun runtime 的 arch
3. 验证：`require('sharp')` 成功 / 失败给出修复指引

**方案 B（评估中）**：完全绕开 sharp。fork 一个 `transformers.js` 轻量版，删掉 image 模块；或者改用 `fastembed-js`（仅 ONNX runtime，无图像依赖）。工作量大，但分发更干净。

> **W0 决策**：α 阶段采用方案 A（成本低）；β 阶段评估方案 B，视用户安装故障率决定是否替换。

### 性能结论

- 首次加载 9.9s（含 23MB 下载 + ONNX runtime init）
- 后续 embed 4 条文本 15ms（≈ 4ms/条）
- 模型缓存 23MB，符合 §4 `~/.ai-emp/models/` 预算

---

## Spike 3 — Anthropic + OpenAI SDK 流式

### 验证内容
- `@anthropic-ai/sdk@0.98.0` 和 `openai@6.39.0` 在 Bun 下：
  - import + 实例化 ✓
  - 自定义 `baseURL` 指向本地 mock SSE server ✓
  - SSE 流式消费，含 tool_use 帧的流式 args 拼接 ✓
- 统一 `LLMChunk` 抽象在两 SDK 上都能落地

### 结果

```
✓ Mock server: http://localhost:49478

── Anthropic SDK ─────────────────────────────────
  usage(in=50 out=0)
  text:"我想" text:"调用工具来确认"
  tool_start(ask_user)
  Δargs:"{"questions":"
  Δargs:"[{"question":"目标用户是开发者还是运营？"}],"
  Δargs:""trigger_reason":"decision_split"}"
  tool_stop args={"questions":[...],"trigger_reason":"decision_split"}
  usage(in=0 out=42)
  message_stop(tool_use)
✓ Anthropic SDK PASS

── OpenAI SDK ─────────────────────────────────
  text:"我想" text:"调用工具来确认"
  tool_start(ask_user)
  Δargs × 3
  tool_stop args={...完整 parse 成功...}
  message_stop(tool_calls)
✓ OpenAI SDK PASS

=== PASS in 153ms ===
```

### 关键发现

- **Bun 的 `fetch` + SSE 解析与两 SDK 完全兼容**，未发现任何特殊 polyfill 需求
- **两 SDK 的 SSE 解析模型差异**（已在 adapter 中归一化）：
  - Anthropic：每个事件都有 `event:` 行 + 结构化 type
  - OpenAI：纯 `data:` 行 + `[DONE]` 哨兵；`tool_calls` 增量通过 `index` 字段拼接
- **tool_use args 流式 partial_json**：分多个 chunk 到达；adapter 累积到 `content_block_stop` / `finish_reason='tool_calls'` 时 `JSON.parse`，全成功
- **`baseURL` 自定义工作正常**：OpenAI SDK 用 `baseURL: '.../v1'`，Anthropic SDK 用 `baseURL: '...'`（SDK 内部追加 `/v1/messages`）

### 落到 `packages/llm` 的设计验证

ARCHITECTURE §9.5 定义的 LLMChunk 抽象通过验证。Anthropic adapter 与 OpenAI adapter 都能产出同一份 chunk 流，下游 runtime 不需要感知 provider。

**LLMChunk 在 spike 中的最终形态**（与文档一致）：

```ts
type LLMChunk =
  | { type: 'thinking_delta' | 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsPartial: string }
  | { type: 'tool_use_stop';  id: string; name: string; args: unknown }
  | { type: 'message_stop';   reason: string }
  | { type: 'usage';          input: number; output: number }
  | { type: 'error';          error: unknown }
```

OpenAI SDK 没有原生 thinking_delta（仅 o1/o3 系列有 `delta.reasoning_content`，未在本 spike 验证）。在生产 adapter 中：DeepSeek-R1 / o1 风格的 thinking 字段映射到 `thinking_delta`；其他模型默认无此 chunk。

---

## 4. 综合工程注意点（移入 `ai-emp init` checklist）

1. **macOS / Linux 上检测 brew sqlite**（含 vec extension loading 能力）；缺失给出安装指引。
2. **首次启动自动处理 sharp 平台二进制**：检测 → 缺失则跑 sharp install/libvips + prebuild-install，按当前 Bun runtime arch 强制安装。
3. **嵌入模型预下载**：`ai-emp init` 强制把 bge-small-zh-v1.5 拉到 `~/.ai-emp/models/`，避免首次 `serve` 卡住 10s+。
4. **postinstall trust**：CI 与首次开发环境跑 `bun pm trust --all` 一次。

---

## 5. 风险消除情况（对比 ALPHA_TASKS §11）

| 风险 | 原评估 | spike 后 |
|---|---|---|
| transformers.js 在 Bun 下兼容问题 | 中 | **已消除** —— sharp install 流程标准化即可 |
| sqlite-vec 的 Bun native binding | 中 | **已消除** —— setCustomSQLite 切换 brew sqlite |
| LLM tool_use 流式语义差异 | 中 | **已消除** —— adapter 抽象成立 |

3 个高风险点已全部消除。**W0 可正式启动 T0.1**（monorepo 初始化）。

---

## 6. 复跑方式

```bash
cd spikes/01-sqlite-vec && bun install && bun run index.ts
cd spikes/02-transformers && bun install && bun run index.ts
cd spikes/03-llm-stream && bun install && bun run index.ts
```

Spike 1 失败 → 检查 brew sqlite 路径。
Spike 2 失败 → 检查 `node_modules/sharp/build/Release/sharp-darwin-arm64v8.node` 是否存在。
Spike 3 不依赖外部网络，必通过。

---

## 7. 下一步

→ 进入 ALPHA_TASKS W0：**T0.1 Monorepo 初始化**。
