'use client'
import { useProject } from '@/components/project-shell'
import { TaskBoard } from '@/components/task-board'

export default function ProjectTasks() {
  return <TaskBoard projectId={useProject().project.id} />
}
