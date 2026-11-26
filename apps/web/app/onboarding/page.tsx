'use client'
import {
  Check,
  ChevronDown,
  Cloud,
  ExternalLink,
  Laptop,
  Moon,
  Timer,
  Wallet,
  Terminal,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AccountCard, machineName } from '@/components/account-card'
import { HarnessLogo } from '@/components/harness-logo'
import { StatusBadge } from '@/components/status-badge'
import { SetupWorkspaceSwitcher } from '@/components/workspace-switcher'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  api,
  ApiError,
  subscribeToCloud,
  useApi,
  usableComputers,
  type Account,
  type AccountLogin,
  type ComputersResponse,
  type Me,
  type OpenInvitation,
  type Teammate,
} from '@/lib/api'
import { inDesktopApp } from '@/lib/brigade-app'
import { rememberTeammate } from '@/lib/last-teammate'
import { computerTaken } from '@/lib/guest'
import { detectDevice, type Device } from '@/lib/device'
import { LINUX_APPIMAGE_URL, LINUX_DEB_URL } from '@/lib/linux-app'
import { MAC_APP_URL } from '@/lib/mac-app'
import { useWindowsAppReady, WINDOWS_APP_URL, WINDOWS_UNSIGNED_HINT } from '@/lib/windows-app'
import { markSignedIn, markSignedOut } from '@/lib/signed-in'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'
import { Questions } from './questions'
import { Shell } from './shell'

/**
 * First run: the project (its organization and first workspace) is made at once, named after
 * the person, then they connect an AI account and meet the chief. Also where a new workspace is made, and
 * where a member without an AI account in this workspace is sent.
 */
