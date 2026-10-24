'use client'
// One text file of a teammate's working folder in the code editor: in a tab of the
// code panel beside the preview (components/code-workspace.tsx), or in the file panel.
// Saves go against the hash it was opened at, so a change made since on the computer
// is not written over without asking. While it shows, it checks every few seconds
// whether the file changed on the computer: with nothing typed, it takes the new
// text in place (the cursor stays); with unsaved edits, it says so at once. In the
// code panel, it shows what changed since the last commit, to revert.
import type { CodeChange, SavedThreadFile, SaveThreadFile, ThreadFile } from '@brigade/contracts'
import { Search, Undo2 } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CodeEditorControls } from '@/components/code-editor'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'
import { comparedTo } from '@/lib/code-changes'
import { draftKey, getDraft, setDraft as keepDraft } from '@/lib/code-drafts'
import { cn } from '@/lib/utils'

// Its own chunk: only a file opened to edit loads it.
const CodeEditor = dynamic(() => import('@/components/code-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted-foreground">Opening the editor…</p>,
})

/** How often a file that shows is checked for changes on the computer. */
const WATCH_MS = 2500
/** How long "Updated" shows after a change came in. */
const UPDATED_MS = 4000
/** How long watching waits after the computer did not answer (offline, restarting). */
const OFFLINE_PAUSE_MS = 15_000

export const MOD =
  typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** A file of a teammate's working folder, as the file panel reads it. */
export const readCodeFile = (threadId: string, teammateId: string, path: string) =>
  api<ThreadFile>(`/threads/${threadId}/file?${new URLSearchParams({ path, teammateId })}`)

/** Whether a file read can be edited in the code editor: a whole text file of a working folder. */
export const editableFile = (file: ThreadFile | undefined) =>
  !!file && file.source === 'thread' && !!file.hash && file.text !== undefined && !file.truncated

/**
 * Editing a text file of a teammate's working folder: what was typed, saved
 * against the hash it was opened at. Unsaved edits outlive the panel
 * (lib/code-drafts.ts): the file opens again with them.
 */
function useEdit(threadId: string, file: ThreadFile | undefined, onSaved?: () => void) {
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string>()
  const key = file?.teammateId ? draftKey(threadId, file.teammateId, file.path) : undefined
  /** What a save expects to find: the hash of the text the edits started from. */
  const base = useRef<string>(undefined)
  /** Counts saves, so a check for changes that a save overtook is not taken for one. */
  const saves = useRef(0)
  /** Counts edits, so the file read while someone typed does not replace what they typed. */
  const edits = useRef(0)
  // Read as the file comes, not after: the editor starts from it as it mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file read
  const initial = useMemo(() => (key ? getDraft(key)?.text : undefined), [file])

  // A file opened (again): with the edits left unsaved in it, if any.
  useEffect(() => {
    const kept = key ? getDraft(key) : undefined
    base.current = kept ? kept.base : file?.hash
    setDraft(kept?.text)
    setConflict(false)
    setError(undefined)
    setSaved(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file read
  }, [file])

  const update = (text: string | undefined) => {
    setDraft(text)
    if (key) keepDraft(key, text === undefined ? undefined : { text, base: base.current })
  }

  const save = async (force = false) => {
    if (!file?.teammateId || draft === undefined || saving) return
    setSaving(true)
    setError(undefined)
    saves.current++
    const text = draft
    try {
      const { hash } = await api<SavedThreadFile>(`/threads/${threadId}/file`, {
        method: 'PUT',
        body: {
          path: file.path,
          teammateId: file.teammateId,
          text,
          ...(force ? {} : { base: base.current }),
        } satisfies SaveThreadFile,
      })
      base.current = hash
      setConflict(false)
      setSaved(true)
      onSaved?.()
      // Typed on while it saved: still to save, from the new base.
      const now = key ? getDraft(key)?.text : undefined
      update(now === undefined || now === text ? undefined : now)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && /changed since/.test(e.message))
        setConflict(true)
      else setError((e as Error).message)
    } finally {
      saves.current++
      setSaving(false)
    }
  }

  return {
    dirty: draft !== undefined,
    saving,
    saved: saved && draft === undefined,
    conflict,
    setConflict,
    error,
    base,
    saves,
    edits,
    /** The unsaved edits it opened with, for the editor to start from; else the file. */
    initial,
    change: (text: string) => {
      edits.current++
      update(text)
      setSaved(false)
    },
    save,
    /** Drops the unsaved edits. */
    reset: () => update(undefined),
  }
}

