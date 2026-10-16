'use client'
// Files for a message: picked, dropped or pasted into the composer, uploaded
// right away, and sent with the message by their ids. In the thread, the files
// a message came with show under it: images and videos open over the page,
// other files in the file panel.
import {
  ATTACHMENT_MAX,
  ATTACHMENTS_PER_MESSAGE,
  type AttachmentInfo,
  EFFORTS,
  type MessageAttachment,
} from '@brigade/contracts'
import {
  ArrowRightLeft,
  Ban,
  Check,
  CircleDot,
  Cloud,
  FileText,
  Laptop,
  Paperclip,
  Play,
  Plus,
  X,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { EffortBars, EffortPanel, type EffortPick } from '@/components/effort'
import { useFileLinks } from '@/components/file-links'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, attachmentUrl, uploadAttachment } from '@/lib/api'
import { cn } from '@/lib/utils'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const VIDEO = /^video\/(mp4|webm|quicktime)$/

export type Media = { name: string; src: string; kind: 'image' | 'video' }

/** How a file of this type shows over the page, if it does. */
const mediaKind = (contentType: string) =>
  IMAGE.test(contentType) ? 'image' : VIDEO.test(contentType) ? 'video' : undefined

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

type Upload = {
  key: string
  name: string
  size: number
  /** 0 to 1 while uploading. */
  progress: number
  info?: AttachmentInfo
  error?: string
  controller: AbortController
  /** An image's or video's own bytes, shown before it finishes uploading (an object URL). */
  preview?: string
  media?: Media['kind']
}

/** The files of the message being written: each uploads as soon as it is added. */
export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([])
  // The list as of now, for adds and removes between renders; uploads start outside any updater.
  const list = useRef<Upload[]>([])
  const count = useRef(0)
  const commit = useCallback((next: Upload[]) => {
    list.current = next
    setUploads(next)
  }, [])
  const update = useCallback(
    (key: string, change: Partial<Upload>) =>
      commit(list.current.map((u) => (u.key === key ? { ...u, ...change } : u))),
    [commit],
  )

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const key = `${Date.now()}-${count.current++}`
        const upload: Upload = {
          key,
          name: file.name || 'Pasted file',
          size: file.size,
          progress: 0,
          controller: new AbortController(),
          ...(mediaKind(file.type)
            ? { preview: URL.createObjectURL(file), media: mediaKind(file.type) }
            : {}),
        }
        const error =
          list.current.filter((u) => !u.error).length >= ATTACHMENTS_PER_MESSAGE
            ? `A message takes up to ${ATTACHMENTS_PER_MESSAGE} files`
            : file.size > ATTACHMENT_MAX
              ? 'Larger than 25 MB'
              : undefined
        commit([...list.current, error ? { ...upload, error } : upload])
        if (error) continue
        uploadAttachment(file, (progress) => update(key, { progress }), upload.controller.signal)
          .then((info) => update(key, { info, progress: 1 }))
          .catch((e: Error) => {
            if (e.name !== 'AbortError') update(key, { error: e.message })
          })
      }
    },
    [commit, update],
  )

  /** Take a file off the message; one already uploaded is deleted. */
  const remove = useCallback(
    (key: string) => {
      const upload = list.current.find((u) => u.key === key)
      upload?.controller.abort()
      if (upload?.preview) URL.revokeObjectURL(upload.preview)
      if (upload?.info)
        void api(`/attachments/${upload.info.id}`, { method: 'DELETE' }).catch(() => undefined)
      commit(list.current.filter((u) => u.key !== key))
    },
    [commit],
  )

  /** After sending: the files went with the message. */
  const clear = useCallback(() => {
    for (const u of list.current) if (u.preview) URL.revokeObjectURL(u.preview)
    commit([])
  }, [commit])

  // Leaving the page with files still on the message: let their previews go.
  useEffect(
    () => () => {
      for (const u of list.current) if (u.preview) URL.revokeObjectURL(u.preview)
    },
    [],
  )

  return {
    uploads,
    add,
    remove,
    clear,
    ids: uploads.flatMap((u) => (u.info ? [u.info.id] : [])),
    /** Still uploading: the message waits. */
    busy: uploads.some((u) => !u.info && !u.error),
    /** A file that failed: remove it before sending. */
    failed: uploads.some((u) => u.error),
  }
}

