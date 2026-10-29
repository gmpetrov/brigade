'use client'
// The library's files by folder: open a folder, drag files and folders into
// another, drop files from the computer to upload them here. Each file says
// who made it and who changed it last; its versions and a preview open beside
// the page. Admins decide which teammates reach a folder.
import {
  designFolderOf,
  designName,
  folderAccessFor,
  type FolderAccess,
  type FolderRule,
  type LibraryAccess,
} from '@brigade/contracts'
import {
  ChevronRight,
  Download,
  Ellipsis,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  Folder,
  FolderLock,
  History,
  Library,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Presentation,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { timeAgo } from '@/components/dashboard'
import { DesignPanel } from '@/components/design-view'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { FilePreview } from '@/components/file-preview'
import { ActorName, FileHistory, size } from '@/components/library-history'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  api,
  type LibraryFile,
  type LibraryFolder,
  type LibraryTree,
  type Teammate,
} from '@/lib/api'
import { API_URL } from '@/lib/config'
import { cn } from '@/lib/utils'

export const contentUrl = (id: string, download = false) =>
  `${API_URL}/api/library/${id}/content${download ? '?download' : ''}`

const DRAG_TYPE = 'application/x-brigade-library'
type Dragged = { kind: 'file'; id: string; path: string } | { kind: 'folder'; path: string }

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

function fileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return FileImage
  if (contentType.startsWith('video/')) return FileVideoCamera
  if (contentType.startsWith('audio/')) return FileAudio
  if (/spreadsheet|text\/csv|tab-separated/.test(contentType)) return FileSpreadsheet
  if (/presentation/.test(contentType)) return Presentation
  if (/zip/.test(contentType)) return FileArchive
  if (/json|yaml|xml|javascript|python|shellscript|text\/css|text\/html/.test(contentType))
    return FileCode
  if (contentType.startsWith('text/') || /pdf|wordprocessing/.test(contentType)) return FileText
  return File
}

/** Every folder: the ones with a row, and the ones that exist through their files. */
function allFolders(tree: LibraryTree) {
  const folders = new Map<string, LibraryFolder>()
  const add = (path: string) => {
    for (let p = path; p; p = parentOf(p))
      if (!folders.has(p))
        folders.set(p, { path: p, explicit: false, restricted: false, grants: [] })
  }
  for (const f of tree.folders) {
    add(parentOf(f.path))
    folders.set(f.path, f)
  }
  for (const f of tree.files) add(parentOf(f.path))
  return folders
}

const rulesOf = (folders: LibraryFolder[]): FolderRule[] =>
  folders
    .filter((f) => f.restricted || f.grants.length > 0)
    .map((f) => ({
      path: f.path,
      restricted: f.restricted,
      grants: Object.fromEntries(f.grants.map((g) => [g.teammateId, g.access])),
    }))

const ACCESS_LABEL: Record<FolderAccess, string> = {
  none: 'No access',
  read: 'Reads',
  read_write: 'Reads and saves',
}

type Upload = { file: File; path: string }

