'use client'
import {
  Check,
  Clock,
  Cloud,
  ExternalLink,
  Laptop,
  Moon,
  ShieldCheck,
  Terminal,
  Wallet,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountCard, machineName } from '@/components/account-card'
import { HarnessLogo } from '@/components/harness-logo'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  api,
  ApiError,
  harnessLabel,
  subscribeToCloud,
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
import { MAC_APP_URL } from '@/lib/mac-app'
import { markSignedIn, markSignedOut } from '@/lib/signed-in'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

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

type LinkCode = { command: string; expiresAt: string; appLink?: string }

/** Where this page is open: Brigade.app runs on a Mac, the runner on a Mac or Linux. */
type Device = 'mac' | 'linux' | 'other'

function detectDevice(): Device {
  const ua = navigator.userAgent
  if (/iPhone|iPad|Android/.test(ua)) return 'other'
  if (/Mac/.test(ua)) return 'mac'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'other'
}

/** Apple's mark, in the text color, for the Mac download. */
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className={cn('size-4', className)}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  )
}

/** A card's leading icon on a soft tile; violet for Brigade Cloud. */
function Tile({ children, violet }: { children: React.ReactNode; violet?: boolean }) {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-4',
        violet ? 'bg-primary/15 text-primary' : 'bg-secondary',
      )}
    >
      {children}
    </span>
  )
}

/** A card's head: icon, title, one line under it, and what sits at its right. */
function CardHead({
  icon,
  violet,
  title,
  meta,
  aside,
}: {
  icon: React.ReactNode
  violet?: boolean
  title: React.ReactNode
  meta: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <Tile violet={violet}>{icon}</Tile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-bold">{title}</p>
        <p className="text-xs text-muted-foreground">{meta}</p>
      </div>
      {aside}
    </div>
  )
}

/** Something on its way, with a pulsing violet dot rather than a spinner. */
function Waiting({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-muted px-3.5 py-3">
      <p className="flex items-center gap-2.5 text-sm">
        <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
        {title}
      </p>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  )
}

function Command({ command }: { command: string }) {
  return (
    <pre className="rounded-xl border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
      {command}
    </pre>
  )
}

const PRICE = (
  <>
    $99<span className="text-xs font-medium text-muted-foreground"> / month</span>
  </>
)

/**
 * Nothing runs without an AI account on a computer: Brigade Cloud first, then
 * the member's own machine, for free, offered as this device allows (Brigade.app
 * on a Mac, the install command on Linux). Not one or the other: the second can
 * be added later from Computers. Once an account works, the chief's setup
 * thread starts.
 */
