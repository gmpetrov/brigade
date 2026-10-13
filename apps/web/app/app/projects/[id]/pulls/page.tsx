'use client'
import { useProject } from '@/components/project-shell'
import { PullList } from '@/components/pull-list'

export default function ProjectPulls() {
  return <PullList projectId={useProject().project.id} />
}
