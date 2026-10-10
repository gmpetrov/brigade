'use client'
// A file the thread mentions, beside it: from the library, the thread's
// attachments, or the teammate's working folder on its computer. Takes the
// desktop panel's place. Text shows as text, images and PDFs as themselves.
import type { ThreadFile } from '@brigade/contracts'
import { Check, Copy, Download, FileText, Library, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { FileLinksProvider, type OpenFile } from '@/components/file-links'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api, attachmentUrl, threadImageUrl } from '@/lib/api'
import { API_URL } from '@/lib/config'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/

/** Pages a PDF shows here; the rest are a download away. */
const PDF_PAGES = 50

let pdfWorker: Worker | undefined

/**
 * A PDF, drawn page by page with pdf.js to the panel's width: the same in every
 * browser, including those that show no PDF in a frame. Loaded only when one opens.
 */
function PdfView({ url, name }: { url: string; name: string }) {
  const pages = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<{ error?: string; count?: number }>({})
  useEffect(() => {
    let cancelled = false
    let destroy: (() => Promise<void>) | undefined
    setStatus({})
    pages.current?.replaceChildren()
    void (async () => {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Could not open it (${response.status})`)
      }
      const data = new Uint8Array(await response.arrayBuffer())
      const pdfjs = await import('pdfjs-dist')
      pdfWorker ??= new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
        type: 'module',
      })
      pdfjs.GlobalWorkerOptions.workerPort = pdfWorker
      const task = pdfjs.getDocument({ data })
      destroy = () => task.destroy()
      const doc = await task.promise
      if (cancelled) return
      setStatus({ count: doc.numPages })
      const root = pages.current
      if (!root) return
      const width = Math.max(200, root.clientWidth - 32)
      const ratio = window.devicePixelRatio || 1
      for (let n = 1; n <= Math.min(doc.numPages, PDF_PAGES) && !cancelled; n++) {
        const page = await doc.getPage(n)
        const scale = width / page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale: scale * ratio })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
        canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`)
        canvas.className = 'mx-auto block rounded-sm bg-white shadow-sm'
        root.append(canvas)
        await page.render({ canvas, viewport }).promise
      }
    })().catch((e: Error) => !cancelled && setStatus({ error: e.message }))
    return () => {
      cancelled = true
      void destroy?.()
    }
  }, [url])
  return (
    <div className="flex min-h-full flex-col gap-4 bg-muted p-4">
      {status.error ? (
        <p className="text-sm text-destructive-text">{status.error}</p>
      ) : (
        status.count === undefined && (
          <p className="text-sm text-muted-foreground">Opening {name}…</p>
        )
      )}
      <div ref={pages} role="document" aria-label={name} className="flex flex-col gap-4" />
      {(status.count ?? 0) > PDF_PAGES && (
        <p className="text-center text-xs text-muted-foreground">
          Showing the first {PDF_PAGES} of {status.count} pages. Download it to see the rest.
        </p>
      )}
    </div>
  )
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

export function FilePanel({
  threadId,
  path,
  teammateId,
  teammateName,
  onOpen,
  onClose,
}: {
  threadId: string
  path: string
  teammateId?: string
  /** Names whose working folder a file came from. */
  teammateName: (id: string | undefined) => string
  onOpen: OpenFile
  onClose: () => void
}) {
  const [file, setFile] = useState<ThreadFile>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setFile(undefined)
    setError(undefined)
    const query = new URLSearchParams({ path, ...(teammateId ? { teammateId } : {}) })
    api<ThreadFile>(`/threads/${threadId}/file?${query}`).then(
      (f) => live && setFile(f),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [threadId, path, teammateId])

  const shown = file?.path ?? path
  const slash = shown.lastIndexOf('/')
  const folder = slash >= 0 ? shown.slice(0, slash) : ''
  // The library's copy, or the file as given to the thread; a working folder's own only through the computer.
  const content = file?.documentId
    ? `${API_URL}/api/library/${file.documentId}/content`
    : file?.attachmentId
      ? attachmentUrl(file.attachmentId)
      : undefined
  // An image or PDF in the teammate's folder shows as itself; other binary files only from storage.
  const own = file && (content ?? threadImageUrl(threadId, file.path, file.teammateId))
  const image = file && IMAGE.test(file.contentType) ? own : undefined
  const pdf = file?.contentType === 'application/pdf' ? own : undefined

  return (
    <aside
      data-desktop-panel
      // A sheet from the bottom on narrow screens; beside the thread on wide ones.
      className="fixed inset-x-0 bottom-0 z-40 flex h-[70vh] flex-col overflow-hidden rounded-t-xl border-t bg-card shadow-lg xl:inset-y-0 xl:right-0 xl:left-auto xl:z-10 xl:h-auto xl:w-(--desktop-w) xl:rounded-none xl:border-t-0 xl:border-l xl:shadow-none"
      aria-label={`File ${shown}`}
    >
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">{shown.slice(slash + 1)}</strong>
          {folder && (
            <span className="truncate font-mono text-xs text-muted-foreground" title={folder}>
              {folder}
            </span>
          )}
        </div>
        {file && (
          <Badge variant="secondary" className="shrink-0 text-muted-foreground">
            {file.source === 'library'
              ? 'Library'
              : file.source === 'attachment'
                ? 'Attached'
                : `${teammateName(file.teammateId)}'s folder`}
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? 'Copied' : 'Copy path'}
          title={copied ? 'Copied' : 'Copy path'}
          onClick={() =>
            void navigator.clipboard.writeText(shown).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
        {content && (
          <Button asChild variant="ghost" size="icon-sm" title="Download">
            <a href={`${content}?download`} aria-label="Download">
              <Download aria-hidden />
            </a>
          </Button>
        )}
        {file?.source === 'library' && (
          <Button asChild variant="ghost" size="icon-sm" title="Open the library">
            <Link href="/app/library" aria-label="Open the library">
              <Library aria-hidden />
            </Link>
          </Button>
        )}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-sm text-destructive-text">{error}</p>
        ) : !file ? (
          <p className="p-4 text-sm text-muted-foreground">Opening {path}…</p>
        ) : pdf ? (
          <PdfView url={pdf} name={shown.slice(slash + 1)} />
        ) : file.text === undefined ? (
          image ? (
            <div className="flex justify-center bg-muted p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt={shown} className="max-w-full" />
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              {size(file.size)}, not a text file.{' '}
              {content ? (
                <a
                  href={`${content}?download`}
                  className="font-medium text-primary hover:underline"
                >
                  Download it
                </a>
              ) : (
                'Take over the computer to open it there.'
              )}
            </p>
          )
        ) : file.contentType === 'text/markdown' ? (
          // Its own relative links open next to it.
          <FileLinksProvider value={{ open: onOpen, base: folder, teammateId: file.teammateId }}>
            <Markdown text={file.text} className="px-5 py-4 text-sm" />
          </FileLinksProvider>
        ) : (
          <pre className="px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
            {file.text}
          </pre>
        )}
        {file?.truncated && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Showing the first 1 MB of {size(file.size)}.
          </p>
        )}
      </div>
    </aside>
  )
}