/**
 * Drag files onto the composer's frame, or paste them. Paste is caught before
 * the editor sees it, so a pasted screenshot becomes a file, not nothing.
 */
export function useFileDrop(add: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  return {
    dragging,
    props: enabled
      ? {
          onDragOver: (e: DragEvent) => {
            if (!hasFiles(e)) return
            e.preventDefault()
            setDragging(true)
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          },
          onDrop: (e: DragEvent) => {
            if (!hasFiles(e)) return
            e.preventDefault()
            setDragging(false)
            add([...e.dataTransfer.files])
          },
          onPasteCapture: (e: React.ClipboardEvent) => {
            const files = [...e.clipboardData.files]
            if (files.length === 0) return
            e.preventDefault()
            e.stopPropagation()
            add(files)
          },
        }
      : {},
  }
}

/** The paperclip: pick files from this computer. */
export function AttachButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label="Attach files"
        title="Attach files (or drop or paste them)"
      >
        <Paperclip aria-hidden />
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files])
          e.target.value = ''
        }}
      />
    </>
  )
}

/** A computer a thread can continue on, for the + menu's Continue on…. */
export type MoveTarget = {
  id: string
  name: string
  cloud: boolean
  /** Where the thread runs now: shown checked, not to pick. */
  current?: boolean
  /** Why it cannot be picked (no account there), if so. */
  unavailable?: string
  /** Offline: picked, the message goes once it is back. */
  offline?: boolean
}

/** A computer's icon: a laptop for a member's machine, a cloud for the cloud computer. */
export function ComputerIcon({ cloud, className }: { cloud: boolean; className?: string }) {
  return cloud ? (
    <Cloud aria-hidden className={className} />
  ) : (
    <Laptop aria-hidden className={className} />
  )
}

/**
 * The composer's +, like Claude's: attach files, teach the teammate a task by
 * recording it on its computer, continue the thread on another computer, or
 * change how hard its teammates think. `teach` is unset where teaching is not
 * offered (phones), and a reason where it is not possible yet; `move` is unset
 * where the thread cannot move.
 */
