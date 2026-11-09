'use client'
// Where the library file in front of the document panel is: its name, and below it one button
// per folder. Each opens a menu of what that folder holds (the name, its own folder's), to go to
// a file beside this one without leaving the page, or up to the top of the library. A file opens
// in place of this one (in a tab of its own with ⌘ or Ctrl), a design in the library, as there.
// The menu also copies the file's path.
import type { LibraryFile } from '@brigade/contracts'
import { ArrowUpRight, Check, ChevronLeft, Copy, Folder, Palette, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { fileIcon } from '@/components/file-icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLeaveFull, usePanelFull } from '@/components/side-panel'
import { api } from '@/lib/api'
import { folderMatches, makeRoom, pathFolders, type FolderMenuEntry } from '@/lib/folder-menu'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * The file's name, as the button that opens its folder's menu: the files beside it, and up from
 * there to the top of the library.
 */
export function FileNameMenu({
  name,
  fileId,
  path,
  className,
}: {
  name: string
  fileId: string
  path: string
  className?: string
}) {
  return (
    <FolderMenu
      folder={parentOf(path)}
      fileId={fileId}
      path={path}
      label={`Files beside ${name}`}
      className={cn('-ml-1 min-w-0 justify-start', className)}
    >
      <span className="truncate">{name}</span>
    </FolderMenu>
  )
}

/**
 * `folder`: where the file is, e.g. "Projects/Brigade/decisions", '' at the top of the library;
 * `fileId` and `path`: the file. One button per folder; nothing at the top of the library, unless
 * `top` (the name is not shown, a tab names the file): then "Library", so its menu is there.
 */
export function DocumentPath({
  folder,
  fileId,
  path,
  top = false,
}: {
  folder: string
  fileId: string
  path: string
  top?: boolean
}) {
  const row = useRef<HTMLElement>(null)
  // A long path keeps its end in view: the folder the file is in.
  useEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth
  }, [folder])
  const folders = pathFolders(folder)
  if (!folders.length && !top) return null
  return (
    <nav
      ref={row}
      aria-label="File location"
      className="-ml-1 flex min-w-0 items-center overflow-x-auto font-mono text-xs text-muted-foreground [scrollbar-width:none]"
    >
      {folders.length ? (
        folders.map((f, i) => (
          <span key={f.path} className="flex shrink-0 items-center">
            {i > 0 && <span aria-hidden>/</span>}
            <FolderMenu folder={f.path} fileId={fileId} path={path} label={`Files in ${f.name}`}>
              {f.name}
            </FolderMenu>
          </span>
        ))
      ) : (
        <FolderMenu folder="" fileId={fileId} path={path} label="Files in Library">
          Library
        </FolderMenu>
      )}
    </nav>
  )
}

function FolderMenu({
  folder,
  fileId,
  path,
  label,
  className,
  children,
}: {
  folder: string
  fileId: string
  path: string
  label: string
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(
          'flex shrink-0 items-center rounded px-1 py-px outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground',
          className,
        )}
        aria-label={label}
      >
        {children}
      </DropdownMenuTrigger>
      {open && (
        <FolderMenuContent
          folder={folder}
          fileId={fileId}
          path={path}
          onDone={() => setOpen(false)}
        />
      )}
    </DropdownMenu>
  )
}

const ICON = { folder: Folder, design: Palette }

