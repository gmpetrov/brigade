'use client'
// What a document shows while it opens: nothing at first, since most open in well under 300 ms
// (opened ahead or kept open, lib/live-documents.ts), and a placeholder that shows only to go
// away would just flash. Past that, the lines of a document where its text will be. Its text then
// fades in (documentFadeIn).
import type { EditTarget } from '@brigade/contracts'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

/** Opening for less than this shows nothing. */
const QUIET_MS = 300

/** When the document began to open: the steps it goes through each show the same placeholder. */
const OpeningSince = createContext<number | null>(null)

/** Around what opens `target`, from the moment it starts to. */
export function DocumentOpening({ target, children }: { target: EditTarget; children: ReactNode }) {
  const key = JSON.stringify(target)
  const [opening, setOpening] = useState(() => ({ key, since: Date.now() }))
  // Another document in its place: it begins to open now.
  if (opening.key !== key) setOpening({ key, since: Date.now() })
  return <OpeningSince.Provider value={opening.since}>{children}</OpeningSince.Provider>
}

/** The placeholder while the document opens. */
export function DocumentLoading() {
  const since = useContext(OpeningSince)
  // Past the quiet start already (a later step of the same opening): at once.
  const [shown, setShown] = useState(() => since !== null && Date.now() - since >= QUIET_MS)
  useEffect(() => {
    if (shown) return
    const waited = since === null ? 0 : Date.now() - since
    const timer = setTimeout(() => setShown(true), Math.max(0, QUIET_MS - waited))
    return () => clearTimeout(timer)
  }, [since, shown])
  return (
    <div role="status" aria-label="Opening the document" className="min-h-32">
      {shown && (
        // Where the editor puts its text (.document-editor .bn-editor): a title, then lines.
        <div
          aria-hidden
          className="flex animate-in flex-col gap-3 pt-1 pr-2 pl-12 duration-300 fade-in motion-reduce:animate-none"
        >
          <Skeleton className="mb-2 h-7 w-3/5" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="mt-3 h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </div>
  )
}

/** The document's text once it is in: it fades in, over what showed while it opened. */
export const documentFadeIn = 'animate-in duration-150 fade-in motion-reduce:animate-none'
