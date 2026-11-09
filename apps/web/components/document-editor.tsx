'use client'
import type { EditTarget } from '@brigade/contracts'
import { useEffect, useState, type ComponentType } from 'react'
import type { PickedLines } from '@/components/list-items'
import { Skeleton } from '@/components/ui/skeleton'

export type DocumentEditorProps = {
  /** The document: a Markdown library file, or a memory file. */
  target: EditTarget
  /** What it is, for screen readers: "refunds.md", "Workspace memory". */
  label: string
  className?: string
  /** After a save, e.g. to refresh a list's sizes and times. */
  onSaved?: () => void
  /** Ask, first in the toolbar over selected text: talk about it with this teammate. */
  ask?: DocumentAsk
}

export type DocumentAsk = {
  teammate: string
  onAsk: (passage: string) => void | Promise<void>
  /** Checklist lines picked: hand them to a teammate (docs/lists.md). */
  onHandOff?: ((picked: PickedLines) => void) | null
}

type View = ComponentType<DocumentEditorProps>

/** The editor's code once it is in: from then on, documents show without waiting for it. */
let loaded: View | undefined
let loading: Promise<View> | undefined
const load = () =>
  (loading ??= import('./document-editor-view').then(
    (m) => (loaded = m.DocumentEditorView),
    (error: unknown) => {
      // Asked again next time (the network came back, say).
      loading = undefined
      throw error
    },
  ))

/** The editor's code, before a document shows (lib/prepare-document.ts). */
export const preloadEditor = () => void load().catch(() => {})

/**
 * A document edited as rich text, Notion-style, and together: everyone who
 * has it open sees each other's changes and cursors, and edits save on their
 * own. Brigade stores the result as Markdown, which teammates read.
 *
 * Not through next/dynamic: its Suspense made React hold the editor back for up to 300 ms
 * after the skeleton showed (its throttle on revealing suspended content), even with the
 * code in already. Here the editor shows in the same render once its code is in.
 */
export function DocumentEditor(props: DocumentEditorProps) {
  const [view, setView] = useState<{ View?: View; failed?: boolean }>(() => ({ View: loaded }))
  useEffect(() => {
    if (view.View || view.failed) return
    let live = true
    load().then(
      (View) => live && setView({ View }),
      () => live && setView({ failed: true }),
    )
    return () => {
      live = false
    }
  }, [view])
  if (view.failed)
    return (
      <p className="text-sm text-destructive-text">
        The editor could not load. Check your connection and reload the page.
      </p>
    )
  return view.View ? <view.View {...props} /> : <Skeleton className="h-32 w-full" />
}
