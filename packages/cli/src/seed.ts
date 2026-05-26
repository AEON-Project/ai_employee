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
  model: string
  skills: string[] // skill name 引用
}

interface SeedSkill {
  name: string
  category: SkillCategory
  description: string
  promptTemplate: string
}

const SKILLS: SeedSkill[] = [
  {
    name: '通用对话',
    category: '通用',
    description: '日常对话、回答问题、解释概念',
    promptTemplate: '请按自然语言对话风格回答用户问题，清晰、简洁。',
  },
  {
    name: '文档总结',
    category: '通用',
    description: '把长文档压缩为关键点列表',
    promptTemplate: '提取核心要点，按优先级排列。',
  },
  {
    name: '联网搜索',
    category: '通用',
    description: '调用 web_search 工具获取实时信息',
    promptTemplate: '当用户问题涉及外部信息时调用 web_search 工具。',
  },
  {
    name: '长文写作',
    category: '内容',
    description: '写文章、报告、博客等长文',
    promptTemplate: '按"开头-论点-论据-结论"结构组织，控制每段 ≤ 200 字。',
  },
  {
    name: '营销文案',
    category: '内容',
    description: '写广告、邮件、落地页文案',
    promptTemplate:
      '突出独特卖点 + 痛点 + 行动召唤；按 AIDA(Attention/Interest/Desire/Action) 模板组织。',
  },
  {
    name: '用户访谈整理',
    category: '内容',
    description: '把访谈录音/笔记整理为结构化报告',
    promptTemplate: '按"背景 + 核心洞察 + 引用原话 + 行动建议"四段式输出。',
  },
  {
    name: '代码生成与解释',
    category: '技术',
    description: '生成函数级 / 单文件代码，解释代码',
    promptTemplate: '按项目语言约定写代码；解释时先讲意图，再讲实现。',
  },
  {
    name: '需求拆解',
    category: '技术',
    description: '把模糊需求拆为可执行步骤',
    promptTemplate: '按 4-6 步拆解，每步要明确"做什么+产出什么"，避免动词模糊。',
  },
]

const PROJECTS: SeedProject[] = [
  {
    name: '前端 Web 应用',
    description:
      '一个 React + TypeScript + Tailwind 的 SaaS 产品官网与控制台。目标用户：独立开发者。',
    conventions: [
      { content: '所有组件用 TypeScript，禁用 any', enforcement: 'required', category: '代码风格' },
      { content: '状态管理用 Zustand，禁用 Redux', enforcement: 'required', category: '架构' },
      {
        content: '样式只用 Tailwind 原子类，不写新 CSS 文件',
        enforcement: 'required',
        category: '样式',
      },
      { content: 'API 调用走 tRPC 而非 fetch', enforcement: 'recommended', category: 'API' },
    ],
  },
  {
    name: '内容运营',
    description:
      '负责小红书 / 公众号 / Newsletter 的内容生产与分发，目标群体：18-30 岁互联网从业者。',
    conventions: [
      { content: '小红书标题 ≤ 20 字，多用 emoji 与悬念', enforcement: 'required' },
      { content: '公众号文章 1500-2500 字，配 3+ 张图', enforcement: 'required' },
      { content: '客户讨厌长邮件，要求 200 字以内', enforcement: 'required', category: '邮件' },
    ],
  },
  {
    name: '个人写作',
    description: '记录技术、产品、生活的随笔与深度思考，主要平台：个人博客 + Substack。',
    conventions: [
      { content: '保持第一人称，避免营销口吻', enforcement: 'required' },
      { content: '每篇 1000-3000 字，倾向慢思考类内容', enforcement: 'recommended' },
    ],
  },
]

const EMPLOYEES: SeedEmployee[] = [
  {
    name: '小李',
    role: '前端工程师',
    persona: '简洁直接，类型严格，喜欢用最少的依赖解决问题',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    skills: ['代码生成与解释', '需求拆解'],
  },
  {
    name: '小美',
    role: 'UI 设计师',
    persona: '审美在线，关注细节，倾向极简主义',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    skills: ['需求拆解', '通用对话'],
  },
  {
    name: '小文',
    role: '文案策划',
    persona: '善于讲故事，喜欢"金句"，对产品调性敏感',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    skills: ['长文写作', '营销文案'],
  },
  {
    name: '小研',
    role: '用户研究员',
    persona: '严谨，会从原始数据中找规律，不轻易下结论',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    skills: ['用户访谈整理', '文档总结'],
  },
  {
    name: '小数',
    role: '数据分析师',
    persona: '逻辑清晰，喜欢用数字说话，常引用对比/趋势',
    provider: 'openai-compat',
    model: 'deepseek-chat',
    skills: ['文档总结', '通用对话'],
  },
]

export interface SeedResult {
  skills: number
  projects: number
  employees: number
  conventions: number
}

/** 写入样板数据；已存在同名实体则跳过 */
export function seedAll(repos: Repos): SeedResult {
  const result: SeedResult = { skills: 0, projects: 0, employees: 0, conventions: 0 }

  // ① skills
  const skillNameToId = new Map<string, string>()
  const existingSkills = repos.skills.list()
  for (const sk of SKILLS) {
    const existing = existingSkills.find((x) => x.name === sk.name)
    if (existing) {
      skillNameToId.set(sk.name, existing.id)
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

  // ② projects + conventions
  const existingProjects = repos.projects.list()
  for (const p of PROJECTS) {
    const existing = existingProjects.find((x) => x.name === p.name)
    if (existing) continue
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

  // ③ employees + skill 挂载
  const existingEmps = repos.employees.list()
  for (const e of EMPLOYEES) {
    const existing = existingEmps.find((x) => x.name === e.name)
    if (existing) continue
    const eid = repos.employees.create({
      name: e.name,
      role: e.role,
      persona: e.persona,
      modelProvider: e.provider,
      modelName: e.model,
      modelKeyRef: 'REPLACE_ME',
    })
    result.employees++
    e.skills.forEach((skillName, idx) => {
      const sid = skillNameToId.get(skillName)
      if (sid) repos.skills.attach(eid, sid, idx)
    })
  }

  return result
}
