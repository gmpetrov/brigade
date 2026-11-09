'use client'
// The library's files by folder: open a folder, drag files and folders into
// another, drop files from the computer to upload them here. Each file says
// who made it and who changed it last; its versions and a preview open beside
// the page. Admins decide which teammates reach a folder.
import {
  DESIGN_OPTIONS_SUFFIX,
  designFolderOf,
  designName,
  designOptionsOf,
  folderAccessFor,
  type FolderAccess,
  type FolderRule,
  type LibraryAccess,
} from '@brigade/contracts'
import {
  ChevronRight,
  Clock,
  Download,
  Ellipsis,
  File,
  FileText,
  Folder,
  FolderLock,
  History,
  House,
  Library,
  Palette,
  Pencil,
  Pin,
  PinOff,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { timeAgo } from '@/components/dashboard'
import { DesignPanel } from '@/components/design-view'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { PUBLIC_LINK } from '@/components/share-button'
import { ActorName, size } from '@/components/library-history'
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
import { Hint, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  type LibraryFile,
  type LibraryFolder,
  type LibraryTree,
  type Teammate,
} from '@/lib/api'
import { contentUrl } from '@/lib/library-urls'
import { fileIcon } from '@/components/file-icon'
import { folderSuggestions, splitTyped } from '@/lib/library-path'
import { cn } from '@/lib/utils'

export { contentUrl }

const DRAG_TYPE = 'application/x-brigade-library'
type Dragged = { kind: 'file'; id: string; path: string } | { kind: 'folder'; path: string }

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

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
  view,
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
  /** Recent or Folders, when the page shows its switch itself (useLibrarySort, LibraryViewSwitch). */
  view?: [LibrarySort, (sort: LibrarySort) => void]
}) {
  const documents = useDocumentPanel()
  /** The design open beside the page: its folder. */
  const [design, setDesign] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const [access, setAccess] = useState<string>()
  const [error, setError] = useState<string>()
  const [over, setOver] = useState<string | null>(null)
  const own = useLibrarySort()
  const [sort, chooseSort] = view ?? own
  const recent = sort === 'updated'

  const folders = useMemo(
    () => (tree ? allFolders(tree) : new Map<string, LibraryFolder>()),
    [tree],
  )
  const rules = useMemo(() => (tree ? rulesOf(tree.folders) : []), [tree])
  /** The folders a new file or folder can go in: not a design's own, nor its options'. */
  const places = useMemo(
    () =>
      [...folders.keys()].filter(
        (p) => !designFolderOf(p) && !p.split('/').some((s) => s.endsWith(DESIGN_OPTIONS_SUFFIX)),
      ),
    [folders],
  )
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

  // Any file opens in the file panel (components/document-panel.tsx), beside whatever page shows.
  function open(file: LibraryFile, show: 'file' | 'history' = 'file') {
    setDesign(undefined)
    documents.open(libraryDocument(file), { history: show === 'history' })
  }

  function openDesign(path: string) {
    documents.close()
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
    // The options offered for a design: one row, opening them side by side.
    const set = isDesign ? [] : optionsIn(tree.files, f.path)
    const isSet = set.length > 0
    const Icon = isDesign || isSet ? Palette : guarded ? FolderLock : Folder
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
            onClick={() =>
              isDesign ? openDesign(f.path) : isSet ? openDesign(set[0]!) : setFolder(f.path)
            }
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            <span className="truncate text-sm font-semibold hover:underline">
              {isDesign
                ? designName(f.path)
                : isSet
                  ? nameOf(f.path).slice(0, -DESIGN_OPTIONS_SUFFIX.length)
                  : nameOf(f.path)}
            </span>
            <span className="text-xs text-muted-foreground">
              {flat && `${parentOf(f.path) || 'Library'} · `}
              {isDesign && 'Design · '}
              {isDesign &&
                tree.files.some((file) => file.shared && file.path === `${f.path}/index.html`) &&
                `${PUBLIC_LINK} · `}
              {isSet
                ? `${set.length} design option${set.length === 1 ? '' : 's'}`
                : inside === 0
                  ? 'Empty'
                  : `${inside} file${inside === 1 ? '' : 's'}`}
              {(isDesign || isSet) && updatedIn(tree.files, f.path)}
            </span>
          </button>
          {f.restricted ? (
            <Badge variant="secondary">Restricted</Badge>
          ) : (
            f.grants.length > 0 && <Badge variant="secondary">Custom access</Badge>
          )}
          <RowMenu label={`Actions for folder ${nameOf(f.path)}`}>
            {(isDesign || isSet) && (
              <DropdownMenuItem onSelect={() => openDesign(isSet ? set[0]! : f.path)}>
                <Palette aria-hidden />
                {isSet ? 'View options' : 'View design'}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setFolder(f.path)}>
              <Folder aria-hidden />
              {isDesign || isSet ? 'Its files' : 'Open'}
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
      documents.current?.target.kind === 'library' && documents.current.target.id === f.id
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
              {f.shared && ` · ${PUBLIC_LINK}`}
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
      {(crumbs.length > 0 || !view) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {crumbs.length > 0 && (
            <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
              <Hint label="Library">
                <button
                  type="button"
                  onClick={() => setFolder('')}
                  {...dropTarget('')}
                  aria-label="Library"
                  className={cn(
                    'rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground',
                    over === '' && 'bg-primary/15',
                  )}
                >
                  <House aria-hidden className="size-4" />
                </button>
              </Hint>
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
          )}
          {!view && (
            <Tabs
              value={sort}
              onValueChange={(v) => chooseSort(v as LibrarySort)}
              className="ml-auto"
            >
              <TabsList aria-label="View">
                <TabsTrigger value="updated">Recent</TabsTrigger>
                <TabsTrigger value="name">Folders</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>
      )}

      {creating && (
        <NewItem
          kind={creating}
          folder={folder}
          folders={places}
          onCancel={() => setCreating(null)}
          onCreated={async (made) => {
            setCreating(null)
            await reload()
            if (made.kind === 'folder') setFolder(made.path)
            else open(made.file)
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
          {...(designOptionsOf(design)
            ? { options: optionsIn(tree.files, designOptionsOf(design)!) }
            : {})}
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

export type LibrarySort = 'name' | 'updated'

/** Recent or Folders: each member's choice, kept in this browser. */
export function useLibrarySort(): [LibrarySort, (sort: LibrarySort) => void] {
  const [sort, setSort] = useState<LibrarySort>('updated')
  useEffect(() => {
    try {
      if (localStorage.getItem(SORT_KEY) === 'name') setSort('name')
    } catch {}
  }, [])
  function chooseSort(next: LibrarySort) {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {}
  }
  return [sort, chooseSort]
}

/** Recent or Folders as two icons, to sit on a row of tabs. */
export function LibraryViewSwitch({
  view: [sort, chooseSort],
  className,
}: {
  view: [LibrarySort, (sort: LibrarySort) => void]
  className?: string
}) {
  return (
    <Tabs value={sort} onValueChange={(v) => chooseSort(v as LibrarySort)} className={className}>
      <TabsList aria-label="View">
        {/* The tab is the tooltip's trigger, not the other way round: a trigger wrapped in
            the tooltip's would take its data-state and lose the active tab's look. */}
        <Tooltip>
          <TabsTrigger value="updated" aria-label="Recent" asChild>
            <TooltipTrigger>
              <Clock aria-hidden />
            </TooltipTrigger>
          </TabsTrigger>
          <TooltipContent>Recent</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TabsTrigger value="name" aria-label="Folders" asChild>
            <TooltipTrigger>
              <Folder aria-hidden />
            </TooltipTrigger>
          </TabsTrigger>
          <TooltipContent>Folders</TooltipContent>
        </Tooltip>
      </TabsList>
    </Tabs>
  )
}

type Entry = { kind: 'folder'; folder: LibraryFolder } | { kind: 'file'; file: LibraryFile }

/** The designs offered in an options folder ("a/x.options"), in the order offered. */
function optionsIn(files: LibraryFile[], folder: string) {
  const designs = new Set<string>()
  for (const file of files) {
    const design = designFolderOf(file.path)
    if (design && designOptionsOf(design) === folder) designs.add(design)
  }
  return [...designs].sort()
}

/**
 * Everything under the folder, at any depth, newest change first: so a file is found
 * without opening each folder on the way. A design counts as one entry, as of its
 * newest file, unless the folder shown is inside it; the options offered for a
 * design count as one, unless the folder shown is theirs.
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
      const options = designOptionsOf(design)
      const entry = options && options.startsWith(under) && options !== folder ? options : design
      if ((designs.get(entry) ?? '') < file.updatedAt) designs.set(entry, file.updatedAt)
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
        <Button variant="ghost" size="icon-sm" aria-label={label} tooltip="Actions">
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

/**
 * A new folder, or a new file named here and written in the editor (Markdown without an extension).
 * Its place is typed with the name: each folder gone into shows as a chip, the
 * folders matching what is typed are offered below, and it starts in the folder shown.
 */
function NewItem({
  kind,
  folder,
  folders,
  onCancel,
  onCreated,
}: {
  kind: 'file' | 'folder'
  folder: string
  /** Every folder a new item can go in. */
  folders: string[]
  onCancel: () => void
  onCreated: (
    made: { kind: 'folder'; path: string } | { kind: 'file'; file: LibraryFile },
  ) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [segments, setSegments] = useState(() => (folder ? folder.split('/') : []))
  const [text, setText] = useState('')
  /** Folders are offered once the member types or goes into one, until Esc or leaving the field. */
  const [offering, setOffering] = useState(false)
  const [active, setActive] = useState(0)
  /** Moved to a folder with the arrows: Enter goes into it rather than creating. */
  const [picked, setPicked] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const base = segments.join('/')
  const offered = offering ? folderSuggestions(folders, base, text) : []
  // The folder it starts in exists, even when it is not offered (a design's files).
  const known = new Set([
    ...folders,
    ...(folder ? folder.split('/') : []).map((_, i, all) => all.slice(0, i + 1).join('/')),
  ])
  const isNew = (i: number) => !known.has(segments.slice(0, i + 1).join('/'))
  const name = text.trim()
  const named = kind === 'file' && name && !/\.[a-z0-9]+$/i.test(name) ? `${name}.md` : name
  const made = segments.filter((_, i) => isNew(i))

  function show(next: string[], typed: string) {
    setSegments(next)
    setText(typed)
    setOffering(true)
    setActive(0)
    setPicked(false)
    input.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && offered.length) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((active + step + offered.length) % offered.length)
      setPicked(true)
    } else if (
      offered.length &&
      ((e.key === 'Tab' && !e.shiftKey && text) || (e.key === 'Enter' && picked))
    ) {
      e.preventDefault()
      show([...segments, offered[active]!], '')
    } else if (e.key === 'Backspace' && segments.length && e.currentTarget.selectionEnd === 0) {
      e.preventDefault()
      show(segments.slice(0, -1), text)
    } else if (e.key === 'Escape' && offered.length) {
      e.preventDefault()
      setOffering(false)
    }
  }

  async function create() {
    setBusy(true)
    setError(undefined)
    try {
      if (kind === 'folder') {
        const path = join(base, name)
        await api('/library/folders', { body: { path } })
        await onCreated({ kind: 'folder', path })
      } else {
        const file = await api<LibraryFile>('/library/text', {
          body: { path: join(base, named), text: '' },
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
        <Label htmlFor="new-name">{kind === 'folder' ? 'Folder name' : 'File name'}</Label>
        <div
          className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input px-3 py-1 font-mono text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
          onClick={() => input.current?.focus()}
        >
          {segments.map((s, i) => (
            <span key={i} className="flex items-center gap-1">
              <Hint label={isNew(i) ? 'New folder: go back to it' : 'Go back to this folder'}>
                <button
                  type="button"
                  onClick={() => show(segments.slice(0, i + 1), '')}
                  className={cn(
                    'rounded-md bg-muted px-2 py-0.5 font-sans hover:bg-accent',
                    isNew(i) && 'border border-dashed border-muted-foreground/50 bg-transparent',
                  )}
                >
                  {s}
                </button>
              </Hint>
              <span className="text-muted-foreground">/</span>
            </span>
          ))}
          <input
            ref={input}
            id="new-name"
            required
            autoFocus
            autoComplete="off"
            role="combobox"
            aria-expanded={offered.length > 0}
            aria-controls="new-name-folders"
            aria-activedescendant={offered.length ? `new-name-folder-${active}` : undefined}
            value={text}
            onChange={(e) => {
              const next = splitTyped(folders, segments, e.target.value)
              show(next.segments, next.text)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setOffering(false)}
            placeholder={kind === 'folder' ? 'policies' : 'refunds.md'}
            className="h-7 min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        {offered.length > 0 && (
          <ul
            id="new-name-folders"
            role="listbox"
            aria-label="Folders"
            className="flex flex-col rounded-md border bg-background p-1 text-sm"
          >
            {offered.map((f, i) => (
              <li
                key={f}
                id={`new-name-folder-${i}`}
                role="option"
                aria-selected={i === active}
                // Keep the field focused: leaving it would close the list before the click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => show([...segments, f], '')}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5',
                  i === active && 'bg-accent text-accent-foreground',
                )}
              >
                <Folder className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate">{f}</span>
                {i === active && (
                  <kbd className="rounded border px-1 font-mono text-xs text-muted-foreground">
                    {picked ? 'Enter' : 'Tab'}
                  </kbd>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {name ? (
            <>
              Creates <span className="font-mono text-foreground">{join(base, named)}</span>
              {made.length > 0 &&
                ` and the new folder${made.length === 1 ? '' : 's'} ${made.join(', ')}`}
            </>
          ) : (
            'Type a folder name to go into it, or / after a new one. ⌫ goes back up.'
          )}
        </p>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || !name}>
          {kind === 'folder' ? 'Create folder' : 'Create and open'}
        </Button>
      </div>
    </form>
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
