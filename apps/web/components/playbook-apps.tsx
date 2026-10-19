'use client'
// A playbook's Apps, as its cards and sheet show them. Each is one App (Gmail) or a role any of
// several Apps can hold (an analytics tool: Mixpanel or an MCP server), shown by its name and the
// logos of the Apps it accepts, with the account it uses or that one is missing.
import { playbookRoles, type PlaybookApp, type PlaybookAppStatus } from '@brigade/contracts'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { cn } from '@/lib/utils'

const APP_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  github: 'GitHub',
  stripe: 'Stripe',
  mixpanel: 'Mixpanel',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  resend: 'Resend',
  linear: 'Linear',
  notion: 'Notion',
  mcp: 'an MCP server',
}
export const appName = (kind: string) => APP_NAMES[kind] ?? kind.replace(/_/g, ' ')

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "Mixpanel or an MCP server". */
const kindsWords = (kinds: string[]) => {
  const names = kinds.map(appName)
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
    : capitalized(names[0] ?? '')
}

type Role = Pick<PlaybookAppStatus, 'name' | 'kinds' | 'access' | 'optional' | 'plain'>

/** A template's Apps or an installation's, as roles. */
export const asRoles = (apps: (PlaybookApp | PlaybookAppStatus)[]): Role[] =>
  apps.map((a) => ('kinds' in a && 'plain' in a ? a : playbookRoles([a as PlaybookApp])[0]!))

/** The logos of the Apps its roles accept, each once, overlapping. */
export function AppLogos({ apps }: { apps: (PlaybookApp | PlaybookAppStatus)[] }) {
  const kinds = [...new Set(asRoles(apps).flatMap((r) => r.kinds))]
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {kinds.slice(0, 4).map((kind) => (
        <span key={kind} className="grid size-7 place-items-center rounded-full border bg-card">
          <ProviderLogo kind={kind as ProviderKind} className="size-4" />
        </span>
      ))}
    </span>
  )
}

/** One row's state: the account it uses, or that it has none. */
function stateOf(app: PlaybookAppStatus) {
  if (app.chosen) return { text: app.chosen.name, missing: false }
  if (app.picks || app.status === 'missing')
    return {
      text: app.optional ? 'No account · optional' : 'No account yet',
      missing: !app.optional,
    }
  if (app.status === 'read_only') return { text: 'Read-only access', missing: true }
  return { text: app.accounts.join(', '), missing: false }
}

/** A row's content: the logos, the name (and for a role, the Apps it accepts), its state. */
export function AppRowBody({ app }: { app: PlaybookApp | PlaybookAppStatus }) {
  const role = asRoles([app])[0]!
  const status = 'status' in app ? stateOf(app) : null
  return (
    <>
      <span className="flex shrink-0 -space-x-1">
        {role.kinds.map((kind) => (
          <ProviderLogo key={kind} kind={kind as ProviderKind} className="size-4" />
        ))}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {role.plain ? appName(role.name) : capitalized(role.name.replace(/_/g, ' '))}
        </span>
        {!role.plain && (
          <span className="truncate text-xs text-muted-foreground">{kindsWords(role.kinds)}</span>
        )}
      </span>
      <span
        className={cn(
          'max-w-[50%] truncate text-xs text-muted-foreground',
          status?.missing && 'text-warning',
        )}
      >
        {status
          ? status.text
          : `${role.access === 'read' ? 'Reads' : 'Reads and writes'}${role.optional ? ' · optional' : ''}`}
      </span>
    </>
  )
}

export function AppList({ apps }: { apps: (PlaybookApp | PlaybookAppStatus)[] }) {
  return (
    <ul className="flex flex-col divide-y rounded-lg bg-muted/60">
      {apps.map((a) => (
        <li
          key={asRoles([a])[0]!.name}
          className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm"
        >
          <AppRowBody app={a} />
        </li>
      ))}
    </ul>
  )
}
