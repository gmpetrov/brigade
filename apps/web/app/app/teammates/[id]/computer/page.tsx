'use client'
import { useParams } from 'next/navigation'
import { useDashboard } from '@/components/dashboard'
import { TeammateComputer } from '@/components/teammate-computer'

export default function TeammateComputerPage() {
  const { id } = useParams<{ id: string }>()
  const { teammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  if (!teammate) return <p className="p-6 text-sm text-muted-foreground">No such AI teammate.</p>
  return <TeammateComputer key={teammate.id} teammate={teammate} />
}
