'use client'
// A file shown as itself, whatever it is: images, video and audio as media,
// PDFs page by page, text and code as text, CSV as a table, HTML and Word
// documents in a frame that runs no script, spreadsheets and decks from the
// API's reading of them. Used by the library and beside threads.
import type { LibraryPreview } from '@brigade/contracts'
import { FileText, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Pages a PDF shows here; the rest are a download away. */
const PDF_PAGES = 50
/** Rows of a CSV file shown as a table. */
const CSV_ROWS = 500
/** Text shown; longer files are cut. */
const TEXT_MAX = 1024 * 1024

export const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/
const VIDEO_TYPE = /^video\/(mp4|webm|quicktime)$/
const AUDIO_TYPE = /^audio\/(mpeg|mp4|wav|ogg)$/
const OFFICE_TYPE =
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/
const TEXT_TYPE = /^(text\/|application\/(json|yaml|xml))/

/** Whether FilePreview shows something for this type, beyond a download link. */
export const previewable = (contentType: string) =>
  IMAGE_TYPE.test(contentType) ||
  VIDEO_TYPE.test(contentType) ||
  AUDIO_TYPE.test(contentType) ||
  OFFICE_TYPE.test(contentType) ||
  TEXT_TYPE.test(contentType) ||
  contentType === 'application/pdf'

let pdfWorker: Worker | undefined

/**
 * A PDF, drawn page by page with pdf.js to the panel's width: the same in every
 * browser, including those that show no PDF in a frame. Loaded only when one opens.
 */
export function PdfView({ url, name }: { url: string; name: string }) {
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

/** A PDF over the page, page by page; Esc, a click outside or × closes it. */
export function PdfPreview({
  pdf,
  onClose,
}: {
  pdf?: { name: string; url: string }
  onClose: () => void
}) {
  return (
    <Dialog open={!!pdf} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-4rem)] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
            {pdf?.name}
          </DialogTitle>
          <DialogClose asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Close"
              tooltip="Close (Esc)"
              className="rounded-full"
            >
              <X aria-hidden />
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {pdf && <PdfView url={pdf.url} name={pdf.name} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The text of a file, first megabyte. */
function useText(url: string, enabled: boolean) {
  const [state, setState] = useState<{ text?: string; cut?: boolean; error?: string }>({})
  useEffect(() => {
    if (!enabled) return
    let live = true
    setState({})
    fetch(url, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not open it (${r.status})`))))
      .then(
        (text) => live && setState({ text: text.slice(0, TEXT_MAX), cut: text.length > TEXT_MAX }),
        (e: Error) => live && setState({ error: e.message }),
      )
    return () => {
      live = false
    }
  }, [url, enabled])
  return state
}

/** Rows of a CSV or TSV file, quotes and all. */
export function parseDelimited(text: string, separator: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') ((cell += '"'), i++)
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === separator) (row.push(cell), (cell = ''))
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length > CSV_ROWS) break
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

function Table({ rows, note }: { rows: string[][]; note?: string }) {
  const width = Math.max(0, ...rows.map((r) => r.length))
  return (
    <div className="flex flex-col">
      <div className="overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={cn(i === 0 && 'bg-muted font-semibold')}>
                {Array.from({ length: width }, (_, j) => (
                  <td
                    key={j}
                    className="max-w-72 truncate border px-2 py-1 align-top whitespace-nowrap"
                    title={row[j]}
                  >
                    {row[j] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

/** HTML in a frame with no script, no forms and nothing fetched from elsewhere. */
function SandboxedHtml({ html, title }: { html: string; title: string }) {
  const doc =
    '<!doctype html><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    '<style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#222;background:#fff}' +
    'img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px}</style>' +
    html
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={doc}
      className="h-full min-h-[32rem] w-full border-0 bg-white"
    />
  )
}

function Office({ url, name }: { url: string; name: string }) {
  const [preview, setPreview] = useState<LibraryPreview>()
  const [error, setError] = useState<string>()
  const [sheet, setSheet] = useState('0')
  useEffect(() => {
    let live = true
    setPreview(undefined)
    setError(undefined)
    setSheet('0')
    api<LibraryPreview>(url).then(
      (p) => live && setPreview(p),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [url])
  if (error) return <p className="p-4 text-sm text-destructive-text">{error}</p>
  if (!preview) return <p className="p-4 text-sm text-muted-foreground">Opening {name}…</p>
  if (preview.kind === 'none')
    return <p className="p-4 text-sm text-muted-foreground">{preview.reason}.</p>
  if (preview.kind === 'html') return <SandboxedHtml html={preview.html} title={name} />
  if (preview.kind === 'slides')
    return (
      <ol className="flex flex-col gap-3 bg-muted p-4">
        {preview.slides.length === 0 && (
          <li className="text-sm text-muted-foreground">The deck has no slides.</li>
        )}
        {preview.slides.map((s, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-md border bg-card p-4 shadow-sm">
            <span className="text-xs text-muted-foreground">Slide {i + 1}</span>
            <strong className="text-sm">{s.title || 'Untitled'}</strong>
            {s.lines.length > 0 && (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
                {s.lines.map((line, j) => (
                  <li key={j}>{line}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    )
  const current = preview.sheets[Number(sheet)]
  return (
    <div className="flex flex-col">
      {preview.sheets.length > 1 && (
        <Tabs value={sheet} onValueChange={setSheet} className="border-b px-3 py-2">
          <TabsList>
            {preview.sheets.map((s, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {s.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {!current || current.rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">This sheet is empty.</p>
      ) : (
        <Table
          rows={current.rows}
          note={
            current.truncated
              ? 'Showing the first rows and columns. Download it to see the rest.'
              : undefined
          }
        />
      )}
    </div>
  )
}

export function FilePreview({
  url,
  previewUrl,
  name,
  contentType,
  download,
}: {
  /** The file's bytes. */
  url: string
  /** The API's preview of an office file (a path for `api`), when there is one. */
  previewUrl?: string
  name: string
  contentType: string
  /** Where to download it, for files with no preview. */
  download?: string
}) {
  const isText = TEXT_TYPE.test(contentType)
  const text = useText(url, isText)

  if (IMAGE_TYPE.test(contentType))
    return (
      <div className="flex justify-center bg-muted p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} className="max-w-full" />
      </div>
    )
  if (VIDEO_TYPE.test(contentType))
    return (
      <div className="flex justify-center bg-black">
        <video src={url} controls className="max-h-[80vh] max-w-full" aria-label={name} />
      </div>
    )
  if (AUDIO_TYPE.test(contentType))
    return (
      <div className="p-4">
        <audio src={url} controls className="w-full" aria-label={name} />
      </div>
    )
  if (contentType === 'application/pdf') return <PdfView url={url} name={name} />
  if (OFFICE_TYPE.test(contentType) && previewUrl) return <Office url={previewUrl} name={name} />
  if (!isText)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No preview for this kind of file.{' '}
        {download && (
          <a href={download} className="font-medium text-primary hover:underline">
            Download it
          </a>
        )}
      </p>
    )

  if (text.error) return <p className="p-4 text-sm text-destructive-text">{text.error}</p>
  if (text.text === undefined)
    return <p className="p-4 text-sm text-muted-foreground">Opening {name}…</p>
  const cut = text.cut ? 'Showing the first 1 MB. Download it to see the rest.' : undefined
  if (contentType === 'text/markdown')
    return <Markdown text={text.text} className="px-5 py-4 text-sm" />
  if (contentType === 'text/csv' || contentType === 'text/tab-separated-values') {
    const rows = parseDelimited(text.text, contentType === 'text/csv' ? ',' : '\t')
    return (
      <Table
        rows={rows.slice(0, CSV_ROWS)}
        note={
          rows.length > CSV_ROWS || text.cut ? `Showing the first ${CSV_ROWS} rows.` : undefined
        }
      />
    )
  }
  if (contentType === 'text/html') return <SandboxedHtml html={text.text} title={name} />
  return (
    <div className="flex flex-col">
      <pre className="px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {text.text}
      </pre>
      {cut && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{cut}</p>}
    </div>
  )
}
