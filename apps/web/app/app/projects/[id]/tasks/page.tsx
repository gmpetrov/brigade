import { redirect } from 'next/navigation'

// The Tasks board is gone (docs/hand-offs.md): a project's opens the Board on that project.
export default async function ProjectTasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/app/board?project=${encodeURIComponent(id)}`)
}
