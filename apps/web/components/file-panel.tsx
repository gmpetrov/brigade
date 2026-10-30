'use client'
// A file the thread mentions, beside it: from the library, the thread's
// attachments, or the teammate's working folder on its computer. Takes the
// desktop panel's place. Text shows as text, images and PDFs as themselves.
// A text file of the working folder opens in the code editor (components/code-file.tsx),
// to edit for whoever may write to the thread (Markdown once they ask to edit it).
// While the thread's preview runs, it opens beside it too; when the preview runs
// another teammate's copy, the panel says that edits here will not show in it.
import {
  designFolderOf,
  designOptionsOf,
  type DesignWhere,
  type ThreadFile,
} from '@brigade/contracts'
import {
  Eye,
  Check,
  Copy,
  Download,
  FileText,
  Library,
  Palette,
  Pencil,
  TriangleAlert,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { CodeFile, editableFile } from '@/components/code-file'
import { DesignPanel } from '@/components/design-view'
import { FileLinksProvider, type OpenFile } from '@/components/file-links'
import { FilePreview, PdfView } from '@/components/file-preview'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { libraryDocument, useDocumentPanel } from '@/components/document-panel'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { Button } from '@/components/ui/button'
import { api, attachmentUrl, threadImageUrl } from '@/lib/api'
import { draftKey, getDraft, setDraft } from '@/lib/code-drafts'
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
  /** The person may write to the thread: a text file of a working folder opens to edit. */
  mayEdit?: boolean
  /**
   * The thread's running preview: whose copy it runs, and how to open a path of it in
   * the code beside it. A file of another copy says its edits will not show there.
   */
  previewCopy?: { teammateId: string; name: string; open: (path: string) => void }
  onOpen: OpenFile
  onClose: () => void
}

/** A library design's folder ("acme/pricing.design") shows as the design; anything else as a file. */
export function FilePanel(props: FilePanelProps) {
  const folder = props.path.trim().replace(/\/+$/, '')
  if (!folder.startsWith('/') && designFolderOf(folder) === folder)
    return designOptionsOf(folder) ? (
      <OptionPanel folder={folder} threadId={props.threadId} onClose={props.onClose} />
    ) : (
      <DesignPanel folder={folder} threadId={props.threadId} onClose={props.onClose} />
    )
  return <ThreadFilePanel {...props} />
}

/**
 * One of a design's options, as an earlier message named it: once one is
 * picked, it has become the design, and the others are in the trash.
 */
function OptionPanel({
  folder,
  threadId,
  onClose,
}: {
  folder: string
  threadId: string
  onClose: () => void
}) {
  const [where, setWhere] = useState<DesignWhere>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    setWhere(undefined)
    setError(undefined)
    api<DesignWhere>('/designs/where', { body: { path: folder } }).then(
      (w) => live && setWhere(w),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [folder])

  if (where && !where.trashed)
    return <DesignPanel folder={where.path} threadId={threadId} onClose={onClose} />

  const slash = folder.lastIndexOf('/')
  return (
    <SidePanel aria-label={`Design ${folder.slice(slash + 1)}`} onClose={onClose} raiseKey={folder}>
      <div className="flex flex-nowrap items-center gap-2 border-b px-3 py-2.5">
        <Palette aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-sm font-semibold">{folder.slice(slash + 1)}</strong>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={folder.slice(0, slash)}
          >
            {folder.slice(0, slash)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close design"
        >
          <X aria-hidden />
        </Button>
      </div>
      {error ? (
        <p className="p-4 text-sm text-destructive-text">{error}</p>
      ) : where ? (
        <p className="p-4 text-sm text-muted-foreground">
          Another option was picked, so this one is in the trash.{' '}
          <Link href="/app/library?tab=trash" className="font-medium text-primary hover:underline">
            Open the trash
          </Link>
        </p>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Opening {folder}…</p>
      )}
    </SidePanel>
  )
}

function ThreadFilePanel({
  threadId,
  path,
  teammateId,
  teammateName,
  mayEdit = false,
  previewCopy,
  onOpen,
  onClose: close,
}: FilePanelProps) {
  const [file, setFile] = useState<ThreadFile>()
  /** A file of a library design: the design shows instead. */
  const [design, setDesign] = useState<string>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const documents = useDocumentPanel()
  const name = path
    .replace(/:\d+(:\d+)?$/, '')
    .split('/')
    .pop()
  const draft = file?.teammateId ? draftKey(threadId, file.teammateId, file.path) : undefined
  // Unsaved edits are not dropped without asking.
  const onClose = useCallback(() => {
    if (draft && getDraft(draft)) {
      if (!window.confirm(`Discard your unsaved changes to ${name}?`)) return
      setDraft(draft, undefined)
    }
    close()
  }, [draft, name, close])

  useEffect(() => {
    let live = true
    setFile(undefined)
    setError(undefined)
    const query = new URLSearchParams({
      path: path.replace(/:\d+(:\d+)?$/, ''),
      ...(teammateId ? { teammateId } : {}),
    })
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
  // `src/app.tsx:42` opens at line 42.
  const line = Number(/:(\d+)(?::\d+)?$/.exec(path)?.[1]) || undefined
  const code = editableFile(file)
  const editable = mayEdit && code
  const markdown = file?.contentType === 'text/markdown'
  // Markdown shows rendered, until edited (or left with unsaved edits).
  const editing = code && (!markdown || editOpen || (!!draft && !!getDraft(draft)))
  // Another teammate's copy than the one the preview runs: edits here will not show in it.
  const otherCopy =
    previewCopy && file?.source === 'thread' && file.teammateId !== previewCopy.teammateId
      ? previewCopy
      : undefined

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
          tooltip={copied ? 'Copied' : 'Copy path'}
          onClick={() =>
            void navigator.clipboard.writeText(shown).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
        {editable && !editing && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Edit"
            tooltip="Edit the file"
            onClick={() => setEditOpen(true)}
          >
            <Pencil aria-hidden />
          </Button>
        )}
        {previewCopy && !otherCopy && code && file && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open it with the preview"
            tooltip="Open it in the code beside the preview, to see your edits as you save"
            onClick={() => previewCopy.open(file.path)}
          >
            <Eye aria-hidden />
          </Button>
        )}
        {content && (
          <Button asChild variant="ghost" size="icon-sm" tooltip="Download">
            <a href={`${content}?download`} aria-label="Download">
              <Download aria-hidden />
            </a>
          </Button>
        )}
        {file?.source === 'library' && (
          <Button asChild variant="ghost" size="icon-sm" tooltip="Open the library">
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
      {otherCopy && file && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-warning/8 px-3 py-2 text-xs"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            The preview runs {otherCopy.name}&rsquo;s copy: edits here won&rsquo;t show in it.
          </span>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => otherCopy.open(file.path)}
          >
            Open {otherCopy.name}&rsquo;s copy
          </button>
        </div>
      )}
      <div className={editing ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto'}>
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
        ) : editing && file.teammateId ? (
          <CodeFile
            threadId={threadId}
            teammateId={file.teammateId}
            path={file.path}
            file={file}
            teammateName={teammateName(file.teammateId)}
            mayEdit={editable}
            line={line}
            className="h-full"
          />
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