export default function Onboarding() {
  const router = useRouter()
  const [me, setMe] = useState<Me>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // A member who has a workspace and an AI account came here to add a workspace.
  const [adding, setAdding] = useState<boolean>()
  // Who just made their project answers onboarding's questions next, once.
  const [asking, setAsking] = useState(false)
  // A form sent and not answered yet: a second Enter or click meanwhile sends nothing. Not
  // `<form action>`: React runs an action as a transition and shows its `busy` only once it
  // ends, so the button stayed enabled and each click made another organization.
  const sending = useRef(false)
  const onSubmit =
    (send: (form: FormData) => Promise<void>) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (sending.current) return
      sending.current = true
      void send(new FormData(event.currentTarget)).finally(() => {
        sending.current = false
      })
    }

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

  // Someone invited and not in an organization yet: join one rather than start their own.
  // Undefined until read: without any, their project is made at once, with no form to fill.
  // 'failed' when they could not be read: then nothing is made, since they may have some.
  const [invitations, setInvitations] = useState<OpenInvitation[] | 'failed'>()
  const noOrganization = !!me && !me.activeOrganizationId
  const readInvitations = useCallback(() => {
    setInvitations(undefined)
    api<OpenInvitation[]>('/invitations')
      .then(setInvitations)
      .catch(() => setInvitations('failed'))
  }, [])
  useEffect(() => {
    if (noOrganization) readInvitations()
  }, [noOrganization, readInvitations])

  async function join(invitation: OpenInvitation) {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/invitations/${encodeURIComponent(invitation.id)}/accept`, { body: {} })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  /**
   * Their own organization and its first workspace, both named after them ("Ada's workspace"):
   * onboarding asks no name, and Settings › Workspace renames it. The API makes them once per
   * person, so a second tab or a reload meanwhile makes no second one.
   */
  async function createProject() {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await api('/me/first-workspace', { body: {} })
      const next = await reload()
      // Not in Brigade.app, where onboarding goes straight to this computer and Chief.
      setAsking(next?.onboardingAnswers === null && !inDesktopApp())
    } catch (e) {
      setError((e as Error).message)
      await reload()
    }
    setBusy(false)
    sending.current = false
  }

  // Invited nowhere (read, not failed): their project is made straight away; and one whose setup
  // was cut (a failure or a reload during it) is finished the same way. Once per page (a ref,
  // for React's double effects in development); the API sees to other tabs.
  const autoCreated = useRef(false)
  const autoCreate =
    (noOrganization && Array.isArray(invitations) && invitations.length === 0) || !!me?.setupPending
  useEffect(() => {
    if (!autoCreate || autoCreated.current) return
    autoCreated.current = true
    void createProject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCreate])

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
    if (invitations === 'failed')
      return (
        <Shell>
          <div className="flex flex-col items-center gap-3">
            <p className="text-center text-sm text-destructive-text">
              Could not reach Brigade. Check your connection and try again.
            </p>
            <Button onClick={readInvitations}>Try again</Button>
          </div>
        </Shell>
      )
    if (!invitations?.length)
      return (
        <Shell>
          {error ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm text-destructive-text">{error}</p>
              <Button disabled={busy} onClick={() => void createProject()}>
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Setting up your workspace…</p>
          )}
        </Shell>
      )
    return (
      <Shell
        title="You were invited"
        description="Join your team, or start a workspace of your own."
      >
        <Card>
          <CardContent className="flex flex-col gap-4">
            {invitations.map((i) => (
              <div key={i.id} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{i.organization}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Invited by {i.invitedBy}
                  </span>
                </div>
                <Button disabled={busy} onClick={() => void join(i)}>
                  Join
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
        {error && <p className="text-center text-sm text-destructive-text">{error}</p>}
        <Button variant="ghost" disabled={busy} onClick={() => void createProject()}>
          Start my own workspace
        </Button>
      </Shell>
    )
  }

  if (me.setupPending)
    return (
      <Shell>
        {error ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-center text-sm text-destructive-text">{error}</p>
            <Button disabled={busy} onClick={() => void createProject()}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground">Setting up your workspace…</p>
        )}
      </Shell>
    )

  if (me.activeWorkspaceId && !adding && asking)
    return (
      <Questions
        onDone={() => {
          setAsking(false)
          void reload()
        }}
      />
    )

  // Stays up once the account works, while the chief's thread starts.
  if (me.activeWorkspaceId && !adding)
    return (
      <>
        <SetupWorkspaceSwitcher me={me} />
        <ConnectAI onReady={reload} guest={!!me.guest} />
      </>
    )

  return (
    <>
      <SetupWorkspaceSwitcher me={me} />
      <Shell
        title="Create a workspace"
        description="A workspace is one business or project. It has its own AI teammates, computer and run log."
      >
        <Card>
          <CardContent>
            <form onSubmit={onSubmit(createWorkspace)} className="flex flex-col gap-5">
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
    </>
  )
}

type LinkCode = { command: string; expiresAt: string; appLink?: string; issuedAt: number }

/** How long a machine may take to connect after its command before the page says what to look for. */
const RELEASES_URL = 'https://github.com/gmpetrov/brigade/releases/latest'
const SLOW_LINK_MS = 90_000

/** Apple's mark, in the text color, for the Mac download. */
function AppleLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className={cn('size-4', className)}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  )
}

/** Windows' mark, in the text color, for the Windows download. */
function WindowsLogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className={cn('size-4', className)}>
      <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
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
  meta?: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <Tile violet={violet}>{icon}</Tile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-bold">{title}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
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

/**
 * What stops the install command, as the terminal shows it: the page cannot see that terminal,
 * so it says what to look for once the machine is slow to connect.
 */
function TerminalHelp({ onNewCode }: { onNewCode: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border px-3.5 py-3 text-xs text-muted-foreground">
      <p className="text-sm text-foreground">Still nothing? Look at the terminal:</p>
      <ul className="flex list-disc flex-col gap-1.5 pl-4">
        <li>
          <code>curl: command not found</code>: install curl (on Debian or Ubuntu,{' '}
          <code>sudo apt install curl</code>), then run the command again.
        </li>
        <li>
          <code>Could not link</code>: each code links one machine, once, for 10 minutes.{' '}
          <button
            type="button"
            className="text-foreground underline underline-offset-4"
            onClick={onNewCode}
          >
            Get a new code
          </button>{' '}
          and run the new command.
        </li>
        <li>
          <code>connected to</code> and nothing here: keep that terminal open, this page follows in
          a few seconds.
        </li>
      </ul>
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

/**
 * Cloud's entry plan, the only one onboarding offers, in its card and in its one line: 100 hours
 * a month. Max is chosen later in Billing; the line once offered it at $99, and people after a
 * $15 plan met eight times the price.
 */
const STARTER_PRICE = (
  <>
    $15<span className="text-xs font-medium text-muted-foreground"> / month</span>
  </>
)

/**
 * Nothing runs without an AI account on a computer: Brigade Cloud first, then
 * the member's own machine, for free, offered as this device allows (Brigade.app
 * on a Mac, the install command on Linux). Not one or the other: the second can
 * be added later from Computers. Once an account works, the chief's setup
 * thread starts.
 */
function ConnectAI({
  onReady,
  guest,
}: {
  onReady: () => Promise<Me | undefined>
  /** A guest (docs/guests.md): their own computer only, Brigade Cloud once the account is saved. */
  guest: boolean
}) {
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
  // A link code expires: the page offers a new one once it has.
  const [now, setNow] = useState(() => Date.now())
  const [finishing, setFinishing] = useState(false)
  // The live update and the timer can both see the account ready: start one thread.
  const started = useRef(false)

  /**
   * Meet the chief: a new workspace's owner or admin lands on Chief's first meeting
   * (components/first-meeting.tsx), which asks for their website and starts the setup thread
   * once they send it: nothing is sent in their name. Anyone else (a member who joined, a
   * workspace with a team already) goes to the dashboard.
   */
  const finish = useCallback(
    async (me: Me) => {
      if (started.current) return
      started.current = true
      setFinishing(true)
      try {
        const [teammates, ready] = await Promise.all([
          api<Teammate[]>('/teammates'),
          api<Account[]>('/accounts'),
        ])
        const chief = teammates.find((t) => t.kind === 'chief')
        const others = teammates.filter((t) => t.kind !== 'chief')
        // Changing the chief is an owner's or admin's: a member's account would be refused.
        if (!chief || others.length > 0 || (me.role !== 'owner' && me.role !== 'admin'))
          return router.replace('/app')
        const works = (a: Account) => ['ready', 'unverified', 'exhausted'].includes(a.status)
        // Only a Codex account: the chief runs on Codex.
        if (
          !ready.some((a) => works(a) && a.provider === chief.harness) &&
          ready.some((a) => works(a))
        ) {
          const harness = ready.find(works)!.provider
          await api(`/teammates/${chief.id}`, { method: 'PATCH', body: { harness, model: null } })
        }
        // The threads page on Chief: before its first thread, its first meeting.
        rememberTeammate(chief.id)
        router.replace('/app/threads')
      } catch (e) {
        setError((e as Error).message)
        started.current = false
        setFinishing(false)
      }
    },
    [router],
  )

  const check = useCallback(async () => {
    const me = await onReady()
    if (me?.aiReady) await finish(me)
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
      setNow(Date.now())
    }, 5000)
    return () => clearInterval(timer)
  }, [reloadAccounts, reloadComputers, check])

  useEffect(() => setDevice(detectDevice(navigator.userAgent)), [])
  // Windows gets Brigade.app's download once the latest release runs teammates there.
  const windowsReady = useWindowsAppReady()

  const getLink = useCallback(() => {
    setError(undefined)
    return api<Omit<LinkCode, 'issuedAt'>>('/computers/link-code', { method: 'POST' })
      .then((issued) => {
        setLink({ ...issued, issuedAt: Date.now() })
        return issued
      })
      .catch((e: Error) => {
        setError(e.message)
        return undefined
      })
  }, [])
  // In Brigade.app's own window, it is this computer: its link goes straight to the app, which
  // asks before it connects (apps/desktop/src/links.ts).
  const [inApp, setInApp] = useState(false)
  useEffect(() => setInApp(inDesktopApp()), [])
  const linkHere = useCallback(async () => {
    const issued = await getLink()
    if (issued?.appLink) location.href = issued.appLink
  }, [getLink])

  const all = computers.data?.computers ?? []
  const usable = usableComputers(computers.data)
  const cloud = all.find((c) => c.kind === 'cloud')
  const cloudUsable = usable.find((c) => c.kind === 'cloud')
  const machine = all.find((c) => c.kind === 'member_machine' && c.online)
  const signingIn = (accounts.data ?? []).filter((a) => a.source === 'brigade')
  // A sign-in under way on this computer; one that failed, or on another computer, leaves its buttons.
  const signingInOn = (computerId: string) =>
    signingIn.some((a) => {
      const login = logins[a.id] ?? a.login
      return (
        a.computer.id === computerId &&
        a.status === 'signing_in' &&
        login?.state !== 'done' &&
        login?.state !== 'failed'
      )
    })
  const offerCloud = !guest && !!computers.data?.cloudAvailable
  // With billing on, the cloud computer comes with Brigade Cloud: their own machine is free.
  const planNeeded = offerCloud && !computers.data?.cloudEntitled
  // A new workspace's computer is still being made: sign-in opens once it starts.
  const preparing =
    !cloudUsable &&
    (cloud ? ['pending', 'creating'].includes(cloud.status) : offerCloud && !planNeeded)
  const failed = !cloudUsable && cloud?.status === 'error'
  // Once they set up their own machine, Brigade Cloud steps back to one line; in Brigade.app from
  // the start, where this computer is the way in.
  const cloudCompact = planNeeded && (inApp || !!link || !!machine)

  // In Brigade.app, this computer links at once, once: the app asks before it connects
  // (apps/desktop/src/links.ts). Not when it runs another workspace's teammates already: the link
  // would stop them, so it links by the button, which the app asks about first (docs/guests.md).
  const linkedHere = useRef(false)
  useEffect(() => {
    if (!inApp || !computers.data || machine || linkedHere.current) return
    linkedHere.current = true
    void computerTaken().then((taken) => {
      if (!taken.linked && !taken.linking) void linkHere()
    })
  }, [inApp, computers.data, machine, linkHere])

  // On Chromebooks the command is the way in: show it straight away.
  const linuxLink = useRef(false)
  useEffect(() => {
    if (device !== 'chromeos' || !computers.data || machine) return
    if (linuxLink.current) return
    linuxLink.current = true
    void getLink()
  }, [device, computers.data, machine, getLink])

  async function signIn(computerId: string, provider: Account['provider']) {
    setBusy(true)
    setError(undefined)
    // One that never got through is signed in again by the API itself (POST /accounts), from
    // its own rows: another click makes no second card.
    try {
      await api('/accounts', { body: { computerId, provider, retry: true } })
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

  function subscribe(tier: 'cloud' | 'starter' = 'cloud') {
    setBusy(true)
    void act(subscribeToCloud('onboarding', tier)).then(() => setBusy(false))
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
    !signingInOn(computerId) && (
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
        {cloudHead(<p className="text-xl font-extrabold tracking-tight">{STARTER_PRICE}</p>)}
        <ul className="flex flex-col gap-2 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          <li className="flex gap-2.5">
            <Moon aria-hidden />
            Works with your laptop closed
          </li>
          <li className="flex gap-2.5">
            <Timer aria-hidden />
            100 hours of cloud computer a month
          </li>
          <li className="flex gap-2.5">
            <Wallet aria-hidden />
            Uses your Claude or ChatGPT plan
          </li>
        </ul>
        <Button size="lg" disabled={busy} onClick={() => subscribe('starter')}>
          Start with Cloud
        </Button>
      </CardContent>
    </Card>
  ) : cloudUsable ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {cloudHead(<StatusBadge status={cloudUsable.online ? 'online' : 'starting'} />)}
        {signInButtons(cloudUsable.id)}
        {!cloudUsable.online && !signingInOn(cloudUsable.id) && (
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
  /** Brigade.app's download and link, where it runs teammates: a Mac, a Linux desktop (a .deb,
   * or the AppImage for other distributions), or a Windows PC. */
  const app: {
    os: string
    name: string
    icon: React.ReactNode
    url: string
    meta: string
    asks: string
    terminal: boolean
    label?: string
  } | null =
    device === 'linux'
      ? {
          os: 'Linux',
          name: 'computer',
          icon: <Laptop />,
          url: LINUX_DEB_URL,
          label: 'Download Brigade for Linux (.deb)',
          meta: 'Uses the Claude or Codex login already on it. Your teammates work while it is on.',
          asks: 'Brigade asks before it installs anything.',
          terminal: true,
        }
      : device === 'mac'
        ? {
            os: 'Mac',
            name: 'Mac',
            icon: <AppleLogo />,
            url: MAC_APP_URL,
            meta: 'Uses the Claude or Codex login already on it. Your teammates work while your Mac is awake.',
            asks: 'Brigade.app asks before it installs anything.',
            terminal: true,
          }
        : device === 'windows' && windowsReady
          ? {
              os: 'Windows',
              name: 'PC',
              icon: <WindowsLogo />,
              url: WINDOWS_APP_URL,
              meta: 'You sign in to Claude or ChatGPT once it is linked. Your teammates work while your PC is on.',
              asks: 'Brigade asks before it installs anything, then sets itself up in a few minutes.',
              terminal: false,
            }
          : null
  /** Every build of Brigade.app, for the download menu (as on the landing page's hero). */
  const downloads = [
    {
      name: 'macOS',
      detail: 'Apple Silicon and Intel · .dmg',
      url: MAC_APP_URL,
      icon: <AppleLogo />,
    },
    { name: 'Windows', detail: 'Installer · .exe', url: WINDOWS_APP_URL, icon: <WindowsLogo /> },
    { name: 'Linux · Ubuntu, Debian', detail: '.deb', url: LINUX_DEB_URL, icon: <Laptop /> },
    { name: 'Linux · other', detail: '.AppImage', url: LINUX_APPIMAGE_URL, icon: <Laptop /> },
  ]
  const until = link && new Date(link.expiresAt).toLocaleTimeString([], { timeStyle: 'short' })
  const expired = !!link && Date.parse(link.expiresAt) <= now
  const slow = !!link && now - link.issuedAt >= SLOW_LINK_MS
  /** Waiting for the machine while its code works; a new code once it expired. */
  const waitFor = (what: string, code: 'code' | 'link') =>
    expired ? (
      <div className="flex flex-col items-start gap-2 rounded-xl bg-muted px-3.5 py-3">
        <p className="text-sm">
          This {code} expired before your {what} connected.
        </p>
        <Button size="sm" variant="outline" onClick={() => void getLink()}>
          Get a new {code}
        </Button>
      </div>
    ) : (
      <Waiting title={`Waiting for your ${what}…`}>
        This page goes on by itself once it connects. The {code} works once, until {until}.
      </Waiting>
    )

  const machineCard = machine ? (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={device === 'mac' ? <AppleLogo /> : <Laptop />}
          title={machineName(machine)}
          meta="Your computer · linked"
          aside={<StatusBadge status="online" />}
        />
        {!signingInOn(machine.id) && (
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
  ) : app ? (
    <Card className={cn(!link && 'bg-transparent shadow-none')}>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<Laptop />}
          title="Run them on your computer"
          meta="Free · works while your computer is on"
          aside={cloudCard ? undefined : free}
        />
        {inApp && !terminal ? (
          <>
            <Button size="lg" onClick={() => void linkHere()}>
              {app.icon}
              Link this {app.name}
            </Button>
            {link && waitFor(app.name, 'link')}
          </>
        ) : !link ? (
          <>
            {/* A split button like the landing hero's (components/landing/download-button.tsx),
                sized as the Starter CTA: this system's build, and the others in the menu. */}
            <div className="flex w-full">
              <Button size="lg" variant="outline" className="flex-1 rounded-r-none" asChild>
                <a href={app.url} onClick={() => void getLink()}>
                  {app.icon}
                  {app.label ?? `Download Brigade for ${app.os}`}
                </a>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-l-none border-l-0 px-3 has-[>svg]:px-3"
                    aria-label="Other platforms"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Download Brigade.app</DropdownMenuLabel>
                  {downloads.map((d) => (
                    <DropdownMenuItem key={d.url} asChild>
                      <a href={d.url} onClick={() => void getLink()}>
                        {d.icon}
                        <span className="flex flex-col">
                          <span className="font-medium">{d.name}</span>
                          <span className="text-xs text-muted-foreground">{d.detail}</span>
                        </span>
                      </a>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      All releases on GitHub
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        ) : terminal || !link.appLink ? (
          <>
            <p className="text-sm text-muted-foreground">
              Run this in a terminal on {device === 'mac' ? 'your Mac' : 'it'}:
            </p>
            <Command command={link.command} />
            {waitFor(device === 'mac' ? 'Mac' : 'machine', 'code')}
            {device === 'linux' && slow && !expired && (
              <TerminalHelp onNewCode={() => void getLink()} />
            )}
          </>
        ) : (
          <>
            <ol className="flex flex-col gap-3.5 text-sm">
              <li className="flex gap-3">
                <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check aria-hidden className="size-3" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">Download Brigade for {app.os}</span>
                  <a
                    href={app.url}
                    className="text-xs text-muted-foreground underline underline-offset-4"
                  >
                    Download again
                  </a>
                  {device === 'windows' && (
                    <span className="text-xs text-muted-foreground">{WINDOWS_UNSIGNED_HINT}</span>
                  )}
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full border border-primary text-xs font-semibold text-primary">
                  2
                </span>
                <span className="flex flex-col items-start gap-2">
                  <span className="font-semibold">Open it and link this workspace</span>
                  <span className="text-xs text-muted-foreground">{app.asks}</span>
                  {!expired && (
                    <Button asChild>
                      <a href={link.appLink}>
                        <ExternalLink aria-hidden />
                        Open in Brigade
                      </a>
                    </Button>
                  )}
                </span>
              </li>
            </ol>
            {waitFor(app.name, 'link')}
            {app.terminal && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer text-center">Or run it in a terminal</summary>
                <div className="mt-2.5">
                  <Command command={link.command} />
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  ) : device === 'chromeos' ? (
    <Card className={cn(!link && 'bg-transparent shadow-none')}>
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<Terminal />}
          title="Run them on this Chromebook"
          meta="In its Linux environment, on the claude or codex login there. Your teammates work while it is on."
          aside={free}
        />
        {link ? (
          <>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
              <li>
                Turn on Linux: Settings, About ChromeOS, Developers, Linux development environment,
                Set up. Skip this if the Terminal app already lists <code>penguin</code>.
              </li>
              <li>
                Open the Terminal app and pick <code>penguin</code>. Not Ctrl+Alt+T: that terminal,
                crosh, can&apos;t run the command.
              </li>
              <li>Run this there:</li>
            </ol>
            <Command command={link.command} />
            {waitFor('Chromebook', 'code')}
            {slow && !expired && <TerminalHelp onNewCode={() => void getLink()} />}
          </>
        ) : (
          <Button variant="outline" className="self-start" onClick={() => void getLink()}>
            Get the install command
          </Button>
        )}
      </CardContent>
    </Card>
  ) : device === 'other' || (device === 'windows' && windowsReady === false) ? (
    <Card className="bg-transparent shadow-none">
      <CardContent className="flex flex-col gap-4">
        <CardHead
          icon={<Laptop />}
          title={
            device === 'windows'
              ? "Teammates don't run on Windows yet"
              : 'Have a Mac or Linux machine?'
          }
          meta={
            device === 'windows'
              ? 'They run for free on a Mac or Linux machine, on its Claude or Codex login'
              : 'Your teammates can run there, on its Claude or Codex login'
          }
          aside={free}
        />
        {link ? (
          <>
            <p className="text-sm text-muted-foreground">Run this in a terminal on it:</p>
            <Command command={link.command} />
            {waitFor('machine', 'code')}
            {slow && !expired && <TerminalHelp onNewCode={() => void getLink()} />}
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
    <Shell title="Give your teammates a computer">
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
                <p className="text-sm font-semibold">Brigade Cloud · {STARTER_PRICE}</p>
                <p className="text-xs text-muted-foreground">
                  Your teammates keep working when your computer sleeps
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => subscribe('starter')}
              >
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
