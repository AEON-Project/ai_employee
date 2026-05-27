# CHANGELOG

每次完成开发后必须更新本文件（按 [docs/ai/WORKFLOW.md §C](../ai/WORKFLOW.md#c-完成开发) 约定）。

格式：

```markdown
| <commit hash> | <一句话内容> | <对应文档链接> |
```

跨多个 commit 的工作单元用 `abc1234..def5678` 范围标记。

---

## V1.0 引擎验证版

| commit | 内容 | 对应文档 |
|---|---|---|
| `b584234` | initial: V1.0 引擎验证版（α + β + W0–W4 共 45 工单一次性落地） | [ALPHA_TASKS §0](./ALPHA_TASKS.md) |
| `824382c` | docs(alpha-tasks): 标记开发状态 | — |
| `f3aefa7` | docs(readme): 重写 README | — |
| `11b812b` | fix(cli): `backup` 命令父目录缺失 | — |
| `65ff4ae` | feat(config): 支持 `.env` 配置（Bun 自动加载，三层覆盖） | [README §3.1](../../README.md) |
| `1900da7` | feat(credentials): `env://` 引用协议（modelKeyRef） | — |
| `1ad538c` | feat(env-ref): `env://` 扩展到 model/baseUrl 字段 | `.env.example` |
| `527153e` | feat(cli): `./ai-emp` shell wrapper | [README](../../README.md) |
| `aee5b93` | style: prettier 自动换行 config.ts 长行 | — |
| `67581e6` | docs(readme): 快速开始改走 .env 路径 | — |
| `f69a6f6` | feat(cli/init): 下一步提示上下文感知 | — |
| `663d4cc` | feat(seed): 5 员工角色（后端/前端/测试/产品/UI 设计）+ 输出清晰化 | — |
| `dcf573b` | fix(seed): `--reset` 真删（不是 archive） | — |
| `f0d8f43` | docs(claude): 加 CLAUDE.md | [CLAUDE.md](../../CLAUDE.md) |
| `6ade242` | docs(claude): CLAUDE.md 加产品需求 + 进度状态 + AI 协作工作流 | [CLAUDE.md](../../CLAUDE.md) |
| `d644706` | docs(claude): 回填 6ade242（吃自己狗粮验证闭环） | — |
| `11a36ec` | docs(claude): 加"本地端到端调试（浏览器自动化）"段 — browser_navigate MCP | [docs/ai/DEBUGGING.md](../ai/DEBUGGING.md) |
| `48631d4` | docs(claude): 回填 d644706 + 11a36ec 到"已交付"表 | — |
| `964f6ac` | docs: 按文件夹分类整理文档 + 拆分 CLAUDE.md（新增 docs/{product,architecture,progress,ai}/） | 本文件 + [WORKFLOW](../ai/WORKFLOW.md) + [DEBUGGING](../ai/DEBUGGING.md) + [CONVENTIONS](../architecture/CONVENTIONS.md) |
| `fb888a3` | feat(web): 补员工/项目/技能详情页 — 填齐 α 阶段 Web UI 占位（员工技能挂载多选+记忆 Tab / 项目规范+知识 CRUD / 技能编辑器）；后端补 PATCH/DELETE skills、PATCH employees、POST memory items | [PRD V1 §M1-M3](../product/PRD_V1.md#m2-员工能力载体) |
| `0f93758` | fix(server): HTTP 派单后调 scheduler.enqueue — 修复 executeRequirement 永不触发（α 阶段 server 模式 P0 bug；e2e 测试一直绕过 server 直调 execute 所以未覆盖） | — |
| `9992f8c` | feat(web): 补「需求」总列表页 + 项目详情页「需求」Tab（顶栏 #/requirements 表格视图+9 状态筛选；后端 GET /requirements 支持 status/projectId/all 组合查询） | [PRD V1 §M4](../product/PRD_V1.md#m4-需求任务入口) |
| `0a00156` | fix(ux): LLM 错误/system_pause 在 UI 思维链可见 + Controls 加 busy/err 显示（"点击继续无响应"根因：systemPause 没 append error message + Controls 吞错误） | — |
| `6cf9253` | docs(debugging): 更新 playwright MCP 全流程测试模板（工具速查/e2e 启动/三条交叉证据/常见 pitfall） | [DEBUGGING.md](../ai/DEBUGGING.md) |
| `4fbea13` | feat(logging): 结构化 NDJSON 日志体系（packages/domain/logger + 埋点 HTTP/scheduler/LLM/SQL + 脱敏 + 「日志先行」工程纪律） | [DEBUGGING.md §3-6](../ai/DEBUGGING.md) |
| `5b6b3f8` | fix(runtime): ask_user args 健壮化 + dispatch 抛错走 systemPause 不冒泡（日志一行定位 args.questions.map TypeError；状态从卡死「进行中」→ 优雅落「已暂停」可恢复） | — |
| `c1e1db4` | docs(debugging): e2e 自动化测试加「杀旧 server 启新进程」流程（lsof -ti :7878 -sTCP:LISTEN 比 pgrep 可靠 + EADDRINUSE pitfall） | [DEBUGGING.md §2](../ai/DEBUGGING.md) |
| `484b92b` | fix(prompt): 给 LLM 暴露 ask_user 等系统 tool 的真实 JSON Schema（ToolDef 加 inputJsonSchema；composer prompt 加结构化提示）— playwright 验证：gpt-4o 正确产出 trigger_reason=missing_info + 2 个 question 数组 → 状态进「等待回答」+ 澄清卡片渲染 | — |
| `412e1ab` | fix(runtime): streaming delta 合并为单条 message（修复思维链「逐字竖排」bug）— handleChunk 改用 StreamingBuffer，按 thinking/text 类型累积，类型切换 / tool_use_stop / message_stop / error / 循环末尾兜底时一次性 flush；中文 provider 把流切到 1–3 字粒度时不再每字一条 | — |
| `09bc043` | feat(web/thread): 思维链 seq 倒序展示（最新在顶）+ 滚动到底 sentinel 触发分页加载更早历史 + 每条消息加 HH:MM:SS；server `?limit=N[&beforeSeq=X]` 分页接口 + storage `MessagesRepo.pageByThread`（hasMore via limit+1） | — |
| `6555d2d` | fix(runtime): advance_step 标 plan.step.status=done + 累积 historySummary（不再清空）+ resumeRequirement 复位 budgetUsed — 修复 LLM 反复 update_plan / 空 advance_step 直到撞 budget_iterations 的死循环（日志定位 reqId 86fc597a 30 轮内 4 次 update_plan + 17 次 textLen=0 的 advance_step）；3 个回归测试 | — |
| `eb5bd5e` | fix(prompt+runtime): composer 注入 currentStep + historySummary（注释 §13/§14 早就写了但实现遗漏，LLM 一直看不到自己干了啥）+ advance_step 的 currentStep 严格单调递增（max(ctx+1, completedIdx+1)，防 LLM 反复报旧 step_idx 卡步号）— playwright E2E 闭环：重启后 resume → 自动答澄清 → 5 步 plan 全 done → status=待验收（iter 27/30 cap，deliverable 已写）| — |
| `d9099e9` | feat(tools): V1.1 file/shell tool 集 — Read / Write / Edit / Glob / Grep / Bash 完整本地权限 — 单用户本地引擎决策：不做路径白名单，等同于运行 server 的用户的终端权限。工程保留：输出截断 50000 字符 / Bash 超时 + AbortController SIGKILL / NDJSON 审计日志 (scope=tools.file)。E2E: 让员工真改 /Users/yuanyong/work/lskj/virtual_card_api/CardChannelTypeEnum.java 加 NEW_BANK_ALCHEMY 枚举值 6 轮 LLM 调用完成。18 个单测 + 211 总测全过 | — |
| `58395e2` | fix(prompt+runtime): V1.2 防 LLM 路径幻觉 + 工具失败假装完成 — (1) composer 加文件 / Shell 工具使用规则（Edit 前必须 Glob/Grep 探索；ok=false 时严禁 advance_step）；(2) runtime advance_step dispatch 前扫最近 tool_result，ok=false 则硬阻止（不更新 plan/step/history，写 system/error 让 LLM 下轮看到）。E2E 第 4 次派发 5 步 plan 11 轮跑通到「待验收」（blocked=0，LLM 改用 Glob/Grep 探索后无 ENOENT 失败）—— 但暴露 V1.3 候选：LLM 0 次 Edit 就 emit_deliverable 谎报"已修改 4 文件" | — |
| `d1cd040` | fix(runtime+prompt): V1.3 emit_deliverable 防"谎报完成" — extractClaimedFilePaths(text) regex 抓 30+ 后缀的 file path 候选；collectEditedPathsFromThread() 扫 tool_result 收集 Write/Edit ok=true 的 value.path；任何 claimed 路径找不到 Edit/Write 记录 → 拒绝交付 + 写 system/error。composer 加规则"summary 只能写真改过的文件，引擎会对账"。runtime.test 加 2 用例：声称无证据 → 拒绝 / 有 ok=true 的 Edit 记录 → 放行。E2E 第 5 次派发 gpt-4o 因 OpenAI TPM 30k 限流 + Edit 多次 old_string 多匹配冲突未跑通，但 V1.2 advance_step.blocked 触发 2 次拦下"工具失败后假装推进"。232 pass。| — |
| `c4ad1f9` | fix(runtime): V1.4 LLM 调用临时错误自动退避重试（429/5xx/网络），不再立即 system_pause — 任何 LLM 调用错误就 system_pause 让人接管违反"AI 数字员工"语义。execute.ts 加 analyzeLlmError(msg)（识别 429 + 提取 retry-after / 5xx / ETIMEDOUT / ECONNRESET / fetch failed），retryable=true 时 log.warn('llm.retry') + sleep(delay) + continue 重进 for loop；ExecuteOptions.maxLlmRetries=5 默认，成功一轮后归零；try/catch 整个 for-await stream 覆盖 provider 直接抛错路径。3 个回归用例：429 退避 → 待验收 / 401 永久错误 → 暂停 / 重试用完 → 暂停。235 pass。| — |
| `0d45d1a` | feat(tools): V1.1 简化为纯 Bash 透传 — 删除 Read/Write/Edit/Glob/Grep 5 个包装工具。用户语义澄清：要的是"大模型调本地命令行执行任务、引擎做透传"，包装工具反而限制 LLM 灵活性（Edit 不会用 replace_all 自救、Glob 1000 限制等）。FILE_TOOLS 只剩 Bash 一个；composer 协作规则改"cat/sed/find/grep/brew/mvn 自由组合"。V1.3 对账配套改：dispatch default 分支增 append type='tool_call' 落 Bash command 文本，collectModifiedPathsFromBashHistory 扫所有 ok=true+exitCode=0 的 Bash 命令文本提路径 token 与 claimed path 对账。file-tools.test 10 用例（含 cat/sed/find/grep 场景）；229 pass。| — |
| `ee728f8` | revert(runtime): 拆 V1.3 emit_deliverable 对账（借鉴 /Users/yuanyong/work/aeon/OpenClaw 设计） — 员工提交工作直接进「待验收」，由用户验收时看 git diff 鉴别真假。删除 execute.ts unverified 拦截 + 删除两个 helper（extractClaimedFilePaths / collectModifiedPathsFromBashHistory）+ composer prompt 改"如实汇报，谎报会被 reject"。删除 5 个 V1.3 对账用例，加 1 新用例验证 emit 不拦截。E2E 第 6 次派 25 轮 LLM 调用直接到「待验收」（之前 V1.3 拦着撞 maxLoops=50 死循环）；保留 V1.2 advance_step.blocked + V1.4 LLM retry；228 pass。| — |
