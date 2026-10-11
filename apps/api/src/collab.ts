// Documents people edit together. The collab server (apps/collab) keeps each
// open document's Yjs state in a Durable Object and syncs it between editors;
// Brigade still stores Markdown, which teammates, search and computers read.
// This module converts between the two, so the collab server never parses
// Markdown and the API stays the one place documents are written.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DOCUMENT_FRAGMENT } from '@brigade/contracts'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { blockMarkdowns, blocksToMarkdown, documentSchema, markdownToBlocks } from '@brigade/editor'
import * as Y from 'yjs'
import { env } from './config.js'

/** The Durable Object class on the collab server, as its URLs name it. */
export const COLLAB_PARTY = 'doc-room'
/** How long an editor's token lets it (re)connect. */
const TOKEN_SECONDS = 10 * 60

export const collabEnabled = () => Boolean(env.COLLAB_SECRET)

// ---------------------------------------------------------------------------
// Tokens and the collab server's calls
// ---------------------------------------------------------------------------

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/** What the collab server needs to let a member into a document's room. */
export function editToken(input: { room: string; memberId: string; name: string }) {
  const payload = b64url(
    JSON.stringify({
      room: input.room,
      member: input.memberId,
      name: input.name,
      exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS,
    }),
  )
  const signature = b64url(createHmac('sha256', env.COLLAB_SECRET!).update(payload).digest())
  return `${payload}.${signature}`
}

/** Whether a request comes from the collab server (its `authorization: Bearer <secret>`). */
export function fromCollabServer(authorization: string | undefined) {
  if (!env.COLLAB_SECRET || !authorization?.startsWith('Bearer ')) return false
  const given = createHash('sha256').update(authorization.slice(7)).digest()
  const expected = createHash('sha256').update(env.COLLAB_SECRET).digest()
  return timingSafeEqual(given, expected)
}

/** A color for a member's cursor, the same on every visit. */
export function cursorColor(memberId: string) {
  const colors = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c', '#0c8599', '#c2255c']
  return colors[createHash('sha256').update(memberId).digest()[0]! % colors.length]!
}

/**
 * Tell a document's room that the API changed it (a teammate saved it, a
 * thread updated memory) or deleted it. The room merges the change into what
 * people are editing. Best effort: a room that misses it catches up when
 * someone next connects.
 */
export function notifyCollab(documentId: string, action: 'refresh' | 'delete' = 'refresh') {
  if (!env.COLLAB_SECRET) return
  void fetch(`${env.COLLAB_URL}/parties/${COLLAB_PARTY}/${encodeURIComponent(documentId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.COLLAB_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action }),
  })
    .then((r) => {
      if (!r.ok) console.warn(`collab: ${action} ${documentId} returned ${r.status}`)
    })
    .catch((error) => console.warn(`collab: could not ${action} ${documentId}: ${String(error)}`))
}

// ---------------------------------------------------------------------------
// Markdown and Yjs
// ---------------------------------------------------------------------------

const createEditor = () => ServerBlockNoteEditor.create({ schema: documentSchema })
type Editor = ReturnType<typeof createEditor>
let editor: Editor | undefined
let queue: Promise<unknown> = Promise.resolve()

/**
 * BlockNote's Markdown conversion borrows a global DOM for each call, so two
 * at once could trip over each other: run them one after another.
 */
function blocknote<T>(work: (editor: Editor) => Promise<T>): Promise<T> {
  editor ??= createEditor()
  const run = queue.then(() => work(editor!))
  queue = run.catch(() => {})
  return run
}

const docFrom = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

/** The document's Markdown, as Brigade stores it: media and mentions included (@brigade/editor). */
export const toMarkdown = (state: Uint8Array) =>
  blocknote((e) => blocksToMarkdown(e, e.yDocToBlocks(docFrom(state), DOCUMENT_FRAGMENT)))

/** Markdown as the editor would write it back, to tell real edits from reformatting. */
export const normalizeMarkdown = (text: string) =>
  blocknote(async (e) => blocksToMarkdown(e, await markdownToBlocks(e, text)))

/**
 * The Yjs update that turns `base` (a document's state when it last matched
 * the stored text) into `text`. Only top-level blocks whose Markdown differs
 * are replaced, so applied to the live document (base plus people's edits
 * since) it keeps whatever people changed elsewhere, and what Markdown cannot
 * hold (an image's width) in the blocks it keeps.
 */
export async function updateFrom(base: Uint8Array, text: string): Promise<Uint8Array> {
  return blocknote(async (e) => {
    const doc = docFrom(base)
    const before = Y.encodeStateVector(doc)
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT)
    const next = await markdownToBlocks(e, text)
    const group = fragment.length === 1 ? fragment.get(0) : undefined

    if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
      // Empty (a first load) or not shaped as BlockNote writes it: replace it all.
      doc.transact(() => {
        fragment.delete(0, fragment.length)
        e.blocksToYXmlFragment(next as never, fragment)
      })
      return Y.encodeStateAsUpdate(doc, before)
    }

    const current = e.yDocToBlocks(doc, DOCUMENT_FRAGMENT)
    const containers = blockContainers(e, next)
    const steps = diff(await blockMarkdowns(e, current), await blockMarkdowns(e, next))
    doc.transact(() => {
      let at = 0
      for (const step of steps) {
        if (step.op === 'keep') at++
        else if (step.op === 'delete') group.delete(at, 1)
        else group.insert(at++, [containers[step.index]!.clone()])
      }
    })
    return Y.encodeStateAsUpdate(doc, before)
  })
}

/** The blocks as BlockNote's Yjs elements, one per top-level block. */
function blockContainers(e: Editor, blocks: unknown[]) {
  const fragment = e
    .blocksToYDoc(blocks as never, DOCUMENT_FRAGMENT)
    .getXmlFragment(DOCUMENT_FRAGMENT)
  const group = fragment.get(0)
  return group instanceof Y.XmlElement ? (group.toArray() as Y.XmlElement[]) : []
}

type Step = { op: 'keep' } | { op: 'delete' } | { op: 'insert'; index: number }

/** The fewest deletes and inserts from `a` to `b` (longest common subsequence). */
function diff(a: string[], b: string[]): Step[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const steps: Step[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      steps.push({ op: 'keep' })
      i++
      j++
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      steps.push({ op: 'insert', index: j++ })
    } else {
      steps.push({ op: 'delete' })
      i++
    }
  }
  return steps
}
