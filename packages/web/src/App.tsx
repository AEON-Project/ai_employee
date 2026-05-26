import { Layout } from './components/Layout'
import { useRoute } from './store/router'
import { HomePage } from './pages/Home'
import { ProjectsPage } from './pages/Projects'
import { EmployeesPage } from './pages/Employees'
import { NewRequirementPage } from './pages/NewRequirement'
import { RequirementDetailPage } from './pages/RequirementDetail'

export function App() {
  const route = useRoute()
  return <Layout>{render(route)}</Layout>
}

function render(route: ReturnType<typeof useRoute>): React.ReactNode {
  switch (route.name) {
    case 'home':
      return <HomePage />
    case 'projects':
      return <ProjectsPage />
    case 'employees':
      return <EmployeesPage />
    case 'new':
      return <NewRequirementPage />
    case 'req':
      return <RequirementDetailPage reqId={route.id} />
    case 'project':
      return <p>项目详情（最小版未实现，请回首页或编辑 API）。id={route.id}</p>
    case 'employee':
      return <p>员工详情（最小版未实现）。id={route.id}</p>
    default:
      return <p>404 — 路由不存在</p>
  }
}
