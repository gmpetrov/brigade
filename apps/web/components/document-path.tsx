'use client'
// The folder of the library file in front of the document panel, one button per folder: each
// opens a menu of what that folder holds, to go to a file beside this one without leaving the
// page. A Markdown file opens in place of this one (in a tab of its own with ⌘ or Ctrl), other
// files and designs in the library, as there.
import type { LibraryFile } from '@brigade/contracts'
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  File,
  FileText,
  Folder,
  Palette,
  Search,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { folderMatches, pathFolders, type FolderMenuEntry } from '@/lib/folder-menu'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** `folder`: where the file is, e.g. "Projects/Brigade/decisions"; `fileId`: the file. */
export function DocumentPath({ folder, fileId }: { folder: string; fileId: string }) {
  const row = useRef<HTMLElement>(null)
  // A long path keeps its end in view: the folder the file is in.
  useEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth
  }, [folder])
  const folders = pathFolders(folder)
  return (
    <nav
      ref={row}
      aria-label="File location"
      className="-ml-1 flex min-w-0 items-center overflow-x-auto font-mono text-xs text-muted-foreground [scrollbar-width:none]"
    >
      {folders.map((f, i) => (
        <span key={f.path} className="flex shrink-0 items-center">
          {i > 0 && <span aria-hidden>/</span>}
          <FolderMenu folder={f.path} name={f.name} fileId={fileId} />
        </span>
      ))}
    </nav>
  )
}

function FolderMenu({ folder, name, fileId }: { folder: string; name: string; fileId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="rounded px-1 py-px outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        aria-label={`Files in ${name}`}
      >
        {name}
      </DropdownMenuTrigger>
      {open && <FolderMenuContent folder={folder} fileId={fileId} onDone={() => setOpen(false)} />}
    </DropdownMenu>
  )
}

const ICON = { folder: Folder, design: Palette }

function FolderMenuContent({
  folder,
  fileId,
  onDone,
}: {
  folder: string
  fileId: string
  onDone: () => void
}) {
  const router = useRouter()
  const documents = useDocumentPanel()
  const [files, setFiles] = useState<LibraryFile[]>()
  const [failed, setFailed] = useState(false)
  // The folder shown: this one, or one inside it gone into from the menu.
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
      return router.push(`/app/library?design=${encodeURIComponent(entry.path)}`)
    if (!entry.panel) return router.push(`/app/library?file=${entry.file.id}`)
    if (entry.file.id === fileId) return
    const document = libraryDocument(entry.file)
    if (newTab) documents.open(document)
    else documents.replace(document)
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

  const inside = at !== folder ? at.slice(folder.length + 1) : undefined
  const upTo = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
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
          placeholder={`Filter ${nameOf(inside ?? folder)}`}
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      {inside && (
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setAt(upTo)
            setQuery('')
            input.current?.focus()
          }}
          className="text-muted-foreground"
        >
          <ChevronLeft aria-hidden />
          <span className="truncate">{inside}</span>
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
          router.push(`/app/library?folder=${encodeURIComponent(at)}`)
        }}
      >
        <ArrowUpRight aria-hidden />
        Open in Library
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
  const Icon = entry.kind === 'file' ? (entry.panel ? FileText : File) : ICON[entry.kind]
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
