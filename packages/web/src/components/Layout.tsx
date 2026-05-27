import { navigate } from '../store/router'

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
          <a
            href="#/"
            className="font-semibold text-lg text-accent"
            onClick={(e) => {
              e.preventDefault()
              navigate('/')
            }}
          >
            ai-emp
          </a>
          <nav className="flex gap-4 text-sm">
            <NavLink to="/" label="仪表" />
            <NavLink to="/projects" label="项目" />
            <NavLink to="/employees" label="员工" />
            <NavLink to="/skills" label="技能" />
            <NavLink to="/new" label="新建需求" />
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto px-4 py-6 w-full">{children}</main>
    </div>
  )
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <a
      href={`#${to}`}
      className="text-slate-600 hover:text-accent"
      onClick={(e) => {
        e.preventDefault()
        navigate(to)
      }}
    >
      {label}
    </a>
  )
}
