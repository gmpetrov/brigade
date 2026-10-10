'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { CircleCheck, ExternalLink, ShieldCheck } from 'lucide-react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
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
  type Webhook,
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

/**
 * How each kind of connection starts threads. http: the service posts to a
 * Brigade URL. gmail: Brigade watches the inbox. Google Calendar has neither.
 */
const TRIGGER_SOURCE: Record<Connection['kind'], 'http' | 'gmail' | null> = {
  gmail: 'gmail',
  google_calendar: null,
  stripe: 'http',
  github: 'http',
  webhook: 'http',
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
  const hooks = useApi<Webhook[]>('/webhooks')
  const [open, setOpen] = useState<{ id: string; tab: 'log' | 'webhooks' }>()
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
      setOpen({ id, tab: 'webhooks' })
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
    await Promise.all([data.reload(), hooks.reload()])
  }

  const connections = data.data?.connections ?? []
  const hooksOf = (id: string) => (hooks.data ?? []).filter((w) => w.connectionId === id)

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
              const source = TRIGGER_SOURCE[c.kind]
              const own = hooksOf(c.id)
              // Webhooks made before a kind lost its trigger stay visible, to delete them.
              const showTriggers = Boolean(source) || own.length > 0
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
                      {showTriggers && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={open?.id === c.id && open.tab === 'webhooks'}
                          onClick={() =>
                            setOpen(
                              open?.id === c.id && open.tab === 'webhooks'
                                ? undefined
                                : { id: c.id, tab: 'webhooks' },
                            )
                          }
                        >
                          {source === 'gmail' ? 'Triggers' : 'Webhooks'}
                        </Button>
                      )}
                      {admin && (
                        <Button variant="danger" size="sm" onClick={() => void remove(c)}>
                          {custom ? 'Remove' : 'Disconnect'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {open?.id === c.id && open.tab === 'log' && <CallLog connectionId={c.id} />}
                  {open?.id === c.id && open.tab === 'webhooks' && (
                    <Webhooks connection={c} hooks={own} reload={hooks.reload} editable={admin} />
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

function Webhooks({
  connection,
  hooks,
  reload,
  editable,
}: {
  connection: Connection
  hooks: Webhook[]
  reload: () => Promise<unknown>
  editable: boolean
}) {
  const { teammates } = useDashboard()
  const [adding, setAdding] = useState(false)
  const [created, setCreated] = useState<{ url: string; signingSecret?: string }>()
  const [error, setError] = useState<string>()
  const stripe = connection.kind === 'stripe'
  const github = connection.kind === 'github'
  const gmail = TRIGGER_SOURCE[connection.kind] === 'gmail'
  const canAdd = editable && TRIGGER_SOURCE[connection.kind] !== null
  const idFor = (field: string) => `webhook-${connection.id}-${field}`

  async function create(form: FormData) {
    setError(undefined)
    try {
      const result = await api<{ url: string | null; signingSecret?: string }>('/webhooks', {
        body: {
          connectionId: connection.id,
          teammateId: String(form.get('teammateId')),
          label: String(form.get('label')),
          ...(gmail
            ? form.get('filter')
              ? { filter: String(form.get('filter')) }
              : {}
            : { verification: String(form.get('verification')) }),
          ...(form.get('signingSecret')
            ? { signingSecret: String(form.get('signingSecret')) }
            : {}),
        },
      })
      setCreated(result.url ? { url: result.url, signingSecret: result.signingSecret } : undefined)
      setAdding(false)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function setSecret(id: string, form: FormData) {
    setError(undefined)
    try {
      await api(`/webhooks/${id}`, {
        method: 'PATCH',
        body: { signingSecret: String(form.get('signingSecret')) },
      })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(id: string) {
    const w = hooks.find((h) => h.id === id)
    const question =
      w?.source === 'gmail'
        ? 'Delete this trigger? New mail stops starting threads.'
        : 'Delete this webhook? Its URL stops working.'
    if (!confirm(question)) return
    await api(`/webhooks/${id}`, { method: 'DELETE' }).catch((e) => setError((e as Error).message))
    await reload()
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {gmail ? (
          <>
            Each new email in this inbox starts a thread for the trigger&apos;s teammate, with the
            email as the first message. Brigade checks the inbox every minute, for mail that arrives
            after the trigger is created. It runs on the accounts of the admin who set it up. An
            email can ask for anything, so every change its thread makes through a connector waits
            for a person. To reply, the teammate also needs access to this mailbox.
          </>
        ) : (
          <>
            Each event posted to a webhook URL starts a new thread for its teammate, with the
            payload as the first message. It runs on the accounts of the admin who set it up. A
            payload can ask for anything, so every change a webhook thread makes through a connector
            waits for a person.
          </>
        )}
      </p>
      {created && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm">
          <div>
            URL: <code className="font-mono text-xs break-all">{created.url}</code>
          </div>
          {created.signingSecret && (
            <div className="flex flex-col gap-1">
              <div>
                Signing secret (shown once):{' '}
                <code className="font-mono text-xs break-all">{created.signingSecret}</code>
              </div>
              <div className="text-muted-foreground">
                {github ? (
                  <>
                    In the repository&apos;s Settings → Webhooks, add this URL with content type{' '}
                    <code className="font-mono text-xs">application/json</code> and this secret.
                    GitHub signs each delivery with it.
                  </>
                ) : (
                  <>
                    The sender signs each body with HMAC-SHA256 and sends{' '}
                    <code className="font-mono text-xs">
                      X-Brigade-Signature: sha256=&lt;hex&gt;
                    </code>
                    .
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {hooks.length > 0 && (
        <div className="flex flex-col divide-y rounded-lg border">
          {hooks.map((w) => (
            <div key={w.id} className="flex flex-col gap-3 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                  <div className="text-sm">
                    <span className="font-semibold">{w.label}</span>{' '}
                    <span className="text-muted-foreground">→ {w.teammate.name}</span>
                  </div>
                  {w.source === 'gmail' ? (
                    <span className="text-xs text-muted-foreground">
                      {w.filter ? (
                        <>
                          New mail matching <code className="font-mono">{w.filter}</code>
                        </>
                      ) : (
                        'All new mail in the inbox'
                      )}
                    </span>
                  ) : (
                    <code className="font-mono text-xs break-all text-muted-foreground">
                      {w.url}
                    </code>
                  )}
                </div>
                {w.source === 'gmail' ? (
                  <StatusBadge status="watching" tone="success" label="watching inbox" />
                ) : w.verification !== 'none' && !w.hasSecret ? (
                  <StatusBadge
                    status="needs_secret"
                    tone="destructive"
                    label="needs signing secret"
                  />
                ) : (
                  <StatusBadge
                    status={w.verification}
                    tone={w.verification === 'none' ? 'warning' : 'success'}
                    label={w.verification === 'none' ? 'unsigned' : `${w.verification} signature`}
                  />
                )}
                {editable && (
                  <Button variant="danger" size="sm" onClick={() => void remove(w.id)}>
                    Delete
                  </Button>
                )}
              </div>
              {editable && w.verification === 'stripe' && !w.hasSecret && (
                <form action={(form) => void setSecret(w.id, form)} className="flex gap-2">
                  <Input
                    name="signingSecret"
                    type="password"
                    autoComplete="off"
                    aria-label="Stripe signing secret"
                    placeholder="Add this URL as an endpoint in Stripe, then paste its whsec_… secret"
                    className="flex-1"
                    required
                  />
                  <Button>Save</Button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
      {canAdd &&
        (adding ? (
          <form action={create} className="flex flex-col gap-4 rounded-lg border bg-muted/50 p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={idFor('label')}>Name</Label>
              <Input
                id={idFor('label')}
                name="label"
                required
                className="bg-card"
                placeholder={
                  stripe
                    ? 'Disputes and failed payments'
                    : github
                      ? 'New issues and pull requests'
                      : gmail
                        ? 'Support inbox'
                        : 'New support request'
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={idFor('teammate')}>Teammate</Label>
              <Select name="teammateId" required defaultValue={teammates[0]?.id}>
                <SelectTrigger id={idFor('teammate')} className="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {gmail ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={idFor('filter')}>Only emails matching (optional)</Label>
                <Input
                  id={idFor('filter')}
                  name="filter"
                  className="bg-card font-mono"
                  placeholder="to:support@acme.com -category:promotions"
                />
                <p className="text-sm text-muted-foreground">
                  Gmail search, as in Gmail&apos;s search box. Leave it empty for every new email in
                  the inbox.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor={idFor('verification')}>Verify the sender with</Label>
                <Select name="verification" defaultValue={stripe ? 'stripe' : 'hmac'}>
                  <SelectTrigger id={idFor('verification')} className="w-full bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stripe && <SelectItem value="stripe">Stripe signature</SelectItem>}
                    <SelectItem value="hmac">
                      {github
                        ? 'GitHub signature (a secret Brigade generates)'
                        : 'A signing secret Brigade generates'}
                    </SelectItem>
                    <SelectItem value="none">Nothing (the URL alone)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {stripe && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={idFor('secret')}>Stripe signing secret</Label>
                <Input
                  id={idFor('secret')}
                  name="signingSecret"
                  type="password"
                  autoComplete="off"
                  placeholder="whsec_…"
                  className="bg-card font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  Leave it empty for now if you have not added the URL in Stripe yet: create the
                  webhook, add its URL as an endpoint in Stripe, then paste the secret here. Events
                  are refused until it is set.
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button>{gmail ? 'Create trigger' : 'Create webhook'}</Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              {gmail ? 'Add a trigger' : 'Add a webhook'}
            </Button>
          </div>
        ))}
    </div>
  )
}
