// Where a thread sits: at the top, a child of a top-level thread, or the review of a pull
// request a child opened, a child of that child (src/reviews.ts), never deeper. What waits on a
// person there, and whether it is archived, put away for later or done, goes by the top-level
// thread it sits under.
import type { Prisma, ScopedDb } from './db.js'

/** What rootOf reads of a thread. */
export const ROOT = { id: true, parentId: true, parent: { select: { parentId: true } } } as const

/** The top-level thread a thread sits under, read with ROOT: itself, its parent, or its parent's. */
export const rootOf = (t: {
  id: string
  parentId: string | null
  parent?: { parentId: string | null } | null
}) => t.parent?.parentId ?? t.parentId ?? t.id

/** The same, by the thread's id; null when there is none. */
export async function rootIdOf(db: ScopedDb, id: string) {
  const thread = await db.session.findFirst({ where: { id }, select: ROOT })
  return thread ? rootOf(thread) : null
}

/** The threads under one, at every level: its children, and their reviews. */
export const below = (id: string) =>
  ({ OR: [{ parentId: id }, { parent: { parentId: id } }] }) satisfies Prisma.SessionWhereInput
