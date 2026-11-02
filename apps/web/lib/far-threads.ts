// Threads waiting on the member that are older than the latest the sidebar loads (choices from
// last week, a ticket in an old thread): asked for by id (GET /threads?id=…, repeated), so the
// list shows them with the others waiting and agrees with the count beside Today.
import { holds } from './sub-threads'

/** The most ids one request takes: the API reads no more (routes/threads.ts). */
export const IDS_PER_REQUEST = 100

/** A thread as the list has it: enough to tell whether it is still one to show. */
type Row = { id: string; archivedAt?: string | null; children?: Tree[] }
type Tree = { id: string; children?: Tree[] }

/** The ids, in requests of at most `size`. */
export function batches<T>(ids: readonly T[], size = IDS_PER_REQUEST): T[][] {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/** Every one of those threads, however many: a request per batch of ids. */
export async function fetchFar<T extends Row>(
  ids: readonly string[],
  get: (path: string) => Promise<T[]>,
): Promise<T[]> {
  const pages = await Promise.all(
    batches(ids).map((batch) =>
      get(`/threads?${batch.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`),
    ),
  )
  return pages.flat()
}

/**
 * The threads asked for apart to show: those that hold one still wanted (an answer from before
 * may bring one that waits no more), not loaded already, not archived.
 */
export function keepFar<T extends Row>(
  rows: readonly T[],
  wanted: readonly string[],
  loaded: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>()
  return rows.filter(
    (t) =>
      !loaded.has(t.id) &&
      !t.archivedAt &&
      !seen.has(t.id) &&
      wanted.some((id) => holds(t, id)) &&
      !!seen.add(t.id),
  )
}

/**
 * Hands on the answer of the latest work only: one started before it and answering after is
 * dropped, so an older list never replaces a newer one. A failure leaves what was there.
 */
export function latestOnly<T>(deliver: (value: T) => void) {
  let latest = 0
  return (work: Promise<T>) => {
    const mine = ++latest
    work.then(
      (value) => {
        if (mine === latest) deliver(value)
      },
      () => undefined,
    )
  }
}
