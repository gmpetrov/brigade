'use client'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { ChevronDown, ExternalLink, Pencil, Plus } from 'lucide-react'
import { CloseButton } from '@/components/close-button'
import { ConnectionTriggers } from '@/components/connection-triggers'
import { useDashboard, timeAgo } from '@/components/dashboard'
import { ProviderTile } from '@/components/provider-logo'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import {
  api,
  isAdmin,
  useApi,
  type App,
  type Connection,
  type ConnectionCall,
  type ConnectionsResponse,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'

type Kind = Connection['kind']
type Scope = 'none' | 'read' | 'read_write'

/**
 * One App: its accounts (who connected each, where teammates may use it, which
 * teammates have it), its tools, and Add or Remove. Opens from the Apps page.
 */
export function AppSheet({
  kind,
  app,
  data,
  triggers,
  catalog,
  reload,
  onClose,
}: {
  kind: Kind
  /** Unset: not added yet, the catalog's description and Add. */
  app?: App
  data: ConnectionsResponse
  triggers: Trigger[]
  catalog?: TriggerCatalog
  reload: () => Promise<unknown>
  onClose: () => void
}) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const entry = data.catalog[kind]
  const custom = kind === 'webhook'
  const accounts = app ? data.connections.filter((c) => c.appId === app.id) : []
  const added = accounts.length > 0
  const name = app?.name ?? entry.name
  const [adding, setAdding] = useState(!added && (kind === 'stripe' || custom))
  const [error, setError] = useState<string>()
  // The App as a whole: an admin, or the member who added it while every account is theirs.
  const managesApp =
    admin ||
    (!!app &&
      app.createdByMemberId === me.memberId &&
      accounts.every((a) => a.createdByMemberId === me.memberId))

  async function run(action: () => Promise<unknown>) {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Google and GitHub sign in at the provider and come back to the Apps page. */
  const connect = () =>
    run(async () => {
      if (kind === 'gmail' || kind === 'google_calendar') {
        const { url } = await api<{ url: string }>('/connections/google', { body: { kind } })
        window.location.href = url
      } else if (kind === 'github') {
        const { url } = await api<{ url: string }>('/connections/github', { body: {} })
        window.location.href = url
      } else setAdding(true)
    })

  const connectStripe = (form: FormData) =>
    run(async () => {
      await api('/connections/stripe', {
        body: {
          apiKey: String(form.get('apiKey')),
          ...(form.get('label') ? { label: String(form.get('label')) } : {}),
        },
      })
      setAdding(false)
      await reload()
    })

  const connectCustomApp = (form: FormData) =>
    run(async () => {
      await api('/connections/webhook', { body: { label: String(form.get('label')) } })
      await reload()
      onClose()
    })

  async function removeApp() {
    if (!app) return
    const message = custom
      ? `Remove ${name}? Its webhook URLs stop working.`
      : `Remove ${name}? ${accounts.length === 1 ? 'Its account is' : `Its ${accounts.length} accounts are`} disconnected and teammates lose access; call logs are kept.`
    if (!confirm(message)) return
    await run(async () => {
      await api(`/connections/apps/${app.id}`, { method: 'DELETE' })
      await reload()
      onClose()
    })
  }

  const setTool = (tool: string, on: boolean) =>
    run(async () => {
      if (!app) return
      const disabledTools = on
        ? app.disabledTools.filter((t) => t !== tool)
        : [...app.disabledTools, tool]
      await api(`/connections/apps/${app.id}`, { method: 'PATCH', body: { disabledTools } })
      await reload()
    })

  const enabled = entry.tools.filter((t) => !app?.disabledTools.includes(t.name)).length

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,52rem)] flex-col gap-6 overflow-y-auto sm:max-w-2xl"
      >
        <div className="flex items-start gap-4">
          <ProviderTile kind={kind} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-tight">{name}</DialogTitle>
            {entry.developer && (
              <span className="text-sm text-muted-foreground">By {entry.developer}</span>
            )}
          </div>
          {!added && !custom && (
            <Button onClick={() => void connect()} disabled={!data.available[kind]}>
              Add
            </Button>
          )}
          <CloseButton label={`Close ${name}`} title="Close" onClick={onClose} />
        </div>
        <DialogDescription className="text-base text-foreground">
          {entry.description}
        </DialogDescription>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        {!data.available[kind] && <Unavailable kind={kind} />}

        {(added || adding) && (
          <Section title={custom ? 'App' : 'Accounts'}>
            {accounts.map((c) => (
              <Account
                key={c.id}
                connection={c}
                data={data}
                triggers={triggers.filter((t) => t.connectionId === c.id)}
                catalog={catalog}
                reload={reload}
                onError={setError}
              />
            ))}
            {adding && kind === 'stripe' && <StripeForm onSubmit={connectStripe} />}
            {adding && custom && <CustomAppForm onSubmit={connectCustomApp} />}
            {added && !custom && !adding && (
              <button
                type="button"
                disabled={!data.available[kind]}
                onClick={() => void connect()}
                className="flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Plus className="size-4" aria-hidden />
                Add another account
              </button>
            )}
          </Section>
        )}

        {entry.tools.length > 0 && (
          <Section title="Tools">
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                {enabled} of {entry.tools.length} enabled
                <ChevronDown
                  className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col divide-y border-t">
                {entry.tools.map((tool) => (
                  <label
                    key={tool.name}
                    className="flex items-start gap-3 px-4 py-2.5 text-sm has-[:disabled]:cursor-default"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <code className="font-mono text-xs">{tool.name}</code>
                        {tool.write && (
                          <Badge variant="secondary" className="bg-warning/15 text-warning">
                            write
                          </Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground">{tool.description}</span>
                    </span>
                    <Switch
                      checked={!app?.disabledTools.includes(tool.name)}
                      disabled={!app || !managesApp}
                      onCheckedChange={(on) => void setTool(tool.name, on)}
                      aria-label={tool.name}
                    />
                  </label>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </Section>
        )}

        <Section title="Information">
          <Info label="Developer" value={entry.developer ?? 'You'} />
          <Info label="Category" value={entry.category} />
          {!custom && (
            <Info
              label="Accounts"
              value={accounts.length === 0 ? 'None yet' : String(accounts.length)}
            />
          )}
        </Section>

        {added && managesApp && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => void removeApp()}>
              Remove {name}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col divide-y rounded-xl bg-muted/60">{children}</div>
    </section>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span>{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  )
}

/**
 * One account: its name, status and owner, where teammates may use it, and the
 * teammates that have it. Its owner or an admin changes it.
 */
function Account({
  connection: c,
  data,
  triggers,
  catalog,
  reload,
  onError,
}: {
  connection: Connection
  data: ConnectionsResponse
  triggers: Trigger[]
  catalog?: TriggerCatalog
  reload: () => Promise<unknown>
  onError: (message: string) => void
}) {
  const { me, teammates } = useDashboard()
  const admin = isAdmin(me)
  const mine = c.createdByMemberId === me.memberId
  const manages = admin || mine
  const custom = c.kind === 'webhook'
  const owner = mine ? 'you' : (data.members[c.createdByMemberId] ?? 'a former member')
  const [renaming, setRenaming] = useState(false)
  const [open, setOpen] = useState<'teammates' | 'log' | 'triggers'>()
  const toggle = (tab: NonNullable<typeof open>) => setOpen(open === tab ? undefined : tab)
  const name = (teammateId: string) =>
    teammates.find((t) => t.id === teammateId)?.name ?? 'a former teammate'

  async function update(body: { label?: string; reach?: Connection['reach'] }) {
    try {
      await api(`/connections/${c.id}`, { method: 'PATCH', body })
      await reload()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  async function setGrant(teammateId: string, scope: Scope) {
    try {
      await api(`/teammates/${teammateId}/grants`, {
        method: 'PUT',
        body: { connectionId: c.id, scope },
      })
      await reload()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  async function remove() {
    const label = c.externalAccount ?? c.label
    const after =
      c.kind === 'github' ? ' Brigade stays installed on GitHub until you uninstall it there.' : ''
    if (!confirm(`Disconnect ${label}? Teammates lose access; the call log is kept.${after}`))
      return
    try {
      await api(`/connections/${c.id}`, { method: 'DELETE' })
      await reload()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            action={(form) => {
              setRenaming(false)
              const label = String(form.get('label')).trim()
              if (label && label !== c.label) void update({ label })
            }}
          >
            <Input
              name="label"
              defaultValue={c.label}
              aria-label="Account name"
              maxLength={80}
              autoFocus
              className="h-8 bg-card"
            />
            <Button size="sm">Save</Button>
          </form>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-medium">
              {c.label}
              {c.externalAccount && c.externalAccount !== c.label && (
                <span className="text-muted-foreground"> · {c.externalAccount}</span>
              )}
            </span>
            {manages && (
              <button
                type="button"
                onClick={() => setRenaming(true)}
                aria-label={`Rename ${c.label}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            )}
          </span>
        )}
        {c.status === 'needs_reauth' ? (
          <StatusBadge status="needs_reauth" tone="destructive" label="Reconnect needed" />
        ) : (
          <span className="text-sm font-medium text-success">Connected</span>
        )}
      </div>

      {!custom && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>Connected by {owner} ·</span>
          {manages ? (
            <Select
              value={c.reach}
              onValueChange={(reach) => void update({ reach: reach as Connection['reach'] })}
            >
              <SelectTrigger size="sm" aria-label="Where teammates may use it">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">
                  {mine ? 'Only in my threads' : `Only in ${owner}'s threads`}
                </SelectItem>
                <SelectItem value="workspace">In every thread</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <span>{c.reach === 'mine' ? `Only in ${owner}'s threads` : 'In every thread'}</span>
          )}
        </div>
      )}

      {!custom && (
        <p className="text-sm text-muted-foreground">
          {c.grants.length === 0
            ? 'No teammate has it yet.'
            : c.grants
                .map(
                  (g) =>
                    `${name(g.teammateId)} (${g.scope === 'read' ? 'read' : 'read and write'})`,
                )
                .join(', ')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!custom && manages && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open === 'teammates'}
            onClick={() => toggle('teammates')}
          >
            Teammates
          </Button>
        )}
        {!custom && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open === 'log'}
            onClick={() => toggle('log')}
          >
            Call log
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open === 'triggers'}
          onClick={() => toggle('triggers')}
        >
          {custom ? 'Webhooks' : 'Triggers'}
          {!custom && triggers.length > 0 && (
            <span className="text-muted-foreground">{triggers.length}</span>
          )}
        </Button>
        {manages && c.kind === 'github' && c.externalUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={c.externalUrl} target="_blank" rel="noreferrer">
              Repositories
              <ExternalLink aria-hidden />
              <span className="sr-only"> (choose them on GitHub)</span>
            </a>
          </Button>
        )}
        {manages && !custom && (
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            Disconnect
          </Button>
        )}
      </div>

      {open === 'teammates' && (
        <div className="flex flex-col divide-y rounded-lg border bg-card">
          {teammates.map((t) => {
            const grant = c.grants.find((g) => g.teammateId === t.id)
            return (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <Select
                  value={grant?.scope ?? 'none'}
                  onValueChange={(scope) => void setGrant(t.id, scope as Scope)}
                >
                  <SelectTrigger size="sm" aria-label={`${t.name}'s access to ${c.label}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No access</SelectItem>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="read_write">Read and write</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      )}
      {open === 'log' && <CallLog connectionId={c.id} />}
      {open === 'triggers' && (
        <ConnectionTriggers
          connection={c}
          triggers={triggers}
          catalog={catalog}
          reload={reload}
          editable={admin}
        />
      )}
    </div>
  )
}

function StripeForm({ onSubmit }: { onSubmit: (form: FormData) => void }) {
  return (
    <form action={onSubmit} className="flex flex-col gap-4 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        Create a restricted key in Stripe&apos;s dashboard with only the access your teammates need,
        and paste it here. It is encrypted in Brigade at once and is never shown again.
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
  )
}

function CustomAppForm({ onSubmit }: { onSubmit: (form: FormData) => void }) {
  return (
    <form action={onSubmit} className="flex flex-col gap-4 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        For your own apps and services, or any tool without an App here. Each webhook you add gets
        its own URL: every event posted to it starts a thread for a teammate. Nothing to sign in to,
        and teammates cannot call the app back through Brigade.
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
  )
}

/** What the server is missing for an App that needs its own setup. */
function Unavailable({ kind }: { kind: Kind }) {
  if (kind === 'gmail' || kind === 'google_calendar')
    return (
      <p className="text-sm text-muted-foreground">
        Needs Google OAuth configured on this Brigade server (
        <span className="font-mono text-xs">GOOGLE_CLIENT_ID</span> and{' '}
        <span className="font-mono text-xs">GOOGLE_CLIENT_SECRET</span>).
      </p>
    )
  if (kind === 'github')
    return (
      <p className="text-sm text-muted-foreground">
        Needs Brigade&apos;s GitHub App configured on this Brigade server (
        <span className="font-mono text-xs">GITHUB_APP_*</span>).
      </p>
    )
  return null
}

function CallLog({ connectionId }: { connectionId: string }) {
  const calls = useApi<ConnectionCall[]>(`/connections/${connectionId}/calls`)
  if (!calls.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (calls.data.length === 0) return <p className="text-sm text-muted-foreground">No calls yet.</p>
  return (
    <div className="rounded-lg border bg-card">
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
