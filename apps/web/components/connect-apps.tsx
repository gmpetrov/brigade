'use client'
// Connect apps: the popup the sidebar's button opens (openConnectApps). The catalog to
// search and add from, and the Apps already connected one click away; each App opens its
// sheet on top. Settings → Apps shows the same, as a page (ConnectApps).
import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { AppSheet } from '@/components/app-sheet'
import { CloseButton } from '@/components/close-button'
import { ProviderLogo, ProviderTile } from '@/components/provider-logo'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  useApi,
  type App,
  type Connection,
  type ConnectionsResponse,
  type Trigger,
  type TriggerCatalog,
} from '@/lib/api'
import { cn } from '@/lib/utils'

type Kind = Connection['kind']

/**
 * The built-in Apps, in the order they are offered. An MCP server and a custom app
 * can be added many times.
 */
export const BUILT_IN: Kind[] = [
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_sheets',
  'google_search_console',
  'google_analytics',
  'github',
  'cloudflare',
  'google_cloud',
  'neon',
  'supabase',
  'atlassian',
  'notion',
  'linear',
  'mixpanel',
  'resend',
  'replicate',
  'openrouter',
  'posthog',
  'dataforseo',
  'ahrefs',
  'stripe',
]

export type AddedApp = { app: App; accounts: Connection[]; kind: Kind }

/** The Apps added: those with an account. One whose accounts were all removed is offered again. */
export function addedApps(data: ConnectionsResponse): AddedApp[] {
  return data.apps
    .map((app) => ({ app, accounts: data.connections.filter((c) => c.appId === app.id) }))
    .filter((a) => a.accounts.length > 0)
    .map((a) => ({ ...a, kind: a.accounts[0]!.kind }))
}

/** What an added App's row says under its name: the account it reaches, or what is wrong. */
export function addedDetail({ app, accounts, kind }: AddedApp) {
  if (accounts.some((c) => c.status === 'needs_reauth')) return 'Reconnect needed'
  if (kind === 'webhook') return 'Custom app'
  if (app.mcp?.auth === 'none') return new URL(app.mcp.url).host
  if (accounts.length === 1) return accounts[0]!.externalAccount ?? accounts[0]!.label
  return `${accounts.length} accounts`
}

const OPEN_EVENT = 'brigade:connect-apps'

export function openConnectApps() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/** The App sheet that is open: an added App, or one from the catalog not added yet. */
export type Open = { kind: Kind; appId?: string }

