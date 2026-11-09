'use client'
import '@blocknote/shadcn/style.css'
import { DOCUMENT_FRAGMENT, type EditSession } from '@brigade/contracts'
import { withCollaboration } from '@blocknote/core/yjs'
import { blocksToMarkdown, markdownToBlocks } from '@brigade/editor'
import { useCreateBlockNote } from '@blocknote/react'
import { useEffect, useRef, useState } from 'react'
import {
  DocumentBlockNoteView,
  editorFiles,
  editorSchema,
  type DocumentBlockEditor,
} from '@/components/document-blocks'
import type { DocumentEditorProps } from '@/components/document-editor'
import { blockDropCursor, blockDropExtension } from '@/components/document-block-drop'
import { blockSelectExtension } from '@/components/document-block-select'
import { checkboxTapExtension } from '@/components/document-checkbox'
import { checklistLookExtension } from '@/components/document-checklist'
import { agentTyping, typeNextUpdate, type Writer } from '@/components/document-typing'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useLiveSession, type LiveConnection } from '@/lib/live-documents'
import { cn } from '@/lib/utils'

export function DocumentEditorView(props: DocumentEditorProps) {
  // Open already when it was prepared (lib/prepare-document.ts) or shown a moment ago: then
  // the editor shows it at once.
  const { session, error, connection, held, deleted } = useLiveSession(props.target)

  if (error) return <p className="text-sm text-destructive-text">{error}</p>
  if (!session) return <Skeleton className="h-32 w-full" />
  if (!session.live) return <SavedDocument key={session.documentId} session={session} {...props} />
  if (!connection) return <Skeleton className="h-32 w-full" />
  const { target, ...rest } = props
  return (
    <LiveEditor
      key={connection.id}
      connection={connection}
      user={session.live.user}
      documentId={session.documentId}
      list={target.kind === 'library'}
      held={held}
      deleted={deleted}
      {...rest}
    />
  )
}

type Status = 'connecting' | 'live' | 'offline' | 'deleted'

/** Synced through the collab server: no save button, edits land as people type. */
function LiveEditor({
  connection: { doc, provider },
  user,
  documentId,
  label,
  className,
  ask,
  list,
  held,
  deleted,
}: Omit<DocumentEditorProps, 'target'> & {
  connection: LiveConnection
  user: { name: string; color: string }
  documentId: string
  list: boolean
  /** Read only until the room's check is done. */
  held: boolean
  deleted?: boolean
}) {
  // Opened before it was shown, it may be connected and synced already: no skeleton then.
  const [status, setStatus] = useState<Status>(() =>
    deleted ? 'deleted' : provider.wsconnected ? 'live' : 'connecting',
  )
  const [synced, setSynced] = useState(() => provider.synced)
  const [others, setOthers] = useState<{ name: string; color: string }[]>([])
  const [typing, setTyping] = useState<Writer | null>(null)

  const self = useRef<DocumentBlockEditor>(null)
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: editorSchema,
      ...editorFiles(documentId, self),
      dropCursor: blockDropCursor(),
      extensions: [
        agentTyping(setTyping),
        checklistLookExtension(),
        checkboxTapExtension(),
        blockDropExtension(),
        blockSelectExtension(),
      ],
      collaboration: {
        provider,
        fragment: doc.getXmlFragment(DOCUMENT_FRAGMENT),
        user,
        showCursorLabels: 'activity',
      },
    }),
    [provider],
  )
  self.current = editor

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) =>
      setStatus((s) =>
        s === 'deleted'
          ? s
          : status === 'connected'
            ? 'live'
            : status === 'connecting'
              ? 'connecting'
              : 'offline',
      )
    const onSync = (isSynced: boolean) => isSynced && setSynced(true)
    const onClose = (event: CloseEvent) => {
      if (event?.code !== 4404) return
      setStatus('deleted')
      provider.disconnect()
    }
    const onAwareness = () => {
      const seen = new Map<string, { name: string; color: string }>()
      for (const [clientId, state] of provider.awareness.getStates()) {
        const u = (state as { user?: { name: string; color: string } }).user
        if (clientId !== doc.clientID && u?.name) seen.set(u.name, u)
      }
      setOthers([...seen.values()])
    }
    // A teammate saved the document: the update that follows is its edit.
    const onMessage = (message: string) => {
      let notice: { type?: string; writer?: Writer }
      try {
        notice = JSON.parse(message) as typeof notice
      } catch {
        return
      }
      if (notice.type !== 'typing' || !notice.writer) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      typeNextUpdate(editor, notice.writer)
    }
    provider.on('status', onStatus)
    provider.on('sync', onSync)
    provider.on('connection-close', onClose)
    provider.on('custom-message', onMessage)
    provider.awareness.on('change', onAwareness)
    // It may have connected and synced before this listened, and others may be here already.
    if (provider.wsconnected) setStatus((s) => (s === 'deleted' ? s : 'live'))
    if (provider.synced) setSynced(true)
    onAwareness()
    return () => {
      provider.off('status', onStatus)
      provider.off('sync', onSync)
      provider.off('connection-close', onClose)
      provider.off('custom-message', onMessage)
      provider.awareness.off('change', onAwareness)
    }
  }, [provider, doc, editor])

  if (status === 'deleted')
    return <p className="text-sm text-muted-foreground">This document was deleted.</p>
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {synced ? (
        <DocumentBlockNoteView
          editor={editor}
          documentId={documentId}
          label={label}
          ask={ask}
          list={list}
          readOnly={held}
        />
      ) : (
        <Skeleton className="h-32 w-full" />
      )}
      <EditorStatus
        status={status}
        synced={synced}
        others={
          typing && !others.some((o) => o.name === typing.name) ? [typing, ...others] : others
        }
      />
    </div>
  )
}

