// The demo's lists (docs/lists.md), in the browser: the sample workspace's library Markdown files
// with checkboxes, read as the API reads them (parseList), and the items work is attached to kept
// in memory: the threads a hand-off started, the pull requests that close them, and who ticked
// them. The fixtures were recorded before lists existed, so nothing of this is recorded: the
// files are, and everything here is worked out from them.
import {
  findLine,
  insertLine,
  listCounts,
  markLine,
  parseList,
  plainItemText,
  projectFolder,
  setLineDone,
  type ItemState,
  type ListDetail,
  type ListItemView,
  type ListSummary,
  type ParsedList,
  type ThreadListItems,
} from '@brigade/contracts'

type Actor = { type: 'member' | 'teammate'; id: string; name: string }
type Doc = { id: string; path: string; updatedAt: string }
type ThreadRef = {
  id: string
  title: string
  status: string
  archivedAt?: string | null
  teammate: { id: string; name: string }
}
type PullRef = { number: number; state: string; threadId: string | null }

type Item = {
  id: string
  documentId: string
  /** Its text when last seen, for an item whose line is gone. */
  text: string
  threads: string[]
  /** The pull requests that close it. */
  pulls: number[]
  doneBy: { name: string; at: string } | null
}

/** What the lists read from, and write to, in the demo's store (lib/demo/server.ts). */
export type ListStore = {
  /** The library's Markdown files. */
  docs: () => Doc[]
  text: (documentId: string) => string | undefined
  write: (documentId: string, text: string, by: Actor) => void
  thread: (id: string) => ThreadRef | undefined
  pull: (number: number) => PullRef | undefined
  projects: () => { id: string; name: string }[]
}

/** A list's title: its first heading, else its file's name (as the API names it). */
const titleOf = (path: string, list: ParsedList) =>
  list.title ? plainItemText(list.title) : path.split('/').pop()!.replace(/\.md$/i, '')

/** As the API's merge note: "PR #155, 9 Nov". */
const shortDate = (at: Date) =>
  at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

const RUNNING = new Set(['starting', 'running'])
const WAITING = new Set(['waiting', 'paused'])

