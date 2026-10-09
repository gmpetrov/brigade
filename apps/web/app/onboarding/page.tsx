'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, ApiError, type Me } from '@/lib/api'
import { authClient } from '@/lib/auth-client'

const slugify = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'org'
  }-${Math.random().toString(36).slice(2, 6)}`

/** First run: create an organization, then its first workspace. */
export default function Onboarding() {
  const router = useRouter()
  const [me, setMe] = useState<Me>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((e) =>
        e instanceof ApiError && e.status === 401
          ? router.replace('/sign-in')
          : setError(String(e)),
      )
  }, [router])

  async function createOrganization(form: FormData) {
    setBusy(true)
    setError(undefined)
    const name = String(form.get('name'))
    const { error } = await authClient.organization.create({ name, slug: slugify(name) })
    if (error) {
      setBusy(false)
      return setError(error.message ?? 'Could not create the organization')
    }
    setMe(await api<Me>('/me'))
    setBusy(false)
  }

  async function createWorkspace(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      await api('/workspaces', { body: { name: String(form.get('name')) } })
      router.push('/app')
    } catch (e) {
      setError(String((e as Error).message))
      setBusy(false)
    }
  }

  if (!me)
    return (
      <main className="narrow">
        {error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>}
      </main>
    )

  if (!me.activeOrganizationId) {
    return (
      <main className="narrow">
        <h1>Name your organization</h1>
        <p className="hint">Your organization holds your team and its workspaces.</p>
        <form action={createOrganization} className="card">
          <div className="field">
            <label htmlFor="name">Organization name</label>
            <input id="name" name="name" placeholder="Acme Inc." required />
          </div>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy}>
            Continue
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="narrow">
      <h1>Create a workspace</h1>
      <p className="hint">
        A workspace is one business or project. It has its own AI teammates, computer and run log.
      </p>
      <form action={createWorkspace} className="card">
        <div className="field">
          <label htmlFor="name">Workspace name</label>
          <input id="name" name="name" placeholder="Customer support" required />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || (me.role !== 'owner' && me.role !== 'admin')}>
          Create workspace
        </button>
        {me.role === 'member' && (
          <p className="hint">Ask an owner or admin to create a workspace.</p>
        )}
      </form>
    </main>
  )
}
