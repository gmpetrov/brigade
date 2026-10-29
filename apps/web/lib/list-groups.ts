// The sidebar's threads that work on a list's items (docs/lists.md), under that list: one row
// for the list where its first thread would be, folded like a thread's child threads.
import type { SidebarChild, ThreadSummary } from '@/lib/api'
import { groupOf } from '@/lib/sub-threads'

const PREFIX = 'list:'

/** A list's row stands in the sidebar's list of threads with an id no thread has. */
export const isListRow = (t: { id: string }) => t.id.startsWith(PREFIX)
export const listRowId = (documentId: string) => `${PREFIX}${documentId}`

/**
 * The threads with those of each list replaced by one row for the list, where its first
 * thread was. Its status is its threads' most pressing (waiting on a person, then working),
 * so a thread that needs someone is never hidden behind a quiet row; its threads are its
 * children.
 */
export function groupByList(threads: ThreadSummary[]): ThreadSummary[] {
  const lists = new Map<string, ThreadSummary[]>()
  const order: (ThreadSummary | string)[] = []
  for (const t of threads) {
    if (!t.list) {
      order.push(t)
      continue
    }
    const of = lists.get(t.list.documentId)
    if (of) of.push(t)
    else {
      lists.set(t.list.documentId, [t])
      order.push(t.list.documentId)
    }
  }
  return order.map((e) => (typeof e === 'string' ? listRow(lists.get(e)!) : e))
}

function listRow(threads: ThreadSummary[]): ThreadSummary {
  const first = threads[0]!
  const groups = threads.map((t) => groupOf(t.status))
  const status = groups.includes('waiting')
    ? 'waiting'
    : groups.includes('working')
      ? 'running'
      : threads.some((t) => t.status === 'failed')
        ? 'failed'
        : 'idle'
  const updatedAt = threads.map((t) => t.updatedAt).sort((a, b) => b.localeCompare(a))[0]!
  const children: SidebarChild[] = threads.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    updatedAt: t.updatedAt,
    unread: !!t.unread,
  }))
  return {
    ...first,
    id: listRowId(first.list!.documentId),
    title: first.list!.title,
    status,
    updatedAt,
    unread: threads.some((t) => t.unread),
    eventsWaitingSince: threads.find((t) => t.eventsWaitingSince)?.eventsWaitingSince ?? null,
    pinnedAt: null,
    laterAt: null,
    pullsWaiting: 0,
    childrenWorking: 0,
    previewRunning: false,
    children,
  }
}
