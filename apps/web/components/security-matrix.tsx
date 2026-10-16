'use client'
// The access matrix: teammates across, what they may reach down. Policies
// (changes through connections, the library), connections and credentials.
// Each cell opens a menu of the levels its row allows; a cell this member
// may not change shows its level and why. At phone width it shows one
// teammate at a time.
import { folderAccessFor, type FolderRule } from '@brigade/contracts'
import { Check, KeyRound, Library, Lock, ShieldAlert, Zap } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { credentialHint } from '@/components/mention'
import { ProviderTile } from '@/components/provider-logo'
import { TeammateAvatar } from '@/components/dashboard'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AccessOverview, CredentialGrantLevel } from '@/lib/api'

type Teammate = AccessOverview['teammates'][number]

/** Library folders where the teammate's access differs from the folder above, hidden ones included. */
function folderExceptionCount(t: Teammate, rules: FolderRule[]) {
  const who = { id: t.id, library: t.libraryAccess }
  return rules.filter((r) => {
    const parent = r.path.includes('/')
      ? folderAccessFor(r.path.slice(0, r.path.lastIndexOf('/')), who, rules)
      : t.libraryAccess
    return folderAccessFor(r.path, who, rules) !== parent
  }).length
}
type Look = 'none' | 'partial' | 'full' | 'free'
type Option = { value: string; label: string; hint: string; look: Look; text?: string }

const CONNECTION: Option[] = [
  { value: 'none', label: 'No access', hint: 'Cannot use this connection', look: 'none' },
  { value: 'read', label: 'Read only', hint: 'Reads, never changes anything', look: 'partial' },
  {
    value: 'read_write',
    label: 'Read and write',
    hint: 'Sends, edits and deletes, under its policy',
    look: 'full',
  },
]
const CREDENTIAL: Option[] = [
  { value: 'none', label: 'No access', hint: 'Not shared with this teammate', look: 'none' },
  {
    value: 'use',
    label: 'Can use, asks first',
    hint: 'Needs a mention in the thread or a person’s approval',
    look: 'full',
  },
  {
    value: 'without_asking',
    label: 'Without asking',
    hint: 'Uses it in any thread, triggered or scheduled ones too',
    look: 'free',
  },
]
const LIBRARY: Option[] = [
  {
    value: 'read',
    label: 'Read only',
    hint: 'Searches the library and memory',
    look: 'partial',
    text: 'Read',
  },
  {
    value: 'read_write',
    label: 'Read and write',
    hint: 'Also saves files to the library',
    look: 'full',
    text: 'Write',
  },
]
const WRITES: Option[] = [
  {
    value: 'allow',
    label: 'Allow',
    hint: 'Sends, edits and deletes without asking anyone',
    look: 'free',
    text: 'Allow',
  },
  {
    value: 'ask',
    label: 'Ask a person first',
    hint: 'Each change waits for a person’s approval',
    look: 'full',
    text: 'Ask',
  },
  {
    value: 'deny',
    label: 'Never',
    hint: 'Never changes anything; only reads',
    look: 'none',
    text: 'Never',
  },
]

/** How a level looks in its cell: a dot for grants, a short word for policies. */
function Mark({ option }: { option: Option }) {
  if (option.text)
    return (
      <span
        className={cn(
          'inline-flex h-7 min-w-14 items-center justify-center rounded-full px-2.5 text-xs font-semibold',
          option.look === 'free' && 'bg-warning/15 text-warning',
          option.look === 'full' && 'bg-success/15 text-success',
          option.look === 'partial' && 'border border-success/50 text-success',
          option.look === 'none' && 'bg-muted text-muted-foreground',
        )}
      >
        {option.text}
      </span>
    )
  return (
    <span
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-full',
        option.look === 'none' && 'bg-muted',
        option.look === 'partial' && 'border-2 border-success/50 text-success',
        option.look === 'full' && 'bg-success/15 text-success',
        option.look === 'free' && 'bg-warning/15 text-warning',
      )}
    >
      {option.look === 'free' ? (
        <Zap className="size-4" aria-hidden />
      ) : option.look !== 'none' ? (
        <Check className="size-4" aria-hidden />
      ) : null}
    </span>
  )
}

