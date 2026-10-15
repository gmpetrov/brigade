'use client'
// Files for a message: picked, dropped or pasted into the composer, uploaded
// right away, and sent with the message by their ids. In the thread, the files
// a message came with show under it and open in the file panel.
import {
  ATTACHMENT_MAX,
  ATTACHMENTS_PER_MESSAGE,
  type AttachmentInfo,
  type MessageAttachment,
} from '@brigade/contracts'
import { Ban, FileText, Paperclip, Play, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useFileLinks } from '@/components/file-links'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api, attachmentUrl, uploadAttachment } from '@/lib/api'
import { cn } from '@/lib/utils'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/
/** Videos browsers play: MP4 (and iPhone's MOV), WebM, Ogg. */
const VIDEO = /^video\/(mp4|quicktime|webm|ogg)$/

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
  /** The file's MIME type: an image or a video is previewed. */
  type: string
  /** An image's or a video's own bytes, shown before it finishes uploading (an object URL). */
  preview?: string
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
          type: file.type,
          ...(IMAGE.test(file.type) || VIDEO.test(file.type)
            ? { preview: URL.createObjectURL(file) }
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

/** What kind of file, from its name: "PDF", "ZIP"; empty when it has no extension. */
const extension = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? ''

/** An image or a video, which opens in a preview on a click. */
type Media = { name: string; src: string; video: boolean }

/** The image or video of a file, or nothing for any other kind. */
function mediaOf(name: string, contentType: string, src: string | undefined): Media | undefined {
  if (!src) return undefined
  if (IMAGE.test(contentType)) return { name, src, video: false }
  if (VIDEO.test(contentType)) return { name, src, video: true }
  return undefined
}

/** A still of the media, filling its tile: a video shows its first frame and a play mark. */
function MediaThumb({ media }: { media: Media }) {
  return media.video ? (
    <>
      <video
        src={`${media.src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        className="pointer-events-none size-full bg-black object-cover"
      />
      <span className="absolute inset-0 grid place-items-center">
        <span className="grid size-8 place-items-center rounded-full bg-black/55 text-white">
          <Play aria-hidden className="size-4 translate-x-px fill-current" />
        </span>
      </span>
    </>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={media.src} alt="" className="size-full object-cover" />
  )
}

/**
 * The files of the message being written, as tiles like Claude's: an image or a video
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
          const media = u.error
            ? undefined
            : mediaOf(u.name, u.type, u.preview ?? (u.info ? attachmentUrl(u.info.id) : undefined))
          return (
            <li
              key={u.key}
              className={cn(
                'group relative size-24 shrink-0 overflow-hidden rounded-lg border bg-muted/40 text-xs',
                u.error && 'border-destructive/40',
              )}
            >
              {media ? (
                <button
                  type="button"
                  className="relative block size-full cursor-zoom-in"
                  onClick={() => setViewing(media)}
                  aria-label={`Preview ${u.name}`}
                  title={u.name}
                >
                  <MediaThumb media={media} />
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

/** An image or a video at full size over the page; Esc, a click outside or × closes it. */
function MediaPreview({ media, onClose }: { media?: Media; onClose: () => void }) {
  const fit = 'max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] object-contain'
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
            className="absolute top-2 right-2 z-10 rounded-full shadow-md"
          >
            <X aria-hidden />
          </Button>
        </DialogClose>
        {media &&
          (media.video ? (
            <video
              src={media.src}
              controls
              autoPlay
              playsInline
              aria-label={media.name}
              className={cn(fit, 'bg-black')}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media.src} alt={media.name} className={fit} />
          ))}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The files a message came with, under it. Images and videos are tiles that open in a
 * preview, as in the composer; any other file opens in the file panel.
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
          const media =
            a.status === 'ready' ? mediaOf(a.name, a.contentType, attachmentUrl(a.id)) : undefined
          if (media)
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className="relative block size-24 cursor-zoom-in overflow-hidden rounded-lg border bg-muted/40 hover:border-ring"
                  onClick={() => setViewing(media)}
                  aria-label={`Preview ${a.name}`}
                  title={a.name}
                >
                  <MediaThumb media={media} />
                </button>
              </li>
            )
          const body = (
            <>
              {a.status === 'ready' ? (
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
