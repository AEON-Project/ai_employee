import { Layout } from './components/Layout'
import { useRoute } from './store/router'
import { HomePage } from './pages/Home'
import { ProjectsPage } from './pages/Projects'
import { ProjectDetailPage } from './pages/ProjectDetail'
import { EmployeesPage } from './pages/Employees'
import { EmployeeDetailPage } from './pages/EmployeeDetail'
import { SkillsPage } from './pages/Skills'
import { RequirementsPage } from './pages/Requirements'
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
    case 'project':
      return <ProjectDetailPage id={route.id} />
    case 'employees':
      return <EmployeesPage />
    case 'employee':
      return <EmployeeDetailPage id={route.id} />
    case 'skills':
      return <SkillsPage />
    case 'requirements':
      return <RequirementsPage />
    case 'new':
      return <NewRequirementPage />
    case 'req':
      return <RequirementDetailPage reqId={route.id} />
    default:
      return <p>404 — 路由不存在</p>
  }
}
