/**
 * 样板项目 — `ai-emp seed` 时一键导入。
 *
 * 3 个项目 + 5 个员工 + 8 个起步技能 + 若干预置 conventions。
 * 员工的 modelKeyRef 留为 "REPLACE_ME"，用户用前需先 `keychain set`。
 */

import type { LLMProvider, SkillCategory } from '@ai-emp/domain'
import type { Repos } from '@ai-emp/storage'

interface SeedProject {
  name: string
  description: string
  conventions: { content: string; enforcement: 'required' | 'recommended'; category?: string }[]
}

interface SeedEmployee {
  name: string
  role: string
  persona: string
  provider: LLMProvider
  /** 直接写死 或 env://... 引用；默认走 env */
  model: string
  /** OpenAI 兼容用；同上支持 env:// */
  baseUrl?: string
  /** keychain key 名 或 env://... 引用 */
  keyRef: string
  skills: string[] // skill name 引用
}

interface SeedSkill {
  name: string
  category: SkillCategory
  description: string
  promptTemplate: string
}

const SKILLS: SeedSkill[] = [
  // ── 技术 ────────────────────────────────────────────────────
  {
    name: '需求拆解',
    category: '技术',
    description: '把模糊需求拆为 4-6 步可执行子任务，每步含产出物',
    promptTemplate: '按 4-6 步拆解，每步要明确"做什么 + 产出什么"，避免动词模糊。',
  },
  {
    name: '代码生成与解释',
    category: '技术',
    description: '函数级 / 单文件代码生成 + 解释',
    promptTemplate: '按项目语言约定写代码；解释时先讲意图，再讲实现，最后讲边界。',
  },
  {
    name: 'API 设计',
    category: '技术',
    description: 'REST / GraphQL / RPC 接口设计：路径、请求/响应 schema、错误码',
    promptTemplate:
      '输出：endpoint 列表 + 每个 endpoint 的 method/path/请求/响应 schema/错误码。优先 RESTful 风格，避免过度设计。',
  },
  {
    name: '数据库设计',
    category: '技术',
    description: '表结构 / 索引 / 关系建模 / 迁移脚本',
    promptTemplate:
      '输出：表 DDL（含字段、约束、索引）+ 关系图（ASCII）+ 关键查询的解释。考虑读写比例、扩展路径。',
  },
  {
    name: '组件开发',
    category: '技术',
    description: 'React / Vue 组件级开发：props/state/事件/样式',
    promptTemplate:
      '组件先定义 props 类型，再写实现；状态最小化，样式遵守项目规范，事件命名 onXxx。',
  },
  {
    name: '测试用例设计',
    category: '技术',
    description: '单测 / 集成测 / E2E 用例覆盖正常/边界/异常路径',
    promptTemplate: '按"正常路径 → 边界 → 异常 → 性能/并发"四档列测试用例，每条标注预期结果。',
  },
  {
    name: 'Bug 分析',
    category: '技术',
    description: '从错误日志 / 复现步骤定位根因 + 给修复方案',
    promptTemplate: '按"现象 → 复现 → 假设 → 验证 → 根因 → 修复方案 → 预防"七步走，避免跳到结论。',
  },

  // ── 设计 ────────────────────────────────────────────────────
  {
    name: '界面设计',
    category: '设计',
    description: '页面布局 / 交互流 / 视觉风格说明',
    promptTemplate:
      '先讲信息层级与用户决策路径，再给布局描述（不画图，文字说明 + ASCII 框图）+ 视觉风格关键词。',
  },
  {
    name: '用户访谈整理',
    category: '内容',
    description: '把访谈录音 / 笔记整理为结构化报告',
    promptTemplate: '按"背景 + 核心洞察 + 引用原话 + 行动建议"四段输出。',
  },

  // ── 通用 ────────────────────────────────────────────────────
  {
    name: '文档总结',
    category: '通用',
    description: '把长文档压缩为关键点列表',
    promptTemplate: '提取核心要点，按优先级排列；超过 5 点就再分组。',
  },
  {
    name: '通用对话',
    category: '通用',
    description: '日常对话、回答问题、解释概念',
    promptTemplate: '清晰、简洁，先给结论再给原因。',
  },
]

