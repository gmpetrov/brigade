'use client'
import {
  DESIGN_SYSTEM_README,
  isLegacyProjectMention,
  parseMentions,
  type Mention,
} from '@brigade/contracts'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api, type Connection, type ConnectionsResponse, type Credential } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useMaybeDashboard } from '@/components/dashboard'
import { useFileLinks } from '@/components/file-links'
import { ProjectIcon } from '@/components/projects'
import { ProviderLogo } from '@/components/provider-logo'
import { Hint } from '@/components/ui/tooltip'

export type ConnectionKind = Connection['kind']

const CREDENTIAL_KINDS: Record<Credential['kind'], string> = {
  website: 'Website',
  database: 'Database',
  api_key: 'API key',
  other: 'Other',
}

/** What a credential's menu row shows beside its name: never the secret. */
export function credentialHint(c: Credential) {
  const d = c.details
  const where = d.url ? new URL(d.url).host : d.host
  return [CREDENTIAL_KINDS[c.kind], d.username, where].filter(Boolean).join(' · ')
}

/** How a message names a connection: its App and its account, so two Stripe accounts differ. */
export function connectionMentionLabel(c: Pick<Connection, 'label' | 'externalAccount'>) {
  return c.externalAccount ? `${c.label} · ${c.externalAccount}` : c.label
}

type KnownConnection = Pick<Connection, 'kind' | 'label' | 'externalAccount'>

// Which service and account a connection is. Loaded once per page, again when an id is new.
let connections: Promise<Map<string, KnownConnection>> | undefined
function knownConnections(refresh = false) {
  if (!connections || refresh)
    connections = api<ConnectionsResponse>('/connections')
      .then((r) => new Map(r.connections.map((c) => [c.id, c])))
      .catch(() => new Map())
  return connections
}

function useConnection(mention: Mention, known?: ConnectionKind) {
  const [connection, setConnection] = useState<KnownConnection>()
  useEffect(() => {
    if (mention.kind !== 'connection') return
    let live = true
    void knownConnections()
      .then((m) => (m.has(mention.id) ? m : knownConnections(true)))
      .then((m) => live && setConnection(m.get(mention.id)))
    return () => {
      live = false
    }
  }, [mention.kind, mention.id])
  return { kind: known ?? connection?.kind, connection }
}

/**
 * A teammate reads as a name; everything else as a chip with its icon. A library file opens in the
 * panel, an email its conversation in the Inbox.
 */
