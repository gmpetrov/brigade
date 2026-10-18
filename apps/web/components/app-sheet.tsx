'use client'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, EllipsisVertical, ExternalLink, Package, Plus } from 'lucide-react'
import { AtlassianDomainHint } from '@/components/atlassian-domain-hint'
import { CloseButton } from '@/components/close-button'
import { ConnectionTriggers } from '@/components/connection-triggers'
import { useDashboard, timeAgo } from '@/components/dashboard'
import { McpServerCard } from '@/components/mcp-server-card'
import { ProviderTile } from '@/components/provider-logo'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { openSignIn } from '@/lib/sign-in-window'
import { cn } from '@/lib/utils'

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
  onAdded,
}: {
  kind: Kind
  /** Unset: not added yet, the catalog's description and Add. */
  app?: App
  data: ConnectionsResponse
  triggers: Trigger[]
  catalog?: TriggerCatalog
  reload: () => Promise<unknown>
  onClose: () => void
  /** An MCP server added from this sheet: show its App. */
  onAdded?: (appId: string) => void
}) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const entry = data.catalog[kind]
  const custom = kind === 'webhook'
  // An MCP server added by its URL: its App keeps the server, its tools and how it signs in.
  const server = kind === 'mcp'
  const mcp = app?.mcp ?? null
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

  /**
   * Google, GitHub and MCP Apps sign in at the provider, in a window of its own:
   * the sheet stays open and shows the account once it has connected.
   */
  const route =
    custom || server || kind === 'stripe'
      ? null
      : kind === 'cloudflare' ||
          kind === 'google_cloud' ||
          kind === 'neon' ||
          kind === 'supabase' ||
          kind === 'atlassian' ||
          kind === 'notion' ||
          kind === 'linear'
        ? 'mcp'
        : kind === 'github'
          ? 'github'
          : 'google'
  const connect = () =>
    run(async () => {
      if (!route) return setAdding(true)
      const before = accounts.length
      const inWindow = await openSignIn(async (returnTo) => {
        const { url } = await api<{ url: string }>(`/connections/${route}`, {
          body: {
            ...(route === 'github' ? {} : { kind }),
            ...(returnTo ? { returnTo } : {}),
          },
        })
        return url
      })
      if (inWindow) setWaiting({ before, since: Date.now() })
    })
  // While the sign-in tab is open: look for the new account every few seconds, for a while.
  const [waiting, setWaiting] = useState<{ before: number; since: number }>()
  useEffect(() => {
    if (!waiting) return
    if (accounts.length > waiting.before) return setWaiting(undefined)
    const timer = setInterval(() => {
      if (Date.now() - waiting.since > 10 * 60_000) setWaiting(undefined)
      else void reload()
    }, 2000)
    return () => clearInterval(timer)
  }, [waiting, accounts.length, reload])

  const connectStripe = (form: FormData) =>
    run(async () => {
      await api('/connections/stripe', {
        body: {
          apiKey: String(form.get('apiKey')),
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

  const skills = added ? (app?.skills ?? []) : []
  const [addingSkills, setAddingSkills] = useState(false)
  /** The skills that come with the App, when they did not come with its first account. */
  const addSkills = () =>
    run(async () => {
      if (!app) return
      setAddingSkills(true)
      try {
        await api(`/connections/apps/${app.id}/skills`, { body: {} })
        await reload()
      } finally {
        setAddingSkills(false)
      }
    })
  const tools = server ? (mcp?.tools ?? []) : entry.tools
  const enabled = tools.filter((t) => !app?.disabledTools.includes(t.name)).length
  const host = mcp ? new URL(mcp.url).host : null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90dvh,52rem)] flex-col gap-6 overflow-y-auto sm:max-w-2xl"
      >
        <div className="flex items-start gap-4">
          <ProviderTile kind={kind} icons={mcp?.icons} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-tight">{name}</DialogTitle>
            {/* A server added by its URL shows the server it connects to, not a developer. */}
            {mcp && (
              <span className="truncate font-mono text-xs text-muted-foreground">{mcp.url}</span>
            )}
            {(entry.developer || entry.source) && (
              <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                {entry.developer && <span>By {entry.developer}</span>}
                {entry.source && (
                  <a
                    href={entry.source}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    View source <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </span>
            )}
          </div>
          {!added && !custom && !server && (
            <Button onClick={() => void connect()} disabled={!data.available[kind]}>
              Add
            </Button>
          )}
          <CloseButton label={`Close ${name}`} title="Close" onClick={onClose} />
        </div>
        <DialogDescription
          className={cn('text-base text-foreground', mcp && !mcp.description && 'sr-only')}
        >
          {mcp ? (mcp.description ?? `The MCP server at ${host}.`) : entry.description}
        </DialogDescription>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        {waiting && (
          <p className="text-sm text-muted-foreground">
            Finish signing in in the tab that opened. The account shows here once it is connected.
          </p>
        )}
        {waiting && kind === 'atlassian' && <AtlassianDomainHint />}
        {!data.available[kind] && <Unavailable kind={kind} />}
        {kind === 'google_cloud' && data.available[kind] && (
          <p className="text-sm text-muted-foreground">
            Each command runs in a project of yours with the{' '}
            <a
              href="https://console.cloud.google.com/apis/library/cloudcli.googleapis.com"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Cloud CLI Execution API
            </a>{' '}
            enabled, and each Google product it uses needs its own API enabled there too.
          </p>
        )}

        {server && !added && (
          <Section title="Server">
            <div className="px-4 py-4">
              <McpServerCard
                connections={data.connections}
                reload={reload}
                onConnected={({ appId }) => {
                  void reload()
                  onAdded?.(appId)
                }}
              />
            </div>
          </Section>
        )}

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
            {adding && server && app && (
              <div className="px-4 py-4">
                <McpServerCard
                  app={app}
                  connections={data.connections}
                  reload={reload}
                  onConnected={() => {
                    setAdding(false)
                    void reload()
                  }}
                />
              </div>
            )}
            {/* A server with nothing to sign in to has one account. */}
            {added && !custom && !adding && mcp?.auth !== 'none' && (
              <button
                type="button"
                disabled={!data.available[kind]}
                onClick={() => (server ? setAdding(true) : void connect())}
                className="flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Plus className="size-4" aria-hidden />
                Add another account
              </button>
            )}
          </Section>
        )}

        {tools.length > 0 && (
          <Section title="Tools">
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                {enabled} of {tools.length} enabled
                <ChevronDown
                  className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col divide-y border-t">
                {tools.map((tool) => (
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

        {(skills.length > 0 || entry.source) && (
          <Section title="Skills">
            {skills.length === 0 && !added ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Added with the App, from its source. Teammates that have {name} get them.
              </p>
            ) : skills.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Its skills aren&apos;t added yet.</span>
                {managesApp && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={addingSkills}
                    onClick={() => void addSkills()}
                  >
                    {addingSkills ? 'Adding…' : 'Add the skills'}
                  </Button>
                )}
              </div>
            ) : (
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium">
                  {skills.length} {skills.length === 1 ? 'skill' : 'skills'}, for the teammates that
                  have it
                  <ChevronDown
                    className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                    aria-hidden
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col divide-y border-t">
                  {skills.map((skill) => (
                    <div key={skill.name} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <Package
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">{skill.name}</span>
                        <span className="line-clamp-2 text-muted-foreground">
                          {skill.description}
                        </span>
                      </span>
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </Section>
        )}

        <Section title="Information">
          {mcp && host ? (
            <>
              <Info label="Server" value={host} />
              <Info
                label="Sign-in"
                value={
                  mcp.auth === 'oauth'
                    ? `OAuth, on ${host}`
                    : mcp.auth === 'api_key'
                      ? `API key, in ${mcp.header ?? 'Authorization'}`
                      : 'None'
                }
              />
            </>
          ) : server ? (
            <Info label="Category" value={entry.category} />
          ) : (
            <>
              <Info label="Developer" value={entry.developer ?? 'You'} />
              <Info label="Category" value={entry.category} />
            </>
          )}
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
 * One account on one line: a status dot, the account, a chip when it is kept to
 * its owner's threads, and a menu for the rest. Its owner or an admin changes it.
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
  const [open, setOpen] = useState<'teammates' | 'log' | 'triggers'>()

  async function update(body: { reach: Connection['reach'] }) {
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

  const panels = {
    teammates: 'Teammates',
    log: 'Call log',
    triggers: custom ? 'Webhooks' : 'Triggers',
  }
  // A chip only when the account is kept to its owner's threads; a dot says the rest.
  const chip = c.reach === 'mine' && !custom ? (mine ? 'Only you' : `${owner} only`) : null

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex min-h-8 items-center gap-3">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            c.status === 'needs_reauth' ? 'bg-destructive-text' : 'bg-success',
          )}
          title={c.status === 'needs_reauth' ? 'Reconnect needed' : 'Connected'}
        >
          <span className="sr-only">
            {c.status === 'needs_reauth' ? 'Reconnect needed' : 'Connected'}
          </span>
        </span>
        {/* The account itself: a mailbox, a Stripe account, a GitHub owner; a custom app's name. */}
        <span className="min-w-0 flex-1 truncate font-medium">{c.externalAccount ?? c.label}</span>
        {c.status === 'needs_reauth' && (
          <span className="shrink-0 text-xs font-medium text-destructive-text">Reconnect</span>
        )}
        {chip && (
          <span className="shrink-0 rounded-md border bg-card px-2 py-0.5 text-xs text-muted-foreground">
            {chip}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${c.label} options`}>
              <EllipsisVertical aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {!custom && (
              <DropdownMenuItem onSelect={() => setOpen('teammates')}>
                Teammates
                <span className="ml-auto text-xs text-muted-foreground">{c.grants.length}</span>
              </DropdownMenuItem>
            )}
            {!custom && (
              <DropdownMenuItem onSelect={() => setOpen('log')}>Call log</DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setOpen('triggers')}>
              {panels.triggers}
              {triggers.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground">{triggers.length}</span>
              )}
            </DropdownMenuItem>
            {manages && c.kind === 'github' && c.externalUrl && (
              <DropdownMenuItem asChild>
                <a href={c.externalUrl} target="_blank" rel="noreferrer">
                  Repositories on GitHub
                  <ExternalLink className="ml-auto" aria-hidden />
                </a>
              </DropdownMenuItem>
            )}
            {!custom && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Teammates may use it
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={c.reach}
                  onValueChange={(reach) => void update({ reach: reach as Connection['reach'] })}
                >
                  <DropdownMenuRadioItem value="mine" disabled={!manages}>
                    {mine ? 'Only in my threads' : `Only in ${owner}'s threads`}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="workspace" disabled={!manages}>
                    In every thread
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            )}
            {manages && !custom && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                  Disconnect
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{panels[open]}</span>
            <button
              type="button"
              onClick={() => setOpen(undefined)}
              className="text-muted-foreground hover:text-foreground"
            >
              Done
            </button>
          </div>
          {open === 'teammates' && (
            <div className="flex flex-col divide-y rounded-lg border bg-card">
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Connected by {owner}.{' '}
                {c.reach === 'mine'
                  ? `Used only in ${mine ? 'your' : `${owner}'s`} threads.`
                  : 'Used in every thread.'}
              </p>
              {teammates.map((t) => {
                const grant = c.grants.find((g) => g.teammateId === t.id)
                return (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <Select
                      value={grant?.scope ?? 'none'}
                      disabled={!manages}
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
  if (
    kind === 'gmail' ||
    kind === 'google_calendar' ||
    kind === 'google_drive' ||
    kind === 'google_docs' ||
    kind === 'google_sheets'
  )
    return (
      <p className="text-sm text-muted-foreground">
        Needs Google OAuth configured on this Brigade server (
        <span className="font-mono text-xs">GOOGLE_CLIENT_ID</span> and{' '}
        <span className="font-mono text-xs">GOOGLE_CLIENT_SECRET</span>).
      </p>
    )
  if (kind === 'google_cloud')
    return (
      <p className="text-sm text-muted-foreground">
        Needs Brigade&apos;s Google client for agents configured on this Brigade server (
        <span className="font-mono text-xs">GOOGLE_MCP_CLIENT_ID</span> and{' '}
        <span className="font-mono text-xs">GOOGLE_MCP_CLIENT_SECRET</span>).
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
