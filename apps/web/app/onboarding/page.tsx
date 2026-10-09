'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

/** Centered column with the brand mark, shared by every onboarding step. */
function Shell({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden
            className="flex size-14 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground"
          >
            B
          </span>
          {title && (
            <div className="flex flex-col gap-1.5">
              <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
          )}
        </div>
        {children}
      </div>
    </main>
  )
}

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
      <Shell>
        {error ? (
          <p className="text-center text-sm text-destructive-text">{error}</p>
        ) : (
          <p className="text-center text-sm text-muted-foreground">Loading…</p>
        )}
      </Shell>
    )

  if (!me.activeOrganizationId) {
    return (
      <Shell
        title="Name your organization"
        description="Your organization holds your team and its workspaces."
      >
        <Card>
          <CardContent>
            <form action={createOrganization} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Organization name</Label>
                <Input id="name" name="name" placeholder="Acme Inc." required />
              </div>
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell
      title="Create a workspace"
      description="A workspace is one business or project. It has its own AI teammates, computer and run log."
    >
      <Card>
        <CardContent>
          <form action={createWorkspace} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Workspace name</Label>
              <Input id="name" name="name" placeholder="Customer support" required />
            </div>
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={busy || (me.role !== 'owner' && me.role !== 'admin')}
            >
              Create workspace
            </Button>
            {me.role === 'member' && (
              <p className="text-sm text-muted-foreground">
                Ask an owner or admin to create a workspace.
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </Shell>
  )
}
