'use client'
// A file the thread mentions, beside it: from the library, the thread's
// attachments, or the teammate's working folder on its computer. Takes the
// desktop panel's place. Text shows as text, images and PDFs as themselves.
import { designFolderOf, type ThreadFile } from '@brigade/contracts'
import { Check, Copy, Download, FileText, Library, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { DesignPanel } from '@/components/design-view'
import { FileLinksProvider, type OpenFile } from '@/components/file-links'
import { FilePreview, PdfView } from '@/components/file-preview'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { api, attachmentUrl, threadImageUrl } from '@/lib/api'
import { API_URL } from '@/lib/config'

const IMAGE = /^image\/(png|jpeg|gif|webp)$/

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`
}

type FilePanelProps = {
  threadId: string
  path: string
  teammateId?: string
  /** Names whose working folder a file came from. */
  teammateName: (id: string | undefined) => string
  onOpen: OpenFile
  onClose: () => void
}

/** A library design's folder ("acme/pricing.design") shows as the design; anything else as a file. */
export function FilePanel(props: FilePanelProps) {
  const folder = props.path.trim().replace(/\/+$/, '')
  if (!folder.startsWith('/') && designFolderOf(folder) === folder)
    return <DesignPanel folder={folder} threadId={props.threadId} onClose={props.onClose} />
  return <ThreadFilePanel {...props} />
}

function ThreadFilePanel({
  threadId,
  path,
  teammateId,
  teammateName,
  onOpen,
  onClose,
}: FilePanelProps) {
  const [file, setFile] = useState<ThreadFile>()
  /** A file of a library design: the design shows instead. */
  const [design, setDesign] = useState<string>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const documents = useDocumentPanel()

  useEffect(() => {
    let live = true
    setFile(undefined)
    setError(undefined)
    const query = new URLSearchParams({ path, ...(teammateId ? { teammateId } : {}) })
    api<ThreadFile>(`/threads/${threadId}/file?${query}`).then(
      (f) => {
        if (!live) return
        // The library's own Markdown is a document: it opens in the document panel, to edit.
        if (f.source === 'library' && f.documentId && f.contentType === 'text/markdown') {
          documents.open(libraryDocument({ id: f.documentId, path: f.path }))
          onClose()
          return
        }
        const folder = f.source === 'library' ? designFolderOf(f.path) : undefined
        if (folder) return setDesign(folder)
        setFile(f)
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file, not when callbacks change
  }, [threadId, path, teammateId])

  if (design) return <DesignPanel folder={design} threadId={threadId} onClose={onClose} />

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
    <SidePanel aria-label={`File ${shown}`} onClose={onClose} raiseKey={shown}>
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
            <Link
              href={file.documentId ? `/app/library?file=${file.documentId}` : '/app/library'}
              aria-label="Open the library"
            >
              <Library aria-hidden />
            </Link>
          </Button>
        )}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-sm text-destructive-text">{error}</p>
        ) : !file ? (
          <p className="p-4 text-sm text-muted-foreground">Opening {path}…</p>
        ) : pdf ? (
          <PdfView url={pdf} name={shown.slice(slash + 1)} />
        ) : file.documentId && content && file.text === undefined ? (
          // A library file: whatever it is, shown as the library shows it.
          <FilePreview
            url={content}
            previewUrl={`/library/${file.documentId}/preview`}
            name={shown.slice(slash + 1)}
            contentType={file.contentType}
            download={`${content}?download`}
          />
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
    </SidePanel>
  )
}
