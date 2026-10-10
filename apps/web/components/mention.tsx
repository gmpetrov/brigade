'use client'
import { parseMentions, type Mention } from '@brigade/contracts'
import { useEffect, useState } from 'react'
import { api, type Connection, type ConnectionsResponse, type Credential } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProviderLogo } from '@/components/provider-logo'

export type ConnectionKind = Connection['kind']

const CREDENTIAL_KINDS: Record<Credential['kind'], string> = {
  website: 'Website',
  database: 'Database',
  api_key: 'API key',
  other: 'Secret',
}

/** What a credential's menu row shows beside its name: never the secret. */
export function credentialHint(c: Credential) {
  const d = c.details
  const where = d.url ? new URL(d.url).host : d.host
  return [CREDENTIAL_KINDS[c.kind], d.username, where].filter(Boolean).join(' · ')
}

// Which service a connection is, for its icon. Loaded once per page, again when an id is new.
let kinds: Promise<Map<string, ConnectionKind>> | undefined
function connectionKinds(refresh = false) {
  if (!kinds || refresh)
    kinds = api<ConnectionsResponse>('/connections')
      .then((r) => new Map(r.connections.map((c) => [c.id, c.kind])))
      .catch(() => new Map())
  return kinds
}

function useConnectionKind(mention: Mention, known?: ConnectionKind) {
  const [kind, setKind] = useState(known)
  useEffect(() => {
    if (known || mention.kind !== 'connection') return
    let live = true
    void connectionKinds()
      .then((m) => (m.has(mention.id) ? m : connectionKinds(true)))
      .then((m) => live && setKind(m.get(mention.id)))
    return () => {
      live = false
    }
  }, [mention.kind, mention.id, known])
  return kind
}

/** A teammate reads as a name; everything else as a chip with its icon. */
export function MentionChip({
  mention,
  connectionKind,
  className,
}: {
  mention: Mention
  connectionKind?: ConnectionKind
  className?: string
}) {
  const kind = useConnectionKind(mention, connectionKind)
  if (mention.kind === 'teammate')
    return <strong className={cn('font-semibold', className)}>@{mention.label}</strong>
  return (
    <span
      data-kind={mention.kind}
      className={cn(
        'mx-px inline-flex max-w-[28ch] items-center gap-1.5 overflow-hidden rounded-md border bg-card px-1.5 align-baseline leading-relaxed text-ellipsis whitespace-nowrap text-card-foreground [&>svg]:flex-none [&>svg]:text-muted-foreground',
        className,
      )}
    >
      <MentionIcon kind={mention.kind} connectionKind={kind} />
      {mention.label}
    </span>
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
  connectionKind,
}: {
  kind: Mention['kind']
  connectionKind?: ConnectionKind
}) {
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
  if (kind === 'repository' || kind === 'project')
    return <ProviderLogo kind="github" className="size-3.5" />
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
