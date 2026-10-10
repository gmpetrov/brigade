'use client'
import { BookOpen, FilePlus, FileText, Library, Search, Upload } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { Markdown } from '@/components/markdown'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  api,
  ApiError,
  useApi,
  type LibraryFile,
  type MemoryFile,
  type MemoryOverview,
  type SearchHit,
} from '@/lib/api'
import { API_URL } from '@/lib/config'

const contentUrl = (id: string, download = false) =>
  `${API_URL}/api/library/${id}/content${download ? '?download' : ''}`

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

/** The workspace's shared files and memory, and one search over both. */
export default function LibraryPage() {
  const files = useApi<LibraryFile[]>('/library')
  const memory = useApi<MemoryOverview>('/library/memory')
  const [tab, setTab] = useState('files')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState<string>()
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)

  async function upload(list: FileList | null) {
    if (!list?.length) return
    setError(undefined)
    for (const file of Array.from(list)) {
      setUploading(file.name)
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(`${API_URL}/api/library/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        setError(`${file.name}: ${body.error ?? response.statusText}`)
        break
      }
    }
    setUploading(undefined)
    if (input.current) input.current.value = ''
    await files.reload()
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Library</h1>
          <p className="max-w-2xl text-muted-foreground">
            Shared files and memory. Every teammate reads the library on its computer and searches
            it; when a thread goes quiet, what it taught goes into memory.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreating((c) => !c)}>
            <FilePlus />
            New file
          </Button>
          <Button disabled={Boolean(uploading)} onClick={() => input.current?.click()}>
            <Upload />
            {uploading ? `Uploading ${uploading}…` : 'Upload'}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
        </div>
      </header>

      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files, memory and past threads"
          aria-label="Search the library"
          className="pl-9"
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}

      {query.trim() ? (
        <SearchResults query={query.trim()} onMemory={() => (setQuery(''), setTab('memory'))} />
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="flex flex-col gap-4 pt-2">
            {creating && (
              <NewFile
                onCancel={() => setCreating(false)}
                onSaved={async () => {
                  setCreating(false)
                  await files.reload()
                }}
              />
            )}
            <Files
              files={files.data}
              reload={files.reload}
              onUpload={() => input.current?.click()}
            />
          </TabsContent>
          <TabsContent value="memory" className="flex flex-col gap-4 pt-2">
            <Memory overview={memory.data} reload={memory.reload} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function Files({
  files,
  reload,
  onUpload,
}: {
  files: LibraryFile[] | undefined
  reload: () => Promise<void>
  onUpload: () => void
}) {
  const [open, setOpen] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const [error, setError] = useState<string>()

  async function act(work: () => Promise<unknown>) {
    setError(undefined)
    try {
      await work()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!files) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (files.length === 0)
    return (
      <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
        >
          <Library className="size-5" />
        </span>
        <p className="font-semibold">The library is empty.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Add guides, price lists, policies or anything your teammates should know. Text and PDF
          files are searchable.
        </p>
        <Button onClick={onUpload}>
          <Upload />
          Upload files
        </Button>
      </Card>
    )

  return (
    <>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <Card className="gap-0 divide-y py-0">
        {files.map((f) => {
          const slash = f.path.lastIndexOf('/')
          return (
            <div key={f.id} className="flex flex-col gap-3 px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-4">
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
                >
                  <FileText className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <span className="truncate text-sm">
                    {slash > 0 && (
                      <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>
                    )}
                    <span className="font-semibold">{f.path.slice(slash + 1)}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {size(f.size)} · updated {timeAgo(f.updatedAt)}
                    {!f.indexed && (
                      <StatusBadge status="unindexed" tone="neutral" label="not searchable" />
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {f.editable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={open === f.id}
                      onClick={() => setOpen(open === f.id ? undefined : f.id)}
                    >
                      {open === f.id ? 'Close' : 'Open'}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" asChild>
                      <a href={contentUrl(f.id)} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" asChild>
                    <a href={contentUrl(f.id, true)}>Download</a>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={renaming === f.id}
                    onClick={() => setRenaming(renaming === f.id ? undefined : f.id)}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      confirm(`Delete ${f.path} from the library?`) &&
                      void act(() => api(`/library/${f.id}`, { method: 'DELETE' }))
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {renaming === f.id && (
                <form
                  className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/50 p-3"
                  action={(form) =>
                    act(async () => {
                      await api(`/library/${f.id}`, {
                        method: 'PATCH',
                        body: { path: String(form.get('path') ?? '') },
                      })
                      setRenaming(undefined)
                    })
                  }
                >
                  <div className="flex flex-1 basis-64 flex-col gap-2">
                    <Label htmlFor={`path-${f.id}`}>Path</Label>
                    <Input
                      id={`path-${f.id}`}
                      name="path"
                      defaultValue={f.path}
                      required
                      className="bg-card font-mono text-sm"
                    />
                  </div>
                  <Button type="button" variant="outline" onClick={() => setRenaming(undefined)}>
                    Cancel
                  </Button>
                  <Button>Save</Button>
                </form>
              )}
              {open === f.id && (
                <TextFile file={f} onSaved={reload} onClose={() => setOpen(undefined)} />
              )}
            </div>
          )
        })}
      </Card>
    </>
  )
}

/** A text file, read and edited in place. */
function TextFile({
  file,
  onSaved,
  onClose,
}: {
  file: LibraryFile
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [text, setText] = useState<string>()
  const [draft, setDraft] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(contentUrl(file.id), { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
      .then(setText, (e: Error) => setError(e.message))
  }, [file.id, file.updatedAt])

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/library/${file.id}/text`, { method: 'PUT', body: { text: draft } })
      setText(draft)
      setDraft(undefined)
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  if (text === undefined)
    return <p className="text-sm text-muted-foreground">{error ?? 'Loading…'}</p>
  const markdown = file.contentType === 'text/markdown'
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4">
      {draft === undefined ? (
        markdown ? (
          <Markdown text={text} className="text-sm" />
        ) : (
          <pre className="max-h-[32rem] overflow-auto font-mono text-xs whitespace-pre-wrap">
            {text}
          </pre>
        )
      ) : (
        <Textarea
          aria-label={`Contents of ${file.path}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(30, Math.max(8, draft.split('\n').length + 1))}
          className="bg-card font-mono text-sm"
        />
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        {draft === undefined ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={() => setDraft(text)}>
              Edit
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function NewFile({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save(form: FormData) {
    setBusy(true)
    setError(undefined)
    try {
      await api('/library/text', {
        body: { path: String(form.get('path') ?? ''), text: String(form.get('text') ?? '') },
      })
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <form action={save} className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-path">Path</Label>
        <Input
          id="new-path"
          name="path"
          required
          placeholder="guides/refunds.md"
          className="font-mono text-sm"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-text">Contents</Label>
        <Textarea id="new-text" name="text" rows={10} className="font-mono text-sm" />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>Add to library</Button>
      </div>
    </form>
  )
}

function Memory({
  overview,
  reload,
}: {
  overview: MemoryOverview | undefined
  reload: () => Promise<void>
}) {
  if (!overview) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <>
      <MemoryCard
        title="Workspace"
        description="People, terms, decisions and where things live. Every teammate loads it."
        file={overview.workspace}
        path="/library/memory/workspace"
        onSaved={reload}
      />
      {overview.teammates.map((t) => (
        <MemoryCard
          key={t.teammateId}
          title={t.name}
          description={`What ${t.name} has learned about its job. Only ${t.name} loads it.`}
          file={t.memory}
          path={`/library/memory/teammates/${t.teammateId}`}
          onSaved={reload}
        />
      ))}
      <Card className="gap-0 overflow-hidden pb-0">
        <CardHeader className="pb-4">
          <CardTitle>
            <h2 className="text-base font-bold">Thread summaries</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Written when a thread goes quiet. Teammates find them with search.
          </p>
        </CardHeader>
        <CardContent className="px-0">
          {overview.summaries.length === 0 ? (
            <p className="border-t px-6 py-3 text-sm text-muted-foreground">None yet.</p>
          ) : (
            overview.summaries.map((s) => (
              <div key={s.sessionId} className="flex flex-col gap-1 border-t px-6 py-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
                  <Link
                    href={`/app/threads/${s.sessionId}`}
                    className="truncate text-sm font-semibold hover:underline"
                  >
                    {s.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(s.updatedAt)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {s.text.replace(/^#[^\n]*\n+/, '').trim()}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </>
  )
}

function MemoryCard({
  title,
  description,
  file,
  path,
  onSaved,
}: {
  title: string
  description: string
  file: MemoryFile
  path: string
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      await api(path, { method: 'PUT', body: { text: draft } })
      setDraft(undefined)
      await onSaved()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
    setBusy(false)
  }

  const body = file.text.replace(/^#[^\n]*\n+/, '').trim()
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-4 px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <BookOpen aria-hidden className="size-4 text-muted-foreground" />
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {description}
            {file.updatedAt && ` Updated ${timeAgo(file.updatedAt)}.`}
          </p>
        </div>
        {draft === undefined && (
          <Button variant="outline" size="sm" onClick={() => setDraft(file.text)}>
            Edit
          </Button>
        )}
      </div>
      <CardContent className="flex flex-col gap-3">
        {draft === undefined ? (
          body ? (
            <Markdown text={body} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
          )
        ) : (
          <>
            <Textarea
              aria-label={`${title} memory`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(24, Math.max(6, draft.split('\n').length + 1))}
              className="font-mono text-sm"
            />
            {error && <p className="text-sm text-destructive-text">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  library: 'File',
  workspace_memory: 'Memory',
  teammate_memory: 'Memory',
  thread_summary: 'Thread',
}

/** Matches arrive between « and »; shown highlighted. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«|»/)
  return (
    <p className="text-sm text-muted-foreground">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  )
}

function SearchResults({ query, onMemory }: { query: string; onMemory: () => void }) {
  const [hits, setHits] = useState<SearchHit[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api<SearchHit[]>(`/library/search?q=${encodeURIComponent(query)}`).then(
        (h) => live && (setHits(h), setError(undefined)),
        (e: Error) => live && setError(e.message),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  if (error) return <p className="text-sm text-destructive-text">{error}</p>
  if (!hits) return <p className="text-sm text-muted-foreground">Searching…</p>
  if (hits.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
  return (
    <Card className="gap-0 divide-y py-0">
      {hits.map((h) => {
        const title = <span className="block truncate text-sm font-semibold">{h.title}</span>
        return (
          <div key={h.documentId} className="flex flex-col gap-1 px-5 py-3">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
              <StatusBadge status={h.kind} tone="neutral" label={KIND_LABEL[h.kind]} />
              {h.kind === 'library' ? (
                <a
                  href={contentUrl(h.documentId)}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 hover:underline"
                >
                  {title}
                </a>
              ) : h.kind === 'thread_summary' && h.sessionId ? (
                <Link href={`/app/threads/${h.sessionId}`} className="min-w-0 hover:underline">
                  {title}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={onMemory}
                  className="min-w-0 text-left hover:underline"
                >
                  {title}
                </button>
              )}
            </div>
            <Snippet text={h.snippet} />
          </div>
        )
      })}
    </Card>
  )
}
