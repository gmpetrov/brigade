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
import { Ban, FileText, Paperclip, X } from 'lucide-react'
import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useFileLinks } from '@/components/file-links'
import { Button } from '@/components/ui/button'
import { api, attachmentUrl, uploadAttachment } from '@/lib/api'
import { cn } from '@/lib/utils'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/

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
      if (upload?.info)
        void api(`/attachments/${upload.info.id}`, { method: 'DELETE' }).catch(() => undefined)
      commit(list.current.filter((u) => u.key !== key))
    },
    [commit],
  )

  /** After sending: the files went with the message. */
  const clear = useCallback(() => commit([]), [commit])

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

/** The files of the message being written, each with its progress or error. */
export function UploadList({
  uploads,
  onRemove,
}: {
  uploads: ReturnType<typeof useUploads>['uploads']
  onRemove: (key: string) => void
}) {
  if (uploads.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2 px-1" aria-label="Attached files">
      {uploads.map((u) => (
        <li
          key={u.key}
          className={cn(
            'relative flex max-w-64 items-center gap-2 overflow-hidden rounded-lg border bg-muted/40 py-1 pr-1 pl-2 text-xs',
            u.error && 'border-destructive/40',
          )}
        >
          {u.info && IMAGE.test(u.info.contentType) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachmentUrl(u.info.id)}
              alt=""
              className="size-6 shrink-0 rounded object-cover"
            />
          ) : (
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium" title={u.name}>
              {u.name}
            </span>
            <span
              className={cn(
                'truncate',
                u.error ? 'text-destructive-text' : 'text-muted-foreground',
              )}
            >
              {u.error ??
                (u.info ? fileSize(u.size) : `Uploading ${Math.round(u.progress * 100)}%`)}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(u.key)}
            aria-label={`Remove ${u.name}`}
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
      ))}
    </ul>
  )
}

/** The files a message came with, under it: each opens in the file panel. */
export function MessageAttachments({
  attachments,
  className,
}: {
  attachments: MessageAttachment[]
  className?: string
}) {
  const links = useFileLinks()
  return (
    <ul className={cn('flex flex-wrap gap-2', className)} aria-label="Attached files">
      {attachments.map((a) => {
        const image = a.status === 'ready' && IMAGE.test(a.contentType)
        const body = (
          <>
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachmentUrl(a.id)}
                alt=""
                className="size-8 shrink-0 rounded object-cover"
              />
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
  )
}