const PROJECTS: SeedProject[] = [
  {
    name: 'SaaS 产品 · 数字员工',
    description: [
      '一个让个人和小团队"招 AI 员工 + 派工单"的 SaaS 平台。',
      '前端：React 18 + TypeScript + Tailwind + Zustand。',
      '后端：Bun + Hono + SQLite + sqlite-vec。',
      '部署形态：单用户本地 CLI（α），未来出 Tauri 桌面版（V1.1+）。',
    ].join('\n'),
    conventions: [
      {
        content: '所有 TS 文件禁用 any，必须显式类型',
        enforcement: 'required',
        category: '代码风格',
      },
      { content: '状态管理用 Zustand，禁用 Redux', enforcement: 'required', category: '前端架构' },
      {
        content: '样式只用 Tailwind 原子类，不写新 CSS 文件',
        enforcement: 'required',
        category: '样式',
      },
      {
        content: 'API 调用走 fetch + Zod 校验，禁直接信任 JSON',
        enforcement: 'required',
        category: 'API',
      },
      {
        content: '数据库 schema 改动必须有 migration 文件，不许 hot patch',
        enforcement: 'required',
        category: '后端',
      },
      {
        content: '提交前必须跑 bun test + bun run typecheck',
        enforcement: 'required',
        category: 'CI',
      },
      {
        content: '组件名 PascalCase；hooks useXxx；事件 onXxx',
        enforcement: 'recommended',
        category: '命名',
      },
    ],
  },
  {
    name: '内部工具 · 客户支持系统',
    description: [
      '内部用的客户工单 / 知识库 / 自动回复系统。',
      '技术栈：Next.js + tRPC + Postgres + Redis。',
      '团队 5 人，迭代节奏：双周一次。',
    ].join('\n'),
    conventions: [
      {
        content: '所有用户输入必经服务端校验，前端 schema 仅做 UX',
        enforcement: 'required',
        category: '安全',
      },
      { content: 'PII 数据写日志前必须脱敏', enforcement: 'required', category: '合规' },
      {
        content: '工单状态变化必须发事件到 Redis pub/sub',
        enforcement: 'required',
        category: '后端架构',
      },
    ],
  },
  {
    name: '副业项目 · 独立开发者落地页',
    description: [
      '帮独立开发者做产品落地页 + 简单后端 + 支付集成的承接项目。',
      '一次性交付为主，长期维护可选。技术栈灵活：Next.js / Astro / SvelteKit 任选。',
    ].join('\n'),
    conventions: [
      { content: '客户讨厌长邮件，沟通邮件 ≤ 200 字', enforcement: 'required', category: '沟通' },
      {
        content: '交付前必须跑 Lighthouse 性能 ≥ 90',
        enforcement: 'recommended',
        category: '质量',
      },
      { content: '页面首屏 LCP < 2.5s', enforcement: 'recommended', category: '性能' },
    ],
  },
]

// 样板员工 default 全部走 env:// —— 用户在 .env 配 LLM 后开箱即用，
// 不想 / 不需要 .env 时改员工字段为 keychain key 名 / 写死 model 即可。
const EMPLOYEES: SeedEmployee[] = [
  {
    name: '小后',
    role: '后端开发',
    persona:
      '务实，关注接口契约、数据一致性、错误处理；不喜欢炫技。先 grep 现有代码再动手；改动小步快走。',
    provider: 'anthropic',
    model: 'env://AIEMP_ANTHROPIC_MODEL',
    keyRef: 'env://AIEMP_ANTHROPIC_API_KEY',
    skills: ['API 设计', '数据库设计', '代码生成与解释', '需求拆解', 'Bug 分析'],
  },
  {
    name: '小前',
    role: '前端开发',
    persona: '简洁直接，类型严格，喜欢用最少的依赖；偏爱组合而非继承。',
    provider: 'anthropic',
    model: 'env://AIEMP_ANTHROPIC_MODEL',
    keyRef: 'env://AIEMP_ANTHROPIC_API_KEY',
    skills: ['组件开发', '代码生成与解释', '需求拆解'],
  },
  {
    name: '小测',
    role: '测试工程师',
    persona: '怀疑论者，先想边界和异常路径；写测试时优先覆盖"会出错的地方"而不是 happy path。',
    provider: 'anthropic',
    model: 'env://AIEMP_ANTHROPIC_MODEL',
    keyRef: 'env://AIEMP_ANTHROPIC_API_KEY',
    skills: ['测试用例设计', 'Bug 分析', '代码生成与解释'],
  },
  {
    name: '小产',
    role: '产品经理',
    persona: '宁可多问也不盲干。澄清前置：先复述需求、列假设、问关键问题；定义验收标准前不动手。',
    provider: 'anthropic',
    model: 'env://AIEMP_ANTHROPIC_MODEL',
    keyRef: 'env://AIEMP_ANTHROPIC_API_KEY',
    skills: ['需求拆解', '用户访谈整理', '文档总结'],
  },
  {
    name: '小美',
    role: 'UI 设计师',
    persona: '审美在线，关注信息层级、留白、可读性；倾向极简但拒绝降低信息密度。',
    provider: 'anthropic',
    model: 'env://AIEMP_ANTHROPIC_MODEL',
    keyRef: 'env://AIEMP_ANTHROPIC_API_KEY',
    skills: ['界面设计', '需求拆解', '通用对话'],
  },
]

