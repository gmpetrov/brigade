'use client'
// What a thread made, beside it: files its teammates wrote or named, library
// documents, images, pull requests, emails, schedules and skills proposed. Read from the event
// log; a file made again keeps one row, and one saved to the library shows only as its library
// row. Open pull requests lead, then the rest newest first under a line for each day. A pull request's row says how its checks went, and an owner or
// admin merges it from there.
import {
  bareToolName as bare,
  designName,
  DELIVERABLE_FILE as DELIVERABLE,
  EMAIL_TOOL,
  isOperation,
  PROPOSE_SKILL_TOOL,
  type SequencedEvent,
} from '@brigade/contracts'
import {
  BookOpenText,
  CalendarClock,
  Check,
  CircleDashed,
  Copy,
  EllipsisVertical,
  ExternalLink,
  FileText,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Image as ImageIcon,
  Library,
  Mail,
  Palette,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { relativeFile, type OpenFile } from '@/components/file-links'
import { pullStatus } from '@/components/pull-status'
import { usePull } from '@/components/pull-card'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { pullHref, type CheckRun, type PullRequestState } from '@/lib/api'
import {
  blockedBecause,
  canMerge,
  hasConflicts,
  resolvesInBrigade,
  resolving,
} from '@/lib/merge-method'
import { dayLabel } from '@/lib/utils'

export type ThreadOutput = {
  key: string
  kind: 'file' | 'library' | 'design' | 'image' | 'pull' | 'email' | 'schedule' | 'skill'
  label: string
  detail?: string
  at: string
  /** Opens beside the thread. */
  file?: { path: string; teammateId?: string }
  href?: string
  pull?: { repository: string; number: number }
}

/** Rows shown before "Show all". */
const SHOWN = 6

/** Code a teammate wrote to make something (a script that renders a PDF), not the thing itself. */
const CODE =
  /\.(?:py|ipynb|[cm]?[jt]sx?|sh|bash|zsh|rb|go|rs|java|kt|swift|php|c|cc|cpp|h|hpp|cs|sql|css|scss|lock)$/i

const json = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

const name = (path: string) => path.split('/').pop() ?? path

/**
 * Whether two paths name the same file: one may be absolute (a write tool's)
 * and the other relative to the working folder (named in a message).
 */
function samePath(a: string, b: string) {
  const [x, y] = [a, b].map((p) => p.replace(/^\.\//, ''))
  if (x === y) return true
  if (!x!.startsWith('/') && y!.endsWith(`/${x}`)) return true
  return !y!.startsWith('/') && x!.endsWith(`/${y}`)
}

/**
 * Files a message names that are something made to hand over, not code it
 * read: a script can write a PDF without a write tool the runner sees.
 */
function namedFiles(text: string) {
  const found = new Set<string>()
  for (const [, code] of text.matchAll(/`([^`\n]+)`/g)) found.add(code!.trim())
  for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const path = relativeFile(href)
    if (path) found.add(path)
  }
  return [...found]
    .map((p) => p.replace(/:\d+(:\d+)?$/, ''))
    .filter((p) => DELIVERABLE.test(p) && !/^(?:\.\/)?attachments\//.test(p) && !/\s/.test(p))
}

export function useThreadOutputs(events: SequencedEvent[]) {
  return useMemo(() => {
    const byKey = new Map<string, ThreadOutput>()
    // Re-adding moves it to the end: the latest version's time and place.
    const add = (output: ThreadOutput) => {
      byKey.delete(output.key)
      byKey.set(output.key, output)
    }
    const named = (text: string, at: string, teammateId: string | undefined) => {
      for (const path of namedFiles(text)) {
        // Named again after it was made: not a new version.
        if (byKey.has(`file:${path}`)) continue
        add({
          key: `file:${path}`,
          kind: /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) ? 'image' : 'file',
          label: name(path),
          detail: path,
          at,
          file: { path, teammateId },
        })
      }
    }
    // Messages still streaming. One cut off when the computer stopped never gets
    // its message.done, so what it named counts when its turn ends.
    const streaming = new Map<string, { text: string; at: string; teammateId?: string }>()
    const flush = () => {
      for (const m of streaming.values()) named(m.text, m.at, m.teammateId)
      streaming.clear()
    }
    const calls = new Map<string, { toolName: string; input: unknown }>()
    // Files saved to the library, as written on the computer and as library paths.
    const saved: string[] = []
    for (const { event: e } of events) {
      switch (e.type) {
        case 'file.changed':
          if (CODE.test(e.path)) break
          add({
            key: `file:${e.path}`,
            kind: 'file',
            label: name(e.path),
            detail: e.path,
            at: e.at,
            file: { path: e.path, teammateId: e.teammateId },
          })
          break
        case 'image.generated':
          add({
            key: `file:${e.path}`,
            kind: 'image',
            label: name(e.path),
            detail: e.prompt ?? e.path,
            at: e.at,
            file: { path: e.path, teammateId: e.teammateId },
          })
          break
        case 'message.delta': {
          const m = streaming.get(e.id)
          if (m) m.text += e.text
          else streaming.set(e.id, { text: e.text, at: e.at, teammateId: e.teammateId })
          break
        }
        case 'message.done':
          streaming.delete(e.id)
          named(e.text, e.at, e.teammateId)
          break
        case 'turn.completed':
          flush()
          break
        case 'tool.started':
          calls.set(`${e.teammateId ?? ''}:${e.toolCallId}`, {
            toolName: e.toolName,
            input: e.input,
          })
          break
        case 'tool.finished': {
          const id = `${e.teammateId ?? ''}:${e.toolCallId}`
          const call = calls.get(id)
          calls.delete(id)
          if (!call || e.isError) break
          const input = (call.input ?? {}) as Record<string, unknown>
          const tool = bare(call.toolName)
          if (tool === 'save_to_library' && typeof input.path === 'string') {
            // Its library row stands for the file on the computer it was saved from.
            if (typeof input.file === 'string') saved.push(input.file)
            saved.push(input.path)
            add({
              key: `library:${input.path}`,
              kind: 'library',
              label: name(input.path),
              detail: `Library · ${input.path}`,
              at: e.at,
              file: { path: input.path },
            })
          } else if (
            (tool === 'move_in_library' || tool === 'delete_from_library') &&
            typeof input.path === 'string'
          ) {
            // What it saved there follows it, or leaves with it.
            const from = input.path
            const to = typeof input.to === 'string' ? input.to : undefined
            if (to) saved.push(to)
            for (const output of [...byKey.values()]) {
              const path = output.file?.path
              if (!path || (output.kind !== 'library' && output.kind !== 'design')) continue
              if (path !== from && !path.startsWith(`${from}/`)) continue
              byKey.delete(output.key)
              if (!to) continue
              const moved = to + path.slice(from.length)
              const named = (p: string) =>
                output.kind === 'design' ? designName(p) || name(p) : name(p)
              add({
                ...output,
                key: `${output.kind}:${moved}`,
                label: output.label === named(path) ? named(moved) : output.label,
                detail: output.detail?.replace(`· ${from}`, `· ${to}`),
                at: e.at,
                file: { path: moved },
              })
            }
          } else if (tool === 'save_design' && typeof input.path === 'string') {
            const path = input.path.replace(/\/+$/, '')
            add({
              key: `design:${path}`,
              kind: 'design',
              label: designName(path) || name(path),
              detail: `Design · ${path}`,
              at: e.at,
              file: { path },
            })
          } else if (tool === 'save_design_system' && typeof input.path === 'string') {
            // Shown by its preview, a design inside its folder.
            const output = (e.output ?? {}) as { name?: unknown; preview?: unknown }
            if (typeof output.preview !== 'string') break
            const path = input.path.replace(/\/+$/, '')
            add({
              key: `design:${output.preview}`,
              kind: 'design',
              label: `${typeof output.name === 'string' ? output.name : name(path)} design system`,
              detail: `Design system · ${path}`,
              at: e.at,
              file: { path: output.preview },
            })
          } else if (isOperation(tool, 'github_create_pull_request')) {
            const found = json(e.output).match(
              /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/,
            )
            if (!found) break
            const repository = found[1]!.toLowerCase()
            const number = Number(found[2])
            add({
              key: `pull:${repository}#${number}`,
              kind: 'pull',
              label: typeof input.title === 'string' ? input.title : `Pull request #${number}`,
              detail: `${repository}#${number}`,
              at: e.at,
              href: pullHref(repository, number),
              pull: { repository, number },
            })
          } else if (EMAIL_TOOL.test(tool)) {
            if (!/gmail|mail/i.test(call.toolName)) break
            const to = Array.isArray(input.to) ? input.to.join(', ') : input.to
            const subject = typeof input.subject === 'string' ? input.subject : undefined
            const draft = /draft/.test(tool)
            add({
              key: `email:${id}`,
              kind: 'email',
              label: subject ?? (draft ? 'Email draft' : 'Email'),
              detail: [draft ? 'Draft, not sent' : 'Sent', typeof to === 'string' ? to : '']
                .filter(Boolean)
                .join(' · '),
              at: e.at,
            })
          } else if (tool === 'create_schedule' && typeof input.title === 'string') {
            add({
              key: `schedule:${input.title}`,
              kind: 'schedule',
              label: input.title,
              detail: typeof input.cron === 'string' ? `Schedule · ${input.cron}` : 'Schedule',
              at: e.at,
              href: '/app/routines',
            })
          } else if (tool === PROPOSE_SKILL_TOOL) {
            // A proposal waits for an admin in Tickets; once approved it is on the Connections page.
            const output = (e.output ?? {}) as { name?: unknown; change?: unknown }
            if (typeof output.name !== 'string') break
            add({
              key: `skill:${output.name}`,
              kind: 'skill',
              label: `/${output.name}`,
              detail: output.change ? 'Skill · a change to approve' : 'Skill · to approve',
              at: e.at,
              href: '/app/tickets',
            })
          }
          break
        }
      }
    }
    flush()
    return [...byKey.values()]
      .filter((o) => o.kind !== 'file' || !saved.some((path) => samePath(path, o.file!.path)))
      .reverse()
  }, [events])
}

