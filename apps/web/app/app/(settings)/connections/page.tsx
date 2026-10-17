'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { CircleCheck, ShieldCheck } from 'lucide-react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { AppSheet } from '@/components/app-sheet'
import { ProviderTile } from '@/components/provider-logo'
import { Skills } from '@/components/skills'
import { Card } from '@/components/ui/card'
import {
  useApi,
  type App,
  type Connection,
  type ConnectionsResponse,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'

type Kind = Connection['kind']

/** Why an account was not connected, from the error a provider's redirect brought back. */
const CONNECT_ERRORS: Record<string, string> = {
  expired: 'The request expired. Start again.',
  forbidden: 'You are no longer in this workspace.',
  declined: 'Access was not granted.',
  google: 'Google did not complete the sign-in. Try again.',
  mcp: 'The sign-in did not complete. Try again.',
  github: 'GitHub did not complete the sign-in. Try again.',
  github_requested:
    "Your request to install Brigade was sent to the GitHub organization's owners. Connect GitHub again once they approve it.",
  github_not_yours:
    'Your GitHub account cannot reach that installation. Sign in to GitHub as someone who can, and try again.',
}

/**
 * The built-in Apps, in the order the page offers them. An MCP server and a custom app
 * can be added many times.
 */
const BUILT_IN: Kind[] = [
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_sheets',
  'github',
  'cloudflare',
  'google_cloud',
  'neon',
  'supabase',
  'stripe',
]

/** The App sheet that is open: an added App, or one from the catalog not added yet. */
type Open = { kind: Kind; appId?: string }

export default function AppsPage() {
  return (
    <Suspense>
      <Apps />
    </Suspense>
  )
}

function Apps() {
  const params = useSearchParams()
  // Back from a provider in the sign-in tab: the page that opened it shows the account.
  if (params.get('popup')) return <SignedIn error={params.get('error')} />
  return <AppsList />
}

/** The sign-in tab's last page: closes itself, or says to. */
function SignedIn({ error }: { error: string | null }) {
  useEffect(() => {
    if (!error) window.close()
  }, [error])
  return (
    <div className="flex flex-col gap-2 py-16 text-center">
      <p className="font-semibold">{error ? 'The account was not connected.' : 'Connected.'}</p>
      <p className="text-sm text-muted-foreground">
        {error
          ? (CONNECT_ERRORS[error] ?? `(${error})`)
          : 'You can close this tab and go back to Brigade.'}
      </p>
    </div>
  )
}

function AppsList() {
  const { me } = useDashboard()
  const params = useSearchParams()
  const router = useRouter()
  const data = useApi<ConnectionsResponse>('/connections')
  const triggers = useApi<Trigger[]>('/triggers')
  const catalog = useApi<TriggerCatalog>('/triggers/catalog')
  const [open, setOpen] = useState<Open>()

  const connections = data.data?.connections ?? []
  const accountsOf = (app: App) => connections.filter((c) => c.appId === app.id)
  // An App is added while it has an account; one whose accounts were all removed is offered again.
  const added = (data.data?.apps ?? [])
    .map((app) => ({ app, accounts: accountsOf(app) }))
    .filter((a) => a.accounts.length > 0)
  const kindOf = (a: (typeof added)[number]) => a.accounts[0]!.kind
  const offered = BUILT_IN.filter((kind) => !added.some((a) => kindOf(a) === kind))

  // Back from a provider's sign-in: open the App the new account belongs to.
  const connected = params.get('connected')
  const [shown, setShown] = useState<string>()
  useEffect(() => {
    const account = connected && connections.find((c) => c.id === connected)
    if (!account || shown === account.id) return
    setShown(account.id)
    setOpen({ kind: account.kind, appId: account.appId })
  }, [connected, connections, shown])

  function close() {
    setOpen(undefined)
    if (connected || params.get('error')) router.replace('/app/connections')
  }

  const reload = () => Promise.all([data.reload(), triggers.reload()])
  // A built-in App opened from the catalog becomes the added one once its first account connects.
  const sheetApp = data.data?.apps.find((a) =>
    open?.appId ? a.id === open.appId : a.key === open?.kind,
  )

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight">Apps</h1>
        <p className="max-w-prose text-muted-foreground">
          The services your teammates work in. Connect your accounts, then choose which teammates
          get each one.
        </p>
        <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-foreground" aria-hidden />
          <p>
            <span className="font-semibold text-accent-foreground">
              An account’s key stays encrypted in Brigade and never reaches a computer:
            </span>{' '}
            every call goes through Brigade, which checks the teammate&apos;s access, asks a person
            before changes when its policy says so, and logs the call.
          </p>
        </div>
        {connected && (
          <p className="flex items-center gap-2 rounded-lg bg-success/15 p-3 text-sm font-semibold text-success">
            <CircleCheck className="size-4" aria-hidden />
            Connected.
          </p>
        )}
        {params.get('error') && (
          <p className="text-sm text-destructive-text">
            The account was not connected.{' '}
            {CONNECT_ERRORS[params.get('error')!] ?? `(${params.get('error')})`}
          </p>
        )}
      </header>

      {data.data && (
        <>
          <section aria-labelledby="added" className="flex flex-col gap-3">
            <h2 id="added" className="text-lg font-bold tracking-tight">
              Added <span className="font-semibold text-muted-foreground">{added.length}</span>
            </h2>
            {added.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Apps yet. Add one below.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {added.map(({ app, accounts }) => {
                  const kind = kindOf({ app, accounts })
                  const reconnect = accounts.some((c) => c.status === 'needs_reauth')
                  return (
                    <AppTile
                      key={app.id}
                      kind={kind}
                      icons={app.mcp?.icons}
                      name={app.name ?? data.data!.catalog[kind].name}
                      detail={
                        reconnect
                          ? 'Reconnect needed'
                          : kind === 'webhook'
                            ? 'Custom app'
                            : app.mcp?.auth === 'none'
                              ? new URL(app.mcp.url).host
                              : accounts.length === 1
                                ? (accounts[0]!.externalAccount ?? accounts[0]!.label)
                                : `${accounts.length} accounts`
                      }
                      warn={reconnect}
                      onClick={() => setOpen({ kind, appId: app.id })}
                    />
                  )
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="more" className="flex flex-col gap-3">
            <h2 id="more" className="text-lg font-bold tracking-tight">
              Add an App
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[...offered, 'mcp' as const, 'webhook' as const].map((kind) => (
                <AppTile
                  key={kind}
                  kind={kind}
                  name={data.data!.catalog[kind].name}
                  detail={data.data!.catalog[kind].description}
                  onClick={() => setOpen({ kind })}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <Skills admin={isAdmin(me)} />

      {open && data.data && (
        <AppSheet
          key={open.appId ?? open.kind}
          kind={open.kind}
          app={sheetApp}
          data={data.data}
          triggers={triggers.data ?? []}
          catalog={catalog.data}
          reload={reload}
          onClose={close}
          onAdded={(appId) => setOpen({ kind: 'mcp', appId })}
        />
      )}
    </div>
  )
}

function AppTile({
  kind,
  icons,
  name,
  detail,
  warn,
  onClick,
}: {
  kind: Kind
  icons?: string[]
  name: string
  detail: string
  warn?: boolean
  onClick: () => void
}) {
  return (
    <Card className="gap-0 p-0 transition-colors hover:bg-accent/50">
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-4 rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ProviderTile kind={kind} icons={icons} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-semibold">{name}</span>
          <span
            className={
              warn
                ? 'truncate text-sm text-destructive-text'
                : 'line-clamp-2 text-sm text-muted-foreground'
            }
          >
            {detail}
          </span>
        </span>
      </button>
    </Card>
  )
}
