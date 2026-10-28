'use client'
import dynamic from 'next/dynamic'
import type { EditTarget } from '@brigade/contracts'
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

export type DocumentAsk = { teammate: string; onAsk: (passage: string) => void | Promise<void> }

/**
 * A document edited as rich text, Notion-style, and together: everyone who
 * has it open sees each other's changes and cursors, and edits save on their
 * own. Brigade stores the result as Markdown, which teammates read.
 */
export const DocumentEditor = dynamic<DocumentEditorProps>(
  () => import('./document-editor-view').then((m) => m.DocumentEditorView),
  {
    ssr: false,
    loading: () => <Skeleton className="h-32 w-full" />,
  },
)