const ICONS = {
  file: FileText,
  library: Library,
  design: Palette,
  image: ImageIcon,
  pull: GitPullRequest,
  email: Mail,
  schedule: CalendarClock,
  skill: BookOpenText,
} satisfies Record<ThreadOutput['kind'], unknown>

const time = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** What a pull request's row learned of it, to place it: open ones lead, a merged one goes by its merge. */
type PullPlace = { open: boolean; at: string }

export function ThreadOutputs({ outputs, onOpen }: { outputs: ThreadOutput[]; onOpen: OpenFile }) {
  const [all, setAll] = useState(false)
  const [pulls, setPulls] = useState<Record<string, PullPlace>>({})
  const place = useCallback(
    (key: string, p: PullPlace) =>
      setPulls((was) =>
        was[key]?.open === p.open && was[key]?.at === p.at ? was : { ...was, [key]: p },
      ),
    [],
  )
  // Open pull requests first, waiting on a merge or a fix; then the rest newest first, by day.
  const { open, rest } = useMemo(() => {
    const open = outputs.filter((o) => pulls[o.key]?.open)
    const rest = outputs
      .filter((o) => !pulls[o.key]?.open)
      .map((output) => ({ output, at: pulls[output.key]?.at ?? output.at }))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    return { open, rest }
  }, [outputs, pulls])
  const shown = all ? rest.length : SHOWN

  const heading = (label: string) => (
    <li role="separator" className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </li>
  )
  const item = (output: ThreadOutput, hidden = false) => {
    // Rendered even past "Show all", hidden: its state places it.
    if (output.pull)
      return (
        <li key={output.key} hidden={hidden}>
          <PullOutput output={output} onPlace={place} {...output.pull} />
        </li>
      )
    if (hidden) return null
    const Icon = ICONS[output.kind]
    const body = (
      <>
        <Icon className="size-4 flex-none text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{output.label}</span>
          {output.detail && (
            <span className="truncate text-xs text-muted-foreground">{output.detail}</span>
          )}
        </span>
        <time dateTime={output.at} className="flex-none text-xs text-muted-foreground">
          {time(output.at)}
        </time>
      </>
    )
    const row = 'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left'
    return (
      <li key={output.key}>
        {output.file ? (
          <button
            type="button"
            className={`${row} hover:bg-secondary/60`}
            title={output.file.path}
            onClick={() => onOpen(output.file!)}
          >
            {body}
          </button>
        ) : output.href ? (
          <Link href={output.href} className={`${row} hover:bg-secondary/60`}>
            {body}
          </Link>
        ) : (
          <div className={row}>{body}</div>
        )}
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {open.length > 0 && heading('Open')}
        {open.map((output) => item(output))}
        {rest.map(({ output, at }, i) => {
          const hidden = i >= shown
          const newDay = i === 0 || dayLabel(rest[i - 1]!.at) !== dayLabel(at)
          return (
            <Fragment key={output.key}>
              {newDay && !hidden && heading(dayLabel(at))}
              {item(output, hidden)}
            </Fragment>
          )
        })}
      </ul>
      {rest.length > SHOWN && (
        <button
          type="button"
          className="self-start px-2 text-xs font-medium text-primary hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${outputs.length}`}
        </button>
      )}
    </div>
  )
}

/** How its checks went, in words: failures first, then those still running. */
function checksLine(checks: CheckRun[]): ReactNode {
  const failed = checks.filter((c) => c.status === 'failure').length
  const pending = checks.filter((c) => c.status === 'pending').length
  const n = checks.length
  if (failed)
    return (
      <>
        <X className="size-3 flex-none text-destructive-text" aria-hidden />
        {n === 1 ? 'Its check failed' : `${failed} of ${n} checks failed`}
      </>
    )
  if (pending)
    return (
      <>
        <CircleDashed className="size-3 flex-none text-warning" aria-hidden />
        {n === 1 ? 'Its check is running' : `${pending} of ${n} checks running`}
      </>
    )
  return (
    <>
      <Check className="size-3 flex-none text-success" aria-hidden />
      {n === 1 ? 'Its check passed' : `${n} checks passed`}
    </>
  )
}

/** The line under its title: how it ended, else what it waits on, else its checks. */
function pullLine(p: PullRequestState, fallback: string): ReactNode {
  if (p.state === 'merged')
    return `Merged into ${p.base}${p.mergedAt ? ` · ${time(p.mergedAt)}` : ''}`
  if (p.state === 'closed') return `Closed · ${fallback}`
  if (resolving(p)) {
    const { label } = pullStatus(p)
    return label.charAt(0).toUpperCase() + label.slice(1)
  }
  if (p.mergeableState === 'dirty') return `Conflicts with ${p.base}`
  return p.checks.length ? checksLine(p.checks) : fallback
}

function PullOutput({
  output,
  onPlace,
  repository,
  number,
}: {
  output: ThreadOutput
  onPlace: (key: string, place: PullPlace) => void
  repository: string
  number: number
}) {
  const { me } = useDashboard()
  const { pull, busy, error, merge, resolve } = usePull(repository, number, { checks: true })
  const p = pull.data
  const state = p?.state
  const mergedAt = p?.mergedAt
  useEffect(() => {
    if (state) onPlace(output.key, { open: state === 'open', at: mergedAt ?? output.at })
  }, [state, mergedAt, onPlace, output.key, output.at])
  const Icon =
    p?.state === 'merged' ? GitMerge : p?.state === 'closed' ? GitPullRequestClosed : GitPullRequest
  const stamp = (
    <time dateTime={output.at} className="flex-none text-xs text-muted-foreground">
      {time(output.at)}
    </time>
  )
  const pill = 'relative z-10 flex-none rounded-full'

  const action = () => {
    if (!p) return stamp
    if (p.state === 'merged')
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="relative z-10 flex-none text-muted-foreground"
              aria-label={`#${number}: more`}
              title="More"
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem asChild>
              <a href={p.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open on GitHub
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(p.url)}>
              <Copy />
              Copy link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    if (p.state !== 'open' || !isAdmin(me) || resolving(p)) return stamp
    if (hasConflicts(p))
      return resolvesInBrigade(p) ? (
        <Button
          size="xs"
          variant="outline"
          className={pill}
          disabled={busy}
          onClick={resolve}
          title={`It conflicts with ${p.base}. ${p.tracking?.author?.name} resolves the conflicts, then it merges.`}
        >
          <GitCompareArrows />
          {busy ? 'Asking…' : 'Resolve conflicts'}
        </Button>
      ) : (
        <Button size="xs" variant="outline" className={pill} asChild>
          <a href={`${p.url}/conflicts`} target="_blank" rel="noreferrer">
            Resolve on GitHub
            <ExternalLink />
          </a>
        </Button>
      )
    const mergeable = canMerge(p)
    // A failed check doesn't stop it here, GitHub does if it must: the pill only gets quieter.
    const failing = p.checks.some((c) => c.status === 'failure')
    return (
      <Button
        size="xs"
        variant={failing ? 'outline' : 'default'}
        className={`${pill} px-2.5`}
        disabled={busy || !mergeable}
        onClick={merge}
        title={mergeable ? undefined : blockedBecause[p.mergeableState]}
      >
        {busy ? 'Merging…' : 'Merge'}
      </Button>
    )
  }

  return (
    <div className="relative flex w-full items-center gap-3 rounded-md px-2 py-1.5 hover:bg-secondary/60">
      <Icon
        className={`size-4 flex-none ${p?.state === 'merged' ? 'text-primary' : 'text-muted-foreground'}`}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <Link
          href={output.href ?? pullHref(repository, number)}
          className="truncate text-sm font-medium after:absolute after:inset-0"
        >
          {output.label}
        </Link>
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          {p ? pullLine(p, output.detail ?? '') : output.detail}
        </span>
        {error && <span className="text-xs text-destructive-text">{error}</span>}
      </span>
      {action()}
    </div>
  )
}
