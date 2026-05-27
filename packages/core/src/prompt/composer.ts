/**
 * PromptComposer — 按 ARCHITECTURE §11.1 顺序拼装 system + chat history。
 *
 * 顺序（硬约束在前，软提示在后）：
 *   [persona]
 *   [memory.style]
 *   [main skill prompt_template]
 *   [project.conventions WHERE enforcement='required']   全量
 *   [project.conventions WHERE enforcement='recommended'] RAG Top-K   (α 暂全量)
 *   [project.facts]                                       RAG Top-K
 *   [project.pitfalls]                                    RAG Top-K
 *   [employee.lessons]                                    RAG Top-K
 *   [runtime: plan + currentStep]
 *   [runtime: historySummary]
 *   [runtime: recentMessages last N]                      作为 chat history
 *   [requirement.description]                             作为首条 user
 */

import type { Repos } from '@ai-emp/storage'
import type { MemoryServices, RecallHit } from '../memory/index.js'
import { recall } from '../memory/index.js'

export interface ComposeInput {
  reqId: string
  employeeId: string
  threadId: string
  /** 提供 memory 服务则启用 RAG；不传则跳过（α 单测时跳过） */
  memory?: MemoryServices
  recentMessageCount?: number
  recallK?: number
}

export interface ComposedPrompt {
  system: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  tokensEstimate: number
  /**
   * Prompt cache 断点（system 字符串中的字节偏移）。
   * 顺序：硬约束部分（persona/style/skill/required conventions）的尾部 ——
   *   这之前的内容稳定，可让 LLM provider 缓存（Anthropic / OpenAI 都支持）。
   * 缺省为空数组（不启用 cache）。
   */
  cacheBreakpoints: number[]
  debug: {
    recalledFacts: RecallHit[]
    recalledPitfalls: RecallHit[]
    recalledLessons: RecallHit[]
    recalledSkills: RecallHit[]
    requiredConventionCount: number
    recommendedConventionCount: number
  }
}

const DEFAULT_RECENT = 10
const DEFAULT_RECALL_K = 5

