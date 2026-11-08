'use client'
// A library file's versions: who saved each (a person, or a teammate from a
// thread), what changed in text files, and a way back to any of them.
import { diffLines } from 'diff'
import { ChevronRight, Download, History, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { FilePreview } from '@/components/file-preview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, useApi, type LibraryActor, type LibraryVersion } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'
import { groupVersions } from '@/lib/version-groups'

const TEXT_TYPE = /^(text\/|application\/(json|yaml|xml))/
/** Unchanged lines kept around each change. */
const CONTEXT = 3

export const versionUrl = (fileId: string, versionId: string, download = false) =>
  `${API_URL}/api/library/${fileId}/versions/${versionId}/content${download ? '?download' : ''}`

export function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

/** "Ada", or "Scout, in a thread" with the thread linked. */
export function ActorName({ actor }: { actor: LibraryActor | null }) {
  if (!actor) return <span>someone</span>
  return (
    <span>
      <span className="font-medium text-foreground">{actor.name}</span>
      {actor.type === 'teammate' && actor.sessionId && (
        <>
          {' in '}
          <Link
            href={`/app/threads/${actor.sessionId}`}
            className="underline-offset-2 hover:underline"
          >
            a thread
          </Link>
        </>
      )}
    </span>
  )
}

/** "57m ago" today; older saves keep their time, so a day of edits tells apart. */
function savedAt(iso: string) {
  if (Date.now() - new Date(iso).getTime() < 86_400_000) return timeAgo(iso)
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

async function textOf(url: string) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not open it (${response.status})`)
  return response.text()
}

type Line = { kind: 'add' | 'remove' | 'same' | 'gap'; text: string }

/** Changed lines with a little context; long unchanged runs fold into a gap. */
function changes(before: string, after: string): Line[] {
  const lines: Line[] = []
  for (const part of diffLines(before, after)) {
    const kind = part.added ? 'add' : part.removed ? 'remove' : 'same'
    for (const text of part.value.replace(/\n$/, '').split('\n')) lines.push({ kind, text })
  }
  const near = lines.map((l, i) =>
    l.kind !== 'same'
      ? true
      : lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((m) => m.kind !== 'same'),
  )
  const out: Line[] = []
  lines.forEach((line, i) => {
    if (near[i]) out.push(line)
    else if (out.at(-1)?.kind !== 'gap') out.push({ kind: 'gap', text: '' })
  })
  return out
}

function TextChanges({
  fileId,
  version,
  previous,
}: {
  fileId: string
  version: LibraryVersion
  previous?: LibraryVersion
}) {
  const [state, setState] = useState<{ lines?: Line[]; error?: string }>({})
  useEffect(() => {
    let live = true
    setState({})
    Promise.all([
      previous ? textOf(versionUrl(fileId, previous.id)) : Promise.resolve(''),
      textOf(versionUrl(fileId, version.id)),
    ]).then(
      ([before, after]) => live && setState({ lines: changes(before, after) }),
      (e: Error) => live && setState({ error: e.message }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the previous version by its id
  }, [fileId, version.id, version.updatedAt, previous?.id])
  if (state.error) return <p className="p-4 text-sm text-destructive-text">{state.error}</p>
  if (!state.lines) return <p className="p-4 text-sm text-muted-foreground">Comparing…</p>
  if (!state.lines.some((l) => l.kind !== 'same' && l.kind !== 'gap'))
    return <p className="p-4 text-sm text-muted-foreground">No change in the text.</p>
  return (
    <pre className="overflow-x-auto py-2 font-mono text-xs leading-relaxed" aria-label="Changes">
      {state.lines.map((line, i) =>
        line.kind === 'gap' ? (
          <div key={i} className="px-4 py-1 text-muted-foreground select-none">
            ⋯
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              'px-4 whitespace-pre-wrap wrap-anywhere',
              line.kind === 'add' && 'bg-success/15',
              line.kind === 'remove' &&
                'bg-destructive/10 text-muted-foreground line-through decoration-destructive/40',
            )}
          >
            <span aria-hidden className="mr-2 inline-block w-3 text-muted-foreground select-none">
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
            </span>
            {line.text || ' '}
          </div>
        ),
      )}
    </pre>
  )
}

/** One line of the history: a single save, or a run of them folded together. */
type Entry = {
  key: string
  /** The version the line stands for: the newest of its run. */
  version: LibraryVersion
  /** What its changes are measured from. */
  previous?: LibraryVersion
  /** Saves folded into the line, when more than one. */
  count: number
}

export function FileHistory({
  file,
  onRestored,
}: {
  file: { id: string; path: string; updatedAt?: string }
  /** After a version was made current again. */
  onRestored?: () => void | Promise<void>
}) {
  const versions = useApi<LibraryVersion[]>(`/library/${file.id}/versions`)
  const reload = versions.reload
  useEffect(() => {
    void reload()
  }, [file.updatedAt, reload])
  /** The line opened under itself: the first by default, none once closed. */
  const [opened, setOpened] = useState<string | null>()
  /** Runs of saves shown one by one. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Another file in the same panel starts from its own newest line.
  const [shownFile, setShownFile] = useState(file.id)
  if (shownFile !== file.id) {
    setShownFile(file.id)
    setOpened(undefined)
    setUnfolded(new Set())
    setError(undefined)
  }
  const list = useMemo(() => versions.data ?? [], [versions.data])
  const groups = useMemo(() => groupVersions(list), [list])
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  const openKey = opened === undefined ? groups[0] && `g:${groups[0].versions[0].id}` : opened
  const rows = useRef(new Map<string, HTMLElement>())
  const clicked = useRef(false)
  useLayoutEffect(() => {
    // Lines above may have just closed: keep the one clicked in view.
    if (!clicked.current || !openKey) return
    clicked.current = false
    rows.current.get(openKey)?.scrollIntoView({ block: 'nearest' })
  }, [openKey])

  function toggle(key: string) {
    clicked.current = true
    setError(undefined)
    setOpened(openKey === key ? null : key)
  }

  async function restore(version: LibraryVersion) {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/library/${file.id}/versions/${version.id}/restore`, { body: {} })
      setOpened(undefined)
      setUnfolded(new Set())
      await versions.reload()
      await onRestored?.()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  if (versions.error)
    return <p className="p-4 text-sm text-destructive-text">{versions.error.message}</p>
  if (!versions.data)
    return <p className="p-4 text-sm text-muted-foreground">Loading the history…</p>
  if (list.length === 0)
    return <p className="p-4 text-sm text-muted-foreground">No versions kept for this file.</p>

  const line = (entry: Entry, nested: boolean, fold?: { open: boolean; toggle: () => void }) => {
    const { key, version: v, previous, count } = entry
    const open = key === openKey
    return (
      <li
        key={key}
        ref={(el) => {
          if (el) rows.current.set(key, el)
          else rows.current.delete(key)
        }}
        className={cn(open && 'bg-primary/5')}
      >
        <div className="flex items-start hover:bg-muted/60">
          <button
            type="button"
            onClick={() => toggle(key)}
            aria-expanded={open}
            className={cn(
              'flex min-w-0 flex-1 items-start gap-3 py-2.5 pr-2 text-left text-sm',
              nested ? 'pl-11' : 'pl-4',
            )}
          >
            <History aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-muted-foreground">
                <ActorName actor={v.by} /> · {savedAt(v.updatedAt)}
              </span>
              <span className="text-xs text-muted-foreground">
                {size(v.size)}
                {v.path !== file.path && ` · as ${v.path}`}
              </span>
            </span>
            {v.current && <Badge variant="secondary">Current</Badge>}
            {v.restoredFromId && <Badge variant="outline">Restored</Badge>}
          </button>
          {fold && (
            <button
              type="button"
              onClick={fold.toggle}
              aria-expanded={fold.open}
              className="mt-2 mr-3 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {count} edits
              <ChevronRight
                aria-hidden
                className={cn('size-3.5 transition-transform', fold.open && 'rotate-90')}
              />
            </button>
          )}
        </div>
        {open && (
          <div className="border-y bg-background">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <span className="text-xs text-muted-foreground">
                {!previous
                  ? count > 1
                    ? `The first ${count} versions kept`
                    : 'The first version kept'
                  : count > 1
                    ? `Changes in these ${count} edits`
                    : 'Changes from the version before'}
              </span>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm">
                  <a href={versionUrl(file.id, v.id, true)}>
                    <Download aria-hidden />
                    Download
                  </a>
                </Button>
                {!v.current && (
                  <Button size="sm" disabled={busy} onClick={() => void restore(v)}>
                    <RotateCcw aria-hidden />
                    Restore this version
                  </Button>
                )}
              </div>
            </div>
            {error && <p className="px-4 pt-2 text-sm text-destructive-text">{error}</p>}
            <div className="max-h-[60vh] overflow-y-auto">
              {TEXT_TYPE.test(v.contentType) ? (
                <TextChanges fileId={file.id} version={v} previous={previous} />
              ) : (
                <FilePreview
                  url={versionUrl(file.id, v.id)}
                  previewUrl={`/library/${file.id}/preview?version=${v.id}`}
                  name={name}
                  contentType={v.contentType}
                  download={versionUrl(file.id, v.id, true)}
                />
              )}
            </div>
          </div>
        )}
      </li>
    )
  }

  return (
    <ol className="flex flex-col border-b" aria-label="Versions">
      {groups.flatMap((group) => {
        const head = group.versions[0]
        const key = `g:${head.id}`
        const count = group.versions.length
        const folded = count > 1 && !unfolded.has(key)
        const entry: Entry = { key, version: head, previous: group.before, count }
        if (count === 1) return [line(entry, false)]
        const fold = {
          open: !folded,
          toggle: () =>
            setUnfolded((was) => {
              const next = new Set(was)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            }),
        }
        if (folded) return [line(entry, false, fold)]
        return [
          line(entry, false, fold),
          ...group.versions.map((v, i) =>
            line(
              { key: v.id, version: v, previous: group.versions[i + 1] ?? group.before, count: 1 },
              true,
            ),
          ),
        ]
      })}
    </ol>
  )
}
