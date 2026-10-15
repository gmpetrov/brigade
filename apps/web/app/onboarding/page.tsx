'use client'
import { LoaderCircle, ShieldCheck, Terminal } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountCard } from '@/components/account-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  api,
  ApiError,
  useApi,
  usableComputers,
  type Account,
  type AccountLogin,
  type ComputersResponse,
  type Me,
  type Teammate,
  type ThreadSummary,
} from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { markSignedIn, markSignedOut } from '@/lib/signed-in'
import { useLive } from '@/lib/use-live'

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
  children?: React.ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-md flex-col gap-7">
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

/** The first message of a new workspace's setup thread with the chief. */
const SETUP_MESSAGE = 'Hi Chief, I just started on Brigade. Help me set up my team.'

/**
 * First run: name the project (its organization and first workspace), connect
 * an AI account, then meet the chief. Also where a new workspace is made, and
 * where a member without an AI account in this workspace is sent.
 */
export default function Onboarding() {
  const router = useRouter()
  const [me, setMe] = useState<Me>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // A member who has a workspace and an AI account came here to add a workspace.
  const [adding, setAdding] = useState<boolean>()

  const reload = useCallback(
    () =>
      api<Me>('/me')
        .then((next) => {
          setMe(next)
          markSignedIn()
          setAdding((was) => was ?? (!!next.activeWorkspaceId && next.aiReady))
          return next
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) {
            markSignedOut()
            router.replace('/sign-in')
          } else setError(String(e))
          return undefined
        }),
    [router],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  /** A new organization and its first workspace, both named after the project. */
  async function createProject(form: FormData) {
    setBusy(true)
    setError(undefined)
    const name = String(form.get('name')).trim()
    try {
      const { error } = await authClient.organization.create({ name, slug: slugify(name) })
      if (error) throw new Error(error.message ?? 'Could not create your project')
      // Reading /me makes the new organization the session's.
      await api<Me>('/me')
      await api('/workspaces', { body: { name } })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function createWorkspace(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      await api('/workspaces', { body: { name: String(form.get('name')) } })
      setAdding(false)
      const next = await reload()
      if (next?.aiReady) router.push('/app')
    } catch (e) {
      setError(String((e as Error).message))
    }
    setBusy(false)
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
        title="What are you building?"
        description="Name your project. Your AI team works on it, and you can rename it later."
      >
        <Card>
          <CardContent>
            <form action={createProject} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Project name</Label>
                <Input id="name" name="name" placeholder="Acme" required autoFocus />
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

  // Stays up once the account works, while the chief's thread starts.
  if (me.activeWorkspaceId && !adding) return <ConnectAI onReady={reload} />

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

type LinkCode = { command: string; expiresAt: string }

/**
 * Nothing runs without an AI account: sign in to Claude (or ChatGPT for
 * Codex) on the workspace computer, or link a machine already signed in.
 * Once one works, the chief's setup thread starts.
 */
function ConnectAI({ onReady }: { onReady: () => Promise<Me | undefined> }) {
  const router = useRouter()
  const accounts = useApi<Account[]>('/accounts')
  const computers = useApi<ComputersResponse>('/computers')
  const [logins, setLogins] = useState<Record<string, AccountLogin>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<LinkCode>()
  const [finishing, setFinishing] = useState(false)
  // The live update and the timer can both see the account ready: start one thread.
  const started = useRef(false)

  /** Meet the chief: a new workspace starts by setting up its team with it. */
  const finish = useCallback(async () => {
    if (started.current) return
    started.current = true
    setFinishing(true)
    try {
      const [teammates, ready] = await Promise.all([
        api<Teammate[]>('/teammates'),
        api<Account[]>('/accounts'),
      ])
      const chief = teammates.find((t) => t.kind === 'chief')
      const works = (a: Account) => ['ready', 'unverified', 'exhausted'].includes(a.status)
      // Only a Codex account: the chief runs on Codex.
      if (
        chief &&
        !ready.some((a) => works(a) && a.provider === chief.harness) &&
        ready.some((a) => works(a))
      ) {
        const harness = ready.find(works)!.provider
        await api(`/teammates/${chief.id}`, { method: 'PATCH', body: { harness, model: null } })
        chief.harness = harness
      }
      const account = ready.find((a) => works(a) && a.provider === chief?.harness)
      const others = teammates.filter((t) => t.kind !== 'chief')
      if (chief && account && others.length === 0) {
        const started = await api<ThreadSummary[]>(`/threads?teammateId=${chief.id}`)
        if (started.length === 0) {
          const thread = await api<{ id: string }>('/threads', {
            body: {
              teammateId: chief.id,
              computerId: account.computer.id,
              accountId: account.id,
              text: SETUP_MESSAGE,
            },
          })
          return router.replace(`/app/threads/${thread.id}`)
        }
      }
      router.replace('/app')
    } catch (e) {
      setError((e as Error).message)
      started.current = false
      setFinishing(false)
    }
  }, [router])

  const check = useCallback(async () => {
    const me = await onReady()
    if (me?.aiReady) await finish()
  }, [onReady, finish])

  useLive((message) => {
    if (message.type === 'account.login') {
      setLogins((current) => ({ ...current, [message.accountId]: message }))
      if (message.state === 'done' || message.state === 'failed') {
        void accounts.reload()
        void check()
      }
    }
    if (message.type === 'computer.updated') void computers.reload()
  })

  // A linked machine's own login shows up when its runner connects.
  const reloadAccounts = accounts.reload
  const reloadComputers = computers.reload
  useEffect(() => {
    void check()
    const timer = setInterval(() => {
      void reloadAccounts()
      void reloadComputers()
      void check()
    }, 5000)
    return () => clearInterval(timer)
  }, [reloadAccounts, reloadComputers, check])

  const usable = usableComputers(computers.data)
  // The workspace computer first: it needs nothing on the person's machine.
  const computer = usable.find((c) => c.kind === 'cloud') ?? usable.find((c) => c.online)
  const cloud = computers.data?.computers.find((c) => c.kind === 'cloud')
  const signingIn = (accounts.data ?? []).filter((a) => a.source === 'brigade')
  // A new workspace's computer is still being made: sign-in opens once it starts.
  const preparing =
    !computer &&
    (cloud ? ['pending', 'creating'].includes(cloud.status) : !!computers.data?.cloudAvailable)
  const failed = !computer && cloud?.status === 'error'

  async function signIn(provider: Account['provider']) {
    if (!computer) return
    setBusy(true)
    setError(undefined)
    try {
      await api('/accounts', { body: { computerId: computer.id, provider } })
      await accounts.reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function act(promise: Promise<unknown>) {
    setError(undefined)
    try {
      await promise
      await accounts.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (finishing) return <Shell title="Meeting Chief…" description="Starting your first thread." />

  return (
    <Shell
      title="Connect your AI"
      description="Your teammates run on your own Claude or ChatGPT subscription. Nothing runs until one is connected."
    >
      <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm text-accent-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          You sign in on the vendor&apos;s own page. Brigade never sees your password, and the login
          stays on the computer.
        </p>
      </div>

      {signingIn.map((a) => (
        <AccountCard key={a.id} account={a} login={logins[a.id] ?? a.login} onAct={act} />
      ))}

      {signingIn.length === 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            {!computers.data ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : computer ? (
              <>
                <Button size="lg" disabled={busy} onClick={() => void signIn('claude_code')}>
                  Sign in with Claude
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void signIn('codex')}
                >
                  Sign in with ChatGPT (Codex)
                </Button>
                {cloud && !cloud.online && (
                  <p className="text-center text-xs text-muted-foreground">
                    Your workspace computer is starting. Sign-in begins as soon as it is up, which
                    takes a few minutes the first time.
                  </p>
                )}
              </>
            ) : preparing ? (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <LoaderCircle aria-hidden className="size-5 animate-spin text-muted-foreground" />
                <p className="text-sm font-medium">Getting your workspace computer ready…</p>
                <p className="text-xs text-muted-foreground">
                  This takes a few minutes the first time. Sign-in opens here as soon as it is up.
                </p>
              </div>
            ) : failed ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Your workspace computer could not be set up. Try again, or link your own machine
                  below.
                </p>
                <Button
                  variant="outline"
                  className="self-start"
                  onClick={() =>
                    void act(api(`/computers/${cloud!.id}/start`, { method: 'POST' })).then(() =>
                      computers.reload(),
                    )
                  }
                >
                  Try again
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This Brigade has no workspace computer. Link your own machine below: its Claude or
                Codex login is used as is.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {error && <p className="text-center text-sm text-destructive-text">{error}</p>}

      <details
        className="group rounded-lg border px-4 py-3 text-sm"
        open={!computer && !preparing && !!computers.data}
      >
        <summary className="flex cursor-pointer items-center gap-2 font-medium">
          <Terminal className="size-4" aria-hidden />
          Use my own machine instead
        </summary>
        <div className="mt-3 flex flex-col gap-3 text-muted-foreground">
          <p>
            Already signed in to <code>claude</code> or <code>codex</code> on your Mac or Linux
            machine? Link it and your teammates run there, on that login.
          </p>
          {link ? (
            <>
              <pre className="rounded-md border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
                {link.command}
              </pre>
              <p>
                Run it in a terminal. The code works once and expires at{' '}
                {new Date(link.expiresAt).toLocaleTimeString()}. This page goes on by itself once
                your machine connects.
              </p>
            </>
          ) : (
            <Button
              variant="outline"
              className="self-start"
              onClick={() =>
                void api<LinkCode>('/computers/link-code', { method: 'POST' })
                  .then(setLink)
                  .catch((e: Error) => setError(e.message))
              }
            >
              Get the install command
            </Button>
          )}
        </div>
      </details>
    </Shell>
  )
}
