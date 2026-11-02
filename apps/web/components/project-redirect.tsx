'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useProject } from '@/components/project-shell'
import type { ProjectDetail } from '@/lib/api'

/**
 * A project page that was a tab: links saved before still land where its content is now, the
 * workspace's page filtered on the project (docs/projects.md, Project page).
 */
export function ProjectRedirect({ to }: { to: (project: ProjectDetail) => string }) {
  const { project } = useProject()
  const router = useRouter()
  const href = to(project)
  useEffect(() => router.replace(href), [router, href])
  return null
}