export function LibraryBrowser({
  tree,
  folder,
  setFolder,
  home = '',
  focus,
  focusDesign,
  reload,
  upload,
  teammates,
  admin,
  creating,
  setCreating,
}: {
  tree: LibraryTree | undefined
  /** The folder shown; '' for the top. */
  folder: string
  setFolder: (folder: string) => void
  /** The folder the browser opens at: the member's pinned files in it show there, on top. */
  home?: string
  /** A file asked for by the address: opened, and scrolled to. */
  focus?: string
  /** A design asked for by the address (its folder): opened beside the page. */
  focusDesign?: string
  reload: () => Promise<void>
  upload: (files: Upload[]) => Promise<void>
  teammates: Teammate[] | undefined
  admin: boolean
  creating: 'file' | 'folder' | null
  setCreating: (what: 'file' | 'folder' | null) => void
}) {
  const documents = useDocumentPanel()
  const [panel, setPanel] = useState<{ id: string; tab: 'preview' | 'history' }>()
  /** The design open beside the page: its folder. */
  const [design, setDesign] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const [access, setAccess] = useState<string>()
  const [error, setError] = useState<string>()
  const [over, setOver] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'updated'>('updated')
  // Each member's choice, kept in this browser.
  useEffect(() => {
    try {
      if (localStorage.getItem(SORT_KEY) === 'name') setSort('name')
    } catch {}
  }, [])
  function chooseSort(next: 'name' | 'updated') {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {}
  }
  const recent = sort === 'updated'

  const folders = useMemo(
    () => (tree ? allFolders(tree) : new Map<string, LibraryFolder>()),
    [tree],
  )
  const rules = useMemo(() => (tree ? rulesOf(tree.folders) : []), [tree])
  const subfolders = [...folders.values()]
    .filter((f) => parentOf(f.path) === folder)
    .sort((a, b) => a.path.localeCompare(b.path))
  const files = (tree?.files ?? [])
    .filter((f) => parentOf(f.path) === folder)
    .sort((a, b) => a.path.localeCompare(b.path))
  const entries = recent
    ? recentIn(tree, folder, folders)
    : [
        ...subfolders.map((f) => ({ kind: 'folder' as const, folder: f })),
        ...files.map((f) => ({ kind: 'file' as const, file: f })),
      ]
  const pinned = new Set(tree?.pinned)
  const pinnedFiles =
    folder === home
      ? (tree?.pinned ?? [])
          .map((id) => tree?.files.find((f) => f.id === id))
          .filter((f): f is LibraryFile => !!f && (!home || f.path.startsWith(`${home}/`)))
      : []
  const opened = tree?.files.find((f) => f.id === panel?.id)

  // A file asked for by the address: its folder, then the file itself.
  const loaded = Boolean(tree)
  useEffect(() => {
    if (!focus || !tree) return
    const file = tree.files.find((f) => f.id === focus)
    if (!file) return
    const inDesign = designFolderOf(file.path)
    if (inDesign) {
      setFolder(parentOf(inDesign))
      openDesign(inDesign)
      return
    }
    setFolder(parentOf(file.path))
    open(file)
    setTimeout(
      () => document.getElementById(`library-file-${focus}`)?.scrollIntoView({ block: 'center' }),
      50,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the list is in, not on each reload
  }, [focus, loaded])
  useEffect(() => {
    if (!focusDesign || !tree) return
    setFolder(parentOf(focusDesign))
    openDesign(focusDesign)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the list is in, not on each reload
  }, [focusDesign, loaded])
  // A design whose files all went away closes.
  const designFiles = design ? tree?.files.filter((f) => f.path.startsWith(`${design}/`)) : []
  useEffect(() => {
    if (design && tree && designFiles?.length === 0) setDesign(undefined)
  }, [design, tree, designFiles?.length])
  // A file that went away (moved to the trash elsewhere) closes.
  useEffect(() => {
    if (panel && tree && !opened) setPanel(undefined)
  }, [panel, tree, opened])

  function open(file: LibraryFile, tab: 'preview' | 'history' = 'preview') {
    // Markdown opens in the editor, which has its own history.
    if (file.contentType === 'text/markdown' && file.editable && tab === 'preview') {
      setPanel(undefined)
      documents.open(libraryDocument(file))
      return
    }
    documents.close()
    setDesign(undefined)
    setPanel({ id: file.id, tab })
  }

  function openDesign(path: string) {
    documents.close()
    setPanel(undefined)
    setDesign(path)
  }

  async function act(work: () => Promise<unknown>) {
    setError(undefined)
    try {
      await work()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const move = (what: Dragged, into: string) =>
    act(async () => {
      if (what.kind === 'file') {
        if (parentOf(what.path) === into) return
        await api(`/library/${what.id}`, {
          method: 'PATCH',
          body: { path: join(into, nameOf(what.path)) },
        })
      } else {
        if (parentOf(what.path) === into || into === what.path || into.startsWith(`${what.path}/`))
          return
        await api('/library/folders', {
          method: 'PATCH',
          body: { path: what.path, to: join(into, nameOf(what.path)) },
        })
        if (folder === what.path || folder.startsWith(`${what.path}/`))
          setFolder(join(into, nameOf(what.path)) + folder.slice(what.path.length))
      }
    })

  /** A folder (or the top, '') that takes dropped rows and files from the computer. */
  const dropTarget = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      if (![...e.dataTransfer.types].some((t) => t === DRAG_TYPE || t === 'Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move'
      setOver(target)
    },
    onDragLeave: () => setOver((o) => (o === target ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setOver(null)
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      if (raw) return void move(JSON.parse(raw) as Dragged, target)
      const list = Array.from(e.dataTransfer.files)
      if (list.length) void upload(list.map((file) => ({ file, path: join(target, file.name) })))
    },
  })
  const draggable = (what: Dragged) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(what))
      e.dataTransfer.effectAllowed = 'move'
    },
  })

  if (!tree) return <p className="text-sm text-muted-foreground">Loading…</p>

  const folderRow = (f: LibraryFolder, flat = false) => {
    const inside = tree.files.filter((file) => file.path.startsWith(`${f.path}/`)).length
    const guarded = f.restricted || f.grants.length > 0
    const isDesign = designFolderOf(f.path) === f.path
    const Icon = isDesign ? Palette : guarded ? FolderLock : Folder
    return (
      <div key={f.path}>
        <div
          {...draggable({ kind: 'folder', path: f.path })}
          {...dropTarget(f.path)}
          className={cn(
            'flex items-center gap-4 px-5 py-3',
            over === f.path && 'bg-primary/10',
            design === f.path && 'bg-primary/5',
          )}
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
          >
            <Icon className="size-4" />
          </span>
          <button
            type="button"
            onClick={() => (isDesign ? openDesign(f.path) : setFolder(f.path))}
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            <span className="truncate text-sm font-semibold hover:underline">
              {isDesign ? designName(f.path) : nameOf(f.path)}
            </span>
            <span className="text-xs text-muted-foreground">
              {flat && `${parentOf(f.path) || 'Library'} · `}
              {isDesign && 'Design · '}
              {inside === 0 ? 'Empty' : `${inside} file${inside === 1 ? '' : 's'}`}
              {isDesign && updatedIn(tree.files, f.path)}
            </span>
          </button>
          {f.restricted ? (
            <Badge variant="secondary">Restricted</Badge>
          ) : (
            f.grants.length > 0 && <Badge variant="secondary">Custom access</Badge>
          )}
          <RowMenu label={`Actions for folder ${nameOf(f.path)}`}>
            {isDesign && (
              <DropdownMenuItem onSelect={() => openDesign(f.path)}>
                <Palette aria-hidden />
                View design
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setFolder(f.path)}>
              <Folder aria-hidden />
              {isDesign ? 'Its files' : 'Open'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(`folder:${f.path}`)}>
              <Pencil aria-hidden />
              Rename or move
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setAccess(f.path)}>
              <ShieldCheck aria-hidden />
              Teammate access
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                confirm(
                  inside > 0
                    ? `Move the ${inside} file${inside === 1 ? '' : 's'} in ${f.path} to the trash?` +
                        (guarded ? ' Restored files follow the access of where they land.' : '')
                    : `Remove the folder ${f.path}?`,
                ) &&
                void act(() =>
                  api(`/library/folders?path=${encodeURIComponent(f.path)}`, {
                    method: 'DELETE',
                  }),
                )
              }
            >
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </RowMenu>
        </div>
        {renaming === `folder:${f.path}` && (
          <Rename
            path={f.path}
            onCancel={() => setRenaming(undefined)}
            onSave={(to) =>
              act(async () => {
                await api('/library/folders', {
                  method: 'PATCH',
                  body: { path: f.path, to },
                })
                setRenaming(undefined)
              })
            }
          />
        )}
      </div>
    )
  }

  const fileRow = (f: LibraryFile, where: 'list' | 'pinned', flat = false) => {
    const Icon = fileIcon(f.contentType)
    const isOpen =
      panel?.id === f.id ||
      (documents.current?.target.kind === 'library' && documents.current.target.id === f.id)
    return (
      <div
        key={f.id}
        id={where === 'list' ? `library-file-${f.id}` : undefined}
        className={cn('scroll-mt-20', (f.id === focus || isOpen) && 'bg-primary/5')}
      >
        <div
          {...draggable({ kind: 'file', id: f.id, path: f.path })}
          className="flex items-center gap-4 px-5 py-3"
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
          >
            <Icon className="size-4" />
          </span>
          <button
            type="button"
            onClick={() => open(f)}
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            <span className="truncate text-sm font-semibold hover:underline">
              {nameOf(f.path)}
              {where === 'list' && pinned.has(f.id) && (
                <Pin aria-label="Pinned" className="ml-1.5 inline size-3 text-muted-foreground" />
              )}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {flat && `${parentOf(f.path) || 'Library'} · `}
              {size(f.size)} · {timeAgo(f.updatedAt)}
              {f.updatedBy && (
                <>
                  {' by '}
                  <ActorName actor={f.updatedBy} />
                </>
              )}
              {!f.indexed && ' · not searchable'}
            </span>
          </button>
          <RowMenu label={`Actions for ${nameOf(f.path)}`}>
            <DropdownMenuItem onSelect={() => open(f)}>
              <FileText aria-hidden />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open(f, 'history')}>
              <History aria-hidden />
              History
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void act(() =>
                  api(`/library/${f.id}/pin`, { method: pinned.has(f.id) ? 'DELETE' : 'POST' }),
                )
              }
            >
              {pinned.has(f.id) ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {pinned.has(f.id) ? 'Unpin' : 'Pin to top'}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={contentUrl(f.id, true)}>
                <Download aria-hidden />
                Download
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(`${where}:file:${f.id}`)}>
              <Pencil aria-hidden />
              Rename or move
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                void act(async () => {
                  await api(`/library/${f.id}`, { method: 'DELETE' })
                  if (panel?.id === f.id) setPanel(undefined)
                  documents.remove({ kind: 'library', id: f.id })
                })
              }
            >
              <Trash2 aria-hidden />
              Move to trash
            </DropdownMenuItem>
          </RowMenu>
        </div>
        {renaming === `${where}:file:${f.id}` && (
          <Rename
            path={f.path}
            onCancel={() => setRenaming(undefined)}
            onSave={(path) =>
              act(async () => {
                await api(`/library/${f.id}`, { method: 'PATCH', body: { path } })
                setRenaming(undefined)
              })
            }
          />
        )}
      </div>
    )
  }

  const crumbs = folder ? folder.split('/') : []
  const empty = entries.length === 0
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => setFolder('')}
            {...dropTarget('')}
            className={cn(
              'rounded-md px-1.5 py-0.5 font-semibold hover:bg-muted',
              over === '' && 'bg-primary/15',
            )}
          >
            Library
          </button>
          {crumbs.map((name, i) => {
            const path = crumbs.slice(0, i + 1).join('/')
            return (
              <span key={path} className="flex items-center gap-1">
                <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => setFolder(path)}
                  aria-current={path === folder ? 'page' : undefined}
                  {...dropTarget(path)}
                  className={cn(
                    'rounded-md px-1.5 py-0.5 hover:bg-muted',
                    path === folder && 'font-semibold',
                    over === path && 'bg-primary/15',
                  )}
                >
                  {name}
                </button>
              </span>
            )
          })}
        </nav>
        <Tabs value={sort} onValueChange={(v) => chooseSort(v as 'name' | 'updated')}>
          <TabsList aria-label="View">
            <TabsTrigger value="updated">Recent</TabsTrigger>
            <TabsTrigger value="name">Folders</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {creating && (
        <NewItem
          kind={creating}
          folder={folder}
          onCancel={() => setCreating(null)}
          onCreated={async (made) => {
            setCreating(null)
            await reload()
            if (made.kind === 'folder') setFolder(made.path)
            else if (made.file.contentType === 'text/markdown')
              documents.open(libraryDocument(made.file))
            else setPanel({ id: made.file.id, tab: 'preview' })
          }}
        />
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}

      {pinnedFiles.length > 0 && (
        <section aria-label="Pinned" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">Pinned</h2>
          <Card className="gap-0 divide-y py-0">
            {pinnedFiles.map((f) => fileRow(f, 'pinned', true))}
          </Card>
        </section>
      )}

      <div
        {...dropTarget(folder)}
        className={cn('rounded-xl', over === folder && 'ring-2 ring-primary/40')}
      >
        {empty ? (
          <EmptyFolder top={!folder} />
        ) : (
          <Card className="gap-0 divide-y py-0">
            {entries.map((e) =>
              e.kind === 'folder' ? folderRow(e.folder, recent) : fileRow(e.file, 'list', recent),
            )}
          </Card>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Drag files and folders onto a folder to move them, or drop files from your computer to
        upload them here.
      </p>

      {design && (
        <DesignPanel
          folder={design}
          version={designFiles?.reduce((v, f) => (f.updatedAt > v ? f.updatedAt : v), '')}
          libraryLink={false}
          onClose={() => setDesign(undefined)}
        />
      )}
      {opened && panel && (
        <LibraryFilePanel
          file={opened}
          tab={panel.tab}
          setTab={(tab) => setPanel({ id: opened.id, tab })}
          onChanged={reload}
          onClose={() => setPanel(undefined)}
        />
      )}
      {access !== undefined && (
        <FolderAccessDialog
          path={access}
          folder={folders.get(access)}
          rules={rules}
          teammates={teammates ?? []}
          admin={admin}
          onClose={() => setAccess(undefined)}
          onSaved={reload}
        />
      )}
    </>
  )
}

const SORT_KEY = 'brigade.library.sort'

type Entry = { kind: 'folder'; folder: LibraryFolder } | { kind: 'file'; file: LibraryFile }

/**
 * Everything under the folder, at any depth, newest change first: so a file is found
 * without opening each folder on the way. A design counts as one entry, as of its
 * newest file, unless the folder shown is inside it.
 */
function recentIn(
  tree: LibraryTree | undefined,
  folder: string,
  folders: Map<string, LibraryFolder>,
): Entry[] {
  const under = folder ? `${folder}/` : ''
  const designs = new Map<string, string>()
  const entries: (Entry & { at: string })[] = []
  for (const file of tree?.files ?? []) {
    if (!file.path.startsWith(under)) continue
    const design = designFolderOf(file.path)
    if (design && design.startsWith(under) && design !== folder) {
      if ((designs.get(design) ?? '') < file.updatedAt) designs.set(design, file.updatedAt)
    } else entries.push({ kind: 'file', file, at: file.updatedAt })
  }
  for (const [path, at] of designs)
    entries.push({
      kind: 'folder',
      folder: folders.get(path) ?? { path, explicit: false, restricted: false, grants: [] },
      at,
    })
  return entries.sort((a, b) => b.at.localeCompare(a.at))
}

/** When a folder's newest file changed, as " · 5 minutes ago". */
function updatedIn(files: LibraryFile[], folder: string) {
  const latest = files
    .filter((f) => f.path.startsWith(`${folder}/`))
    .reduce((v, f) => (f.updatedAt > v ? f.updatedAt : v), '')
  return latest ? ` · ${timeAgo(latest)}` : ''
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title="Actions">
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

function EmptyFolder({ top }: { top: boolean }) {
  return (
    <Card className="items-center gap-3 border-dashed px-6 py-12 text-center shadow-none">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-md bg-primary/15 text-primary"
      >
        {top ? <Library className="size-5" /> : <Upload className="size-5" />}
      </span>
      <p className="font-semibold">{top ? 'The library is empty.' : 'This folder is empty.'}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {top
          ? 'Add guides, price lists, policies or anything your teammates should know. Drop files here to upload them. Text, PDF and Office files are searchable.'
          : 'Drop files here to upload them, or drag files from another folder.'}
      </p>
    </Card>
  )
}

function Rename({
  path,
  onCancel,
  onSave,
}: {
  path: string
  onCancel: () => void
  onSave: (path: string) => Promise<void>
}) {
  return (
    <form
      className="mx-5 mb-3 flex flex-wrap items-end gap-2 rounded-lg border bg-muted/50 p-3"
      action={(form) => onSave(String(form.get('path') ?? '').trim())}
    >
      <div className="flex flex-1 basis-64 flex-col gap-2">
        <Label htmlFor={`rename-${path}`}>Path</Label>
        <Input
          id={`rename-${path}`}
          name="path"
          defaultValue={path}
          required
          autoFocus
          className="bg-card font-mono text-sm"
        />
      </div>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button>Save</Button>
    </form>
  )
}

/** A new folder, or a new file named here and written in the editor (Markdown without an extension). */
function NewItem({
  kind,
  folder,
  onCancel,
  onCreated,
}: {
  kind: 'file' | 'folder'
  folder: string
  onCancel: () => void
  onCreated: (
    made: { kind: 'folder'; path: string } | { kind: 'file'; file: LibraryFile },
  ) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function create(form: FormData) {
    setBusy(true)
    setError(undefined)
    const name = String(form.get('name') ?? '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
    try {
      if (kind === 'folder') {
        const path = join(folder, name)
        await api('/library/folders', { body: { path } })
        await onCreated({ kind: 'folder', path })
      } else {
        const file = await api<LibraryFile>('/library/text', {
          body: { path: join(folder, /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`), text: '' },
        })
        await onCreated({ kind: 'file', file })
      }
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <form action={create} className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-name">
          {kind === 'folder' ? 'Folder name' : 'File name'}
          {folder && <span className="font-normal text-muted-foreground"> in {folder}/</span>}
        </Label>
        <Input
          id="new-name"
          name="name"
          required
          autoFocus
          placeholder={kind === 'folder' ? 'policies' : 'refunds.md'}
          className="font-mono text-sm"
        />
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy}>{kind === 'folder' ? 'Create folder' : 'Create and open'}</Button>
      </div>
    </form>
  )
}

/** A library file beside the page: its preview (text files editable) and its history. */
function LibraryFilePanel({
  file,
  tab,
  setTab,
  onChanged,
  onClose,
}: {
  file: LibraryFile
  tab: 'preview' | 'history'
  setTab: (tab: 'preview' | 'history') => void
  onChanged: () => Promise<void>
  onClose: () => void
}) {
  const name = nameOf(file.path)
  const folder = parentOf(file.path)
  const Icon = fileIcon(file.contentType)
  // Markdown edits in the editor; other text files here.
  const editable = file.editable && file.contentType !== 'text/markdown'
  return (
    <SidePanel aria-label={`File ${file.path}`} onClose={onClose} raiseKey={file.id}>
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">{name}</strong>
          <span className="truncate text-xs text-muted-foreground">
            {folder && <span className="font-mono">{folder} · </span>}
            {file.createdBy ? (
              <>
                added by <ActorName actor={file.createdBy} /> {timeAgo(file.createdAt)}
              </>
            ) : (
              `added ${timeAgo(file.createdAt)}`
            )}
          </span>
        </div>
        <Button asChild variant="ghost" size="icon-sm" title="Download">
          <a href={contentUrl(file.id, true)} aria-label="Download">
            <Download aria-hidden />
          </a>
        </Button>
        <PanelExpandButton />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close file"
        >
          <X aria-hidden />
        </Button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'preview' | 'history')}
        className="border-b px-3 py-2"
      >
        <TabsList>
          <TabsTrigger value="preview">{editable ? 'File' : 'Preview'}</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'history' ? (
          <FileHistory file={file} onRestored={onChanged} />
        ) : editable ? (
          <TextFile file={file} onSaved={onChanged} />
        ) : (
          <FilePreview
            key={file.updatedAt}
            url={contentUrl(file.id)}
            previewUrl={`/library/${file.id}/preview`}
            name={name}
            contentType={file.contentType}
            download={contentUrl(file.id, true)}
          />
        )}
      </div>
    </SidePanel>
  )
}

/** A plain text file (not Markdown, which opens in the editor), read and edited in place. */
function TextFile({ file, onSaved }: { file: LibraryFile; onSaved: () => Promise<void> }) {
  const [text, setText] = useState<string>()
  const [draft, setDraft] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(contentUrl(file.id), { credentials: 'include', cache: 'no-store' })
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
    return <p className="p-4 text-sm text-muted-foreground">{error ?? 'Loading…'}</p>
  if (draft === undefined && /^text\/(csv|tab-separated-values|html)$/.test(file.contentType))
    return (
      <div className="flex flex-col">
        <div className="flex justify-end border-b px-4 py-2">
          <Button size="sm" variant="outline" onClick={() => setDraft(text)}>
            Edit
          </Button>
        </div>
        <FilePreview
          key={file.updatedAt}
          url={contentUrl(file.id)}
          name={nameOf(file.path)}
          contentType={file.contentType}
        />
      </div>
    )
  return (
    <div className="flex flex-col gap-3 p-4">
      {draft === undefined ? (
        <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">{text}</pre>
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
          <Button size="sm" onClick={() => setDraft(text)}>
            Edit
          </Button>
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

/**
 * Which teammates reach a folder. Restricted: only those listed. Otherwise
 * each keeps its library access unless set here. Shows what each ends up with.
 */
function FolderAccessDialog({
  path,
  folder,
  rules,
  teammates,
  admin,
  onClose,
  onSaved,
}: {
  path: string
  folder: LibraryFolder | undefined
  rules: FolderRule[]
  teammates: Teammate[]
  admin: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [restricted, setRestricted] = useState(folder?.restricted ?? false)
  const [grants, setGrants] = useState<Record<string, LibraryAccess>>(() =>
    Object.fromEntries((folder?.grants ?? []).map((g) => [g.teammateId, g.access])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // The rules with this folder's as drafted, to show what each teammate gets.
  const drafted = [...rules.filter((r) => r.path !== path), { path, restricted, grants }]
  const unset = restricted ? 'none' : 'default'

  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      await api('/library/folders/access', {
        method: 'PUT',
        body: {
          path,
          restricted,
          grants: Object.entries(grants).map(([teammateId, access]) => ({ teammateId, access })),
        },
      })
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderLock aria-hidden className="size-4" />
            Teammate access to {nameOf(path)}
          </DialogTitle>
          <DialogDescription>
            Applies to <span className="font-mono">{path}/</span> and every folder in it, unless a
            folder inside has its own. Teammates without access don&apos;t see it on their computer
            or in search. People in the workspace always see everything.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold">Restricted</span>
            <span className="text-xs text-muted-foreground">
              Only the teammates you give access to below reach this folder, including teammates
              added later.
            </span>
          </span>
          <Switch
            checked={restricted}
            disabled={!admin}
            onCheckedChange={setRestricted}
            aria-label="Restricted"
          />
        </label>
        <ul className="flex flex-col divide-y rounded-lg border">
          {teammates.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">No teammates yet.</li>
          )}
          {teammates.map((t) => {
            const library = t.libraryAccess ?? 'read'
            const effective = folderAccessFor(path, { id: t.id, library }, drafted)
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <span
                    className={cn(
                      'text-xs',
                      effective === 'none' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {ACCESS_LABEL[effective]}
                  </span>
                </span>
                <Select
                  value={grants[t.id] ?? unset}
                  disabled={!admin}
                  onValueChange={(v) =>
                    setGrants((g) => {
                      const next = { ...g }
                      if (v === 'none' || v === 'default') delete next[t.id]
                      else next[t.id] = v as LibraryAccess
                      return next
                    })
                  }
                >
                  <SelectTrigger size="sm" aria-label={`${t.name}'s access to ${path}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {restricted ? (
                      <SelectItem value="none">No access</SelectItem>
                    ) : (
                      <SelectItem value="default">As in the rest of the library</SelectItem>
                    )}
                    <SelectItem value="read">Reads</SelectItem>
                    <SelectItem value="read_write">Reads and saves</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            )
          })}
        </ul>
        {!admin && (
          <p className="text-sm text-muted-foreground">Only admins change teammate access.</p>
        )}
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {admin ? 'Cancel' : 'Close'}
          </Button>
          {admin && (
            <Button disabled={busy} onClick={() => void save()}>
              Save access
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