function Cell({
  options,
  value,
  label,
  locked,
  onChange,
}: {
  options: Option[]
  value: string
  /** What the cell is: teammate and row, for screen readers and the menu. */
  label: string
  /** Why this member cannot change it; unset when they can. */
  locked?: string
  onChange: (value: string) => void
}) {
  const option = options.find((o) => o.value === value) ?? options[0]!
  if (locked)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={`${label}: ${option.label}. ${locked}`}
            className="inline-flex rounded-full"
          >
            <Mark option={option} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {option.label}. {locked}
        </TooltipContent>
      </Tooltip>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label}: ${option.label}. Change`}
        className="inline-flex rounded-full outline-none transition hover:ring-2 hover:ring-ring/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Mark option={option} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} className="items-start">
              <span className="flex flex-col">
                <span className="font-medium">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type MatrixActions = {
  setConnection: (teammateId: string, connectionId: string, scope: string) => void
  setCredential: (credentialId: string, teammateId: string, level: CredentialGrantLevel) => void
  shareCredential: (credentialId: string, all: boolean) => void
  setLibrary: (teammateId: string, access: string) => void
  setWrites: (teammateId: string, policy: string) => void
}

export function AccessMatrix({
  data,
  admin,
  memberId,
  actions,
}: {
  data: AccessOverview
  admin: boolean
  memberId: string | null
  actions: MatrixActions
}) {
  const { teammates } = data
  // At phone width: one teammate's column at a time.
  const [focus, setFocus] = useState(teammates[0]?.id)
  const focused = teammates.some((t) => t.id === focus) ? focus : teammates[0]?.id
  const col = (t: Teammate) => cn(t.id !== focused && 'hidden sm:table-cell')
  const adminOnly = admin ? undefined : 'Only an admin can change this.'

  if (teammates.length === 0)
    return (
      <div className="rounded-xl border border-dashed px-6 py-12 text-center">
        <p className="font-semibold">No teammates yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Access is set per teammate.{' '}
          <Link href="/app/teammates/new" className="font-medium text-primary hover:underline">
            Create a teammate
          </Link>
          .
        </p>
      </div>
    )

  const section = (title: string, aside?: ReactNode) => (
    <tr>
      <th
        scope="colgroup"
        colSpan={teammates.length + 1}
        className="border-t bg-muted/60 px-4 py-2 text-left font-mono text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase sm:px-5"
      >
        <span className="flex items-center gap-3">
          <span className="flex-1">{title}</span>
          {aside}
        </span>
      </th>
    </tr>
  )
  const rowHead = (icon: ReactNode, name: ReactNode, sub?: ReactNode, extra?: ReactNode) => (
    <th
      scope="row"
      className="sticky left-0 z-10 w-full max-w-0 bg-card px-4 py-3 text-left font-normal sm:w-72 sm:max-w-72 sm:px-5"
    >
      <span className="flex items-center gap-3">
        {icon}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">{name}</span>
          {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
          {extra}
        </span>
      </span>
    </th>
  )
  const tile = (children: ReactNode) => (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
    >
      {children}
    </span>
  )
  const cellClass = 'px-2 py-3 text-center'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 sm:hidden">
        <span className="text-sm font-medium">Showing</span>
        <Select value={focused} onValueChange={setFocus}>
          <SelectTrigger className="flex-1" aria-label="Teammate to show">
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
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card px-4 py-3 text-left align-bottom font-mono text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase sm:px-5"
              >
                Access
              </th>
              {teammates.map((t) => (
                <th
                  key={t.id}
                  scope="col"
                  className={cn('min-w-24 px-2 py-3 align-bottom', col(t))}
                >
                  <Link
                    href={`/app/teammates/${t.id}`}
                    className="group flex flex-col items-center gap-1.5"
                  >
                    <TeammateAvatar teammate={t} className="size-9 text-sm" />
                    <span className="max-w-24 truncate text-xs font-semibold group-hover:underline">
                      {t.name}
                    </span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="[&>tr]:border-t">
            {section('Policies')}
            <tr>
              {rowHead(
                tile(<ShieldAlert className="size-4" />),
                'Acts without approval',
                'Sending, editing, deleting',
              )}
              {teammates.map((t) => (
                <td key={t.id} className={cn(cellClass, col(t))}>
                  <Cell
                    options={WRITES}
                    value={t.connectorWrites}
                    label={`${t.name} · Acts without approval`}
                    locked={adminOnly}
                    onChange={(v) => actions.setWrites(t.id, v)}
                  />
                </td>
              ))}
            </tr>
            <tr>
              {rowHead(
                tile(<Library className="size-4" />),
                <Link href="/app/library" className="truncate hover:underline">
                  Document library
                </Link>,
                'Search, memory and the shared files',
              )}
              {teammates.map((t) => (
                <td key={t.id} className={cn(cellClass, col(t))}>
                  <Cell
                    options={LIBRARY}
                    value={t.libraryAccess}
                    label={`${t.name} · Document library`}
                    locked={adminOnly}
                    onChange={(v) => actions.setLibrary(t.id, v)}
                  />
                  {(() => {
                    const differ = folderExceptionCount(t, data.libraryFolders ?? [])
                    return (
                      differ > 0 && (
                        <Link
                          href="/app/library"
                          className="mt-1 block text-xs text-muted-foreground hover:underline"
                        >
                          {differ === 1 ? '1 folder differs' : `${differ} folders differ`}
                        </Link>
                      )
                    )
                  })()}
                </td>
              ))}
            </tr>

            {section(
              'Apps',
              <Link
                href="/app/connections"
                className="tracking-normal normal-case text-primary hover:underline"
              >
                Manage
              </Link>,
            )}
            {data.connections.length === 0 ? (
              <tr>
                <td
                  colSpan={teammates.length + 1}
                  className="px-5 py-3 text-sm text-muted-foreground"
                >
                  No connections yet.{' '}
                  <Link
                    href="/app/connections"
                    className="font-medium text-primary hover:underline"
                  >
                    Connect a service
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              data.connections.map((cn_) => (
                <tr key={cn_.id}>
                  {rowHead(
                    <ProviderTile kind={cn_.kind} small />,
                    <span className="truncate">{cn_.label}</span>,
                    cn_.status === 'needs_reauth'
                      ? 'Needs to be connected again'
                      : (cn_.externalAccount ?? undefined),
                  )}
                  {teammates.map((t) => (
                    <td key={t.id} className={cn(cellClass, col(t))}>
                      <Cell
                        options={CONNECTION}
                        value={
                          data.connectionGrants.find(
                            (g) => g.teammateId === t.id && g.connectionId === cn_.id,
                          )?.scope ?? 'none'
                        }
                        label={`${t.name} · ${cn_.externalAccount ?? cn_.label}`}
                        locked={adminOnly}
                        onChange={(v) => actions.setConnection(t.id, cn_.id, v)}
                      />
                    </td>
                  ))}
                </tr>
              ))
            )}

            {section(
              'Secrets',
              <Link
                href="/app/vault"
                className="tracking-normal normal-case text-primary hover:underline"
              >
                Manage
              </Link>,
            )}
            {data.credentials.length === 0 ? (
              <tr>
                <td
                  colSpan={teammates.length + 1}
                  className="px-5 py-3 text-sm text-muted-foreground"
                >
                  No secrets yet.{' '}
                  <Link href="/app/vault" className="font-medium text-primary hover:underline">
                    Add a secret
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              data.credentials.map((c) => {
                const mayChange = admin || c.createdByMemberId === memberId
                const locked = mayChange
                  ? undefined
                  : 'Only its creator or an admin can change this.'
                const levelOf = (teammateId: string): CredentialGrantLevel => {
                  const g = c.grants.find((g) => g.teammateId === teammateId)
                  return g?.withoutAsking
                    ? 'without_asking'
                    : g || c.access === 'all'
                      ? 'use'
                      : 'none'
                }
                return (
                  <tr key={c.id}>
                    {rowHead(
                      tile(<KeyRound className="size-4" />),
                      <>
                        <span className="truncate">{c.name}</span>
                        {c.access === 'all' && (
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px] tracking-widest"
                          >
                            SHARED
                          </Badge>
                        )}
                      </>,
                      credentialHint(c),
                      mayChange && (
                        <label className="mt-1 flex w-fit items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            size="sm"
                            checked={c.access === 'all'}
                            onCheckedChange={(all) => actions.shareCredential(c.id, all)}
                          />
                          All teammates
                        </label>
                      ),
                    )}
                    {teammates.map((t) => (
                      <td key={t.id} className={cn(cellClass, col(t))}>
                        <Cell
                          // Shared with all: nobody can be left out, only allowed without asking.
                          options={c.access === 'all' ? CREDENTIAL.slice(1) : CREDENTIAL}
                          value={levelOf(t.id)}
                          label={`${t.name} · ${c.name}`}
                          locked={locked}
                          onChange={(v) =>
                            actions.setCredential(c.id, t.id, v as CredentialGrantLevel)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <Legend />
    </div>
  )
}

function Legend() {
  const item = (option: Option, text: string) => (
    <span className="flex items-center gap-2">
      <span className="scale-75">
        <Mark option={option} />
      </span>
      {text}
    </span>
  )
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {item(CONNECTION[1]!, 'Read only')}
      {item(CONNECTION[2]!, 'Read and write, or can use a secret')}
      {item(CREDENTIAL[2]!, 'Without asking a person')}
      {item(CONNECTION[0]!, 'No access')}
      <span className="flex items-center gap-1.5">
        <Lock className="size-3.5" aria-hidden />
        Hover a cell you cannot change to see who can
      </span>
    </div>
  )
}
