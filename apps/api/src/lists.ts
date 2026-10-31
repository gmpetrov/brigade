// Lists (docs/lists.md): a library Markdown file's checklist lines, handed to teammates. The
// file stays the list; a line work is attached to carries its marker (`<!-- item:<id> -->`),
// and `ListItem` keeps by that id what the file cannot: the threads on it, the pull requests
// that finish it, who ticked it from Brigade, the lines of what remains of it. Brigade changes
// the file only to mark, tick or add a line, each a save of its own credited to who did it.
import { memberMayWrite } from './account-sharing.js'
import { createHash } from 'node:crypto'
import {
  findLine,
  insertLine,
  ListItemId,
  listCounts,
  sameItemText,
  setMarker,
  newListItemId,
  parseList,
  plainItemText,
  setLineDone,
  type HandOffItems,
  type ItemState,
  type LinkItems,
  type ListDetail,
  type ListItemView,
  type ListLine,
  type ListOperations,
  type ListSummary,
  type ParsedList,
  type ThreadListItems,
  handOffMessage,
  projectFolder,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs } from './hub.js'
import { teammateLibraryAccess } from './library-folders.js'
import { actorNames } from './library-history.js'
import { committedBytes, documentText, saveLibraryFile, withLibraryLock } from './library.js'
import { pullWaitsOnPerson, REVIEW_THREAD } from './review-state.js'
import { computerFor } from './tasks.js'
import { noteInThread } from './thread-notes.js'
import { startThread } from './work.js'

type ListOperation = z.infer<(typeof ListOperations)[number]>

export const isListOperation = (op: { name: string }): op is ListOperation =>
  op.name === 'list_items' ||
  op.name === 'link_items' ||
  op.name === 'complete_item' ||
  op.name === 'add_item'

/** Files that may hold a list: Markdown in the library. */
const LIST_FILE = { kind: 'library', deletedAt: null, contentType: 'text/markdown' } as const

async function listFile(db: ScopedDb, where: { id: string } | { path: string }) {
  const row = await db.document.findFirst({ where: { ...where, ...LIST_FILE } })
  if (!row) throw new HTTPException(404, { message: 'No Markdown file of the library is there' })
  return row
}

type FileRow = Awaited<ReturnType<typeof listFile>>

/** A list's title: its first heading, else its file's name. */
const titleOf = (path: string, list: ParsedList) =>
  list.title ? plainItemText(list.title) : path.split('/').pop()!.replace(/\.md$/i, '')

/**
 * Change a list's file: `edit` gets its text as stored now and gives the new one (the same when
 * there is nothing to do), holding the file's lock, which every save of it takes: no save lands
 * between what it reads and what it writes. People's live edits are kept: the collab server
 * applies the change to the lines it touches only.
 */
async function editList(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  documentId: string,
  context: Record<string, string>,
  edit: (text: string, list: ParsedList) => string | Promise<string>,
  /** What `edit` wrote elsewhere, undone when the change fails: still under the file's lock. */
  undo?: () => Promise<unknown>,
) {
  return withLibraryLock(scope, documentId, async (lease) => {
    const row = await listFile(db, { id: documentId })
    const text = await storedText(scope, row)
    try {
      const next = await edit(text, parseList(text))
      if (next === text) return row
      return await saveLibraryFile(
        db,
        scope,
        actor,
        { path: row.path, bytes: new TextEncoder().encode(next), contentType: row.contentType },
        context,
        { lease },
      )
    } catch (error) {
      await undo?.()
      throw error
    }
  })
}

/**
 * A list's text as last saved: the bytes its row points to. A file at the legacy key, from before
 * objects per save, may hold bytes a save past its lease wrote over: then what its row says they
 * are (its full text, or its saved version), until they are saved again (repairBytes). Never bytes
 * the row does not vouch for: refused when nothing else is there.
 */
