'use client'
// A file the thread mentions, beside it: from the library, or from the
// teammate's working folder on its computer. Takes the desktop panel's place.
import type { ThreadFile } from '@brigade/contracts'
import { Check, Copy, Download, FileText, Library, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { FileLinksProvider, type OpenFile } from '@/components/file-links'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { API_URL } from '@/lib/config'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/

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
  const content = file?.documentId && `${API_URL}/api/library/${file.documentId}/content`

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
            {file.source === 'library' ? 'Library' : `${teammateName(file.teammateId)}'s folder`}
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
        ) : file.text === undefined ? (
          content && IMAGE.test(file.contentType) ? (
            <div className="flex justify-center bg-muted p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={content} alt={shown} className="max-w-full" />
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