export function CodeFile({
  threadId,
  teammateId,
  path,
  file: given,
  teammateName,
  mayEdit,
  line,
  lineKey,
  visible = true,
  breadcrumb = false,
  head,
  base,
  status,
  reloadKey,
  onRevert,
  onSaved,
  className,
}: {
  threadId: string
  teammateId: string
  /** Relative to the teammate's working folder. */
  path: string
  /** Already read (the file panel): not read again. */
  file?: ThreadFile
  /** Whose working folder it is: they are the likely one to change it. */
  teammateName: string
  mayEdit: boolean
  /** The line to show; again each time `lineKey` changes. */
  line?: number
  lineKey?: unknown
  /** Shown: only then is it checked for changes on the computer. */
  visible?: boolean
  /** Its folders above it, as in a tab of the code panel. */
  breadcrumb?: boolean
  /**
   * The last commits of the folder's repositories (lib/code-changes.ts): when set,
   * what changed since shows, read again once another commit is made.
   */
  head?: string
  /** The default branch it compares to ("main"); unset: the last commit. */
  base?: string
  /** How it differs from that, if it does: it can be reverted. */
  status?: CodeChange['status']
  /** Reverted: each time it changes, the file is read again, unsaved edits dropped. */
  reloadKey?: number
  /** Revert it to that, once asked; why not, if it failed. */
  onRevert?: () => Promise<string | undefined>
  onSaved?: () => void
  className?: string
}) {
  const [file, setFile] = useState<ThreadFile | undefined>(given)
  const [loadError, setLoadError] = useState<string>()
  const [gone, setGone] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number>()
  const editor = useRef<CodeEditorControls | null>(null)
  const edit = useEdit(threadId, file, onSaved)
  /** The file as in the last commit; null: in none, or not known. */
  const [original, setOriginal] = useState<string | null>(null)
  const [revertError, setRevertError] = useState<string>()
  /** Still on screen: a read that ends after it closed changes nothing. */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const editable = mayEdit && editableFile(file)

  useEffect(() => {
    if (given) return
    let live = true
    readCodeFile(threadId, teammateId, path).then(
      (f) => {
        if (!live) return
        // Not found in this copy, the read tried the thread's other teammates' folders.
        if (f.source !== 'thread' || f.teammateId !== teammateId)
          return setLoadError(`Not in ${teammateName}'s copy.`)
        setFile(f)
      },
      (e: Error) => live && setLoadError(e.message),
    )
    return () => {
      live = false
    }
  }, [threadId, teammateId, path, given, teammateName])

  // As in the last commit, to show what changed since: again after another commit.
  const diffed = head !== undefined && !!file
  useEffect(() => {
    if (!diffed) return setOriginal(null)
    let live = true
    api<{ text: string | null }>(
      `/threads/${threadId}/code/original?${new URLSearchParams({ teammateId, path })}`,
    ).then(
      ({ text }) => live && setOriginal(text),
      // Too large, not text, or the computer did not answer: no changes shown.
      () => live && setOriginal(null),
    )
    return () => {
      live = false
    }
  }, [diffed, head, threadId, teammateId, path])

  // Reverted: the file as it is now, whatever was typed before (who reverted was asked).
  // Not over what is typed or saved while it reads: then the watch finds the file
  // changed under those edits, and asks.
  useEffect(() => {
    if (!reloadKey) return
    let live = true
    edit.reset()
    const edits = edit.edits.current
    const saves = edit.saves.current
    readCodeFile(threadId, teammateId, path).then(
      (now) => {
        if (!live || !mounted.current) return
        if (edits !== edit.edits.current || saves !== edit.saves.current) return
        if (now.text === undefined || !now.hash) return setGone(true)
        editor.current?.replace(now.text)
        edit.base.current = now.hash
        edit.reset()
        edit.setConflict(false)
        setGone(false)
      },
      () => live && setGone(true),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each time it is reverted
  }, [reloadKey])

  // A line asked for again (an element picked a second time): there.
  useEffect(() => {
    if (line) editor.current?.goto(line)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each time it is asked
  }, [lineKey])

  /**
   * The file as it is now on the computer, in place of what shows, as one change: the
   * cursor and scroll stay. Not when someone typed or saved while it was read: what they
   * typed stays, and the next check finds the file changed under their edits. Whether it
   * came in. Through a ref, so the watch below calls this render's, whose edit knows the
   * file (one from before it was read would keep the draft).
   */
  const takeTheirs = async () => {
    const edits = edit.edits.current
    const saves = edit.saves.current
    // The unsaved edits as they were: another editor of the file (this one closed and
    // opened again) may have typed some while it read.
    const key = draftKey(threadId, teammateId, path)
    const draft = getDraft(key)?.text
    const now = await readCodeFile(threadId, teammateId, path)
    if (now.text === undefined || !now.hash) return false
    if (
      !mounted.current ||
      edits !== edit.edits.current ||
      saves !== edit.saves.current ||
      getDraft(key)?.text !== draft
    )
      return false
    editor.current?.replace(now.text)
    edit.base.current = now.hash
    edit.reset()
    edit.setConflict(false)
    setGone(false)
    return true
  }
  const latestTakeTheirs = useRef(takeTheirs)
  latestTakeTheirs.current = takeTheirs

  // While it shows: has it changed on the computer?
  const dirty = edit.dirty
  const watched = !!file?.hash && file.text !== undefined
  useEffect(() => {
    if (!visible || !watched) return
    let stopped = false
    /** The computer did not answer: a while before asking again, or until the window comes back. */
    let pausedUntil = 0
    const check = async () => {
      if (document.visibilityState !== 'visible' || edit.saving || Date.now() < pausedUntil) return
      const saves = edit.saves.current
      try {
        const { hashes } = await api<{ hashes: Record<string, string | null> }>(
          `/threads/${threadId}/code/hashes`,
          { body: { teammateId, paths: [path] } },
        )
        // A save started or ended meanwhile: its own change, not someone else's.
        if (stopped || saves !== edit.saves.current) return
        const now = hashes[path]
        if (now === undefined || now === edit.base.current) return setGone(false)
        if (now === null) return setGone(true)
        setGone(false)
        if (dirty) return edit.setConflict(true)
        if ((await latestTakeTheirs.current()) && !stopped) setUpdatedAt(Date.now())
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) return
        // A runner too old to tell: no watching. Offline or restarting: again in a while.
        if (/Update Brigade/.test(e.message)) stopped = true
        else pausedUntil = Date.now() + OFFLINE_PAUSE_MS
      }
    }
    const timer = setInterval(() => !stopped && void check(), WATCH_MS)
    const onFocus = () => {
      pausedUntil = 0
      if (!stopped) void check()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edit's refs; dirty and saving restart it
  }, [visible, watched, dirty, edit.saving, threadId, teammateId, path])

  useEffect(() => {
    if (!updatedAt) return
    const timer = setTimeout(() => setUpdatedAt(undefined), UPDATED_MS)
    return () => clearTimeout(timer)
  }, [updatedAt])

  if (loadError) return <p className="p-4 text-sm text-destructive-text">{loadError}</p>
  if (!file) return <p className="p-4 text-sm text-muted-foreground">Opening {path}…</p>
  if (file.text === undefined)
    return <p className="p-4 text-sm text-muted-foreground">Not a text file.</p>

  const parts = file.path.split('/')
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3 text-xs">
        {breadcrumb ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={file.path}>
            {parts.slice(0, -1).map((part, i) => (
              <span key={i}>
                {part}
                <span className="px-1 opacity-60">/</span>
              </span>
            ))}
            <span className="text-foreground">{parts.at(-1)}</span>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {updatedAt && (
          <span role="status" className="shrink-0 text-muted-foreground">
            Updated from the computer
          </span>
        )}
        {!editable && (
          <span className="shrink-0 text-muted-foreground">
            {file.truncated ? 'First 1 MB, read only' : 'Read only'}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Find in the file"
          title={`Find in the file (${MOD}F)`}
          onClick={() => editor.current?.search()}
        >
          <Search aria-hidden />
        </Button>
        {editable && status && onRevert && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            title={
              status === 'A'
                ? `Delete it: it is new ${comparedTo({ base }).since}`
                : `Put it back ${comparedTo({ base }).as}`
            }
            onClick={() => {
              setRevertError(undefined)
              void onRevert().then(setRevertError)
            }}
          >
            <Undo2 aria-hidden />
            Revert file
          </Button>
        )}
        {editable && (
          <Button
            type="button"
            size="xs"
            variant={edit.dirty ? 'default' : 'ghost'}
            disabled={!edit.dirty || edit.saving}
            title={`Save it on the computer (${MOD}S)`}
            onClick={() => void edit.save()}
          >
            {edit.saving ? 'Saving…' : edit.saved ? 'Saved' : 'Save'}
          </Button>
        )}
      </div>
      {gone && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive-text">
          This file is no longer on the computer, or is no longer a text file to edit.
        </p>
      )}
      {editable && edit.conflict && !gone && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-destructive/8 px-3 py-2 text-xs text-destructive-text"
        >
          <span className="min-w-0 flex-1">
            The file changed on the computer since you opened it, maybe by {teammateName}.
          </span>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => {
              if (!window.confirm('Drop your changes and open the file as it is now?')) return
              void takeTheirs()
            }}
          >
            Reload theirs
          </button>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => void edit.save(true)}
          >
            Keep mine
          </button>
        </div>
      )}
      {(edit.error || revertError) && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive-text">
          {edit.error ?? revertError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          key={file.hash ?? file.path}
          path={file.path}
          initial={edit.initial ?? file.text}
          line={line}
          onChange={edit.change}
          onSave={() => void edit.save()}
          controls={editor}
          readOnly={!editable}
          original={original}
        />
      </div>
    </div>
  )
}
