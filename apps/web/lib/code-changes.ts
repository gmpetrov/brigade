// The files of a teammate's working folder that differ from where their repository's
// branch left its default branch (or, from older runners and with no default branch, from
// its last commit), for the code panel's Changes and its editor's tabs: read again every
// few seconds while the panel shows, and at once after a save or a revert.
import type { CodeChange } from '@brigade/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'

export type CodeChanges = {
  changes: CodeChange[]
  /** Cut at CODE_CHANGES_MAX. */
  more: boolean
  /** The last commits of the folder's repositories (and their bases): another one, and files compare to it again. */
  head: string
  /** The default branch they compare to ("main"); unset: their last commits. */
  base?: string
}

/** What the changes compare to, in words: on this branch, against main; else since the last commit. */
export function comparedTo(data: Pick<CodeChanges, 'base'> | undefined) {
  const base = data?.base
  return base
    ? { since: 'on this branch', as: `as on ${base}`, to: base }
    : { since: 'since the last commit', as: 'as in the last commit', to: 'the last commit' }
}

/** How often the changes are read while the panel shows. */
const CHANGES_MS = 4000
/** How long it waits after the computer did not answer (offline, restarting). */
const OFFLINE_PAUSE_MS = 15_000

export function useCodeChanges(threadId: string, teammateId: string, shown: boolean) {
  const [data, setData] = useState<CodeChanges>()
  const [error, setError] = useState<string>()
  /** A runner too old to tell: no Changes. */
  const [unsupported, setUnsupported] = useState(false)
  const refresh = useRef<() => void>(() => undefined)

  // Another copy (the preview restarted from another teammate's): its own changes.
  useEffect(() => {
    setData(undefined)
    setError(undefined)
    setUnsupported(false)
  }, [threadId, teammateId])

  useEffect(() => {
    if (!shown || unsupported) return
    let stopped = false
    let pausedUntil = 0
    /** Counts reads: only the last one asked for is taken, so an older answer never wins. */
    let asked = 0
    let reading = false
    const check = async (now = false) => {
      if (!now && (reading || document.visibilityState !== 'visible' || Date.now() < pausedUntil))
        return
      const mine = ++asked
      reading = true
      try {
        const next = await api<CodeChanges>(
          `/threads/${threadId}/code/changes?${new URLSearchParams({ teammateId })}`,
        )
        if (stopped || mine !== asked) return
        setError(undefined)
        setData((was) => (was && JSON.stringify(was) === JSON.stringify(next) ? was : next))
      } catch (e) {
        if (stopped || mine !== asked) return
        if (e instanceof ApiError && e.status === 409 && /Update Brigade/.test(e.message))
          return setUnsupported(true)
        pausedUntil = Date.now() + OFFLINE_PAUSE_MS
        setError((e as Error).message)
      } finally {
        if (mine === asked) reading = false
      }
    }
    refresh.current = () => {
      pausedUntil = 0
      void check(true)
    }
    void check(true)
    const timer = setInterval(() => void check(), CHANGES_MS)
    const onFocus = () => {
      pausedUntil = 0
      void check()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      refresh.current = () => undefined
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [threadId, teammateId, shown, unsupported])

  return {
    data,
    error,
    unsupported,
    /** Read them again now: after a save or a revert. */
    refresh: useCallback(() => refresh.current(), []),
  }
}

/** Each changed file's status, by path. */
export const statusByPath = (data: CodeChanges | undefined) =>
  new Map((data?.changes ?? []).map((c) => [c.path, c.status]))

/**
 * How many files changed, for the thread's Outputs: read once, and again each time
 * `key` changes (a turn ended), not every few seconds as the open panel does.
 * Undefined until read, or when the computer did not answer; `unsupported` for a runner too old.
 */
export function useChangesCount(
  threadId: string | undefined,
  teammateId: string | undefined,
  key: unknown,
) {
  const [data, setData] = useState<CodeChanges>()
  const [error, setError] = useState<string>()
  const [unsupported, setUnsupported] = useState(false)
  useEffect(() => {
    if (!threadId || !teammateId || unsupported) return
    let live = true
    api<CodeChanges>(
      `/threads/${threadId}/code/changes?${new URLSearchParams({ teammateId })}`,
    ).then(
      (next) => {
        if (!live) return
        setError(undefined)
        setData(next)
      },
      (e: unknown) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 409 && /Update Brigade/.test(e.message))
          return setUnsupported(true)
        setError((e as Error).message)
      },
    )
    return () => {
      live = false
    }
  }, [threadId, teammateId, key, unsupported])
  return { data, error, unsupported }
}
