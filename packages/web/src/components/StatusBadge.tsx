import type { RequirementStatus } from '../lib/types'

const COLORS: Record<RequirementStatus, string> = {
  待分派: 'bg-slate-100 text-slate-700',
  待澄清: 'bg-amber-100 text-amber-700',
  进行中: 'bg-blue-100 text-blue-700',
  等待回答: 'bg-orange-100 text-orange-700',
  已暂停: 'bg-yellow-100 text-yellow-700',
  待验收: 'bg-purple-100 text-purple-700',
  已完成: 'bg-green-100 text-green-700',
  已驳回: 'bg-red-100 text-red-700',
  已取消: 'bg-slate-200 text-slate-500',
}

export function StatusBadge({ status }: { status: RequirementStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${COLORS[status]}`}>
      {status}
    </span>
  )
}
