// What shows beside a thread: its preview, its changes or a file. Per thread, kept for the
// browser tab's session, so going to another thread and back (or a reload) finds it as it was
// left; the code beside a preview is kept apart (lib/code-tabs.ts).

export type ThreadSide =
  { kind: 'preview' } | { kind: 'changes' } | { kind: 'file'; path: string; teammateId?: string }

const storageKey = (threadId: string) => `brigade:thread-side:${threadId}`

export function readThreadSide(threadId: string): ThreadSide | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(threadId)) ?? 'null') as {
      kind?: unknown
      path?: unknown
      teammateId?: unknown
    } | null
    if (saved?.kind === 'preview' || saved?.kind === 'changes') return { kind: saved.kind }
    if (saved?.kind === 'file' && typeof saved.path === 'string')
      return {
        kind: 'file',
        path: saved.path,
        ...(typeof saved.teammateId === 'string' && { teammateId: saved.teammateId }),
      }
  } catch {
    // Nothing saved, or no storage: nothing beside it.
  }
  return undefined
}

export function rememberThreadSide(threadId: string, side: ThreadSide | undefined) {
  try {
    if (side) sessionStorage.setItem(storageKey(threadId), JSON.stringify(side))
    else sessionStorage.removeItem(storageKey(threadId))
  } catch {
    // Full or blocked: forgotten on leaving the thread.
  }
}
