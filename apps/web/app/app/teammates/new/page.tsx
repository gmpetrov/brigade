'use client'
import { useRouter } from 'next/navigation'
import { useDashboard } from '@/components/dashboard'
import { TeammateForm } from '@/components/teammate-form'
import { api, type Teammate } from '@/lib/api'

export default function NewTeammate() {
  const router = useRouter()
  const { reloadTeammates } = useDashboard()
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <h1 className="text-3xl font-extrabold tracking-tight">New AI teammate</h1>
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
