import type { ReactNode } from 'react'
import { ProjectShell } from '@/components/project-shell'

export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <ProjectShell>{children}</ProjectShell>
}