export function MentionChip({
  mention,
  connectionKind,
  className,
  onOpen,
}: {
  mention: Mention
  connectionKind?: ConnectionKind
  className?: string
  /** What a click does, in place of the thread's file links. */
  onOpen?: () => void
}) {
  const { kind, connection } = useConnection(mention, connectionKind)
  const links = useFileLinks()
  if (mention.kind === 'teammate')
    return <strong className={cn('font-semibold', className)}>@{mention.label}</strong>
  // A design system opens on its rules, the one file every system has.
  const path =
    mention.kind === 'design-system'
      ? `${mention.id}/${DESIGN_SYSTEM_README}`
      : mention.kind === 'document' || mention.kind === 'design'
        ? mention.label
        : undefined
  const open = onOpen ?? (path !== undefined && links ? () => links.open({ path }) : undefined)
  // Older messages name a connection by its App alone: add its account.
  const label =
    connection && mention.label === connection.label
      ? connectionMentionLabel(connection)
      : mention.label
  const Tag = open ? 'button' : 'span'
  const chip =
    'mx-px inline-flex max-w-[28ch] items-center gap-1.5 overflow-hidden rounded-md border bg-card px-1.5 align-baseline leading-relaxed text-ellipsis whitespace-nowrap text-card-foreground [&>svg]:flex-none [&>svg]:text-muted-foreground'
  // An email opens its conversation in the Inbox.
  if (mention.kind === 'email')
    return (
      <Hint label={`Open ${mention.label} in the Inbox`}>
        <Link
          href={`/app/inbox?status=all&item=${encodeURIComponent(`mail:${mention.id}`)}`}
          data-kind="email"
          className={cn(chip, 'max-w-[40ch] hover:bg-accent', className)}
        >
          <MentionIcon kind="email" />
          <span className="min-w-0 truncate">{mention.label}</span>
        </Link>
      </Hint>
    )
  // A project opens its page.
  if (mention.kind === 'project' && !isLegacyProjectMention(mention))
    return (
      <Link
        href={`/app/projects/${mention.id}`}
        data-kind="project"
        className={cn(chip, 'hover:bg-accent', className)}
      >
        <MentionIcon kind="project" id={mention.id} />
        {mention.label}
      </Link>
    )
  // A chip that opens says so in a tooltip; one that doesn't keeps the plain title, for a
  // label cut short.
  return (
    <Hint label={open ? `Open ${label}` : undefined}>
      <Tag
        data-kind={mention.kind}
        {...(open && {
          type: 'button' as const,
          onClick: open,
        })}
        title={open ? undefined : label}
        className={cn(
          open && 'cursor-pointer hover:bg-accent',
          chip,
          // Room for the account, which is what tells two accounts of one App apart.
          mention.kind === 'connection' && 'max-w-[40ch]',
          className,
        )}
      >
        <MentionIcon
          kind={isLegacyProjectMention(mention) ? 'repository' : mention.kind}
          connectionKind={kind}
        />
        <span className="min-w-0 truncate">{label}</span>
      </Tag>
    </Hint>
  )
}

/** Message text with its mentions as chips. */
export function MessageText({ text }: { text: string }) {
  return parseMentions(text).map((part, i) =>
    typeof part === 'string' ? part : <MentionChip key={i} mention={part} />,
  )
}

export function MentionIcon({
  kind,
  id,
  connectionKind,
}: {
  kind: Mention['kind']
  /** What is mentioned: a project shows its own logo or icon. */
  id?: string
  connectionKind?: ConnectionKind
}) {
  const project = useMaybeDashboard()?.projects.find((p) => kind === 'project' && p.id === id)
  if (project)
    return <ProjectIcon project={project} className="size-3.5 rounded-[3px] text-[0.5rem]" />
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true } as const
  const line = {
    ...common,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  if (kind === 'connection') {
    if (connectionKind) return <ProviderLogo kind={connectionKind} className="size-3.5" />
    // A plug: a connection whose service is unknown here.
    return (
      <svg {...line}>
        <path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0zM12 16v5" />
      </svg>
    )
  }
  if (kind === 'repository') return <ProviderLogo kind="github" className="size-3.5" />
  if (kind === 'project')
    // A board: a project's work.
    return (
      <svg {...line}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M15 4v9" />
      </svg>
    )
  if (kind === 'document')
    return (
      <svg {...line}>
        <path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6" />
      </svg>
    )
  if (kind === 'design')
    return (
      <svg {...line}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 9v11" />
      </svg>
    )
  if (kind === 'design-system')
    // A palette.
    return (
      <svg {...line}>
        <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.9 1.4-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z" />
        <circle cx="7.5" cy="11.5" r="1" />
        <circle cx="10.5" cy="7.5" r="1" />
        <circle cx="15.5" cy="8.5" r="1" />
      </svg>
    )
  if (kind === 'email')
    // An envelope.
    return (
      <svg {...line}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    )
  if (kind === 'thread')
    return (
      <svg {...line}>
        <path d="M4 5h16v11H9l-5 4z" />
      </svg>
    )
  if (kind === 'credential')
    return (
      <svg {...line}>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9M17 6l3 3M14 9l2 2" />
      </svg>
    )
  if (kind === 'computer')
    return (
      <svg {...line}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    )
  return (
    <svg {...line}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  )
}
