'use client'
import { useEffect, useState } from 'react'
import type { MergeMethod } from '@/lib/api'

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
