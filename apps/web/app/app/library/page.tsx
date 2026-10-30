'use client'
import { FilePlus, FolderPlus, FolderUp, Search, Upload } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { DesignGallery } from '@/components/design-gallery'
import { DesignSystems } from '@/components/design-systems'
import { MemoryCard } from '@/components/memory-card'
import { useDocumentPanel } from '@/components/document-panel'
import {
  join,
  LibraryBrowser,
  LibraryViewSwitch,
  useLibrarySort,
} from '@/components/library-browser'
import { LibraryTrash } from '@/components/library-trash'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  api,
  isAdmin,
  uploadToLibrary,
  useApi,
  type LibraryTree,
  type Me,
  type MemoryOverview,
  type SearchHit,
  type Teammate,
} from '@/lib/api'

/** The workspace's shared files and memory, and one search over both. */
export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryView />
    </Suspense>
  )
}

type Tab = 'files' | 'designs' | 'memory' | 'design-systems' | 'trash'

function LibraryView() {
  const params = useSearchParams()
  const router = useRouter()
  const tree = useApi<LibraryTree>('/library/tree', ['library.updated'])
  const memory = useApi<MemoryOverview>('/library/memory', ['library.updated'])
  const teammates = useApi<Teammate[]>('/teammates', ['teammates.updated'])
  const me = useApi<Me>('/me')
  const [tab, setTab] = useState<Tab>('files')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const view = useLibrarySort()
  const documents = useDocumentPanel()
  // What the panel saved: sizes, times and memory previews, once it closes or switches.
  const shown = JSON.stringify(documents.current?.target ?? null)
  const reloadTree = tree.reload
  const reloadMemory = memory.reload
  useEffect(() => {
    void reloadTree()
    void reloadMemory()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the open document changes
  }, [shown])
  const [uploading, setUploading] = useState<string>()
  const [error, setError] = useState<string>()
  const files = useRef<HTMLInputElement>(null)
  const folders = useRef<HTMLInputElement>(null)
  // ?folder=<path> shows that folder, ?file=<id> that file, ?tab=memory the memory; e.g. from search.
  const folder = params.get('folder') ?? ''
  const focus = params.get('file') ?? undefined
  const focusDesign = params.get('design') ?? undefined
  const setFolder = useCallback(
    (path: string) => {
      setCreating(null)
      router.replace(path ? `/app/library?folder=${encodeURIComponent(path)}` : '/app/library', {
        scroll: false,
      })
    },
    [router],
  )
  useEffect(() => {
    const asked = focus || focusDesign ? 'files' : params.get('tab')
    const tabs: Tab[] = ['files', 'designs', 'memory', 'design-systems', 'trash']
    if (!tabs.includes(asked as Tab)) return
    setTab(asked as Tab)
    setQuery('')
  }, [focus, focusDesign, params])

  async function upload(list: { file: File; path: string }[]) {
    if (list.length === 0) return
    setError(undefined)
    for (const [i, { file, path }] of list.entries()) {
      setUploading(list.length > 1 ? `${i + 1} of ${list.length}` : file.name)
      try {
        await uploadToLibrary(path, file)
      } catch (e) {
        setError(`${path}: ${(e as Error).message}`)
        break
      }
    }
    setUploading(undefined)
    for (const input of [files.current, folders.current]) if (input) input.value = ''
    await tree.reload()
  }

  /** Files picked from the computer, into the folder shown; a picked folder keeps its own. */
  const picked = (list: FileList | null) =>
    upload(
      Array.from(list ?? []).map((file) => ({
        file,
        path: join(folder, file.webkitRelativePath || file.name),
      })),
    )

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-extrabold tracking-tight">Library</h1>
        <div className="flex items-center gap-2">
          {uploading && (
            <span className="truncate text-sm text-muted-foreground">Uploading {uploading}…</span>
          )}
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            aria-label="New folder"
            title="New folder"
            onClick={() => (
              setTab('files'),
              setQuery(''),
              setCreating(creating === 'folder' ? null : 'folder')
            )}
          >
            <FolderPlus />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full"
            aria-label="New file"
            title="New file"
            onClick={() => (
              setTab('files'),
              setQuery(''),
              setCreating(creating === 'file' ? null : 'file')
            )}
          >
            <FilePlus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                className="rounded-full"
                disabled={Boolean(uploading)}
                aria-label="Upload"
                title="Upload"
              >
                <Upload />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => files.current?.click()}>
                <Upload aria-hidden />
                Files
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => folders.current?.click()}>
                <FolderUp aria-hidden />A folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={files}
            type="file"
            multiple
            hidden
            onChange={(e) => void picked(e.target.files)}
          />
          <input
            ref={folders}
            type="file"
            hidden
            {...{ webkitdirectory: '' }}
            onChange={(e) => void picked(e.target.files)}
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
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <div className="flex items-center gap-2">
            <TabsList className="min-w-0 justify-start overflow-x-auto">
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="designs">Designs</TabsTrigger>
              <TabsTrigger value="design-systems">Design systems</TabsTrigger>
              <TabsTrigger value="trash">Trash</TabsTrigger>
            </TabsList>
            {tab === 'files' && <LibraryViewSwitch view={view} className="ml-auto shrink-0" />}
          </div>
          <TabsContent value="files" className="flex flex-col gap-4 pt-2">
            <LibraryBrowser
              tree={tree.data}
              folder={folder}
              setFolder={setFolder}
              focus={focus}
              focusDesign={focusDesign}
              reload={tree.reload}
              upload={upload}
              teammates={teammates.data}
              admin={me.data ? isAdmin(me.data) : false}
              creating={creating}
              setCreating={setCreating}
              view={view}
            />
          </TabsContent>
          <TabsContent value="designs" className="flex flex-col gap-4 pt-2">
            <DesignGallery tree={tree.data} />
          </TabsContent>
          <TabsContent value="memory" className="flex flex-col gap-4 pt-2">
            <Memory overview={memory.data} reload={memory.reload} />
          </TabsContent>
          <TabsContent value="design-systems" className="flex flex-col gap-4 pt-2">
            <DesignSystems
              tree={tree.data}
              teammates={teammates.data}
              admin={me.data ? isAdmin(me.data) : false}
            />
          </TabsContent>
          <TabsContent value="trash" className="flex flex-col gap-4 pt-2">
            <LibraryTrash
              onRestored={async (id) => {
                await tree.reload()
                router.replace(`/app/library?file=${id}`, { scroll: false })
              }}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
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
      {/* A project's empty memory is on its own page; here it would only add an empty card. */}
      {overview.projects
        .filter(
          (p) =>
            p.memory.documentId &&
            (p.memory.archived > 0 || p.memory.text.replace(/^#[^\n]*\n+/, '').trim()),
        )
        .map((p) => (
          <MemoryCard
            key={p.projectId}
            title={p.name}
            description={`What teammates know about this project. Every thread in it loads the core; topics, when its work touches them.`}
            file={p.memory}
            target={{ kind: 'project_memory', projectId: p.projectId }}
            onSaved={reload}
          />
        ))}
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

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  library: 'File',
  workspace_memory: 'Memory',
  teammate_memory: 'Memory',
  project_memory: 'Memory',
  archived_memory: 'Removed from memory',
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
      {hits.map((h, i) => {
        const title = <span className="block truncate text-sm font-semibold">{h.title}</span>
        return (
          <div key={`${h.kind}:${h.documentId}:${i}`} className="flex flex-col gap-1 px-5 py-3">
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