function FolderMenuContent({
  folder,
  fileId,
  path,
  onDone,
}: {
  folder: string
  fileId: string
  path: string
  onDone: () => void
}) {
  const router = useRouter()
  const documents = useDocumentPanel()
  const full = usePanelFull()
  const leaveFull = useLeaveFull()
  const [files, setFiles] = useState<LibraryFile[]>()
  const [failed, setFailed] = useState(false)
  // The folder shown: this one, or one gone into or up to from the menu.
  const [at, setAt] = useState(folder)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    api<LibraryFile[]>('/library').then(
      (f) => live && setFiles(f),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [])
  // The field has the keyboard once the menu shows (the menu focuses itself first).
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const entries = useMemo(() => (files ? folderMatches(files, at, query) : []), [files, at, query])
  const newTabKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac() ? e.metaKey : e.ctrlKey)

  function go(entry: FolderMenuEntry, newTab: boolean) {
    if (entry.kind === 'folder') {
      setAt(entry.path)
      setQuery('')
      input.current?.focus()
      return
    }
    onDone()
    if (entry.kind === 'design')
      return toLibrary(`/app/library?design=${encodeURIComponent(entry.path)}`)
    if (entry.file.id === fileId) return
    const document = libraryDocument(entry.file)
    if (newTab) documents.open(document)
    else documents.replace(document)
  }

  // The library page shows: the panel steps aside where it would cover it.
  function toLibrary(href: string) {
    const room = makeRoom(window.matchMedia('(min-width: 1280px)').matches, full)
    if (room === 'minimize') documents.minimize()
    else if (room === 'unexpand') leaveFull()
    router.push(href)
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') return
    // The menu's own keys (type to jump to an item) stay out of the field.
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      list.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    } else if (e.key === 'Enter' && entries[0]) {
      e.preventDefault()
      go(entries[0], newTabKey(e))
    }
  }

  // Typing while an item has the focus goes on in the field.
  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target === input.current || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key.length === 1 || e.key === 'Backspace') {
      e.preventDefault()
      setQuery((q) => (e.key === 'Backspace' ? q.slice(0, -1) : q + e.key))
      input.current?.focus()
    }
  }

  // Up one folder, from wherever it is, to the top of the library.
  const upTo = parentOf(at)
  return (
    <DropdownMenuContent
      align="start"
      className="w-72 max-w-[calc(100vw-2rem)] p-1"
      onKeyDown={onMenuKey}
    >
      <label className="mb-1 flex h-8 items-center gap-2 rounded-md border px-2">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder={`Filter ${at ? nameOf(at) : 'Library'}`}
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      {at && (
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setAt(upTo)
            setQuery('')
            input.current?.focus()
          }}
          className="text-muted-foreground"
          aria-label={`Up to ${upTo ? nameOf(upTo) : 'Library'}`}
        >
          <ChevronLeft aria-hidden />
          <span className="truncate">{at}</span>
        </DropdownMenuItem>
      )}
      <div ref={list} className="max-h-80 overflow-y-auto">
        {failed ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Could not load the files.</p>
        ) : !files ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {query.trim() ? 'No file matches.' : 'Empty folder.'}
          </p>
        ) : (
          entries.map((entry) => (
            <EntryItem
              key={entry.kind === 'file' ? entry.file.id : entry.path}
              entry={entry}
              current={entry.kind === 'file' && entry.file.id === fileId}
              onGo={(newTab) => go(entry, newTab)}
              newTabKey={newTabKey}
            />
          ))
        )}
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          onDone()
          toLibrary(at ? `/app/library?folder=${encodeURIComponent(at)}` : '/app/library')
        }}
      >
        <ArrowUpRight aria-hidden />
        Open in Library
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(path)}>
        <Copy aria-hidden />
        Copy path
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

function EntryItem({
  entry,
  current,
  onGo,
  newTabKey,
}: {
  entry: FolderMenuEntry
  current: boolean
  onGo: (newTab: boolean) => void
  newTabKey: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean
}) {
  const Icon = entry.kind === 'file' ? fileIcon(entry.file.contentType) : ICON[entry.kind]
  return (
    <DropdownMenuItem
      // A folder opens in the menu, which stays.
      onSelect={(e) => {
        if (entry.kind === 'folder') e.preventDefault()
      }}
      onClick={(e: MouseEvent) => onGo(newTabKey(e))}
      onKeyDown={(e) => {
        // ⌘↵ (Ctrl+Enter elsewhere): in a tab of its own. A plain ↵ clicks.
        if (e.key === 'Enter' && newTabKey(e)) {
          e.preventDefault()
          onGo(true)
        }
      }}
      title={entry.kind === 'file' ? entry.file.path : entry.path}
      className={cn(current && 'font-medium')}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {current && <Check aria-hidden className="text-foreground" />}
    </DropdownMenuItem>
  )
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
