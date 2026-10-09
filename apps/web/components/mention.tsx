'use client'
import { parseMentions, type Mention } from '@brigade/contracts'
import { useEffect, useState } from 'react'
import { api, type Connection, type ConnectionsResponse, type Credential } from '@/lib/api'
import { cn } from '@/lib/utils'

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
    if (connectionKind === 'gmail')
      return (
        <svg {...common}>
          <path d="M3 6.5 12 13l9-6.5" fill="none" stroke="#EA4335" strokeWidth="2.4" />
          <path d="M3 6.5V19h3.5v-8.5" fill="#4285F4" />
          <path d="M21 6.5V19h-3.5v-8.5" fill="#34A853" />
          <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="#C5221F" />
        </svg>
      )
    if (connectionKind === 'google_calendar')
      return (
        <svg {...common}>
          <rect
            x="3"
            y="4"
            width="18"
            height="17"
            rx="3"
            fill="#fff"
            stroke="#4285F4"
            strokeWidth="2"
          />
          <path d="M3 9h18" stroke="#4285F4" strokeWidth="2" />
          <path d="M8 2.5v3M16 2.5v3" stroke="#1A73E8" strokeWidth="2" strokeLinecap="round" />
          <rect x="8" y="12" width="3" height="3" rx=".5" fill="#EA4335" />
        </svg>
      )
    if (connectionKind === 'stripe')
      return (
        <svg {...common}>
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#635BFF" />
          <path
            d="M14.8 9.2c-.6-.4-1.5-.7-2.4-.7-.9 0-1.4.3-1.4.8 0 1.4 4.6.7 4.6 3.9 0 1.6-1.3 2.7-3.4 2.7-1.1 0-2.3-.3-3.1-.8"
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )
    // A plug: a connection whose service is unknown here.
    return (
      <svg {...line}>
        <path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0zM12 16v5" />
      </svg>
    )
  }
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
