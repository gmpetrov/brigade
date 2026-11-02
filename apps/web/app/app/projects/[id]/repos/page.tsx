'use client'
import { ProjectRedirect } from '@/components/project-redirect'

/** Repositories and previews are a section of the project's settings. */
export default function ProjectRepos() {
  return <ProjectRedirect to={(p) => `/app/projects/${p.id}/settings#repositories`} />
}
