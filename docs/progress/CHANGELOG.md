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
