'use client'
// File paths in a thread's messages (`faq/support.md`, `src/app.ts:42`, a
// relative Markdown link) open in a panel beside the thread. Markdown asks
// this context; without one, paths stay plain text.
import { createContext, useContext, type ReactNode } from 'react'

export type OpenFile = (file: { path: string; teammateId?: string }) => void

type FileLinks = {
  open: OpenFile
  /** The teammate whose message this is: its working folder is tried first. */
  teammateId?: string
  /** Relative links resolve against this folder (a file's own, in the panel). */
  base?: string
}

const Context = createContext<FileLinks | null>(null)

/**
 * Gives Markdown below it file links. Nested, it adds to the one above (who
 * wrote the message, where links resolve); `null` turns them off, e.g. in code blocks.
 */
export function FileLinksProvider({
  value,
  children,
}: {
  value: Partial<FileLinks> | null
  children: ReactNode
}) {
  const parent = useContext(Context)
  const merged = value === null ? null : { ...parent, ...value }
  return (
    <Context.Provider value={merged?.open ? (merged as FileLinks) : null}>
      {children}
    </Context.Provider>
  )
}

export const useFileLinks = () => useContext(Context)

/**
 * Whether inline code names a file: a path with an extension that starts with
 * a letter (not `1.2.3`), no spaces, optionally `:line` or `:line:col`.
 */
const FILE =
  /^(?:~?\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?$/
const NOT_FILES = /^(?:[\w-]+\.)+(?:com|org|net|io|ai|dev|app|xyz|co|fr|de|uk)$/i

export const looksLikeFile = (text: string) =>
  text.length <= 300 && FILE.test(text) && !NOT_FILES.test(text)

/** A relative link target (no scheme, not an anchor), resolved against `base`. */
export function relativeFile(href: string | undefined, base?: string) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//'))
    return undefined
  const path = decodeURI(href.split('#')[0]!.split('?')[0]!)
  if (!path) return undefined
  if (path.startsWith('/') || !base) return path.replace(/^\.\//, '')
  const parts = [...base.split('/').filter(Boolean), ...path.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part) out.push(part)
  }
  return (base.startsWith('/') ? '/' : '') + out.join('/')
}