export function ComposerMenu({
  onFiles,
  teach,
  move,
  effort,
  effortLater,
}: {
  onFiles: (files: File[]) => void
  teach?: (() => void) | string
  move?: { targets: MoveTarget[]; onPick: (target: MoveTarget) => void }
  effort?: EffortPick
  /** A turn is running: a new effort waits for the next one. */
  effortLater?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  // A computer picked: the cursor goes to the message, not back to the +.
  const picked = useRef(false)
  // Effort's slider opens over the composer from the +, once the menu has closed.
  const [effortOpen, setEffortOpen] = useState(false)
  const effortNext = useRef(false)
  const index = effort ? EFFORTS.findIndex((e) => e.id === (effort.value ?? effort.fallback)) : -1
  return (
    <Popover.Root open={effortOpen} onOpenChange={setEffortOpen}>
      <DropdownMenu>
        <Popover.Anchor asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full [&_svg:not([class*='size-'])]:size-5"
              aria-label="Add files and more"
              title="Add files and more"
            >
              <Plus aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </Popover.Anchor>
        <DropdownMenuContent
          align="start"
          side="top"
          className="min-w-52"
          onCloseAutoFocus={(e) => {
            // Effort picked: its slider opens only now that the menu is gone. Opened
            // with the menu still closing, it closed again as the menu went.
            if (effortNext.current) {
              effortNext.current = false
              e.preventDefault()
              setEffortOpen(true)
              return
            }
            if (!picked.current) return
            picked.current = false
            e.preventDefault()
          }}
        >
          <DropdownMenuItem onSelect={() => input.current?.click()}>
            <Paperclip aria-hidden />
            Attach files
          </DropdownMenuItem>
          {teach !== undefined && (
            <DropdownMenuItem
              disabled={typeof teach === 'string'}
              onSelect={() => typeof teach === 'function' && teach()}
              className="items-start"
            >
              <CircleDot aria-hidden className="mt-0.5 text-destructive-text" />
              <span className="flex flex-col">
                Teach a task
                {typeof teach === 'string' && (
                  <span className="text-xs text-muted-foreground">{teach}</span>
                )}
              </span>
            </DropdownMenuItem>
          )}
          {move && move.targets.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowRightLeft aria-hidden />
                  Continue on…
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-56">
                  {move.targets.map((target) => (
                    <DropdownMenuItem
                      key={target.id}
                      disabled={target.current || !!target.unavailable}
                      onSelect={() => {
                        picked.current = true
                        move.onPick(target)
                      }}
                    >
                      <ComputerIcon cloud={target.cloud} />
                      <span className="min-w-0 flex-1 truncate">{target.name}</span>
                      {target.current ? (
                        <Check aria-label="Runs here now" className="ml-auto" />
                      ) : (
                        (target.unavailable || target.offline) && (
                          <span className="ml-auto text-xs text-muted-foreground">
                            {target.unavailable ?? 'Offline'}
                          </span>
                        )
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
          {effort && (
            <>
              {!(move && move.targets.length > 1) && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => {
                  effortNext.current = true
                }}
              >
                <EffortBars index={index} className="mr-0.5" />
                Effort
                <span className="ml-auto pl-3 text-xs text-muted-foreground">
                  {EFFORTS[index]?.label}
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {effort && <EffortPanel effort={effort} later={!!effortLater} align="start" />}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files])
          e.target.value = ''
        }}
      />
    </Popover.Root>
  )
}

/** What kind of file, from its name: "PDF", "ZIP"; empty when it has no extension. */
const extension = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? ''

/**
 * The files of the message being written, as tiles like Claude's: an image or video
 * shows itself and opens larger on a click (Esc closes it), any other file its name and kind.
 */
export function UploadList({
  uploads,
  onRemove,
}: {
  uploads: ReturnType<typeof useUploads>['uploads']
  onRemove: (key: string) => void
}) {
  const [viewing, setViewing] = useState<Media>()
  if (uploads.length === 0) return null
  return (
    <>
      <ul className="flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached files">
        {uploads.map((u) => {
          const kind = u.media ?? (u.info && mediaKind(u.info.contentType))
          const src = u.preview ?? (u.info && kind ? attachmentUrl(u.info.id) : undefined)
          return (
            <li
              key={u.key}
              className={cn(
                'group relative size-24 shrink-0 overflow-hidden rounded-lg border bg-muted/40 text-xs',
                u.error && 'border-destructive/40',
              )}
            >
              {src && kind && !u.error ? (
                <button
                  type="button"
                  className="relative block size-full cursor-zoom-in"
                  onClick={() => setViewing({ name: u.name, src, kind })}
                  aria-label={`Preview ${u.name}`}
                  title={u.name}
                >
                  <Thumbnail src={src} kind={kind} />
                </button>
              ) : (
                <div className="flex size-full flex-col justify-between gap-1 p-2" title={u.name}>
                  <span className="line-clamp-3 font-medium break-all">{u.name}</span>
                  {u.error ? (
                    <span className="line-clamp-2 text-destructive-text">{u.error}</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      {extension(u.name) ? (
                        <span className="rounded bg-secondary px-1 font-mono text-[0.625rem] text-muted-foreground">
                          {extension(u.name)}
                        </span>
                      ) : (
                        <FileText aria-hidden className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="truncate text-muted-foreground">
                        {u.info ? fileSize(u.size) : `${Math.round(u.progress * 100)}%`}
                      </span>
                    </span>
                  )}
                </div>
              )}
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                onClick={() => onRemove(u.key)}
                aria-label={`Remove ${u.name}`}
                className="absolute top-1 right-1 rounded-full shadow-sm [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
              >
                <X aria-hidden />
              </Button>
              {!u.info && !u.error && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width]"
                  style={{ width: `${u.progress * 100}%` }}
                />
              )}
            </li>
          )
        })}
      </ul>
      <MediaPreview media={viewing} onClose={() => setViewing(undefined)} />
    </>
  )
}

/** An image or a video's first frame, filling its tile; a video has a play mark. */
function Thumbnail({
  src,
  kind,
  small = false,
}: {
  src: string
  kind: Media['kind']
  small?: boolean
}) {
  if (kind === 'image')
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="size-full object-cover" />
  return (
    <>
      {/* #t=0.1 makes Safari draw a frame instead of a blank box. */}
      <video
        src={`${src}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        className="pointer-events-none size-full object-cover"
      />
      <span className="absolute inset-0 grid place-items-center">
        <span
          className={cn(
            'grid place-items-center rounded-full bg-black/60 text-white',
            small ? 'size-4' : 'size-6',
          )}
        >
          <Play aria-hidden className={cn('fill-current', small ? 'size-2' : 'size-3')} />
        </span>
      </span>
    </>
  )
}

/** An image or a video at full size over the page; Esc, a click outside or × closes it. */
export function MediaPreview({ media, onClose }: { media?: Media; onClose: () => void }) {
  return (
    <Dialog open={!!media} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="block w-auto max-w-none overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{media?.name}</DialogTitle>
        <DialogClose asChild>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Close"
            title="Close (Esc)"
            className="absolute top-2 right-2 rounded-full shadow-md"
          >
            <X aria-hidden />
          </Button>
        </DialogClose>
        {media?.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.src}
            alt={media.name}
            className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] object-contain"
          />
        )}
        {media?.kind === 'video' && (
          <video
            src={media.src}
            aria-label={media.name}
            controls
            autoPlay
            playsInline
            className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] bg-black"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The files a message came with, under it: an image or video opens over the page
 * like in the composer, any other file in the file panel.
 */
export function MessageAttachments({
  attachments,
  className,
}: {
  attachments: MessageAttachment[]
  className?: string
}) {
  const links = useFileLinks()
  const [viewing, setViewing] = useState<Media>()
  return (
    <>
      <ul className={cn('flex flex-wrap gap-2', className)} aria-label="Attached files">
        {attachments.map((a) => {
          const kind = a.status === 'ready' ? mediaKind(a.contentType) : undefined
          const body = (
            <>
              {kind ? (
                <span className="relative size-8 shrink-0 overflow-hidden rounded">
                  <Thumbnail src={attachmentUrl(a.id)} kind={kind} small />
                </span>
              ) : a.status === 'ready' ? (
                <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Ban aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex min-w-0 flex-col text-left">
                <span className="truncate font-medium">{a.name}</span>
                <span className="truncate text-muted-foreground">
                  {a.status === 'ready' ? fileSize(a.size) : (a.note ?? 'Not kept')}
                </span>
              </span>
            </>
          )
          const chip =
            'flex max-w-64 items-center gap-2 rounded-lg border bg-card py-1.5 pr-3 pl-2 text-xs'
          return (
            <li key={a.id}>
              {a.status !== 'ready' ? (
                <span className={cn(chip, 'opacity-70')} title={a.note}>
                  {body}
                </span>
              ) : kind ? (
                <button
                  type="button"
                  className={cn(chip, 'cursor-zoom-in hover:border-ring')}
                  onClick={() => setViewing({ name: a.name, src: attachmentUrl(a.id), kind })}
                  aria-label={`Preview ${a.name}`}
                  title={a.name}
                >
                  {body}
                </button>
              ) : links ? (
                <button
                  type="button"
                  className={cn(chip, 'hover:border-ring')}
                  onClick={() => links.open({ path: a.path })}
                  title={a.path}
                >
                  {body}
                </button>
              ) : (
                <a href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" className={chip}>
                  {body}
                </a>
              )}
            </li>
          )
        })}
      </ul>
      <MediaPreview media={viewing} onClose={() => setViewing(undefined)} />
    </>
  )
}
