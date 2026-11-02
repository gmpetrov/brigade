'use client'
import { ProjectRedirect } from '@/components/project-redirect'

/** A project's pull requests: the Pull requests page, filtered on it. */
export default function ProjectPulls() {
  return <ProjectRedirect to={(p) => `/app/pulls?project=${p.id}`} />
}
