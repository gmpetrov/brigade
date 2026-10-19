'use client'
import { ProjectTriggers } from '@/components/project-triggers'
import { useProject } from '@/components/project-shell'
import { ScheduleList } from '@/components/schedule-list'

export default function ProjectRoutines() {
  const { project } = useProject()
  return (
    <div className="flex flex-col gap-8">
      <ScheduleList projectId={project.id} />
      <ProjectTriggers projectId={project.id} />
    </div>
  )
}