export async function compose(repos: Repos, input: ComposeInput): Promise<ComposedPrompt> {
  const req = repos.requirements.findById(input.reqId)
  if (!req) throw new Error(`requirement not found: ${input.reqId}`)
  const emp = repos.employees.findById(input.employeeId)
  if (!emp) throw new Error(`employee not found: ${input.employeeId}`)

  const skills = repos.skills.listForEmployee(emp.id)
  const main = skills[0]?.skill
  const others = skills.slice(1).map((s) => s.skill)

  // ① 硬约束部分
  const parts: string[] = []
  parts.push('# 你是一个 AI 员工', `## 角色\n${emp.role}`)
  if (emp.persona) parts.push(`## 人设\n${emp.persona}`)
  if (emp.memoryStyleText) parts.push(`## 工作风格（系统沉淀）\n${emp.memoryStyleText}`)
  if (main) {
    parts.push(`## 主技能：${main.name}\n${main.promptTemplate || main.description}`)
  }
  if (others.length > 0) {
    parts.push(
      `## 额外能力（按需引用）\n${others.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`,
    )
  }

  // ② 项目规范
  let requiredCount = 0
  let recommendedCount = 0
  if (req.projectId) {
    const conv = repos.conventions.listByProject(req.projectId)
    const required = conv.filter((c) => c.enforcement === 'required')
    const recommended = conv.filter((c) => c.enforcement === 'recommended')
    requiredCount = required.length
    recommendedCount = recommended.length
    if (required.length > 0) {
      parts.push(
        `## 项目规范（required，必须遵守）\n${required.map((c) => `- ${c.content}`).join('\n')}`,
      )
    }
    // α: recommended 也全量（避免再做一次 RAG）
    if (recommended.length > 0) {
      parts.push(
        `## 项目规范（recommended，相关时参考）\n${recommended.map((c) => `- ${c.content}`).join('\n')}`,
      )
    }
  }

  // ⚓ cache breakpoint — 到此为止的内容稳定，可缓存
  //   后续 RAG / plan / chat 都按需求变化，不能进 cache
  const cacheBreakpointBytes = parts.reduce((sum, p) => sum + p.length, 0) + parts.length * 2 // 加上 \n\n 分隔

  // ③ RAG：facts / pitfalls / lessons / skills
  let facts: RecallHit[] = []
  let pitfalls: RecallHit[] = []
  let lessons: RecallHit[] = []
  let skills_recall: RecallHit[] = []
  if (input.memory) {
    const k = input.recallK ?? DEFAULT_RECALL_K
    const query = `${req.title}\n${req.description}`
    if (req.projectId) {
      facts = await recall(input.memory, {
        scope: 'project',
        scopeId: req.projectId,
        kinds: ['fact'],
        query,
        k,
      })
      pitfalls = await recall(input.memory, {
        scope: 'project',
        scopeId: req.projectId,
        kinds: ['pitfall'],
        query,
        k,
      })
    }
    lessons = await recall(input.memory, {
      scope: 'employee',
      scopeId: emp.id,
      kinds: ['lesson'],
      query,
      k,
    })
    // V2 O1 Skills 自演化：注入员工自己沉淀的可复用做法套路
    skills_recall = await recall(input.memory, {
      scope: 'employee',
      scopeId: emp.id,
      kinds: ['skill'],
      query,
      k,
    })
  }
  if (facts.length > 0) {
    parts.push(
      `## 项目知识（facts，按相关性 Top-K）\n${facts.map((f) => `- ${f.content}`).join('\n')}`,
    )
  }
  if (pitfalls.length > 0) {
    parts.push(
      `## 项目踩坑（pitfalls，避免重蹈）\n${pitfalls.map((p) => `- ${p.content}`).join('\n')}`,
    )
  }
  if (lessons.length > 0) {
    parts.push(`## 个人教训（lessons）\n${lessons.map((l) => `- ${l.content}`).join('\n')}`)
  }
  if (skills_recall.length > 0) {
    parts.push(
      [
        '## 你过往沉淀的可复用 Skills（按相关性 Top-K）',
        '⭐ 若以下某个 skill 与当前任务套路匹配，**优先按其步骤执行**，不要从零摸索。',
        '',
        skills_recall.map((s) => s.content).join('\n\n---\n\n'),
      ].join('\n'),
    )
  }

  // ④ Plan / 当前步骤
  if (req.planJson) {
    parts.push(
      `## 当前 Plan\n${req.planJson.steps.map((s) => `  ${s.idx}. [${s.status}] ${s.text}`).join('\n')}`,
    )
  }

  // ④a 运行时状态：currentStep + historySummary
  //   注释 §13/§14 早就要求注入，但实现遗漏 → LLM 看不到自己干了啥，反复在同一 step 内
  //   advance_step / ask_user 死循环。这块是切断 LLM 重复输出的关键上下文。
  const rs = repos.runtimeState.find(input.reqId)
  if (rs) {
    const totalSteps = req.planJson?.steps.length ?? 0
    const stepHint =
      totalSteps > 0
        ? `共 ${totalSteps} 步，当前应该推进 step ${rs.currentStep}${rs.currentStep >= totalSteps ? '（已超出 plan 范围 → 应该 emit_deliverable）' : ''}`
        : `当前步索引 ${rs.currentStep}`
    parts.push(`## 当前进度\n- ${stepHint}`)
    if (rs.historySummary && rs.historySummary.trim().length > 0) {
      parts.push(
        [
          '## 已完成步骤摘要（不要重复总结已完成的 step）',
          rs.historySummary.trim(),
          '',
          '⚠️ 上面已经记录了之前完成的 step。**不要**再对同一个 step 调 advance_step。',
          '推进到下一 step 应该 `advance_step({ step_idx: <下一未完成 idx>, summary: "本步成果" })`。',
          '若所有 plan step 都 done，直接 `emit_deliverable`。',
        ].join('\n'),
      )
    }
  }

  // ⑤ 协作规则
  parts.push(
    [
      '## 协作规则',
      '- 你可以调用以下系统工具：',
      '  - `advance_step`：完成 plan 中一步后调用',
      '  - `update_plan`：当需要调整计划时调用',
      '  - `emit_deliverable`：交付最终产物，进入 待验收 状态',
      '  - `emit_skill`：完成任务后，若识别出"这是一类可复用的解决套路"，沉淀到长期记忆；',
      '    未来同员工接到相似需求时引擎会自动注入。例：「Java enum 新增值」「修复 React useEffect 死循环」。',
      '    一次性具体修改（"把 main.ts 第 23 行的 foo 改成 bar"）不要 emit_skill。可选，不强制。',
      '  - `emit_lesson`：察觉到自己犯了可避免的错误 / 反复 3 次以上某种失败模式 / 用户在澄清里',
      '    指出你之前做错 / 即将交付但回顾过程觉得"走了弯路下次别再犯"时，主动沉淀教训。',
      '    scope=employee（个人教训）或 project（项目踩坑）。下次同类需求引擎会自动注入。',
      '    例：「先 sed 改文件再 find 验证 → 多次 ENOENT；应先 find 确认路径再改」。',
      '    若当前任务很顺利没有可总结的反面经验，不要调；引擎不强制 emit_lesson。',
      '  - `ask_user`：以下 5 种场景**必须**主动暂停发问（带正确 trigger_reason）：',
      '    · `decision_split`：方案 A vs B 不可自行决断',
      '    · `missing_info`：关键事实/参数缺失，无法继续',
      '    · `judgment`：3 个候选都说得通，需用户选偏好',
      '    · `pitfall_hit`：察觉到本项目 pitfall 命中，先与用户确认本次做法',
      '    · `cost_alert`：预估接下来要超出 budget，请用户决定是否继续',
      '    ⚠️ 调用 `ask_user` 时必须以结构化 args 传入：',
      '       { "questions": [ { "question": "..." }, ... ], "trigger_reason": "missing_info" }',
      '       **不要**把澄清问题写在 text 输出中；text 只放概述，问题列表只在 questions 字段。',
      '- 默认行为：当本步骤产出已写入交付，**必须** 调用 advance_step',
      '- 严格遵守"项目规范 required"；recommended 视相关性引用',
      '',
      '### Bash 工具使用规则（完整本地权限 + 防假装完成）',
      '你有一个 `Bash` 工具，等同于在用户终端跑命令的完整权限。请按需自由组合：',
      '  - 查文件：`find <root> -name "<pattern>"`、`ls -la <dir>`、`tree -L 2 <dir>`',
      '  - 看内容：`cat <file>`、`sed -n "10,40p" <file>`、`head -n 50 <file>`',
      '  - 搜内容：`grep -rn "<pattern>" <root>`、`rg "<pattern>" <root>`（推荐 rg 更快）',
      '  - 改文件：`sed -i "" "s/old/new/g" <file>`（macOS）、`echo "..." > <file>`、`cat > <file> <<EOF ... EOF`',
      '  - 装软件：`brew install <pkg>`、`npm i <pkg>`、`pip install <pkg>`',
      '  - 编译验证：`mvn compile -q`、`go build`、`cargo check`',
      '- 多次失败时切策略：grep 找不到就 `find -type f -name "*.java" | head`；sed 改不动就 `python3 -c "import re; ..."`',
      '',
      '### ⛔ 防路径幻觉（最容易出错的一类）',
      '- 每个文件路径在 Edit / Write / Read / cat / sed -i 之前**必须先**用 find / ls / cat 验证它真的存在；',
      '  禁止"凭包名/模块名直觉编路径"（典型错误：根据 io.alchemytech.foo.Bar 猜 src/main/java/io/alchemytech/foo/Bar.java 然后直接 sed —— 实际目录可能在 share/common/src/main/java/...）',
      '- 标准探索顺序：',
      '  1. **先看根**：`ls <project-root>` 看顶层模块；',
      '  2. **再 find**：`find <project-root> -name "<basename>.<ext>"`（注意只用文件名，不带目录猜测）；',
      '  3. **找到后 cat**：取真实绝对路径，cat 一下确认是目标类；',
      '  4. **再 sed/echo 修改**：path 直接用 find 返回的字符串，不要手动重写。',
      '- 出现 `No such file or directory` / `ENOENT` 时**立刻退回**步骤 2（find），不要在同一个错误路径上反复重试。',
      '- 复制 find 输出时**别裁剪**目录前缀（`/Users/...full/path/to/X.java` 完整保留，不要省略中间）。',
      '',
      '- ⛔ tool_result.ok=false（命令非 0 退出 / 异常）时**严禁**直接 advance_step。',
      '  引擎会硬阻止并要求你先修好（重新查路径 / 改命令）。',
      '- emit_deliverable 时如实汇报：summary / contentText 写真实改动；用户会在"待验收"',
      '  状态查看代码（git diff / 文件内容）后决定 approve 或 reject。**谎报会被 reject**。',
    ].join('\n'),
  )

  const system = parts.join('\n\n')

  // chat history
  const recent = repos.messages.tailByThread(
    input.threadId,
    input.recentMessageCount ?? DEFAULT_RECENT,
  )
  const messages: ComposedPrompt['messages'] = []
  messages.push({ role: 'user', content: `# 需求\n${req.title}\n\n${req.description}` })
  for (const m of recent) {
    const text = extractText(m.contentJson)
    if (!text) continue
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: text })
    } else if (m.role === 'tool') {
      messages.push({ role: 'assistant', content: `[tool] ${text}` })
    }
  }

  return {
    system,
    messages,
    tokensEstimate:
      Math.round(system.length / 2) + messages.reduce((a, m) => a + m.content.length / 2, 0),
    cacheBreakpoints:
      cacheBreakpointBytes > 0 ? [Math.min(cacheBreakpointBytes, system.length)] : [],
    debug: {
      recalledFacts: facts,
      recalledPitfalls: pitfalls,
      recalledLessons: lessons,
      recalledSkills: skills_recall,
      requiredConventionCount: requiredCount,
      recommendedConventionCount: recommendedCount,
    },
  }
}

function extractText(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null
  const o = c as { type?: string; text?: string; reason?: string }
  if (o.type === 'text' || o.type === 'thinking') return o.text ?? null
  if (o.type === 'plan_update') return `plan_update: ${o.reason ?? ''}`
  if (o.type === 'tool_result') return `tool_result`
  return null
}
