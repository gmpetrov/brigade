'use client'
import {
  createdTeam,
  teamCreatedMessage,
  type ProposedConnection,
  type ProposedTeammate,
  type TeamProposal,
} from '@brigade/contracts'
import { Check, Plus, Users, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { ProviderLogo } from '@/components/provider-logo'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, useApi, type Connection, type ConnectionsResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<ProposedConnection['kind'], string> = {
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
  google_search_console: 'Google Search Console',
  google_analytics: 'Google Analytics',
  stripe: 'Stripe',
  github: 'GitHub',
}

/** "read" or "read and write (asks you first)", for a connection a teammate needs. */
const scopeLabel = (scope: ProposedConnection['scope']) =>
  scope === 'read' ? 'read' : 'read and write, asks you first'

/** The workspace's live connection of a kind, if it has one. */
const connectionOf = (data: ConnectionsResponse | undefined, kind: Connection['kind']) =>
  data?.connections.find((c) => c.kind === kind && c.status !== 'removed')

/**
 * The team the chief proposes: a person edits it, connects what it needs,
 * and creates it with one click. Creating sends "Created the team: …" to the
 * thread, which closes the proposal; any other message leaves it for the chief
 * to revise.
 */
export function TeamProposalCard({
  proposal,
  reply,
  onSend,
}: {
  proposal: TeamProposal
  /** The next message in the thread, if there is one. */
  reply?: string
  onSend?: (text: string) => Promise<void>
}) {
  const { me, teammates, reloadTeammates } = useDashboard()
  const connections = useApi<ConnectionsResponse>('/connections')
  const [draft, setDraft] = useState(() =>
    proposal.teammates.map((t) => ({ ...t, included: true })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const createdNames = reply === undefined ? null : createdTeam(reply)
  // The newest teammate of each name: an older one may have been archived and replaced.
  const created =
    createdNames &&
    createdNames.flatMap((name) => {
      const found = teammates.filter((t) => t.name.toLowerCase() === name.toLowerCase()).at(-1)
      return found ? [{ id: found.id, name: found.name }] : []
    })
  const open = reply === undefined && !!onSend && isAdmin(me)

  const kinds = [
    ...new Set(draft.filter((t) => t.included).flatMap((t) => t.connections.map((c) => c.kind))),
  ]

  function edit(index: number, change: Partial<(typeof draft)[number]>) {
    setDraft((current) => current.map((t, i) => (i === index ? { ...t, ...change } : t)))
  }

  // Created, but the message telling the chief did not go: trying again only sends it.
  const [made, setMade] = useState<{ id: string; name: string }[]>()

  async function create() {
    if (!onSend) return
    setBusy(true)
    setError(undefined)
    try {
      let team = made
      if (!team) {
        const teammates: ProposedTeammate[] = draft
          .filter((t) => t.included)
          .map(({ included: _, ...t }) => t)
        team = (
          await api<{ teammates: { id: string; name: string }[] }>('/teammates/team', {
            body: { teammates },
          })
        ).teammates
        setMade(team)
        await reloadTeammates()
      }
      await onSend(teamCreatedMessage(team))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Card className="gap-4 border-primary/40 px-5 py-4">
      <div className="flex items-start gap-2">
        <Users aria-hidden className="mt-0.5 size-4 flex-none text-primary" />
        <div className="min-w-0 flex-1 font-semibold">Your team</div>
        {reply !== undefined && (
          <StatusBadge
            status={created ? 'answered' : 'replied'}
            tone={created ? 'success' : 'neutral'}
            label={created ? 'Created' : 'Replied'}
          />
        )}
      </div>

      {created ? (
        <CreatedTeam
          team={created}
          proposal={proposal}
          connections={connections.data}
          onGranted={() => void connections.reload()}
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {draft.map((t, i) => (
              <ProposedRow
                key={i}
                teammate={t}
                editable={open && !busy && !made}
                connections={connections.data}
                onChange={(change) => edit(i, change)}
              />
            ))}
          </ul>

          {open && kinds.length > 0 && <ConnectList kinds={kinds} data={connections.data} />}

          {error && <p className="text-sm text-destructive-text">{error}</p>}
          {open && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={busy || !draft.some((t) => t.included)}
                onClick={() => void create()}
              >
                {busy
                  ? 'Creating…'
                  : made
                    ? 'Tell Chief'
                    : `Create team (${draft.filter((t) => t.included).length})`}
              </Button>
              <p className="text-xs text-muted-foreground">
                Or tell Chief what to change. Their writes ask you first; change that on each
                teammate&apos;s page.
              </p>
            </div>
          )}
          {reply === undefined && onSend && !isAdmin(me) && (
            <p className="text-sm text-muted-foreground">An owner or admin creates the team.</p>
          )}
        </>
      )}
    </Card>
  )
}

/** One proposed teammate: name, role, instructions and connections, editable until created. */
function ProposedRow({
  teammate: t,
  editable,
  connections,
  onChange,
}: {
  teammate: ProposedTeammate & { included: boolean }
  editable: boolean
  connections: ConnectionsResponse | undefined
  onChange: (change: Partial<ProposedTeammate & { included: boolean }>) => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-3.5',
        !t.included && 'opacity-50',
      )}
    >
      <div className="flex items-start gap-3">
        <TeammateAvatar teammate={{ name: t.name }} className="size-9 shrink-0 text-sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-semibold">{t.name}</p>
          <p className="text-sm text-muted-foreground">{t.role}</p>
        </div>
        {editable && (
          <div className="flex shrink-0 gap-1">
            {t.included && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
                {editing ? 'Done' : 'Edit'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t.included ? `Leave out ${t.name}` : `Add ${t.name} back`}
              title={t.included ? 'Leave out' : 'Add back'}
              onClick={() => {
                setEditing(false)
                onChange({ included: !t.included })
              }}
            >
              {t.included ? <X aria-hidden /> : <Plus aria-hidden />}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`name-${t.name}`}>Name</Label>
            <Input
              id={`name-${t.name}`}
              defaultValue={t.name}
              onBlur={(e) => e.target.value.trim() && onChange({ name: e.target.value.trim() })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`instructions-${t.name}`}>Instructions</Label>
            <Textarea
              id={`instructions-${t.name}`}
              rows={8}
              defaultValue={t.instructions}
              onBlur={(e) => onChange({ instructions: e.target.value })}
            />
          </div>
        </div>
      )}

      {t.connections.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {t.connections.map((c) => {
            const connected = !!connectionOf(connections, c.kind)
            return (
              <li
                key={c.kind}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                title={c.why}
              >
                <ProviderLogo kind={c.kind} className="size-3.5" />
                <span className="font-medium">{KIND_LABEL[c.kind]}</span>
                <span className="text-muted-foreground">· {scopeLabel(c.scope)}</span>
                {connected && <Check aria-label="connected" className="size-3.5 text-success" />}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

/** The connections the team needs, each connected already or with its Connect button. */
function ConnectList({
  kinds,
  data,
  created,
}: {
  kinds: ProposedConnection['kind'][]
  data: ConnectionsResponse | undefined
  /** The team exists: connecting is all that is left. */
  created?: boolean
}) {
  const pathname = usePathname()
  const [error, setError] = useState<string>()

  async function connect(kind: ProposedConnection['kind']) {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>(
        kind === 'github'
          ? '/connections/github'
          : kind === 'stripe'
            ? '/connections/mcp'
            : '/connections/google',
        { body: kind === 'github' ? { returnTo: pathname } : { kind, returnTo: pathname } },
      )
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3.5">
      <p className="text-sm font-semibold">Apps this team needs</p>
      <ul className="flex flex-col gap-2">
        {kinds.map((kind) => {
          const connection = connectionOf(data, kind)
          const available = data?.available[kind] ?? true
          return (
            <li key={kind} className="flex items-center gap-2.5 text-sm">
              <ProviderLogo kind={kind} className="size-4" />
              <span className="flex-1">
                {KIND_LABEL[kind]}
                {connection?.externalAccount && (
                  <span className="text-muted-foreground"> · {connection.externalAccount}</span>
                )}
              </span>
              {connection ? (
                <span className="flex items-center gap-1 text-xs font-medium text-success">
                  <Check className="size-3.5" aria-hidden />
                  Connected
                </span>
              ) : available ? (
                <Button size="sm" variant="outline" onClick={() => void connect(kind)}>
                  Connect
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Not set up on this Brigade</span>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {!created && !kinds.every((kind) => connectionOf(data, kind)) && (
        <p className="text-xs text-muted-foreground">
          You can also create the team first and connect these after.
        </p>
      )}
    </div>
  )
}

/**
 * The team once created: each teammate, and for each connection it needed
 * that it was not given (not connected then), a button to give it now.
 */
function CreatedTeam({
  team,
  proposal,
  connections,
  onGranted,
}: {
  team: { id: string; name: string }[]
  proposal: TeamProposal
  connections: ConnectionsResponse | undefined
  onGranted: () => void
}) {
  const { me } = useDashboard()
  const [error, setError] = useState<string>()
  // The proposal said what each needs; matched by name, as the person may have left some out.
  const needs = (name: string) =>
    proposal.teammates.find((p) => p.name.toLowerCase() === name.toLowerCase())?.connections ?? []

  const unconnected = [
    ...new Set(
      team.flatMap((t) =>
        needs(t.name)
          .filter((need) => !connectionOf(connections, need.kind))
          .map((need) => need.kind),
      ),
    ),
  ]

  async function grant(
    teammateId: string,
    connectionId: string,
    scope: ProposedConnection['scope'],
  ) {
    setError(undefined)
    try {
      await api(`/teammates/${teammateId}/grants`, {
        method: 'PUT',
        body: { connectionId, scope },
      })
      onGranted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {team.map((t) => {
          const missing = needs(t.name).flatMap((need) => {
            const connection = connectionOf(connections, need.kind)
            if (!connection || connection.grants.some((g) => g.teammateId === t.id)) return []
            return [{ need, connection }]
          })
          const waiting = needs(t.name).filter((need) => !connectionOf(connections, need.kind))
          return (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
            >
              <TeammateAvatar teammate={t} className="size-8 shrink-0 text-sm" />
              <Link href={`/app/teammates/${t.id}`} className="font-semibold hover:underline">
                {t.name}
              </Link>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {isAdmin(me) &&
                  missing.map(({ need, connection }) => (
                    <Button
                      key={need.kind}
                      size="sm"
                      variant="outline"
                      onClick={() => void grant(t.id, connection.id, need.scope)}
                    >
                      <ProviderLogo kind={need.kind} className="size-3.5" />
                      Give {KIND_LABEL[need.kind]}
                    </Button>
                  ))}
                {waiting.map((need) => (
                  <span key={need.kind} className="text-xs text-muted-foreground">
                    {KIND_LABEL[need.kind]} not connected
                  </span>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      {isAdmin(me) && unconnected.length > 0 && (
        <ConnectList kinds={unconnected} data={connections} created />
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}
