'use client'
// A library file's versions: who saved each (a person, or a teammate from a
// thread), what changed in text files, and a way back to any of them.
import { diffLines } from 'diff'
import { Download, History, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { FilePreview } from '@/components/file-preview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, useApi, type LibraryActor, type LibraryVersion } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

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
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const list = useMemo(() => versions.data ?? [], [versions.data])
  const shown = list.find((v) => v.id === selected) ?? list[0]
  const previous = shown ? list[list.indexOf(shown) + 1] : undefined
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)

  async function restore(version: LibraryVersion) {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/library/${file.id}/versions/${version.id}/restore`, { body: {} })
      setSelected(undefined)
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
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col border-b" aria-label="Versions">
        {list.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => setSelected(v.id)}
              aria-current={v.id === shown?.id}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/60',
                v.id === shown?.id && 'bg-primary/5',
              )}
            >
              <History aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-muted-foreground">
                  <ActorName actor={v.by} /> · {timeAgo(v.updatedAt)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {size(v.size)}
                  {v.path !== file.path && ` · as ${v.path}`}
                </span>
              </span>
              {v.current && <Badge variant="secondary">Current</Badge>}
              {v.restoredFromId && <Badge variant="outline">Restored</Badge>}
            </button>
          </li>
        ))}
      </ol>
      {shown && (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-xs text-muted-foreground">
              {previous ? 'Changes from the version before' : 'The first version kept'}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={versionUrl(file.id, shown.id, true)}>
                  <Download aria-hidden />
                  Download
                </a>
              </Button>
              {!shown.current && (
                <Button size="sm" disabled={busy} onClick={() => void restore(shown)}>
                  <RotateCcw aria-hidden />
                  Restore this version
                </Button>
              )}
            </div>
          </div>
          {error && <p className="px-4 pt-2 text-sm text-destructive-text">{error}</p>}
          {TEXT_TYPE.test(shown.contentType) ? (
            <TextChanges fileId={file.id} version={shown} previous={previous} />
          ) : (
            <FilePreview
              url={versionUrl(file.id, shown.id)}
              previewUrl={`/library/${file.id}/preview?version=${shown.id}`}
              name={name}
              contentType={shown.contentType}
              download={versionUrl(file.id, shown.id, true)}
            />
          )}
        </div>
      )}
    </div>
  )
}
