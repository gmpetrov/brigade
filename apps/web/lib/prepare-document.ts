'use client'
// Opening a document before it is asked for: a pointer resting on it, a search row picked, a
// panel tab under the pointer. What opens it (lib/live-documents.ts) and the editor's own code
// load only then, apart from the dashboard's: nothing is fetched for a document nobody is about
// to open.
import type { EditSession, EditTarget } from '@brigade/contracts'
import type { PointerEvent } from 'react'
import { preloadEditor } from '@/components/document-editor'
import { api } from '@/lib/api'

/** A pointer resting this long on something that opens a document prepares it. */
export const HOVER_MS = 100

/** What opens documents (lib/live-documents.ts), once its code is in. */
let opener: ((target: EditTarget) => void) | undefined
export const setOpener = (open: (target: EditTarget) => void) => {
  opener = open
}

/** Closes everything it opened (lib/live-documents.ts), once its code is in. */
let forget: (() => void) | undefined
export const setForget = (forgetAll: () => void) => {
  forget = forgetAll
}

/** Whose documents are open: a person in a workspace (DashboardShell). */
let scope: string | undefined

/**
 * The person signed in and the workspace they are in; undefined once they signed out. Another
 * than before, and nothing open or asked for is reused: it was opened as someone else, or in
 * another workspace. The first one known keeps what opened before it was (the same person).
 */
export function setDocumentScope(next: string | undefined) {
  if (next === scope) return
  const before = scope
  scope = next
  if (before === undefined) return
  asked.clear()
  forget?.()
}

/** Sessions asked for before that code was in, until it takes them. */
const asked = new Map<string, Promise<EditSession>>()

/** The session asked for `target` meanwhile, if any: taken once (lib/live-documents.ts). */
export function takeAskedSession(target: EditTarget) {
  const key = JSON.stringify(target)
  const session = asked.get(key)
  asked.delete(key)
  return session
}

/** Starts opening a document to edit, unless it is open already: showing it then costs no wait. */
export function prepareDocument(target: EditTarget) {
  // The editor's own code, meanwhile.
  preloadEditor()
  if (opener) return opener(target)
  // The code that opens documents is not in yet: its session is asked for meanwhile.
  const key = JSON.stringify(target)
  if (!asked.has(key)) {
    const session = api<EditSession>('/library/edit', { body: target })
    asked.set(key, session)
    // Not taken (that code failed to load, say): dropped, as it would go stale.
    setTimeout(() => asked.get(key) === session && asked.delete(key), 10_000)
  }
  void import('@/lib/live-documents').then(
    () => opener?.(target),
    () => {},
  )
}

/** One pointer: one rest at a time. */
let resting: ReturnType<typeof setTimeout> | undefined

/**
 * Props for something that opens `target` (null: it opens no document to edit): resting on it a
 * moment, focusing it or touching it prepares the document.
 */
export function openIntent(target: EditTarget | null) {
  if (!target) return {}
  const now = () => {
    clearTimeout(resting)
    prepareDocument(target)
  }
  return {
    // Held a moment: passing over a list on the way elsewhere opens nothing.
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      clearTimeout(resting)
      resting = setTimeout(now, HOVER_MS)
    },
    onPointerLeave: () => clearTimeout(resting),
    onFocus: now,
    // A finger on it: the tap follows.
    onTouchStart: now,
  }
}