function EditorStatus({
  status,
  synced,
  others,
}: {
  status: Status
  synced: boolean
  others: { name: string; color: string }[]
}) {
  // Saving as you type is the norm, so nothing says so: the row speaks only when edits
  // cannot reach the document. A reconnect in progress stays quiet, its edits are kept.
  const problem =
    status === 'offline'
      ? synced
        ? 'Offline. Your edits are kept and sync when you reconnect.'
        : 'Could not reach the document. Retrying…'
      : undefined
  // Both at the foot of the panel. The notice is a child of the editor's column, which spans the
  // whole document, so it stays in view while the document scrolls.
  return (
    <>
      {others.length > 0 && (
        <span className="mt-auto flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="flex -space-x-1.5">
            {others.slice(0, 4).map((o) => (
              <Hint key={o.name} label={o.name}>
                <span
                  className="flex size-6 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold text-white"
                  style={{ backgroundColor: o.color }}
                >
                  {o.name.slice(0, 1).toUpperCase()}
                </span>
              </Hint>
            ))}
          </span>
          {others.length === 1 ? `${others[0]!.name} is here` : `${others.length} others here`}
        </span>
      )}
      <p
        role="status"
        className={cn(
          'sticky bottom-0 flex items-center gap-2 rounded-md bg-[color-mix(in_oklch,var(--warning)_14%,var(--card))] px-3 py-2 text-xs text-foreground empty:hidden',
          others.length === 0 && 'mt-auto',
        )}
      >
        {problem && (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
            {problem}
          </>
        )}
      </p>
    </>
  )
}

/** Without a collab server: edited alone and saved whole. */
function SavedDocument({
  session,
  label,
  className,
  onSaved,
  ask,
  target,
}: DocumentEditorProps & { session: EditSession }) {
  const self = useRef<DocumentBlockEditor>(null)
  const editor = useCreateBlockNote({
    schema: editorSchema,
    ...editorFiles(session.documentId, self),
    dropCursor: blockDropCursor(),
    extensions: [
      checklistLookExtension(),
      checkboxTapExtension(),
      blockDropExtension(),
      blockSelectExtension(),
    ],
  })
  self.current = editor
  // Always there without `live`.
  const stored = session.text ?? ''
  const [saved, setSaved] = useState(stored)
  // For onChange, which runs with the render it was made in.
  const savedText = useRef(stored)
  savedText.current = saved
  // While the stored text fills it, its changes are not the person's.
  const filling = useRef(true)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    // Only the last load fills the editor: an earlier one, still converting, would replace
    // blocks that are gone by then.
    let live = true
    filling.current = true
    void (async () => {
      const blocks = await markdownToBlocks(editor, stored)
      if (!live) return
      editor.replaceBlocks(editor.document, blocks as never)
      // What the editor writes back for the text as stored: unchanged until this differs.
      const text = await blocksToMarkdown(editor, editor.document)
      if (!live) return
      savedText.current = text
      setSaved(text)
      setDirty(false)
      filling.current = false
    })()
    return () => {
      live = false
    }
  }, [editor, stored])

  async function save() {
    setBusy(true)
    setError(undefined)
    const text = await blocksToMarkdown(editor, editor.document)
    try {
      await api(`/library/edit/${session.documentId}`, { method: 'PUT', body: { text } })
      setSaved(text)
      setDirty(false)
      onSaved?.()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <DocumentBlockNoteView
        editor={editor}
        documentId={session.documentId}
        label={label}
        ask={ask}
        list={target.kind === 'library'}
        readOnly={session.readOnly}
        onChange={() => {
          if (filling.current) return
          void blocksToMarkdown(editor, editor.document).then((text) =>
            setDirty(text !== savedText.current),
          )
        }}
      />
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      {!session.readOnly && (
        <div className="flex items-center justify-end gap-3">
          <span className="text-xs text-muted-foreground">
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </div>
  )
}