export function ConnectAppsDialog() {
  const [open, setOpen] = useState(false)
  // Each opening starts again on the catalog, with no search or category.
  const [opening, setOpening] = useState(0)
  const [sheet, setSheet] = useState<Open>()
  const data = useApi<ConnectionsResponse>(open ? '/connections' : null)
  const triggers = useApi<Trigger[]>(open ? '/triggers' : null)
  const catalog = useApi<TriggerCatalog>(open ? '/triggers/catalog' : null)

  useEffect(() => {
    const onOpen = () => {
      setOpening((n) => n + 1)
      setSheet(undefined)
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  const reload = () => Promise.all([data.reload(), triggers.reload()])
  // A built-in App opened from the catalog becomes the added one once its first account connects.
  const sheetApp = data.data?.apps.find((a) =>
    sheet?.appId ? a.id === sheet.appId : a.key === sheet?.kind,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[min(90dvh,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <ConnectApps
          key={opening}
          data={data.data}
          onOpen={setSheet}
          onClose={() => setOpen(false)}
        />

        {sheet && data.data && (
          <AppSheet
            key={sheet.appId ?? sheet.kind}
            kind={sheet.kind}
            app={sheetApp}
            data={data.data}
            triggers={triggers.data ?? []}
            catalog={catalog.data}
            reload={reload}
            onClose={() => setSheet(undefined)}
            onAdded={(appId) => setSheet({ kind: 'mcp', appId })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The catalog to search and add from, and the Apps connected one click away: the popup's
 * content (with onClose), and Settings → Apps' (without, its intro under the title).
 */
export function ConnectApps({
  data,
  onOpen,
  onClose,
  intro,
}: {
  data?: ConnectionsResponse
  onOpen: (open: Open) => void
  /** In the popup: its close button. Unset on the page, which scrolls as a whole. */
  onClose?: () => void
  intro?: ReactNode
}) {
  const [view, setView] = useState<'catalog' | 'connected'>('catalog')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>()
  const added = data ? addedApps(data) : []
  const dialog = !!onClose
  const props = { data, added, onOpen, onClose, intro }
  return view === 'catalog' ? (
    <Catalog
      {...props}
      query={query}
      setQuery={setQuery}
      category={category}
      setCategory={setCategory}
      onConnected={() => setView('connected')}
      dialog={dialog}
    />
  ) : (
    <Connected {...props} onBack={() => setView('catalog')} dialog={dialog} />
  )
}

type ViewProps = {
  data?: ConnectionsResponse
  added: AddedApp[]
  onOpen: (open: Open) => void
  onClose?: () => void
  intro?: ReactNode
  dialog: boolean
}

/** The view's title: the dialog's in the popup, the page's heading in Settings. */
function Title({ dialog, children }: { dialog: boolean; children: ReactNode }) {
  return dialog ? (
    <DialogTitle className="flex-1 text-xl font-bold tracking-tight">{children}</DialogTitle>
  ) : (
    <h1 className="flex-1 text-3xl font-extrabold tracking-tight">{children}</h1>
  )
}

function Catalog({
  data,
  added,
  query,
  setQuery,
  category,
  setCategory,
  onOpen,
  onConnected,
  onClose,
  intro,
  dialog,
}: ViewProps & {
  query: string
  setQuery: (query: string) => void
  category?: string
  setCategory: (category?: string) => void
  onConnected: () => void
}) {
  const kinds: Kind[] = [...BUILT_IN, 'mcp', 'webhook']
  const categories = data ? [...new Set(kinds.map((k) => data.catalog[k].category))] : []
  const q = query.trim().toLowerCase()
  const shown = data
    ? kinds.filter((kind) => {
        const entry = data.catalog[kind]
        if (category && entry.category !== category) return false
        return !q || `${entry.name} ${entry.description}`.toLowerCase().includes(q)
      })
    : []
  // With no search or category: grouped by category, in the catalog's order.
  const groups =
    q || category
      ? [{ title: category, kinds: shown }]
      : categories.map((title) => ({
          title,
          kinds: shown.filter((k) => data!.catalog[k].category === title),
        }))

  return (
    <>
      <div className={cn('flex flex-col gap-4 pb-4', dialog && 'px-6 pt-6')}>
        <div className="flex items-center gap-3">
          <Title dialog={dialog}>{dialog ? 'Connect apps' : 'Apps'}</Title>
          {added.length > 0 && (
            <button
              type="button"
              onClick={onConnected}
              className="flex items-center gap-2 rounded-full py-1 pr-1.5 pl-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden className="flex">
                {added.slice(0, 4).map(({ app, kind }) => (
                  <span
                    key={app.id}
                    className="-ml-1.5 flex size-6 items-center justify-center overflow-hidden rounded-[0.4rem] border border-background bg-white text-[#181717] first:ml-0"
                  >
                    <ProviderLogo
                      kind={kind}
                      className={kind === 'stripe' ? 'size-full' : 'size-4'}
                    />
                  </span>
                ))}
              </span>
              {added.length} connected
              <ChevronRight className="size-4" aria-hidden />
            </button>
          )}
          {onClose && <CloseButton label="Close Connect apps" title="Close" onClick={onClose} />}
        </div>
        {intro}
        <label className="flex h-10 items-center gap-2.5 rounded-full border bg-card px-4 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div
          className={cn(
            'flex gap-2 overflow-x-auto [scrollbar-width:none]',
            dialog ? '-mx-6 px-6' : 'flex-wrap',
          )}
        >
          {[undefined, ...categories].map((c) => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                'h-8 shrink-0 rounded-full border px-3.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
                category === c
                  ? 'border-foreground bg-foreground text-background'
                  : 'bg-card hover:bg-accent',
              )}
            >
              {c ?? 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className={cn(dialog && 'flex-1 overflow-y-auto px-6 pb-6')}>
        {data && shown.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">No App matches.</p>
        )}
        {data &&
          groups
            .filter((g) => g.kinds.length > 0)
            .map((group) => (
              <section key={group.title ?? 'results'} className="flex flex-col gap-1 pt-4">
                {group.title && !category && (
                  <h3 className="pb-1 text-sm font-semibold text-muted-foreground">
                    {group.title}
                  </h3>
                )}
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {group.kinds.map((kind) => {
                    // An MCP server and a custom app are always offered: each can be added again.
                    const app =
                      kind === 'mcp' || kind === 'webhook'
                        ? undefined
                        : added.find((a) => a.kind === kind)
                    const reconnect = app?.accounts.some((c) => c.status === 'needs_reauth')
                    return (
                      <AppRow
                        key={kind}
                        kind={kind}
                        name={data.catalog[kind].name}
                        detail={data.catalog[kind].description}
                        status={reconnect ? 'reconnect' : app ? 'added' : 'add'}
                        onClick={() => onOpen({ kind, appId: app?.app.id })}
                      />
                    )
                  })}
                </div>
              </section>
            ))}
      </div>
    </>
  )
}

function Connected({
  data,
  added,
  onOpen,
  onBack,
  onClose,
  dialog,
}: ViewProps & { onBack: () => void }) {
  const description = 'Open one to see its accounts and choose which teammates get each.'
  return (
    <>
      <div className={cn('flex items-center gap-3 pb-2', dialog && 'px-6 pt-6')}>
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex flex-1 items-center gap-1 self-center rounded-md px-1 py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:flex-none"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {dialog ? 'Connect apps' : 'Apps'}
        </button>
        <span className="hidden flex-1 sm:block" />
        {onClose && <CloseButton label="Close Connect apps" title="Close" onClick={onClose} />}
      </div>
      <div className={cn(dialog && 'flex-1 overflow-y-auto px-6 pb-6')}>
        <div className="flex flex-col gap-1 pt-2 pb-3">
          <Title dialog={dialog}>Connected apps</Title>
          {dialog ? (
            <DialogDescription className="text-sm text-muted-foreground">
              {description}
            </DialogDescription>
          ) : (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {data && added.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">No Apps yet.</p>
        )}
        {data && (
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {added.map((a) => {
              const reconnect = a.accounts.some((c) => c.status === 'needs_reauth')
              return (
                <AppRow
                  key={a.app.id}
                  kind={a.kind}
                  icons={a.app.mcp?.icons}
                  name={a.app.name ?? data.catalog[a.kind].name}
                  detail={addedDetail(a)}
                  warn={reconnect}
                  status={reconnect ? 'reconnect' : 'connected'}
                  onClick={() => onOpen({ kind: a.kind, appId: a.app.id })}
                />
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

const STATUS: Record<'add' | 'added' | 'connected' | 'reconnect', string> = {
  add: 'Add',
  added: 'Added',
  connected: 'Connected',
  reconnect: 'Reconnect',
}

/** One App in the popup: the whole row opens its sheet, where it is added and managed. */
function AppRow({
  kind,
  icons,
  name,
  detail,
  warn,
  status,
  onClick,
}: {
  kind: Kind
  icons?: string[]
  name: string
  detail: string
  warn?: boolean
  status: keyof typeof STATUS
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row -mx-2 flex min-w-0 items-center gap-3 rounded-lg p-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ProviderTile kind={kind} icons={icons} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span
          className={cn(
            'truncate text-sm',
            warn ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {detail}
        </span>
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-sm',
          status === 'add' &&
            'h-8 rounded-full bg-secondary px-3.5 font-medium text-secondary-foreground group-hover/row:bg-background',
          status === 'reconnect' &&
            'h-8 rounded-full border border-destructive-text/40 px-3.5 font-medium text-destructive-text',
          status === 'added' && 'text-muted-foreground',
          status === 'connected' && 'text-success',
        )}
      >
        {status === 'added' && <Check className="size-4" aria-hidden />}
        {STATUS[status]}
      </span>
    </button>
  )
}
