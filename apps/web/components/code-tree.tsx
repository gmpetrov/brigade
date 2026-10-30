'use client'
// The code panel's tree of a teammate's working folder for the thread, folders
// loaded as they open, and its filter: files by name, or with "?" first, lines
// holding a text, across the folder (the runner's thread.code).
import type { CodeEntry, SourceMatch } from '@brigade/contracts'
import { ChevronRight, File, Folder, FolderOpen, RotateCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'

type Listing = { entries?: CodeEntry[]; more?: boolean; error?: string }

/** The folders that hold a path, outermost first ("a/b/c.ts": "", "a", "a/b"). */
export function ancestors(path: string) {
  const parts = path.split('/').filter(Boolean)
  return ['', ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

export function CodeTree({
  threadId,
  teammateId,
  reveal = [],
  active,
  onOpen,
  className,
}: {
  threadId: string
  teammateId: string
  /** Paths whose folders open at first: the preview's folder, the file in front. */
  reveal?: string[]
  /** The file in front, marked. */
  active?: string
  onOpen: (file: { path: string; line?: number }) => void
  className?: string
}) {
  const [folders, setFolders] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(reveal.flatMap((p) => [...ancestors(p), p])),
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    files?: string[]
    matches?: SourceMatch[]
    error?: string
    busy?: boolean
  }>()
  const filter = useRef<HTMLInputElement>(null)

  const load = useCallback(
    (path: string) =>
      api<{ entries: CodeEntry[]; more: boolean }>(
        `/threads/${threadId}/code?${new URLSearchParams({ teammateId, path })}`,
      ).then(
        ({ entries, more }) => setFolders((f) => ({ ...f, [path]: { entries, more } })),
        (e: Error) => setFolders((f) => ({ ...f, [path]: { error: e.message } })),
      ),
    [threadId, teammateId],
  )

  // Another copy (the preview restarted from another teammate's): its own tree.
  useEffect(() => {
    setFolders({})
    void load('')
  }, [load])

  // Each open folder, once.
  useEffect(() => {
    for (const path of expanded) if (path && !folders[path]) void load(path)
  }, [expanded, folders, load])

  // A file brought in front elsewhere (an element picked in the page): its folders open.
  useEffect(() => {
    if (!active) return
    setExpanded((open) => {
      const missing = ancestors(active).filter((p) => !open.has(p))
      return missing.length ? new Set([...open, ...missing]) : open
    })
  }, [active])

  // The filter: by name, or "?" and a text across the files. A pause in typing first.
  const searching = query.trim()
  useEffect(() => {
    if (!searching) return setResults(undefined)
    const grep = searching.startsWith('?')
    const q = (grep ? searching.slice(1) : searching).trim()
    if (!q) return setResults({ files: [] })
    let live = true
    setResults((r) => ({ ...r, busy: true }))
    const timer = setTimeout(() => {
      api<{ files?: string[]; matches?: SourceMatch[] }>(
        `/threads/${threadId}/code/${grep ? 'grep' : 'find'}?${new URLSearchParams({ teammateId, q })}`,
      ).then(
        (r) => live && setResults(r),
        (e: Error) => live && setResults({ error: e.message }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [searching, threadId, teammateId])

  const toggle = (path: string) =>
    setExpanded((open) => {
      const next = new Set(open)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const refresh = () => {
    setFolders({})
    void load('')
  }

  const first = results?.files?.[0] ?? results?.matches?.[0]?.path
  const root = folders['']

  function rows(folder: string, depth: number): React.ReactNode {
    const entries = folders[folder]?.entries
    if (!entries)
      return folders[folder]?.error ? (
        <p className="py-1 text-destructive-text" style={{ paddingLeft: 8 + depth * 12 }}>
          {folders[folder]!.error}
        </p>
      ) : (
        <p className="py-1 text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
          …
        </p>
      )
    return (
      <>
        {entries.map((entry) => {
          const path = join(folder, entry.name)
          const open = entry.dir && expanded.has(path)
          return (
            <div key={path}>
              <button
                type="button"
                title={path}
                aria-expanded={entry.dir ? open : undefined}
                className={cn(
                  'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-muted',
                  path === active && 'bg-primary/10 text-foreground',
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => (entry.dir ? toggle(path) : onOpen({ path }))}
              >
                {entry.dir ? (
                  <>
                    <ChevronRight
                      aria-hidden
                      className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
                    />
                    {open ? (
                      <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </>
                ) : (
                  <File aria-hidden className="ml-[18px] size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              {open && rows(path, depth + 1)}
            </div>
          )
        })}
        {folders[folder]?.more && (
          <p className="py-1 text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
            More not shown: filter by name to find one.
          </p>
        )}
      </>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col text-xs', className)}>
      <div className="flex shrink-0 items-center gap-1 p-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 focus-within:border-primary">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={filter}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                setQuery('')
              } else if (e.key === 'Enter' && first) {
                e.preventDefault()
                const match = results?.matches?.[0]
                onOpen(match ? { path: match.path, line: match.line } : { path: first })
              }
            }}
            placeholder="Filter, or ? to search in files"
            aria-label="Filter files, or ? and a text to search in them"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setQuery('')
                filter.current?.focus()
              }}
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </label>
        <Hint label="Refresh the files">
          <button
            type="button"
            aria-label="Refresh the files"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={refresh}
          >
            <RotateCw aria-hidden className="size-3.5" />
          </button>
        </Hint>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {searching ? (
          results?.error ? (
            <p className="px-2 py-1 text-destructive-text">{results.error}</p>
          ) : results?.files ? (
            results.files.length ? (
              results.files.map((path) => {
                const slash = path.lastIndexOf('/')
                return (
                  <button
                    key={path}
                    type="button"
                    title={path}
                    className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
                    onClick={() => onOpen({ path })}
                  >
                    <span className="shrink-0">{path.slice(slash + 1)}</span>
                    <span className="truncate text-muted-foreground">{path.slice(0, slash)}</span>
                  </button>
                )
              })
            ) : (
              <p className="px-2 py-1 text-muted-foreground">No file by that name.</p>
            )
          ) : results?.matches ? (
            results.matches.length ? (
              results.matches.map((m) => (
                <button
                  key={`${m.path}:${m.line}`}
                  type="button"
                  title={`${m.path}:${m.line}`}
                  className="flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-muted"
                  onClick={() => onOpen({ path: m.path, line: m.line })}
                >
                  <span className="truncate">
                    {m.path.split('/').pop()}
                    <span className="text-muted-foreground">:{m.line}</span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {m.preview}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-2 py-1 text-muted-foreground">No file holds that text.</p>
            )
          ) : (
            <p className="px-2 py-1 text-muted-foreground">Looking…</p>
          )
        ) : root?.error ? (
          <p className="px-2 py-1 text-destructive-text">{root.error}</p>
        ) : (
          rows('', 0)
        )}
      </div>
    </div>
  )
}