export function demoLists(store: ListStore) {
  const items = new Map<string, Item>()

  const parsed = (documentId: string) => {
    const text = store.text(documentId)
    return text === undefined ? undefined : parseList(text)
  }

  /** Where an item stands from its threads and pull requests, as the API's stateOf says. */
  function stateOf(done: boolean, item: Item | undefined): ItemState {
    if (done) return 'done'
    const threads = (item?.threads ?? []).flatMap((id) => {
      const t = store.thread(id)
      return t && !t.archivedAt ? [t] : []
    })
    const open = (item?.pulls ?? []).flatMap((n) => {
      const p = store.pull(n)
      return p?.state === 'open' ? [p] : []
    })
    if (
      threads.some(
        (t) =>
          WAITING.has(t.status) ||
          (!RUNNING.has(t.status) &&
            t.status !== 'failed' &&
            open.some((p) => p.threadId === t.id)),
      )
    )
      return 'needs_you'
    if (threads.some((t) => RUNNING.has(t.status)) || open.length) return 'in_progress'
    return 'open'
  }

  function view(item: Item, list: ParsedList): ListItemView {
    const line = list.lines.find((l) => l.id === item.id)
    const done = line ? line.done : !!item.doneBy
    const state = stateOf(done, item)
    const threads = item.threads.flatMap((id) => {
      const t = store.thread(id)
      return t
        ? [{ id: t.id, title: t.title, status: t.status, stuck: false, teammate: t.teammate }]
        : []
    })
    return {
      id: item.id,
      text: line?.text ?? item.text,
      done,
      state,
      missing: !line,
      stalled: !!line && state === 'open' && threads.length > 0,
      section: line?.section ?? null,
      doneBy: done ? item.doneBy : null,
      threads,
      pulls: item.pulls.flatMap((n) => {
        const p = store.pull(n)
        return p
          ? [
              {
                repository: 'acme/web',
                number: n,
                state: p.state,
                closes: true,
                remains: null,
                url: `https://github.com/acme/web/pull/${n}`,
              },
            ]
          : []
      }),
    }
  }

  /** The items work is attached to in this file: in its order, then those gone from it. */
  function viewsOf(documentId: string, list: ParsedList) {
    const of = [...items.values()].filter((i) => i.documentId === documentId)
    const at = (i: Item) => {
      const n = list.lines.findIndex((l) => l.id === i.id)
      return n === -1 ? Infinity : n
    }
    return of.sort((a, b) => at(a) - at(b)).map((i) => view(i, list))
  }

  function counts(list: ParsedList, views: ListItemView[]) {
    const open = views.filter((v) => !v.missing)
    return {
      ...listCounts(list),
      needsYou: open.filter((v) => v.state === 'needs_you').length,
      inProgress: open.filter((v) => v.state === 'in_progress').length,
    }
  }

  const projectOf = (path: string) =>
    store.projects().find((p) => path.startsWith(`${projectFolder(p.name)}/`))?.id ?? null

  function detail(documentId: string): ListDetail | undefined {
    const doc = store.docs().find((d) => d.id === documentId)
    const list = parsed(documentId)
    if (!doc || !list) return undefined
    const views = viewsOf(documentId, list)
    return {
      documentId,
      path: doc.path,
      title: titleOf(doc.path, list),
      ...counts(list, views),
      updatedAt: doc.updatedAt,
      items: views,
    }
  }

  /** Every list: the Markdown files with a checklist, last changed first. */
  function summaries(): ListSummary[] {
    return store
      .docs()
      .flatMap((doc) => {
        const list = parsed(doc.id)
        if (!list?.lines.length) return []
        const views = viewsOf(doc.id, list).filter((v) => !v.missing)
        return [
          {
            documentId: doc.id,
            path: doc.path,
            title: titleOf(doc.path, list),
            projectId: projectOf(doc.path),
            ...counts(list, views),
            updatedAt: doc.updatedAt,
            next: [
              ...views.filter((v) => v.state === 'needs_you'),
              ...views.filter((v) => v.state === 'in_progress'),
            ]
              .slice(0, 3)
              .map((v) => ({ id: v.id, text: plainItemText(v.text), state: v.state })),
          },
        ]
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** The items a thread works on, for the card at its top. */
  function ofThread(threadId: string): ThreadListItems {
    return [...items.values()]
      .filter((i) => i.threads.includes(threadId))
      .flatMap((i) => {
        const doc = store.docs().find((d) => d.id === i.documentId)
        const list = parsed(i.documentId)
        if (!doc || !list) return []
        return [
          {
            ...view(i, list),
            documentId: doc.id,
            path: doc.path,
            listTitle: titleOf(doc.path, list),
          },
        ]
      })
  }

  /**
   * Lines attached to a thread, by the id the editor gave each: marked in the file when its save
   * has not landed yet (found by its text), or added at its end when the line is not in it at all.
   */
  function attach(
    documentId: string,
    picked: { id: string; text: string }[],
    threadId: string,
    by: Actor,
  ) {
    let text = store.text(documentId)
    if (text === undefined) return []
    for (const p of picked) {
      const list = parseList(text)
      if (!list.lines.some((l) => l.id === p.id)) {
        const line = findLine(list, p.text)
        text =
          typeof line === 'string' || line.id
            ? insertLine(text, list, {}, p.text, p.id)
            : markLine(text, line, p.id)
      }
      const item = items.get(p.id) ?? {
        id: p.id,
        documentId,
        text: p.text,
        threads: [],
        pulls: [],
        doneBy: null,
      }
      if (!item.threads.includes(threadId)) item.threads.push(threadId)
      items.set(p.id, item)
    }
    if (text !== store.text(documentId)) store.write(documentId, text, by)
    return picked.map((p) => p.id)
  }

  /** The list a thread works on, for the sidebar's row (lib/list-groups.ts). */
  function listOf(threadId: string) {
    const item = [...items.values()].find((i) => i.threads.includes(threadId))
    const doc = item && store.docs().find((d) => d.id === item.documentId)
    const list = item && parsed(item.documentId)
    return doc && list ? { documentId: doc.id, title: titleOf(doc.path, list) } : null
  }

  /** Ticks or unticks the item's line, with a note after its text when given. */
  function setDone(itemId: string, done: boolean, by: Actor, note?: string) {
    const item = items.get(itemId)
    const text = item && store.text(item.documentId)
    if (!item || text === undefined) return false
    const line = parseList(text).lines.find((l) => l.id === itemId)
    if (!line) return false
    item.doneBy = done ? { name: by.name, at: new Date().toISOString() } : null
    if (line.done !== done)
      store.write(item.documentId, setLineDone(text, line, done, done ? note : undefined), by)
    return true
  }

  /** A pull request opened in the thread closes the items it works on. */
  function linkPull(threadId: string, number: number) {
    const linked = [...items.values()].filter((i) => i.threads.includes(threadId))
    for (const i of linked) if (!i.pulls.includes(number)) i.pulls.push(number)
    return linked.map((i) => ({ id: i.id, text: plainItemText(i.text) }))
  }

  /** Merged: the items it closes are ticked, with its number, credited to its author. */
  function settleMerge(number: number, author: Actor) {
    const ticked: string[] = []
    for (const i of items.values())
      if (
        i.pulls.includes(number) &&
        setDone(i.id, true, author, `PR #${number}, ${shortDate(new Date())}`)
      )
        ticked.push(plainItemText(i.text))
    return ticked
  }

  return { summaries, detail, ofThread, attach, listOf, setDone, linkPull, settleMerge, projectOf }
}
export type DemoLists = ReturnType<typeof demoLists>