async function storedText(scope: Scope, row: FileRow) {
  if (row.bytesStaleAt) {
    const bytes = await committedBytes(scope, row)
    if (!bytes)
      throw new HTTPException(409, { message: 'The list is being repaired; try again shortly' })
    return new TextDecoder().decode(bytes)
  }
  const text = await documentText(scope, row)
  if (sha256(text) === row.sha256) return text
  const bytes = await committedBytes(scope, row)
  if (!bytes)
    throw new HTTPException(409, { message: 'The list is being saved; try again shortly' })
  return new TextDecoder().decode(bytes)
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// ---- Reading --------------------------------------------------------------------------------

const itemInclude = {
  threads: {
    include: {
      session: {
        select: {
          id: true,
          title: true,
          status: true,
          archivedAt: true,
          teammate: { select: { id: true, name: true } },
          _count: { select: { tickets: { where: { status: 'open' as const } } } },
          pullRequests: {
            select: { state: true, mergeStatus: true, reviewSession: { select: REVIEW_THREAD } },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  pulls: {
    include: { pullRequest: { select: { repository: true, number: true, state: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const

type ItemRow = Awaited<ReturnType<typeof itemRows>>[number]

const itemRows = (
  db: ScopedDb,
  where: { documentId: { in: string[] } } | { id: { in: string[] } },
) => db.listItem.findMany({ where, include: itemInclude })

/**
 * Where an item stands: ticked, else from its threads and pull requests. A thread needs you as
 * on Tasks and in the sidebar (columnOf): an open ticket, waiting, or stopped at a pull request
 * a person merges.
 */
function stateOf(done: boolean, row: ItemRow | undefined): ItemState {
  if (done) return 'done'
  const live = row?.threads.filter((t) => !t.session.archivedAt) ?? []
  if (
    live.some(
      ({ session: s }) =>
        s._count.tickets > 0 ||
        s.status === 'waiting' ||
        s.status === 'paused' ||
        (!['starting', 'running', 'failed'].includes(s.status) &&
          s.pullRequests.some(pullWaitsOnPerson)),
    )
  )
    return 'needs_you'
  if (
    live.some((t) => t.session.status === 'starting' || t.session.status === 'running') ||
    row?.pulls.some((p) => p.pullRequest.state === 'open')
  )
    return 'in_progress'
  return 'open'
}

/** The items' views: those in the file in its order, then those gone from it. */
async function views(
  db: ScopedDb,
  scope: Scope,
  rows: ItemRow[],
  lines: Map<string, ListLine>,
): Promise<ListItemView[]> {
  const threadIds = [...new Set(rows.flatMap((r) => r.threads.map((t) => t.session.id)))]
  const [waiting, who, remainders] = await Promise.all([
    threadIds.length
      ? hubs.get(scope.workspaceId).eventsWaitingSince(threadIds)
      : ({} as Record<string, unknown>),
    actorNames(
      db,
      rows.flatMap((r) =>
        r.doneByType && r.doneById ? [{ type: r.doneByType, id: r.doneById }] : [],
      ),
    ),
    rows.length
      ? db.listItem.findMany({
          where: { remainderOfId: { in: rows.map((r) => r.id) } },
          select: { id: true, remainderOfId: true },
        })
      : [],
  ])
  // Items with a line of what remains of them still open in their file: that line carries it.
  const remaining = new Set(
    remainders.flatMap((r) => (lines.get(r.id)?.done === false ? [r.remainderOfId!] : [])),
  )
  return rows.map((row) => {
    const line = lines.get(row.id)
    // Gone from the file: Brigade's tick is all that is known of it.
    const done = line ? line.done : !!row.doneAt
    const by = who(row.doneByType, row.doneById)
    const state = stateOf(done, row)
    return {
      id: row.id,
      text: line?.text ?? row.text,
      done,
      state,
      missing: !line,
      // Its threads stopped with it open, and nothing else carries it: someone should look.
      stalled:
        !!line &&
        state === 'open' &&
        row.threads.some((t) => !t.session.archivedAt) &&
        !remaining.has(row.id),
      section: line?.section ?? null,
      doneBy: done && by && row.doneAt ? { name: by.name, at: row.doneAt.toISOString() } : null,
      threads: row.threads.map((t) => ({
        id: t.session.id,
        title: t.session.title,
        status: t.session.status,
        stuck: !!(waiting as Record<string, unknown>)[t.session.id],
        teammate: t.session.teammate,
      })),
      pulls: row.pulls.map((p) => ({
        repository: p.pullRequest.repository,
        number: p.pullRequest.number,
        state: p.pullRequest.state,
        closes: p.closes,
        remains: p.remains,
        url: `https://github.com/${p.pullRequest.repository}/pull/${p.pullRequest.number}`,
      })),
    }
  })
}

const byLine = (list: ParsedList) =>
  new Map(list.lines.flatMap((l) => (l.id ? [[l.id, l] as const] : [])))

/** In the file's order, then those gone from it. */
const ordered = (rows: ItemRow[], lines: Map<string, ListLine>) =>
  [...rows].sort(
    (a, b) =>
      (lines.get(a.id)?.line ?? Number.MAX_SAFE_INTEGER) -
        (lines.get(b.id)?.line ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )

function counts(list: ParsedList, items: ListItemView[]) {
  const open = items.filter((i) => !i.missing)
  return {
    ...listCounts(list),
    needsYou: open.filter((i) => i.state === 'needs_you').length,
    inProgress: open.filter((i) => i.state === 'in_progress').length,
  }
}

/** Every list of the library: its Markdown files with a checklist, last changed first. */
export async function listSummaries(db: ScopedDb, scope: Scope): Promise<ListSummary[]> {
  const files = await db.document.findMany({
    where: { ...LIST_FILE, OR: [{ text: { contains: '[ ]' } }, { text: { contains: '[x]' } }] },
    select: { id: true, path: true, text: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
  const parsed = files
    .map((file) => ({ file, list: parseList(file.text) }))
    .filter((f) => f.list.lines.length > 0)
  const rows = parsed.length
    ? await itemRows(db, { documentId: { in: parsed.map((f) => f.file.id) } })
    : []
  const all = await views(db, scope, rows, new Map(parsed.flatMap((f) => [...byLine(f.list)])))
  const projectOfPath = await projectFinder(db)
  return parsed.map(({ file, list }) => {
    const lines = byLine(list)
    const items = all.filter((i) => rows.find((r) => r.id === i.id)?.documentId === file.id)
    const inOrder = items
      .filter((i) => !i.missing)
      .sort((a, b) => lines.get(a.id)!.line - lines.get(b.id)!.line)
    return {
      documentId: file.id,
      path: file.path,
      title: titleOf(file.path, list),
      projectId: projectOfPath(file.path),
      ...counts(list, items),
      updatedAt: file.updatedAt.toISOString(),
      next: [
        ...inOrder.filter((i) => i.state === 'needs_you'),
        ...inOrder.filter((i) => i.state === 'in_progress'),
      ]
        .slice(0, 3)
        .map((i) => ({ id: i.id, text: plainItemText(i.text), state: i.state })),
    }
  })
}

/** One list, with the items work is attached to. */
export async function listDetail(
  db: ScopedDb,
  scope: Scope,
  documentId: string,
): Promise<ListDetail> {
  const file = await listFile(db, { id: documentId })
  const list = parseList(file.text)
  const lines = byLine(list)
  const rows = ordered(await itemRows(db, { documentId: { in: [file.id] } }), lines)
  const items = await views(db, scope, rows, lines)
  return {
    documentId: file.id,
    path: file.path,
    title: titleOf(file.path, list),
    ...counts(list, items),
    updatedAt: file.updatedAt.toISOString(),
    items,
  }
}

/** The items a thread works on, for the card at its top. */
export async function threadItems(
  db: ScopedDb,
  scope: Scope,
  sessionId: string,
): Promise<ThreadListItems> {
  const links = await db.listItemThread.findMany({
    where: { sessionId },
    select: { itemId: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!links.length) return []
  const rows = await itemRows(db, { id: { in: links.map((l) => l.itemId) } })
  const files = await db.document.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.documentId))] }, ...LIST_FILE },
    select: { id: true, path: true, text: true },
  })
  const parsed = new Map(files.map((f) => [f.id, { file: f, list: parseList(f.text) }]))
  const lines = new Map([...parsed.values()].flatMap((p) => [...byLine(p.list)]))
  const order = new Map(links.map((l, i) => [l.itemId, i]))
  const all = await views(db, scope, rows, lines)
  return all
    .flatMap((view) => {
      const row = rows.find((r) => r.id === view.id)!
      const p = parsed.get(row.documentId)
      if (!p) return [] // its file is gone
      return [
        {
          ...view,
          documentId: p.file.id,
          path: p.file.path,
          listTitle: titleOf(p.file.path, p.list),
        },
      ]
    })
    .sort((a, b) => {
      // A list's items in its order; lists as the thread got them.
      if (a.documentId !== b.documentId) return order.get(a.id)! - order.get(b.id)!
      return (lines.get(a.id)?.line ?? 1e9) - (lines.get(b.id)?.line ?? 1e9)
    })
}

/**
 * The list each thread works on, for the sidebar, which shows the threads of a list under it:
 * the list of its first item, when it has any (a thread may carry items of several lists).
 */
export async function threadLists(db: ScopedDb, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, { documentId: string; title: string }>()
  const links = await db.listItemThread.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, item: { select: { documentId: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const first = new Map<string, string>()
  for (const l of links) if (!first.has(l.sessionId)) first.set(l.sessionId, l.item.documentId)
  const files = first.size
    ? await db.document.findMany({
        where: { id: { in: [...new Set(first.values())] }, ...LIST_FILE },
        select: { id: true, path: true, text: true },
      })
    : []
  // Its title is its first heading, near its top.
  const titles = new Map(
    files.map((f) => [f.id, titleOf(f.path, parseList(f.text.slice(0, 8_000)))]),
  )
  const out = new Map<string, { documentId: string; title: string }>()
  for (const [sessionId, documentId] of first) {
    const title = titles.get(documentId)
    if (title) out.set(sessionId, { documentId, title })
  }
  return out
}

/** The lists this member pinned in their sidebar, with their titles; those since deleted left out. */
export async function pinnedLists(db: ScopedDb, memberId: string) {
  const pins = await db.listPin.findMany({
    where: { memberId, document: LIST_FILE },
    select: {
      documentId: true,
      pinnedAt: true,
      position: true,
      document: { select: { path: true, text: true } },
    },
  })
  return pins.map((p) => ({
    documentId: p.documentId,
    title: titleOf(p.document.path, parseList(p.document.text.slice(0, 8_000))),
    pinnedAt: p.pinnedAt.toISOString(),
    position: p.position,
  }))
}

/** The threads working on the lists this member pinned: the sidebar shows them under each. */
export async function pinnedListThreads(db: ScopedDb, memberId: string) {
  // The threads themselves, not their item links: one thread on many items takes one place.
  const threads = await db.session.findMany({
    where: {
      archivedAt: null,
      parentId: null,
      listItems: {
        some: { item: { document: { ...LIST_FILE, listPins: { some: { memberId } } } } },
      },
    },
    select: { id: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  })
  return threads.map((t) => t.id)
}

/** Where a new pin goes under Pinned: after this member's pinned threads and lists alike. */
export async function nextPinPosition(db: ScopedDb, memberId: string) {
  const [threads, lists] = await Promise.all([
    db.threadPin.aggregate({ where: { memberId }, _max: { position: true } }),
    db.listPin.aggregate({ where: { memberId }, _max: { position: true } }),
  ])
  return Math.max(threads._max.position ?? -1, lists._max.position ?? -1) + 1
}

/** Pin it under this member's Pinned, at the end. */
export async function pinList(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  documentId: string,
) {
  const file = await listFile(db, { id: documentId })
  const position = await nextPinPosition(db, scope.memberId)
  await db.listPin.upsert({
    where: { memberId_documentId: { memberId: scope.memberId, documentId: file.id } },
    create: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      memberId: scope.memberId,
      documentId: file.id,
      position,
    },
    update: {},
  })
}

/** What a thread's teammate is told it works on (ThreadSpec.items). */
export async function specItems(db: ScopedDb, sessionId: string) {
  const links = await db.listItemThread.findMany({
    where: { sessionId },
    include: {
      item: { include: { document: { select: { path: true, text: true, deletedAt: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return links
    .filter((l) => !l.item.document.deletedAt)
    .map(({ item }) => {
      const line = parseList(item.document.text).lines.find((l) => l.id === item.id)
      return {
        id: item.id,
        path: item.document.path,
        text: plainItemText(line?.text ?? item.text),
        done: line ? line.done : !!item.doneAt,
      }
    })
}

// ---- Attaching work -------------------------------------------------------------------------

type Picked = { id: string; text: string }

/**
 * The picked lines as items of this file: each gets its row, and its marker in the file unless
 * it has one (the editor that picked it adds it too, and its save may be on its way). A line that
 * already has an item keeps it. An id the editor gave that anything else has (another list's
 * line, another workspace's, a line above it copied with its marker) is never taken over: the
 * line gets an id of its own. Returns each picked line's item id, in the order picked.
 */
async function itemsFor(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  file: FileRow,
  picked: Picked[],
  context: Record<string, string> = {},
) {
  // Across workspaces: ids are the rows' keys, and a file or an editor can hold any marker (a
  // line pasted from elsewhere with its own). Those of the picked lines, and the file's.
  const stored = parseList(file.text).lines.flatMap((l) => (l.marker ? [l.marker] : []))
  const elsewhere = new Set(
    (
      await prisma.listItem.findMany({
        where: {
          id: { in: [...new Set([...picked.map((p) => p.id), ...stored])] },
          documentId: { not: file.id },
        },
        select: { id: true },
      })
    ).map((r) => r.id),
  )
  const ids = picked.map((p) => (elsewhere.has(p.id) ? newListItemId() : p.id))
  await editList(db, scope, actor, file.id, context, (text, list) => {
    let next = text
    picked.forEach((p, i) => {
      // The line the editor marked, when its marker is stored already; else the line by its text.
      const marked = list.lines.find((l) => l.id === ids[i] && sameItemText(l.text, p.text))
      const line = marked ?? findLine(list, p.text)
      // Not in the stored file yet (typed just now): the editor's save brings its marker.
      if (typeof line === 'string') return
      // Its own item already; a marker another list's item has is not, and is replaced.
      if (line.id && !elsewhere.has(line.id)) {
        ids[i] = line.id
        return
      }
      // Its own id, unless another line of the file has that one.
      if (list.lines.some((l) => l.id === ids[i])) ids[i] = newListItemId()
      next = setMarker(next, line, ids[i]!)
    })
    return next
  }).catch((error) => {
    // The rows still hold the work; a marker the file lacks shows as a line gone from it.
    console.warn(`lists: lines of ${file.id} not marked: ${String(error)}`)
  })
  const texts = new Map(ids.map((id, i) => [id, picked[i]!.text]))
  await db.listItem.createMany({
    data: [...texts].map(([id, text]) => ({
      id,
      documentId: file.id,
      text: plainItemText(text).slice(0, 2_000),
    })) as never,
    skipDuplicates: true,
  })
  // Made by another list meanwhile (skipped above): never this list's.
  const mine = await db.listItem.count({
    where: { id: { in: [...texts.keys()] }, documentId: file.id },
  })
  if (mine !== texts.size)
    throw new HTTPException(409, { message: 'Those lines changed meanwhile; try again' })
  return ids
}

/** The lines as a bulleted list, for a thread's first message or a note. */
const bullets = (texts: string[]) => texts.map((t) => `- ${plainItemText(t)}`).join('\n')

/** Which project's folder holds a file: its threads work in it, and Lists groups it there. */
async function projectFinder(db: ScopedDb) {
  const projects = await db.project.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, folder: true },
  })
  return (path: string) =>
    projects.find((p) => path.startsWith(`${p.folder ?? projectFolder(p.name)}/`))?.id ?? null
}

const projectOf = async (db: ScopedDb, path: string) => (await projectFinder(db))(path)

/** Hand lines to a teammate: one thread for them all, or one each. */
export async function handOff(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  documentId: string,
  input: HandOffItems & { projectId?: string | null },
) {
  const file = await listFile(db, { id: documentId })
  const teammate = await db.teammate.findFirst({ where: { id: input.teammateId } })
  if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
  const actor: Actor = { type: 'member', id: memberId }
  // Where it runs first: with no computer to run on, nothing is changed.
  const [computer, projectId] = await Promise.all([
    computerFor(db, memberId, teammate.harness),
    input.projectId ?? projectOf(db, file.path),
  ])
  const picked = await itemsFor(db, scope, actor, file, input.items)
  const texts = new Map(input.items.map((p, i) => [picked[i]!, p.text]))
  const ids = [...texts.keys()]
  const message = (group: string[]) =>
    handOffMessage(
      file,
      group.map((id) => texts.get(id)!),
      input.note,
    )
  const groups = input.mode === 'each' ? ids.map((id) => [id]) : [ids]
  const threads: string[] = []
  for (const group of groups) {
    const first = plainItemText(texts.get(group[0]!)!)
    const { thread } = await startThread(db, scope, {
      teammate,
      computer,
      memberId,
      title: first.slice(0, 120),
      text: message(group),
      listItemIds: group,
      ...(projectId ? { projectId } : {}),
    })
    threads.push(thread.id)
  }
  await audit({
    ...scope,
    actor,
    action: 'list.handed_off',
    target: { type: 'document', id: file.id },
    data: { teammateId: teammate.id, items: ids, threads },
  })
  return { threadIds: threads }
}

/**
 * Attach lines to a thread that runs already. Its teammate is told by a note at its next turn,
 * unless `quiet`: the person sends the hand-off as a message right after, which starts it.
 */
export async function linkToThread(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  documentId: string,
  input: LinkItems,
) {
  const file = await listFile(db, { id: documentId })
  const session = await db.session.findFirst({ where: { id: input.sessionId } })
  if (!session) throw new HTTPException(404, { message: 'Thread not found' })
  // Its teammate reads the lines at its next turn, on its starter's accounts: as a message would.
  if (!(await memberMayWrite(session, memberId)))
    throw new HTTPException(403, { message: 'Only who may write in this thread can do that' })
  const ids = [
    ...new Set(await itemsFor(db, scope, { type: 'member', id: memberId }, file, input.items)),
  ]
  await db.listItemThread.createMany({
    data: ids.map((itemId) => ({ itemId, sessionId: session.id })) as never,
    skipDuplicates: true,
  })
  if (!input.quiet)
    await noteInThread(
      db,
      session.id,
      `Items of ${file.path} were added to this thread:\n${bullets(input.items.map((p) => p.text))}` +
        (input.note ? `\n\nWith this note from the person who added them:\n${input.note}` : ''),
    )
  return { sessionId: session.id, itemIds: ids }
}

/** Tick or untick an item in its file, credited to who did it. */
export async function setItemDone(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  itemId: string,
  done: boolean,
  options: {
    note?: string
    sessionId?: string
    /**
     * Ticks it only if this holds of the list as it is under the file's lock, read again there:
     * else nothing changes, and it comes back not done.
     */
    when?: (list: ParsedList) => boolean | Promise<boolean>
  } = {},
) {
  const item = await db.listItem.findFirst({ where: { id: itemId } })
  if (!item) throw new HTTPException(404, { message: 'Item not found' })
  let text = item.text
  let changed = false
  let refused = false
  await editList(
    db,
    scope,
    actor,
    item.documentId,
    options.sessionId ? { sessionId: options.sessionId } : {},
    async (current, list) => {
      const line = list.lines.find((l) => l.id === itemId)
      if (!line)
        throw new HTTPException(404, {
          message: 'This item is no longer in its list: its line or its marker was removed',
        })
      text = line.text
      if (line.done === done) return current
      if (done && options.when && !(await options.when(list))) {
        refused = true
        return current
      }
      changed = true
      return setLineDone(current, line, done, done ? options.note : undefined)
    },
  )
  if (refused) return { id: itemId, done: false, text: plainItemText(text), changed }
  await db.listItem.updateMany({
    where: { id: itemId },
    data: done
      ? {
          doneByType: actor.type,
          doneById: actor.id,
          doneAt: new Date(),
          text: plainItemText(text),
        }
      : { doneByType: null, doneById: null, doneAt: null },
  })
  // What remained of another item: that one may be done now. Its failure is not this tick's:
  // the sweep tries it again.
  if (done && item.remainderOfId)
    await settleRemainders(db, scope, item.remainderOfId).catch((error) =>
      console.warn(`lists: item ${item.remainderOfId} not settled: ${String(error)}`),
    )
  return { id: itemId, done, text: plainItemText(text), changed }
}

// ---- What remains ---------------------------------------------------------------------------

/** Brigade itself ticks an item once all its remaining lines are. */
const BRIGADE: Actor = { type: 'system', id: 'lists' }

/**
 * Under an item a merged pull request was only part of, what remains of it, as a line of its
 * own nested under it, attached to the pull request's thread. Its id is kept on the link first,
 * so that a retry adds the line once. Nothing when the item is ticked already. Returns the line.
 */
async function addRemainder(
  db: ScopedDb,
  scope: Scope,
  authorId: string,
  pull: { id: string; number: number; sessionId: string | null },
  link: {
    itemId: string
    remains: string | null
    remainderId: string | null
    item: { documentId: string }
  },
) {
  if (!link.remains) return null
  if (!link.remainderId) {
    await db.listItemPull.updateMany({
      where: { itemId: link.itemId, pullRequestId: pull.id, remainderId: null },
      data: { remainderId: newListItemId() },
    })
  }
  const id = (
    await db.listItemPull.findFirst({
      where: { itemId: link.itemId, pullRequestId: pull.id },
      select: { remainderId: true },
    })
  )?.remainderId
  if (!id) return null
  const row = () =>
    db.listItem.createMany({
      data: [
        {
          id,
          documentId: link.item.documentId,
          text: plainItemText(link.remains!).slice(0, 2_000),
          remainderOfId: link.itemId,
        },
      ] as never,
      skipDuplicates: true,
    })
  // In the file now: added by this try, or by an earlier one.
  let present = false
  let added = false
  await editList(
    db,
    scope,
    { type: 'teammate', id: authorId },
    link.item.documentId,
    pull.sessionId ? { sessionId: pull.sessionId } : {},
    async (text, list) => {
      present = list.lines.some((l) => l.marker === id)
      if (present) {
        await row()
        return text
      }
      const item = list.lines.find((l) => l.id === link.itemId)
      if (!item)
        throw new HTTPException(404, {
          message: 'This item is no longer in its list: its line or its marker was removed',
        })
      // Ticked already: nothing remains of it.
      if (item.done) return text
      // Its row with its line, under the file's lock, as every remaining line's (settleRemainders).
      await row()
      present = added = true
      return insertLine(text, list, { after: item, nested: true }, link.remains!, id)
    },
    // Not written: no row without its line, gone before anyone else may read the file.
    async () => {
      if (added) await db.listItem.deleteMany({ where: { id } })
    },
  )
  if (!present) return null
  if (pull.sessionId)
    await db.listItemThread.createMany({
      data: [{ itemId: id, sessionId: pull.sessionId }] as never,
      skipDuplicates: true,
    })
  return added ? link.remains : null
}

/**
 * An item's remaining lines, looked at: once all are ticked the item is ticked too, by Brigade,
 * unless work on it is still on its way (a pull request open, or one merged whose remaining line
 * is not added yet), checked again under the file's lock. Its remaining lines are settled, no
 * longer looked at, once the item is done (or gone), or for good when one of them was removed
 * from the file: a line gone never counts as done, and the item then waits for a person. Until
 * then they are looked at again, so that a pull request closed later lets the item be ticked.
 */
export async function settleRemainders(db: ScopedDb, scope: Scope, itemId: string) {
  const all = () =>
    db.listItem.updateMany({
      where: { remainderOfId: itemId, remainderSettledAt: null },
      data: { remainderSettledAt: new Date() },
    })
  const item = await db.listItem.findFirst({
    where: { id: itemId },
    select: { documentId: true },
  })
  if (!item) return void (await all())
  // Read under the file's lock, where every remaining line is made with its row (add_item,
  // addRemainder): never a row whose line is on its way, nor a line added past this read.
  const ready = await withLibraryLock(scope, item.documentId, async () => {
    const remainders = await db.listItem.findMany({
      where: { remainderOfId: itemId },
      select: { id: true },
    })
    if (!remainders.length) return false
    const file = await db.document.findFirst({ where: { id: item.documentId, ...LIST_FILE } })
    const lines = file ? byLine(parseList(await storedText(scope, file))) : null
    const line = lines?.get(itemId)
    // Its own line gone, ticked already, or one of its remaining lines removed: for good.
    if (!lines || !line || line.done || remainders.some((r) => !lines.get(r.id))) {
      await all()
      return false
    }
    return remainders.every((r) => lines.get(r.id)!.done)
  })
  if (!ready) return
  const coming = await db.listItemPull.count({
    where: {
      itemId,
      OR: [
        { pullRequest: { state: 'open' } },
        { remains: { not: null }, settledAt: null, pullRequest: { state: 'merged' } },
      ],
    },
  })
  if (coming) return
  const ticked = await setItemDone(db, scope, BRIGADE, itemId, true, {
    note: `what remained is done, ${shortDate(new Date())}`,
    // Its remaining lines read again under the lock: one unticked or added meanwhile keeps it
    // open.
    when: async (list) => {
      const ids = new Set(
        (
          await db.listItem.findMany({ where: { remainderOfId: itemId }, select: { id: true } })
        ).map((r) => r.id),
      )
      const mine = list.lines.filter((l) => l.id && ids.has(l.id))
      return mine.length === ids.size && mine.every((l) => l.done)
    },
  })
  if (ticked.done) await all()
}

/**
 * After a save of a list's file: items whose remaining lines a person may have just ticked
 * there. Never fails the save it follows.
 */
export async function settleRemaindersIn(db: ScopedDb, scope: Scope, documentId: string) {
  try {
    const pending = await db.listItem.findMany({
      where: { documentId, remainderOfId: { not: null }, remainderSettledAt: null },
      select: { remainderOfId: true },
      distinct: ['remainderOfId'],
    })
    for (const p of pending) await settleRemainders(db, scope, p.remainderOfId!)
  } catch (error) {
    console.warn(`lists: remaining lines of ${documentId} not settled: ${String(error)}`)
  }
}

/** Items with remaining lines not yet settled, every workspace's, a page at a time (jobs.ts). */
async function sweepRemainders() {
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.listItem.groupBy({
      by: ['remainderOfId', 'organizationId', 'workspaceId'],
      where: {
        remainderOfId: cursor ? { gt: cursor } : { not: null },
        remainderSettledAt: null,
      },
      orderBy: { remainderOfId: 'asc' },
      take: 200,
    })
    for (const p of page) {
      const scope = { organizationId: p.organizationId, workspaceId: p.workspaceId }
      await settleRemainders(scoped(scope), scope, p.remainderOfId!).catch((error) =>
        console.warn(`lists: remaining lines of ${p.remainderOfId} not settled: ${String(error)}`),
      )
    }
    if (page.length < 200) return
    cursor = page.at(-1)!.remainderOfId!
  }
}

// ---- Pull requests --------------------------------------------------------------------------

/** What a pull request says of list items (github_create_pull_request's `items`). */
export type PullItems = {
  closes?: string[]
  /** Those it is only part of, each with what remains of it once it is merged. */
  partOf?: { item: string; remains: string }[]
}

/**
 * The items a pull request finishes (`closes`) or works on (`partOf`, with what remains of
 * each), by id; also its thread's. Only lists its author may read; and it closes only items of
 * lists it may change, as ticking one itself would need: elsewhere, a pull request is only part
 * of the work.
 */
export async function linkPullItems(
  db: ScopedDb,
  pullRequestId: string,
  sessionId: string,
  teammateId: string,
  items: PullItems,
) {
  const closes = new Set((items.closes ?? []).filter((id) => ListItemId.safeParse(id).success))
  const remains = new Map(
    (items.partOf ?? []).flatMap((p) =>
      ListItemId.safeParse(p.item).success && !closes.has(p.item) && p.remains?.trim()
        ? [[p.item, p.remains.trim().slice(0, 500)] as const]
        : [],
    ),
  )
  const wanted = [...closes, ...remains.keys()]
  if (!wanted.length) return
  const teammate = await db.teammate.findFirst({ where: { id: teammateId } })
  if (!teammate) return
  const access = await teammateLibraryAccess(db, teammate)
  const rows = await db.listItem.findMany({
    where: { id: { in: wanted }, document: { deletedAt: null } },
    select: { id: true, document: { select: { path: true } } },
  })
  const level = new Map(rows.map((r) => [r.id, access.of(r.document.path)]))
  const ids = wanted.filter((id) => (level.get(id) ?? 'none') !== 'none')
  if (!ids.length) return
  await db.listItemPull.createMany({
    data: ids.map((itemId) => {
      const closing = closes.has(itemId) && level.get(itemId) === 'read_write'
      return {
        itemId,
        pullRequestId,
        closes: closing,
        remains: closing ? null : (remains.get(itemId) ?? null),
      }
    }) as never,
    skipDuplicates: true,
  })
  await db.listItemThread.createMany({
    data: ids.map((itemId) => ({ itemId, sessionId })) as never,
    skipDuplicates: true,
  })
}

const shortDate = (at: Date) =>
  at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * A pull request was merged: the items it closes are ticked, with its number, credited to the
 * teammate that opened it, where it may still change their list; under those it is only part
 * of, what remains of each is added as a line of its own (addRemainder). Its thread is told.
 * Each item is settled once done (or for good: gone from its list, or out of its author's
 * reach); one that failed otherwise (storage, the database) is tried again by sweepListMerges.
 */
export async function settleItemsOnMerge(
  db: ScopedDb,
  scope: Scope,
  pull: { id: string; number: number; sessionId: string | null },
) {
  try {
    const links = await db.listItemPull.findMany({
      where: {
        pullRequestId: pull.id,
        OR: [{ closes: true }, { remains: { not: null } }],
        settledAt: null,
      },
      select: {
        itemId: true,
        closes: true,
        remains: true,
        remainderId: true,
        item: { select: { documentId: true, document: { select: { path: true } } } },
      },
    })
    if (!links.length) return
    const row = await db.pullRequest.findFirst({
      where: { id: pull.id },
      select: { authorTeammateId: true, mergedAt: true },
    })
    const author = row?.authorTeammateId
      ? await db.teammate.findFirst({ where: { id: row.authorTeammateId } })
      : null
    const access = author ? await teammateLibraryAccess(db, author) : null
    const ticked: string[] = []
    const remaining: string[] = []
    for (const link of links) {
      const settle = () =>
        db.listItemPull.updateMany({
          where: { itemId: link.itemId, pullRequestId: pull.id },
          data: { settledAt: new Date() },
        })
      if (!author || access?.of(link.item.document.path) !== 'read_write') {
        await settle()
        continue
      }
      try {
        if (!link.closes) {
          const added = await addRemainder(db, scope, author.id, pull, link)
          await settle()
          if (added) remaining.push(added)
          continue
        }
        const done = await setItemDone(
          db,
          scope,
          { type: 'teammate', id: author.id },
          link.itemId,
          true,
          {
            note: `PR #${pull.number}, ${shortDate(row?.mergedAt ?? new Date())}`,
            ...(pull.sessionId ? { sessionId: pull.sessionId } : {}),
          },
        )
        await settle()
        if (done.changed) ticked.push(done.text)
      } catch (error) {
        // Gone from its list: nothing to tick, for good. Else the sweep tries again.
        if (error instanceof HTTPException && error.status === 404) await settle()
        else console.warn(`lists: item ${link.itemId} not ticked on merge: ${String(error)}`)
      }
    }
    if (ticked.length && pull.sessionId)
      await noteInThread(
        db,
        pull.sessionId,
        `Ticked in its list, as #${pull.number} closes it:\n${bullets(ticked)}`,
      )
    if (remaining.length && pull.sessionId)
      await noteInThread(
        db,
        pull.sessionId,
        `Added to its list, under the items #${pull.number} is only part of, what remains of them; ` +
          `each item is ticked once its remaining lines are:\n${bullets(remaining)}`,
      )
  } catch (error) {
    console.warn(`lists: items of pull request ${pull.id} not settled: ${String(error)}`)
  }
}

/**
 * Merged pull requests whose items are not all settled: tried again; and items whose remaining
 * lines a person may have ticked in the file (jobs.ts).
 */
export async function sweepListMerges() {
  await sweepRemainders().catch((error) =>
    console.warn(`lists: remaining lines not swept: ${String(error)}`),
  )
  const pending = await prisma.listItemPull.findMany({
    where: {
      OR: [{ closes: true }, { remains: { not: null } }],
      settledAt: null,
      pullRequest: { state: 'merged' },
    },
    select: {
      organizationId: true,
      workspaceId: true,
      pullRequest: { select: { id: true, number: true, sessionId: true } },
    },
    distinct: ['pullRequestId'],
    take: 200,
  })
  for (const p of pending) {
    const scope = { organizationId: p.organizationId, workspaceId: p.workspaceId }
    await settleItemsOnMerge(scoped(scope), scope, p.pullRequest)
  }
}

// ---- A teammate's tools ---------------------------------------------------------------------

type Teammate = {
  id: string
  name: string
  libraryAccess: Parameters<typeof teammateLibraryAccess>[1]['libraryAccess']
}

/** A line as a teammate reads it. */
const lineOut = (
  l: ListLine,
  views: Map<string, ListItemView>,
  remainsOf: Map<string, string | null>,
) => {
  const view = l.id ? views.get(l.id) : undefined
  const of = l.id ? remainsOf.get(l.id) : undefined
  return {
    id: l.id,
    done: l.done,
    text: l.text,
    ...(l.section ? { section: l.section } : {}),
    ...(of ? { remainsOf: of } : {}),
    ...(view?.threads.length ? { threads: view.threads.map((t) => t.title) } : {}),
    ...(view?.pulls.length ? { pulls: view.pulls.map((p) => `#${p.number} ${p.state}`) } : {}),
  }
}

/**
 * list_items, link_items, complete_item and add_item: a teammate reads a list, attaches lines
 * to its thread, ticks one, or adds one. Within the library access its folders give it.
 */
export async function handleListCall(
  db: ScopedDb,
  scope: Scope,
  session: { id: string },
  teammate: Teammate,
  op: ListOperation,
): Promise<object | { error: string }> {
  const access = await teammateLibraryAccess(db, teammate)
  const actor: Actor = { type: 'teammate', id: teammate.id }
  const context = { sessionId: session.id }
  const fileAt = async (path: string, write: boolean) => {
    const level = access.of(path)
    if (level === 'none' || (write && level !== 'read_write'))
      throw new HTTPException(403, {
        message: write ? `You may not change ${path}` : `You may not read ${path}`,
      })
    return listFile(db, { path })
  }
  try {
    if (op.name === 'list_items') {
      if (!op.path) {
        const items = (await specItems(db, session.id)).filter((i) => access.of(i.path) !== 'none')
        return {
          items,
          hint: items.length
            ? 'The items this thread works on. Give a path to read a whole list.'
            : 'This thread works on no list item yet. Give a path to read a list.',
        }
      }
      const file = await fileAt(op.path, false)
      const list = parseList(await storedText(scope, file))
      const lines = byLine(list)
      const rows = await itemRows(db, { documentId: { in: [file.id] } })
      const viewMap = new Map((await views(db, scope, rows, lines)).map((v) => [v.id, v]))
      const remainsOf = new Map(rows.map((r) => [r.id, r.remainderOfId]))
      return {
        path: file.path,
        title: titleOf(file.path, list),
        ...listCounts(list),
        lines: list.lines.map((l) => lineOut(l, viewMap, remainsOf)),
      }
    }

    if (op.name === 'link_items') {
      const file = await fileAt(op.path, false)
      const list = parseList(await storedText(scope, file))
      const picked: Picked[] = []
      for (const ref of op.items) {
        const line = findLine(list, ref)
        if (typeof line === 'string') return { error: line }
        picked.push({ id: line.id ?? newListItemId(), text: line.text })
      }
      // Marking a line changes the file: only with the right to change it.
      if (
        picked.some((p) => !list.lines.some((l) => l.id === p.id)) &&
        access.of(file.path) !== 'read_write'
      )
        return { error: `You may not change ${file.path}, and some of those lines have no id yet` }
      const ids = await itemsFor(db, scope, actor, file, picked, context)
      await db.listItemThread.createMany({
        data: ids.map((itemId) => ({ itemId, sessionId: session.id })) as never,
        skipDuplicates: true,
      })
      return {
        linked: ids.map((id, i) => ({ id, text: plainItemText(picked[i]!.text) })),
        hint: 'Name them by id in complete_item, and in github_create_pull_request items.closes.',
      }
    }

    if (op.name === 'complete_item') {
      let itemId = ListItemId.safeParse(op.item).success
        ? (await db.listItem.findFirst({ where: { id: op.item }, select: { id: true } }))?.id
        : undefined
      if (itemId) {
        const item = await db.listItem.findFirst({
          where: { id: itemId },
          include: { document: { select: { path: true } } },
        })
        await fileAt(item!.document.path, true)
      } else {
        if (!op.path) return { error: 'Give the item’s id, or its text with the list’s path' }
        const file = await fileAt(op.path, true)
        const line = findLine(parseList(await storedText(scope, file)), op.item)
        if (typeof line === 'string') return { error: line }
        ;[itemId] = await itemsFor(
          db,
          scope,
          actor,
          file,
          [{ id: line.id ?? newListItemId(), text: line.text }],
          context,
        )
      }
      const done = await setItemDone(db, scope, actor, itemId!, true, {
        note: op.note,
        sessionId: session.id,
      })
      await db.listItemThread.createMany({
        data: [{ itemId: itemId!, sessionId: session.id }] as never,
        skipDuplicates: true,
      })
      return { ticked: done }
    }

    // add_item
    const file = await fileAt(op.path, true)
    // What remains of an item: nested under it, which is an item (marked) for the link.
    let remainsOf: string | undefined
    if (op.remainsOf) {
      const line = findLine(parseList(await storedText(scope, file)), op.remainsOf)
      if (typeof line === 'string') return { error: line }
      if (line.done) return { error: 'That item is ticked already: nothing remains of it' }
      ;[remainsOf] = await itemsFor(
        db,
        scope,
        actor,
        file,
        [{ id: line.id ?? newListItemId(), text: line.text }],
        context,
      )
    }
    const id = newListItemId()
    let made = false
    await editList(
      db,
      scope,
      actor,
      file.id,
      context,
      async (text, list) => {
        let after: ListLine | undefined
        const ref = remainsOf ?? op.after
        if (ref) {
          const line = remainsOf ? list.lines.find((l) => l.id === remainsOf) : findLine(list, ref)
          if (!line) throw new HTTPException(404, { message: 'That item is no longer in its list' })
          if (typeof line === 'string') throw new HTTPException(404, { message: line })
          if (remainsOf && line.done)
            throw new HTTPException(409, {
              message: 'That item is ticked already: nothing remains of it',
            })
          after = line
        }
        // Its row with its line, under the file's lock (settleRemainders reads them there).
        await db.listItem.create({
          data: {
            id,
            documentId: file.id,
            text: plainItemText(op.text).slice(0, 2_000),
            ...(remainsOf ? { remainderOfId: remainsOf } : {}),
          } as never,
        })
        made = true
        return insertLine(
          text,
          list,
          remainsOf
            ? { after: after!, nested: true }
            : {
                ...(after ? { after } : {}),
                ...(op.nested ? { nested: true } : {}),
                ...(op.section ? { section: op.section } : {}),
              },
          op.text,
          id,
        )
      },
      // Not written: no row without its line, gone before anyone else may read the file.
      async () => {
        if (made) await db.listItem.deleteMany({ where: { id } })
      },
    )
    await db.listItemThread.create({ data: { itemId: id, sessionId: session.id } as never })
    return {
      added: { id, text: plainItemText(op.text), path: file.path },
      ...(remainsOf
        ? {
            hint:
              'Brigade ticks the item it remains of once all its remaining lines are ticked, by ' +
              'whoever does them.',
          }
        : {}),
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}
