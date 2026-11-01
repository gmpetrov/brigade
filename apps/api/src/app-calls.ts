// A teammate's list_apps, from any thread but a playbook's run (which has only the Apps the
// playbook declares): the App accounts it uses here, the workspace's it may ask for with an
// access ticket, and the Apps a person may connect for it, so it can suggest one from what a
// person needs ("track my Google rankings": Ahrefs). Names only, one line each: an account's
// tools stay in the thread's spec, as before. Scoped to the person the thread works for, never
// to the teammate, which works for every member and in threads an event or a routine started:
// another member's own account (reach mine) never shows, and a thread several people ask in
// shows no member's own account at all, as none answers there (connector-calls.ts).
import type { ScheduleOperation } from '@brigade/contracts'
import { appCatalog, connectors } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import type { ScopedDb } from './db.js'
import { customMcp } from './mcp-servers.js'
import { availableApps } from './routes/connections.js'
import { askedBy, teammateGrants, usableGrants } from './thread-spec.js'

type Operation = Extract<ScheduleOperation, { name: 'list_apps' }>
type Session = {
  id: string
  playbookRunId: string | null
  startedByMemberId: string
  projectId: string | null
}
type Account = {
  kind: ConnectorKind
  label: string
  externalAccount: string | null
  status: string
  appId: string
}

/**
 * The Apps a teammate asks for in an access ticket: open_ticket's app.kind, which a test keeps
 * in step with these. Every App of the catalog but a custom app, which only receives webhooks
 * (no tools), and the Email App, whose addresses are given from its own pages (an agent's own
 * address, a project's inbox), never from a ticket. Read when called: this file is imported while
 * the catalog's own imports still load (through schedules.ts).
 */
export const askableKinds = (): ConnectorKind[] =>
  (Object.keys(appCatalog) as ConnectorKind[]).filter(
    (kind) => kind !== 'webhook' && kind !== 'email',
  )

/** Accounts by their App's name, then their own. */
const listed = (lines: string[]) =>
  lines.length ? lines.sort((a, b) => a.localeCompare(b)) : ['None.']

export async function handleAppCall(
  db: ScopedDb,
  session: Session,
  teammate: { id: string },
  _op: Operation,
): Promise<{ error: string } | { output: string }> {
  if (session.playbookRunId)
    return { error: "A playbook's run has only the Apps the playbook declares." }
  const [granted, connections, servers, asker] = await Promise.all([
    teammateGrants(db, teammate.id),
    db.connection.findMany({
      where: { status: { not: 'removed' } },
      select: {
        id: true,
        kind: true,
        label: true,
        externalAccount: true,
        status: true,
        reach: true,
        createdByMemberId: true,
        appId: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    // MCP servers added by their URL, by their own names.
    db.app.findMany({
      where: { key: { startsWith: 'mcp:' } },
      select: { id: true, name: true, mcp: true },
      orderBy: { createdAt: 'asc' },
    }),
    askedBy(db, session.id),
  ])
  // Whose own accounts may show: the thread's starter while nobody else asks in it (an event's or
  // a routine's thread runs on its starter's accounts, and nobody asks there); no one's once another
  // member does.
  const person = !asker || asker === session.startedByMemberId ? session.startedByMemberId : null
  const shown = (c: { reach: string; createdByMemberId: string }) =>
    c.reach === 'workspace' || c.createdByMemberId === person
  const serverName = new Map(servers.map((s) => [s.id, s.name ?? appCatalog.mcp.name]))
  // An MCP server is asked for by its name (what), which a ticket finds it by; by its URL too
  // when that name does not tell it apart (staging and production both "Team Notes", or no name
  // of its own), else the ticket takes the first of that name. Only then: a URL may hold the
  // server's key (some providers put one in its path).
  const same = (name: string) => name.trim().toLowerCase()
  const named = new Map<string, number>()
  for (const { name } of servers) if (name) named.set(same(name), (named.get(same(name)) ?? 0) + 1)
  const server = (appId: string) => {
    const found = servers.find((s) => s.id === appId)
    const url = found && customMcp(found)?.url
    const unique = !!found?.name && named.get(same(found.name)) === 1
    return `what "${serverName.get(appId) ?? appCatalog.mcp.name}"${url && !unique ? `, app.url "${url}"` : ''}`
  }
  const app = (c: Account) =>
    c.kind === 'mcp' ? (serverName.get(c.appId) ?? appCatalog.mcp.name) : appCatalog[c.kind].name
  const account = (c: Account) =>
    `${app(c)} · ${c.externalAccount ?? c.label}${c.status === 'needs_reauth' ? ' (sign-in expired)' : ''}`

  // The accounts the thread's spec gives, as tools.
  const yours = (await usableGrants(db, session, teammate.id, granted, null)).filter(
    (g) => (connectors[g.connection.kind] || g.connection.kind === 'mcp') && shown(g.connection),
  )
  const askable = askableKinds()
  const used = new Set(yours.map((g) => g.connection.id))
  const others = connections.filter((c) => askable.includes(c.kind) && !used.has(c.id) && shown(c))
  const accounts = [...yours.map((g) => g.connection), ...others]
  const kinds = new Set(accounts.map((c) => c.kind))
  const apps = new Set(accounts.map((c) => c.appId))
  const available = availableApps()

  const lines = ['Your accounts, whose tools you have here:']
  lines.push(...listed(yours.map((g) => `- ${account(g.connection)}: ${g.scope}`)))
  if (!person)
    lines.push(
      "Several people ask in this thread, so it uses no member's own account (their Gmail, their Notion…), only " +
        'those the workspace shares: for one of their own, a person asks you in a thread of their own.',
    )
  lines.push(
    '',
    'Connected in the workspace, not granted to you: ask for one with open_ticket, an access ask of kind ' +
      'connection with app.kind and app.account as shown (and what and app.url, for an MCP server), and the scope ' +
      'you need.',
  )
  lines.push(
    ...listed(
      others.map(
        (c) =>
          `- ${account(c)}: app.kind ${c.kind}${c.kind === 'mcp' ? `, ${server(c.appId)}` : ''}, ` +
          `app.account "${c.externalAccount ?? c.label}"`,
      ),
    ),
  )
  lines.push(
    '',
    'Apps you can connect, with no account here yet: ask for one with open_ticket, an access ask of kind ' +
      'connection with its app.kind (and what and app.url, for an MCP server); the person connects it from the ' +
      'ticket.',
  )
  for (const kind of askable)
    if (kind !== 'mcp' && available[kind] && !kinds.has(kind))
      lines.push(`- ${appCatalog[kind].name} (app.kind ${kind}): ${appCatalog[kind].description}`)
  for (const { id } of servers)
    if (!apps.has(id))
      lines.push(
        `- ${serverName.get(id)} (app.kind mcp, ${server(id)}): an MCP server added in the workspace`,
      )
  lines.push(`- ${appCatalog.mcp.name} (app.kind mcp, with its url): ${appCatalog.mcp.description}`)
  return { output: lines.join('\n') }
}
