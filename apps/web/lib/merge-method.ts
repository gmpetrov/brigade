'use client'
import { useEffect, useState } from 'react'
import type { MergeMethod, PullRequestTracking } from '@/lib/api'

const LAST_MERGE_METHOD = 'brigade.pulls.mergeMethod'
const mergeMethods: MergeMethod[] = ['squash', 'merge', 'rebase']

/** Why GitHub will not merge yet, in GitHub's mergeable_state terms. */
export const blockedBecause: Record<string, string> = {
  dirty: 'It conflicts with the base branch.',
  blocked: 'GitHub requires an approving review or passing checks first.',
  behind: 'The branch is behind the base branch.',
  draft: 'It is a draft.',
  unknown: 'GitHub is still checking whether it can merge.',
}

/** Whether the Merge button is worth pressing: GitHub has the last word. */
export const canMerge = (p: { mergeable: boolean | null; mergeableState: string }) =>
  p.mergeable !== false && !['dirty', 'draft'].includes(p.mergeableState)

/** It conflicts, and nobody is resolving it yet: Resolve conflicts takes the Merge button's place. */
export const hasConflicts = (p: { mergeableState: string; tracking: PullRequestTracking | null }) =>
  p.mergeableState === 'dirty' &&
  !['resolving', 'merging'].includes(p.tracking?.mergeStatus ?? 'none')

/** A teammate wrote it in a thread, so it can resolve the conflicts there; else they are resolved on GitHub. */
export const resolvesInBrigade = (p: { tracking: PullRequestTracking | null }) =>
  Boolean(p.tracking?.author && p.tracking.sessionId)

/** Where Brigade waits on the pull request's teammate or on GitHub before it merges. */
export const resolving = (p: { tracking: PullRequestTracking | null }) =>
  p.tracking?.mergeStatus === 'resolving' || p.tracking?.mergeStatus === 'merging'

/** Who is reviewing it, while a review is under way. */
export const reviewer = (p: { tracking: PullRequestTracking | null }) =>
  p.tracking?.review?.state === 'reviewing'
    ? (p.tracking.review.reviewer?.name ?? 'A teammate')
    : null

/** Merge, but not without a word while a review is under way: the person may want to wait for it. */
export function confirmMerge(
  p: { number: number; base?: string; tracking: PullRequestTracking | null } | undefined,
  number: number,
  method: string,
) {
  const by = p ? reviewer(p) : null
  return confirm(
    by
      ? `${by} is still reviewing #${number}. Merge it anyway (${method})?`
      : `Merge #${number}${p?.base ? ` into ${p.base}` : ''} (${method})?`,
  )
}

/** The merge method last picked, remembered per browser. Squash until one is picked. */
export function useLastMergeMethod() {
  const [method, setMethod] = useState<MergeMethod>('squash')
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_MERGE_METHOD) as MergeMethod | null
      if (saved && mergeMethods.includes(saved)) setMethod(saved)
    } catch {}
  }, [])
  return [
    method,
    (next: MergeMethod) => {
      setMethod(next)
      try {
        localStorage.setItem(LAST_MERGE_METHOD, next)
      } catch {}
    },
  ] as const
}
