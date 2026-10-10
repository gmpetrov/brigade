'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { CircleCheck, ExternalLink, ShieldCheck } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { ConnectionTriggers } from '@/components/connection-triggers'
import { ProviderTile } from '@/components/provider-logo'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import {
  api,
  useApi,
  type Connection,
  type ConnectionCall,
  type ConnectionsResponse,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'

/** Why a connection was not created, from the error a provider's redirect brought back. */
const CONNECT_ERRORS: Record<string, string> = {
  expired: 'The request expired. Start again.',
  forbidden: 'Only an owner or admin of this workspace can add connections.',
  declined: 'Access was not granted.',
  google: 'Google did not complete the sign-in. Try again.',
  github: 'GitHub did not complete the sign-in. Try again.',
  github_requested:
    "Your request to install Brigade was sent to the GitHub organization's owners. Connect GitHub again once they approve it.",
  github_not_yours:
    'Your GitHub account cannot reach that installation. Sign in to GitHub as someone who can, and try again.',
}

export default function ConnectionsPage() {
  return (
    <Suspense>
      <Connections />
    </Suspense>
  )
}

function Connections() {
  const { me, teammates } = useDashboard()
  const params = useSearchParams()
  const data = useApi<ConnectionsResponse>('/connections')
  const triggers = useApi<Trigger[]>('/triggers')
  const catalog = useApi<TriggerCatalog>('/triggers/catalog')
  const [open, setOpen] = useState<{ id: string; tab: 'log' | 'triggers' }>()
  const [stripeOpen, setStripeOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [error, setError] = useState<string>()
  const admin = isAdmin(me)
  const name = (teammateId: string) =>
    teammates.find((t) => t.id === teammateId)?.name ?? 'a former teammate'

  async function connectGoogle(kind: 'gmail' | 'google_calendar') {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>('/connections/google', { body: { kind } })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function connectGitHub() {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>('/connections/github', { body: {} })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function connectStripe(form: FormData) {
    setError(undefined)
    try {
      await api('/connections/stripe', {
        body: {
          apiKey: String(form.get('apiKey')),
          ...(form.get('label') ? { label: String(form.get('label')) } : {}),
        },
      })
      setStripeOpen(false)
      await data.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function connectCustomApp(form: FormData) {
    setError(undefined)
    try {
      const { id } = await api<{ id: string }>('/connections/webhook', {
        body: { label: String(form.get('label')) },
      })
      setCustomOpen(false)
      await data.reload()
      // Its webhooks are the point: open them straight away.
      setOpen({ id, tab: 'triggers' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(c: Connection) {
    const label = c.externalAccount ?? c.label
    const after =
      c.kind === 'github' ? ' Brigade stays installed on GitHub until you uninstall it there.' : ''
    const message =
      c.kind === 'webhook'
        ? `Remove ${label}? Its webhook URLs stop working.`
        : `Disconnect ${label}? Teammates lose access; the call log is kept.${after}`
    if (!confirm(message)) return
    const id = c.id
    await api(`/connections/${id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await Promise.all([data.reload(), triggers.reload()])
  }

  const connections = data.data?.connections ?? []
  const triggersOf = (id: string) => (triggers.data ?? []).filter((t) => t.connectionId === id)
  // A new trigger may have just subscribed the vendor: its status comes with the connections.
  const reloadTriggers = () => Promise.all([triggers.reload(), data.reload()])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight">Connections</h1>
        <p className="max-w-prose text-muted-foreground">
          External accounts your teammates can use. Grant access on each teammate&apos;s page.
        </p>
        <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-foreground" aria-hidden />
          <p>
            <span className="font-semibold text-accent-foreground">
              The credential stays in Brigade&apos;s vault and never reaches a computer:
            </span>{' '}
            every call goes through Brigade, which checks the teammate&apos;s grant, asks a person
            before changes when its policy says so, and logs the call.
          </p>
        </div>
        {params.get('connected') && (
          <p className="flex items-center gap-2 rounded-lg bg-success/15 p-3 text-sm font-semibold text-success">
            <CircleCheck className="size-4" aria-hidden />
            Connected.
          </p>
        )}
        {params.get('error') && (
          <p className="text-sm text-destructive-text">
            The connection was not created.{' '}
            {CONNECT_ERRORS[params.get('error')!] ?? `(${params.get('error')})`}
          </p>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </header>

      <section aria-labelledby="connected" className="flex flex-col gap-3">
        <h2 id="connected" className="text-lg font-bold tracking-tight">
          Connected{' '}
          <span className="font-semibold text-muted-foreground">{connections.length}</span>
        </h2>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        ) : (
          <Card className="gap-0 divide-y py-0">
            {connections.map((c) => {
              const own = triggersOf(c.id)
              const custom = c.kind === 'webhook'
              return (
                <div key={c.id} className="flex flex-col gap-3 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <ProviderTile kind={c.kind} />
                    <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{c.label}</span>
                        {c.status === 'needs_reauth' ? (
                          <StatusBadge
                            status="needs_reauth"
                            tone="destructive"
                            label="reconnect needed"
                          />
                        ) : (
                          <StatusBadge status="active" tone="success" />
                        )}
                      </div>
                      {c.externalAccount && (
                        <span className="truncate text-sm text-muted-foreground">
                          {c.externalAccount}
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {custom
                          ? own.length === 0
                            ? 'Custom app · no webhooks yet'
                            : `Custom app · ${own.map((w) => `${w.label} → ${w.teammate.name}`).join(', ')}`
                          : c.grants.length === 0
                            ? 'No teammate has access'
                            : c.grants
                                .map(
                                  (g) =>
                                    `${name(g.teammateId)} (${g.scope === 'read' ? 'read' : 'read and write'})`,
                                )
                                .join(', ')}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {admin && c.kind === 'github' && c.externalUrl && (
                        <Button variant="outline" size="sm" asChild>
                          <a href={c.externalUrl} target="_blank" rel="noreferrer">
                            Repositories
                            <ExternalLink aria-hidden />
                            <span className="sr-only"> (choose them on GitHub)</span>
                          </a>
                        </Button>
                      )}
                      {!custom && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={open?.id === c.id && open.tab === 'log'}
                          onClick={() =>
                            setOpen(
                              open?.id === c.id && open.tab === 'log'
                                ? undefined
                                : { id: c.id, tab: 'log' },
                            )
                          }
                        >
                          {open?.id === c.id && open.tab === 'log' ? 'Hide log' : 'Call log'}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={open?.id === c.id && open.tab === 'triggers'}
                        onClick={() =>
                          setOpen(
                            open?.id === c.id && open.tab === 'triggers'
                              ? undefined
                              : { id: c.id, tab: 'triggers' },
                          )
                        }
                      >
                        {custom ? 'Webhooks' : 'Triggers'}
                        {!custom && own.length > 0 && (
                          <span className="text-muted-foreground">{own.length}</span>
                        )}
                      </Button>
                      {admin && (
                        <Button variant="danger" size="sm" onClick={() => void remove(c)}>
                          {custom ? 'Remove' : 'Disconnect'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {open?.id === c.id && open.tab === 'log' && <CallLog connectionId={c.id} />}
                  {open?.id === c.id && open.tab === 'triggers' && (
                    <ConnectionTriggers
                      connection={c}
                      triggers={own}
                      catalog={catalog.data}
                      reload={reloadTriggers}
                      editable={admin}
                    />
                  )}
                </div>
              )
            })}
          </Card>
        )}
      </section>

      {admin && (
        <Card className="gap-4 border-dashed p-5 shadow-none">
          <h2 className="font-bold tracking-tight">Connect an account</h2>
          <div className="flex flex-col divide-y">
            {(
              [
                {
                  kind: 'gmail',
                  name: 'Gmail',
                  button: (
                    <Button
                      disabled={!data.data?.available.gmail}
                      onClick={() => void connectGoogle('gmail')}
                    >
                      Connect
                    </Button>
                  ),
                },
                {
                  kind: 'google_calendar',
                  name: 'Google Calendar',
                  button: (
                    <Button
                      variant="outline"
                      disabled={!data.data?.available.google_calendar}
                      onClick={() => void connectGoogle('google_calendar')}
                    >
                      Connect
                    </Button>
                  ),
                },
                {
                  kind: 'stripe',
                  name: 'Stripe',
                  button: (
                    <Button
                      variant="outline"
                      aria-expanded={stripeOpen}
                      onClick={() => setStripeOpen(!stripeOpen)}
                    >
                      Connect
                    </Button>
                  ),
                },
                {
                  kind: 'github',
                  name: 'GitHub',
                  button: (
                    <Button
                      variant="outline"
                      disabled={!data.data?.available.github}
                      onClick={() => void connectGitHub()}
                    >
                      Connect
                    </Button>
                  ),
                },
                {
                  kind: 'webhook',
                  name: 'Custom app',
                  hint: 'Any app or service that can send a webhook',
                  button: (
                    <Button
                      variant="outline"
                      aria-expanded={customOpen}
                      onClick={() => setCustomOpen(!customOpen)}
                    >
                      Add a custom app
                    </Button>
                  ),
                },
              ] as const
            ).map((option) => (
              <div
                key={option.name}
                className="flex flex-wrap items-center gap-4 py-3 first:pt-0 last:pb-0"
              >
                <ProviderTile kind={option.kind} />
                <span className="flex flex-1 flex-col">
                  <span className="font-semibold">{option.name}</span>
                  {'hint' in option && (
                    <span className="text-sm text-muted-foreground">{option.hint}</span>
                  )}
                </span>
                {option.button}
              </div>
            ))}
          </div>
          {data.data && !data.data.available.gmail && (
            <p className="text-sm text-muted-foreground">
              Gmail and Google Calendar need Google OAuth configured on this Brigade server (
              <span className="font-mono text-xs">GOOGLE_CLIENT_ID</span> and{' '}
              <span className="font-mono text-xs">GOOGLE_CLIENT_SECRET</span>).
            </p>
          )}
          {data.data && !data.data.available.github && (
            <p className="text-sm text-muted-foreground">
              GitHub needs Brigade&apos;s GitHub App configured on this Brigade server (
              <span className="font-mono text-xs">GITHUB_APP_*</span>).
            </p>
          )}
          {data.data?.available.github && (
            <p className="text-sm text-muted-foreground">
              Connecting GitHub installs Brigade&apos;s GitHub App on your account or organization.
              You choose which repositories it can reach, and can change them on GitHub at any time.
            </p>
          )}
          {customOpen && (
            <form
              action={connectCustomApp}
              className="flex flex-col gap-4 rounded-lg border bg-muted/50 p-4"
            >
              <p className="text-sm text-muted-foreground">
                For your own apps and services, or any tool without a connector here. Each webhook
                you add gets its own URL: every event posted to it starts a thread for a teammate.
                Nothing to sign in to, and teammates cannot call the app back through Brigade.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="custom-label">App name</Label>
                <Input
                  id="custom-label"
                  name="label"
                  placeholder="Zendesk, our backend, Typeform…"
                  className="bg-card"
                  required
                />
              </div>
              <div className="flex justify-end">
                <Button>Add</Button>
              </div>
            </form>
          )}
          {stripeOpen && (
            <form
              action={connectStripe}
              className="flex flex-col gap-4 rounded-lg border bg-muted/50 p-4"
            >
              <p className="text-sm text-muted-foreground">
                Create a restricted key in Stripe&apos;s dashboard with only the access your
                teammates need, and paste it here. It goes straight into Brigade&apos;s vault and is
                never shown again.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="apiKey">Secret or restricted key</Label>
                <Input
                  id="apiKey"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder="rk_live_… or sk_test_…"
                  className="bg-card font-mono"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="label">Name (optional)</Label>
                <Input id="label" name="label" placeholder="Stripe" className="bg-card" />
              </div>
              <div className="flex justify-end">
                <Button>Connect</Button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  )
}

function CallLog({ connectionId }: { connectionId: string }) {
  const calls = useApi<ConnectionCall[]>(`/connections/${connectionId}/calls`)
  if (!calls.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (calls.data.length === 0) return <p className="text-sm text-muted-foreground">No calls yet.</p>
  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableBody>
          {calls.data.map((call) => (
            <TableRow key={call.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {timeAgo(call.createdAt)}
              </TableCell>
              <TableCell>{call.teammate.name}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  <code className="font-mono text-xs">{call.operation}</code>
                  {call.write && (
                    <Badge variant="secondary" className="bg-warning/15 text-warning">
                      write
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">{call.target}</TableCell>
              <TableCell className="whitespace-normal">
                <StatusBadge
                  status={call.result}
                  tone={
                    call.result === 'ok'
                      ? 'success'
                      : call.result === 'denied'
                        ? 'warning'
                        : 'destructive'
                  }
                />
                {call.error && <span className="text-muted-foreground"> {call.error}</span>}
              </TableCell>
              <TableCell>
                <Link
                  href={`/app/threads/${call.sessionId}`}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  thread
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
