'use client'
import '@blocknote/shadcn/style.css'
import { DOCUMENT_FRAGMENT, type EditSession, type EditTarget } from '@brigade/contracts'
import { withCollaboration } from '@blocknote/core/yjs'
import { blocksToMarkdown, markdownToBlocks } from '@brigade/editor'
import { useCreateBlockNote } from '@blocknote/react'
import { useEffect, useRef, useState } from 'react'
import YProvider from 'y-partyserver/provider'
import * as Y from 'yjs'
import {
  DocumentBlockNoteView,
  editorFiles,
  editorSchema,
  type DocumentBlockEditor,
} from '@/components/document-blocks'
import type { DocumentEditorProps } from '@/components/document-editor'
import { agentTyping, typeNextUpdate, type Writer } from '@/components/document-typing'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const openDocument = (target: EditTarget) => api<EditSession>('/library/edit', { body: target })

export function DocumentEditorView(props: DocumentEditorProps) {
  const [session, setSession] = useState<EditSession>()
  const [error, setError] = useState<string>()
  const key = JSON.stringify(props.target)

  useEffect(() => {
    let current = true
    setSession(undefined)
    setError(undefined)
    openDocument(props.target).then(
      (s) => current && setSession(s),
      (e: Error) => current && setError(e.message),
    )
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the target, by value
  }, [key])

  if (error) return <p className="text-sm text-destructive-text">{error}</p>
  if (!session) return <Skeleton className="h-32 w-full" />
  return session.live ? (
    <LiveDocument key={session.documentId} session={session} {...props} />
  ) : (
    <SavedDocument key={session.documentId} session={session} {...props} />
  )
}

type Connection = { doc: Y.Doc; provider: YProvider }
type Status = 'connecting' | 'live' | 'offline' | 'deleted'

/** Synced through the collab server: no save button, edits land as people type. */
function LiveDocument({
  session,
  target,
  ...props
}: DocumentEditorProps & { session: EditSession }) {
  const live = session.live!
  const [connection, setConnection] = useState<Connection>()

  useEffect(() => {
    const doc = new Y.Doc()
    const url = new URL(live.url)
    // The first connection uses the token that came with the session; reconnects ask for a new one.
    let token: string | undefined = live.token
    const provider = new YProvider(url.host, live.room, doc, {
      party: live.party,
      protocol: url.protocol === 'https:' ? 'wss' : 'ws',
      params: async () => {
        const fresh = token ?? (await openDocument(target).catch(() => null))?.live?.token
        token = undefined
        return { token: fresh ?? '' }
      },
    })
    setConnection({ doc, provider })
    return () => {
      provider.destroy()
      doc.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one connection per room
  }, [live.room])

  if (!connection) return <Skeleton className="h-32 w-full" />
  return (
    <LiveEditor
      connection={connection}
      user={live.user}
      documentId={session.documentId}
      list={target.kind === 'library'}
      {...props}
    />
  )
}

function LiveEditor({
  connection: { doc, provider },
  user,
  documentId,
  label,
  className,
  ask,
  list,
}: Omit<DocumentEditorProps, 'target'> & {
  connection: Connection
  user: { name: string; color: string }
  documentId: string
  list: boolean
}) {
  const [status, setStatus] = useState<Status>('connecting')
  const [synced, setSynced] = useState(false)
  const [others, setOthers] = useState<{ name: string; color: string }[]>([])
  const [typing, setTyping] = useState<Writer | null>(null)

  const self = useRef<DocumentBlockEditor>(null)
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: editorSchema,
      ...editorFiles(documentId, self),
      extensions: [agentTyping(setTyping)],
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
    // It may have connected and synced before this listened.
    if (provider.wsconnected) setStatus((s) => (s === 'deleted' ? s : 'live'))
    if (provider.synced) setSynced(true)
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
  const text =
    status === 'offline'
      ? synced
        ? 'Offline. Your edits are kept and sync when you reconnect.'
        : 'Could not reach the document. Retrying…'
      : status === 'connecting' || !synced
        ? 'Connecting…'
        : 'Changes save as you type.'
  return (
    <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-muted-foreground">
      <span role="status" className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            status === 'live' && synced
              ? 'bg-success'
              : status === 'offline'
                ? 'bg-warning'
                : 'bg-muted-foreground/50',
          )}
        />
        {text}
      </span>
      {others.length > 0 && (
        <span className="flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {others.slice(0, 4).map((o) => (
              <span
                key={o.name}
                title={o.name}
                className="flex size-6 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold text-white"
                style={{ backgroundColor: o.color }}
              >
                {o.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
          {others.length === 1 ? `${others[0]!.name} is here` : `${others.length} others here`}
        </span>
      )}
    </div>
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
  })
  self.current = editor
  const [saved, setSaved] = useState(session.text)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void (async () => {
      editor.replaceBlocks(editor.document, (await markdownToBlocks(editor, session.text)) as never)
      // What the editor writes back for the text as stored: unchanged until this differs.
      setSaved(await blocksToMarkdown(editor, editor.document))
    })()
  }, [editor, session.text])

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
        onChange={() =>
          void blocksToMarkdown(editor, editor.document).then((text) => setDirty(text !== saved))
        }
      />
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'Saved'}</span>
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}
