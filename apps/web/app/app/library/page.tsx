'use client'
import { BookOpen, FilePlus, FileText, Library, Search, Upload } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { Markdown } from '@/components/markdown'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type { EditTarget } from '@brigade/contracts'
import {
  api,
  useApi,
  type LibraryFile,
  type MemoryFile,
  type MemoryOverview,
  type SearchHit,
} from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

const contentUrl = (id: string, download = false) =>
  `${API_URL}/api/library/${id}/content${download ? '?download' : ''}`

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

/** The workspace's shared files and memory, and one search over both. */
export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryView />
    </Suspense>
  )
}

function LibraryView() {
  const params = useSearchParams()
  const files = useApi<LibraryFile[]>('/library')
  const memory = useApi<MemoryOverview>('/library/memory')
  const [tab, setTab] = useState('files')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string>()
  const documents = useDocumentPanel()
  // What the panel saved: sizes, times and memory previews, once it closes or switches.
  const shown = JSON.stringify(documents.current?.target ?? null)
  const reloadFiles = files.reload
  const reloadMemory = memory.reload
  useEffect(() => {
    void reloadFiles()
    void reloadMemory()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the open document changes
  }, [shown])
  const [uploading, setUploading] = useState<string>()
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  // ?file=<id> shows that file, ?tab=memory the memory; e.g. from search.
  const focus = params.get('file') ?? undefined
  useEffect(() => {
    const asked = focus ? 'files' : params.get('tab')
    if (asked !== 'files' && asked !== 'memory') return
    setTab(asked)
    setQuery('')
  }, [focus, params])

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
        <SearchResults
          query={query.trim()}
          onMemory={() => (setQuery(''), setTab('memory'))}
          onFile={() => setQuery('')}
        />
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
                onCreated={async (file) => {
                  setCreating(false)
                  await files.reload()
                  if (file.contentType === 'text/markdown') documents.open(libraryDocument(file))
                  else setOpen(file.id)
                }}
              />
            )}
            <Files
              files={files.data}
              focus={focus}
              open={open}
              setOpen={setOpen}
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
  focus,
  open,
  setOpen,
  reload,
  onUpload,
}: {
  files: LibraryFile[] | undefined
  /** A file asked for by the address: opened if it can be, and scrolled to. */
  focus?: string
  /** The file open in place. */
  open: string | undefined
  setOpen: (id: string | undefined) => void
  reload: () => Promise<void>
  onUpload: () => void
}) {
  const documents = useDocumentPanel()
  const current = documents.current?.target
  const inPanel = (id: string) => current?.kind === 'library' && current.id === id
  const [renaming, setRenaming] = useState<string>()
  const [error, setError] = useState<string>()

  const loaded = Boolean(files)
  useEffect(() => {
    if (!focus || !loaded) return
    const file = files?.find((f) => f.id === focus)
    if (file?.contentType === 'text/markdown' && file.editable)
      documents.open(libraryDocument(file))
    else if (file?.editable) setOpen(focus)
    document.getElementById(`library-file-${focus}`)?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the list is in, not on each reload
  }, [focus, loaded])

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
            <div
              key={f.id}
              id={`library-file-${f.id}`}
              className={cn(
                'flex scroll-mt-20 flex-col gap-3 px-5 py-3.5',
                (f.id === focus || inPanel(f.id)) && 'bg-primary/5',
              )}
            >
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
                  {f.editable && f.contentType === 'text/markdown' ? (
                    <Button
                      variant={inPanel(f.id) ? 'default' : 'outline'}
                      size="sm"
                      aria-pressed={inPanel(f.id)}
                      onClick={() =>
                        inPanel(f.id) ? documents.close() : documents.open(libraryDocument(f))
                      }
                    >
                      {inPanel(f.id) ? 'Close' : 'Open'}
                    </Button>
                  ) : f.editable ? (
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
                      void act(async () => {
                        await api(`/library/${f.id}`, { method: 'DELETE' })
                        if (inPanel(f.id)) documents.close()
                      })
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

/** A plain text file (not Markdown, which opens in the document panel), read and edited in place. */
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
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4">
      {draft === undefined ? (
        <pre className="max-h-[32rem] overflow-auto font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
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

/** A new file: named here, then written in the editor. A name without an extension is Markdown. */
function NewFile({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (file: LibraryFile) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function create(form: FormData) {
    setBusy(true)
    setError(undefined)
    const path = String(form.get('path') ?? '').trim()
    try {
      const file = await api<LibraryFile>('/library/text', {
        body: { path: /\.[a-z0-9]+$/i.test(path) ? path : `${path}.md`, text: '' },
      })
      await onCreated(file)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <form action={create} className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-path">Path</Label>
        <Input
          id="new-path"
          name="path"
          required
          autoFocus
          placeholder="guides/refunds.md"
          className="font-mono text-sm"
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>Create and open</Button>
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
        target={{ kind: 'workspace_memory' }}
        onSaved={reload}
      />
      {overview.teammates.map((t) => (
        <MemoryCard
          key={t.teammateId}
          title={t.name}
          description={`What ${t.name} has learned about its job. Only ${t.name} loads it.`}
          file={t.memory}
          target={{ kind: 'teammate_memory', teammateId: t.teammateId }}
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
  target,
  onSaved,
}: {
  title: string
  description: string
  file: MemoryFile
  target: EditTarget
  onSaved: () => Promise<void>
}) {
  const documents = useDocumentPanel()
  const editing = JSON.stringify(documents.current?.target) === JSON.stringify(target)

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
        <Button
          variant={editing ? 'default' : 'outline'}
          size="sm"
          aria-pressed={editing}
          onClick={() => {
            if (!editing) {
              documents.open({ target, title: `${title} memory`, subtitle: description })
              return
            }
            documents.close()
            void onSaved()
          }}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>
      <CardContent>
        {body ? (
          <Markdown text={body} className="text-sm" />
        ) : (
          <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
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

function SearchResults({
  query,
  onMemory,
  onFile,
}: {
  query: string
  onMemory: () => void
  onFile: () => void
}) {
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
                <Link
                  href={`/app/library?file=${h.documentId}`}
                  onClick={onFile}
                  className="min-w-0 hover:underline"
                >
                  {title}
                </Link>
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
