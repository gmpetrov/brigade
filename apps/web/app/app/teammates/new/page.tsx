'use client'
import { useRouter } from 'next/navigation'
import { useDashboard } from '@/components/dashboard'
import { TeammateForm } from '@/components/teammate-form'
import { api, type Teammate } from '@/lib/api'

export default function NewTeammate() {
  const router = useRouter()
  const { reloadTeammates } = useDashboard()
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <h1>New AI teammate</h1>
      <TeammateForm
        submitLabel="Create teammate"
        onSubmit={async (input) => {
          const teammate = await api<Teammate>('/teammates', { body: input })
          await reloadTeammates()
          router.push(`/app/teammates/${teammate.id}`)
        }}
      />
    </div>
  )
}
