'use client'
import { ProjectRedirect } from '@/components/project-redirect'

/** A project's routines: the Routines page, filtered on it. */
export default function ProjectRoutines() {
  return <ProjectRedirect to={(p) => `/app/routines?project=${p.id}`} />
}
