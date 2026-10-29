// Lists (docs/lists.md): a library Markdown file's checklist lines, handed to teammates. The
// file stays the list; a line work is attached to carries its marker (`<!-- item:<id> -->`),
// and `ListItem` keeps by that id what the file cannot: the threads on it, the pull requests
// that finish it, who ticked it from Brigade. Brigade changes the file only to mark, tick or
// add a line, each a save of its own credited to who did it.
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
  formatMention,
  projectFolder,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit, type Actor } from './audit.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs } from './hub.js'
import { teammateLibraryAccess } from './library-folders.js'
import { actorNames } from './library-history.js'
import { documentText, saveLibraryFile, withLibraryLock } from './library.js'
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
  edit: (text: string, list: ParsedList) => string,
) {
  return withLibraryLock(scope, documentId, async () => {
    const row = await listFile(db, { id: documentId })
    const text = await documentText(scope, row)
    const next = edit(text, parseList(text))
    if (next === text) return row
    return saveLibraryFile(
      db,
      scope,
      actor,
      { path: row.path, bytes: new TextEncoder().encode(next), contentType: row.contentType },
      context,
      { locked: true },
    )
  })
}

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

/** Where an item stands: ticked, else from its threads and pull requests. */
function stateOf(done: boolean, row: ItemRow | undefined): ItemState {
  if (done) return 'done'
  const live = row?.threads.filter((t) => !t.session.archivedAt) ?? []
  if (live.some((t) => t.session.status === 'waiting' || t.session.status === 'paused'))
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
  const [waiting, who] = await Promise.all([
    threadIds.length
      ? hubs.get(scope.workspaceId).eventsWaitingSince(threadIds)
      : ({} as Record<string, unknown>),
    actorNames(
      db,
      rows.flatMap((r) =>
        r.doneByType && r.doneById ? [{ type: r.doneByType, id: r.doneById }] : [],
      ),
    ),
  ])
  return rows.map((row) => {
    const line = lines.get(row.id)
    // Gone from the file: Brigade's tick is all that is known of it.
    const done = line ? line.done : !!row.doneAt
    const by = who(row.doneByType, row.doneById)
    return {
      id: row.id,
      text: line?.text ?? row.text,
      done,
      state: stateOf(done, row),
      missing: !line,
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
  // Across workspaces: ids are the rows' keys, and an editor can be handed any marker.
  const elsewhere = new Set(
    (
      await prisma.listItem.findMany({
        where: { id: { in: picked.map((p) => p.id) }, documentId: { not: file.id } },
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
      if (line.id) {
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

/** The project whose folder holds the file: its threads work in it. */
async function projectOf(db: ScopedDb, path: string) {
  const projects = await db.project.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, folder: true },
  })
  return projects.find((p) => path.startsWith(`${p.folder ?? projectFolder(p.name)}/`))?.id ?? null
}

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
  const mention = formatMention({ kind: 'document', id: file.id, label: file.path })
  const message = (group: string[]) =>
    [
      input.note?.trim() ||
        (group.length > 1
          ? `Please take these items of ${mention}:`
          : `Please take this item of ${mention}:`),
      bullets(group.map((id) => texts.get(id)!)),
    ].join('\n\n')
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

/** Attach lines to a thread that runs already; its teammate is told at its next turn. */
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
  if (session.startedByMemberId !== memberId && !session.othersMayPrompt)
    throw new HTTPException(403, { message: 'Only who may write in this thread can do that' })
  const ids = [
    ...new Set(await itemsFor(db, scope, { type: 'member', id: memberId }, file, input.items)),
  ]
  await db.listItemThread.createMany({
    data: ids.map((itemId) => ({ itemId, sessionId: session.id })) as never,
    skipDuplicates: true,
  })
  await noteInThread(
    db,
    session.id,
    `Items of ${file.path} were added to this thread:\n${bullets(input.items.map((p) => p.text))}`,
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
  options: { note?: string; sessionId?: string } = {},
) {
  const item = await db.listItem.findFirst({ where: { id: itemId } })
  if (!item) throw new HTTPException(404, { message: 'Item not found' })
  let text = item.text
  let changed = false
  await editList(
    db,
    scope,
    actor,
    item.documentId,
    options.sessionId ? { sessionId: options.sessionId } : {},
    (current, list) => {
      const line = list.lines.find((l) => l.id === itemId)
      if (!line)
        throw new HTTPException(404, {
          message: 'This item is no longer in its list: its line or its marker was removed',
        })
      text = line.text
      if (line.done === done) return current
      changed = true
      return setLineDone(current, line, done, done ? options.note : undefined)
    },
  )
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
  return { id: itemId, done, text: plainItemText(text), changed }
}

// ---- Pull requests --------------------------------------------------------------------------

/**
 * The items a pull request finishes (`closes`) or works on (`partOf`), by id; also its thread's.
 * Only lists its author may read; and it closes only items of lists it may change, as ticking
 * one itself would need: elsewhere, a pull request is only part of the work.
 */
export async function linkPullItems(
  db: ScopedDb,
  pullRequestId: string,
  sessionId: string,
  teammateId: string,
  items: { closes?: string[]; partOf?: string[] },
) {
  const closes = new Set((items.closes ?? []).filter((id) => ListItemId.safeParse(id).success))
  const partOf = (items.partOf ?? []).filter(
    (id) => ListItemId.safeParse(id).success && !closes.has(id),
  )
  const wanted = [...closes, ...partOf]
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
    data: ids.map((itemId) => ({
      itemId,
      pullRequestId,
      closes: closes.has(itemId) && level.get(itemId) === 'read_write',
    })) as never,
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
 * teammate that opened it, where it may still change their list. Its thread is told. Each item
 * is settled once ticked (or for good: gone from its list, or out of its author's reach); one
 * that failed otherwise (storage, the database) is tried again by sweepListMerges.
 */
export async function settleItemsOnMerge(
  db: ScopedDb,
  scope: Scope,
  pull: { id: string; number: number; sessionId: string | null },
) {
  try {
    const links = await db.listItemPull.findMany({
      where: { pullRequestId: pull.id, closes: true, settledAt: null },
      select: { itemId: true, item: { select: { document: { select: { path: true } } } } },
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
  } catch (error) {
    console.warn(`lists: items of pull request ${pull.id} not settled: ${String(error)}`)
  }
}

/** Merged pull requests whose items are not all settled: tried again (jobs.ts). */
export async function sweepListMerges() {
  const pending = await prisma.listItemPull.findMany({
    where: { closes: true, settledAt: null, pullRequest: { state: 'merged' } },
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
const lineOut = (l: ListLine, views: Map<string, ListItemView>) => {
  const view = l.id ? views.get(l.id) : undefined
  return {
    id: l.id,
    done: l.done,
    text: l.text,
    ...(l.section ? { section: l.section } : {}),
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
      const list = parseList(await documentText(scope, file))
      const lines = byLine(list)
      const rows = await itemRows(db, { documentId: { in: [file.id] } })
      const viewMap = new Map((await views(db, scope, rows, lines)).map((v) => [v.id, v]))
      return {
        path: file.path,
        title: titleOf(file.path, list),
        ...listCounts(list),
        lines: list.lines.map((l) => lineOut(l, viewMap)),
      }
    }

    if (op.name === 'link_items') {
      const file = await fileAt(op.path, false)
      const list = parseList(await documentText(scope, file))
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
        const line = findLine(parseList(await documentText(scope, file)), op.item)
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
        ...(op.note ? { note: op.note } : {}),
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
    const id = newListItemId()
    await editList(db, scope, actor, file.id, context, (text, list) => {
      let after: ListLine | undefined
      if (op.after) {
        const line = findLine(list, op.after)
        if (typeof line === 'string') throw new HTTPException(404, { message: line })
        after = line
      }
      return insertLine(
        text,
        list,
        {
          ...(after ? { after } : {}),
          ...(op.nested ? { nested: true } : {}),
          ...(op.section ? { section: op.section } : {}),
        },
        op.text,
        id,
      )
    })
    await db.listItem.create({
      data: { id, documentId: file.id, text: plainItemText(op.text).slice(0, 2_000) } as never,
    })
    await db.listItemThread.create({ data: { itemId: id, sessionId: session.id } as never })
    return { added: { id, text: plainItemText(op.text), path: file.path } }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}