export interface SeedResult {
  skills: number
  projects: number
  employees: number
  conventions: number
  skipped: {
    skills: number
    projects: number
    employees: number
  }
}

/** 写入样板数据；已存在同名实体则跳过（按名字幂等）。 */
export function seedAll(repos: Repos): SeedResult {
  const result: SeedResult = {
    skills: 0,
    projects: 0,
    employees: 0,
    conventions: 0,
    skipped: { skills: 0, projects: 0, employees: 0 },
  }

  // ① skills
  const skillNameToId = new Map<string, string>()
  const existingSkills = repos.skills.list()
  for (const sk of SKILLS) {
    const existing = existingSkills.find((x) => x.name === sk.name)
    if (existing) {
      skillNameToId.set(sk.name, existing.id)
      result.skipped.skills++
      continue
    }
    const id = repos.skills.create({
      name: sk.name,
      category: sk.category,
      description: sk.description,
      promptTemplate: sk.promptTemplate,
      builtin: true,
    })
    skillNameToId.set(sk.name, id)
    result.skills++
  }

  // ② projects + conventions（只对 active 项目去重，archived 视为不存在）
  const existingProjects = repos.projects.list().filter((p) => p.status === 'active')
  for (const p of PROJECTS) {
    const existing = existingProjects.find((x) => x.name === p.name)
    if (existing) {
      result.skipped.projects++
      continue
    }
    const pid = repos.projects.create({ name: p.name, description: p.description })
    result.projects++
    for (const c of p.conventions) {
      repos.conventions.create({
        projectId: pid,
        content: c.content,
        enforcement: c.enforcement,
        ...(c.category ? { category: c.category } : {}),
      })
      result.conventions++
    }
  }

  // ③ employees + skill 挂载（同样只看 active）
  const existingEmps = repos.employees.list().filter((e) => e.status === 'active')
  for (const e of EMPLOYEES) {
    const existing = existingEmps.find((x) => x.name === e.name)
    if (existing) {
      result.skipped.employees++
      continue
    }
    const eid = repos.employees.create({
      name: e.name,
      role: e.role,
      persona: e.persona,
      modelProvider: e.provider,
      modelName: e.model,
      modelKeyRef: e.keyRef,
      ...(e.baseUrl ? { modelBaseUrl: e.baseUrl } : {}),
    })
    result.employees++
    e.skills.forEach((skillName, idx) => {
      const sid = skillNameToId.get(skillName)
      if (sid) repos.skills.attach(eid, sid, idx)
    })
  }

  return result
}

/**
 * 清空所有样板内容（按名字匹配；用户自建的不动）后重新导入。
 * 用法：`./ai-emp seed --reset`
 */
export function seedReset(repos: Repos): SeedResult {
  const seedSkillNames = new Set(SKILLS.map((s) => s.name))
  const seedProjectNames = new Set(PROJECTS.map((p) => p.name))
  const seedEmployeeNames = new Set(EMPLOYEES.map((e) => e.name))

  for (const e of repos.employees.list()) {
    if (seedEmployeeNames.has(e.name)) repos.employees.archive(e.id)
  }
  for (const p of repos.projects.list()) {
    if (seedProjectNames.has(p.name)) repos.projects.delete(p.id)
  }
  // skills 没有 delete 方法；这里直接重新建会冲突 — 跳过 skills 重置
  // （技能本身设计为可复用，少量重复无害）
  void seedSkillNames

  return seedAll(repos)
}
