'use client'
import { ProjectRedirect } from '@/components/project-redirect'

/** A project's threads are in the sidebar: a click on the project filters them. */
export default function ProjectThreads() {
  return <ProjectRedirect to={(p) => `/app/projects/${p.id}`} />
}