function ConnectAI({ onReady }: { onReady: () => Promise<Me | undefined> }) {
  const router = useRouter()
  const accounts = useApi<Account[]>('/accounts')
  const computers = useApi<ComputersResponse>('/computers')
  const [logins, setLogins] = useState<Record<string, AccountLogin>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<LinkCode>()
  // On a Mac: the install command rather than Brigade.app.
  const [terminal, setTerminal] = useState(false)
  const [device, setDevice] = useState<Device>()
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

  useEffect(() => setDevice(detectDevice()), [])

  const getLink = useCallback(() => {
    setError(undefined)
    return api<LinkCode>('/computers/link-code', { method: 'POST' })
      .then(setLink)
      .catch((e: Error) => setError(e.message))
  }, [])

  const all = computers.data?.computers ?? []
  const usable = usableComputers(computers.data)
  const cloud = all.find((c) => c.kind === 'cloud')
  const cloudUsable = usable.find((c) => c.kind === 'cloud')
  const machine = all.find((c) => c.kind === 'member_machine' && c.online)
  const signingIn = (accounts.data ?? []).filter((a) => a.source === 'brigade')
  const offerCloud = !!computers.data?.cloudAvailable
  // With billing on, the cloud computer comes with Brigade Cloud: their own machine is free.
  const planNeeded = offerCloud && !computers.data?.cloudEntitled
  // A new workspace's computer is still being made: sign-in opens once it starts.
  const preparing =
    !cloudUsable &&
    (cloud ? ['pending', 'creating'].includes(cloud.status) : offerCloud && !planNeeded)
  const failed = !cloudUsable && cloud?.status === 'error'
  // Once they set up their own machine, Brigade Cloud steps back to one line.
  const cloudCompact = planNeeded && (!!link || !!machine)

  // On Linux the command is the way in: show it straight away.
  const linuxLink = useRef(false)
  useEffect(() => {
    if (device !== 'linux' || !computers.data || machine || linuxLink.current) return
    linuxLink.current = true
    void getLink()
  }, [device, computers.data, machine, getLink])

  async function signIn(computerId: string, provider: Account['provider']) {
    setBusy(true)
    setError(undefined)
    try {
      await api('/accounts', { body: { computerId, provider } })
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

  function subscribe() {
    setBusy(true)
    void act(subscribeToCloud('onboarding')).then(() => setBusy(false))
  }

  if (finishing)
    return (
      <Shell
        title="Your team is ready"
        description="Chief, your first teammate, is setting up your team with you."
      >
        <p className="flex items-center justify-center gap-2.5 text-sm">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-primary" />
          Meeting Chief… starting your first thread.
        </p>
      </Shell>
    )

  const signInButtons = (computerId: string) =>
    signingIn.length === 0 && (
      <div className="flex flex-col gap-2.5">
        <Button
          size="lg"
          variant="outline"
          disabled={busy}
          onClick={() => void signIn(computerId, 'claude_code')}
        >
          <HarnessLogo harness="claude_code" />
          Sign in with Claude
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={busy}
          onClick={() => void signIn(computerId, 'codex')}
        >
          <HarnessLogo harness="codex" />
          Sign in with ChatGPT (Codex)
        </Button>
      </div>
    )

  const cloudHead = (aside: React.ReactNode) => (
    <CardHead
      icon={<Cloud />}
      violet
      title="Brigade Cloud"
      meta="Your team's own computer, always on"
      aside={aside}
    />
  )

  const cloudCard = !offerCloud ? null : cloudCompact ? null : planNeeded ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {cloudHead(<p className="text-xl font-extrabold tracking-tight">{PRICE}</p>)}
        <ul className="flex flex-col gap-2 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          <li className="flex gap-2.5">
            <Moon aria-hidden />
            Close your laptop. Your teammates keep working.
          </li>
          <li className="flex gap-2.5">
            <Clock aria-hidden />
            Schedules and triggers run on time, even at 3&nbsp;a.m.
          </li>
          <li className="flex gap-2.5">
            <Wallet aria-hidden />
            Runs on your Claude or ChatGPT plan, so no API bill
          </li>
        </ul>
        <Button size="lg" disabled={busy} onClick={subscribe}>
          Get Brigade Cloud
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Ready in a few minutes. Cancel anytime.
        </p>
      </CardContent>
    </Card>
  ) : cloudUsable ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {cloudHead(<StatusBadge status={cloudUsable.online ? 'online' : 'starting'} />)}
        {signInButtons(cloudUsable.id)}
        {!cloudUsable.online && signingIn.length === 0 && (
          <p className="text-center text-xs text-muted-foreground">
            Your cloud computer is starting. Sign-in begins as soon as it is up, which takes a few
            minutes the first time.
          </p>
        )}
      </CardContent>
    </Card>
  ) : preparing ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {cloudHead(<StatusBadge status="active" />)}
        <Waiting title="Getting your cloud computer ready…">
          A few minutes the first time. Sign-in opens here as soon as it is up.
        </Waiting>
      </CardContent>
    </Card>
  ) : failed ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {cloudHead(<StatusBadge status="error" />)}
        <p className="text-sm text-muted-foreground">
          Your cloud computer could not be set up. Try again, or use your own computer.
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
      </CardContent>
    </Card>
  ) : null

  const free = <StatusBadge status="free" tone="success" />
  const until = link && new Date(link.expiresAt).toLocaleTimeString([], { timeStyle: 'short' })

  const machineCard = machine ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={device === 'mac' ? <AppleLogo /> : <Laptop />}
          title={machineName(machine)}
          meta="Your computer · linked"
          aside={<StatusBadge status="online" />}
        />
        {signingIn.length === 0 && (
          <>
            <p className="text-sm text-muted-foreground">
              No Claude or Codex login on it yet. Sign in on the vendor&apos;s page:
            </p>
            {signInButtons(machine.id)}
            <p className="text-center text-xs text-muted-foreground">
              Already signed in with <code>claude</code> or <code>codex</code> in a terminal? It
              shows up here by itself.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  ) : device === 'mac' ? (
    <Card className={cn(!link && 'bg-transparent shadow-none')}>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<AppleLogo />}
          title="Run them on this Mac"
          meta="Uses the Claude or Codex login already on it. Your teammates work while your Mac is awake."
          aside={free}
        />
        {!link ? (
          <>
            <Button variant="outline" size="lg" asChild>
              <a href={MAC_APP_URL} onClick={() => void getLink()}>
                <AppleLogo />
                Download Brigade for Mac
              </a>
            </Button>
            <button
              type="button"
              className="text-center text-xs text-muted-foreground"
              onClick={() => {
                setTerminal(true)
                void getLink()
              }}
            >
              Prefer a terminal?{' '}
              <span className="text-foreground underline underline-offset-4">
                Get the install command
              </span>
            </button>
          </>
        ) : terminal || !link.appLink ? (
          <>
            <p className="text-sm text-muted-foreground">Run this in a terminal on your Mac:</p>
            <Command command={link.command} />
            <Waiting title="Waiting for your Mac…">
              This page goes on by itself once it connects. The code works once, until {until}.
            </Waiting>
          </>
        ) : (
          <>
            <ol className="flex flex-col gap-3.5 text-sm">
              <li className="flex gap-3">
                <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check aria-hidden className="size-3" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">Download Brigade for Mac</span>
                  <a
                    href={MAC_APP_URL}
                    className="text-xs text-muted-foreground underline underline-offset-4"
                  >
                    Download again
                  </a>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full border border-primary text-xs font-semibold text-primary">
                  2
                </span>
                <span className="flex flex-col items-start gap-2">
                  <span className="font-semibold">Open it and link this workspace</span>
                  <span className="text-xs text-muted-foreground">
                    Brigade.app asks before it installs anything.
                  </span>
                  <Button asChild>
                    <a href={link.appLink}>
                      <ExternalLink aria-hidden />
                      Open in Brigade
                    </a>
                  </Button>
                </span>
              </li>
            </ol>
            <Waiting title="Waiting for your Mac…">
              This page goes on by itself once it connects. The link works once, until {until}.
            </Waiting>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer text-center">Or run it in a terminal</summary>
              <div className="mt-2.5">
                <Command command={link.command} />
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  ) : device === 'linux' ? (
    <Card className={cn(!link && 'bg-transparent shadow-none')}>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<Terminal />}
          title="Run them on this machine"
          meta="Uses the claude or codex login already on it. Your teammates work while it is on."
          aside={free}
        />
        {link ? (
          <>
            <p className="text-sm text-muted-foreground">Run this in a terminal on it:</p>
            <Command command={link.command} />
            <Waiting title="Waiting for your machine…">
              This page goes on by itself once it connects. The code works once, until {until}.
            </Waiting>
          </>
        ) : (
          <Button variant="outline" className="self-start" onClick={() => void getLink()}>
            Get the install command
          </Button>
        )}
      </CardContent>
    </Card>
  ) : device === 'other' ? (
    <Card className="bg-transparent shadow-none">
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<Laptop />}
          title="Have a Mac or Linux machine?"
          meta="Your teammates can run there, on its Claude or Codex login"
          aside={free}
        />
        {link ? (
          <>
            <p className="text-sm text-muted-foreground">Run this in a terminal on it:</p>
            <Command command={link.command} />
            <Waiting title="Waiting for your machine…">
              This page goes on by itself once it connects. The code works once, until {until}.
            </Waiting>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Open this page on it to link it, or link it later from Computers.{' '}
            <button
              type="button"
              className="text-foreground underline underline-offset-4"
              onClick={() => void getLink()}
            >
              Get the install command
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  ) : null

  return (
    <Shell
      title="Give your teammates a computer"
      description="They work on a computer of their own, using your Claude or ChatGPT plan. Use Brigade Cloud, your own computer, or both."
    >
      <div className="-mt-3 flex justify-center gap-2">
        {(['claude_code', 'codex'] as const).map((harness) => (
          <span
            key={harness}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary px-3 text-xs font-semibold"
          >
            <HarnessLogo harness={harness} className="size-3.5" />
            {harnessLabel(harness)}
          </span>
        ))}
      </div>

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

      {!computers.data ? (
        <p className="text-center text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {cloudCard}
          {cloudCard && machineCard && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
              {planNeeded ? 'or, for free' : 'and, for free'}
            </div>
          )}
          {machineCard}
          {cloudCompact && (
            <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
              <Tile violet>
                <Cloud />
              </Tile>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-semibold">Brigade Cloud · {PRICE}</p>
                <p className="text-xs text-muted-foreground">
                  Your teammates keep working when your computer sleeps
                </p>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={subscribe}>
                Start
              </Button>
            </div>
          )}
        </>
      )}

      {error && <p className="text-center text-sm text-destructive-text">{error}</p>}
    </Shell>
  )
}
