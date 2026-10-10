import { redirect } from 'next/navigation'

/** Projects were renamed Repositories; old links land there. */
export default function ProjectsPage() {
  redirect('/app/repositories')
}
