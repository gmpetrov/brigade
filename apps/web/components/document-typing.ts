// A teammate's edit, typed in. When a teammate saves a document people have
// open, the collab server first says who wrote the update it is about to
// send; the editor then shows what changed appear behind a cursor with the
// teammate's name, block after block, instead of all at once. It is only
// decorations over the text: the document already holds the whole edit, so
// nothing here is saved, synced or undone.
import { createExtension, type BlockNoteEditor } from '@blocknote/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export type Writer = { name: string; color: string }

/** A changed block: its units (characters, and 1 per mention or image) from `from` to `to` get typed. */
type Typed = { id: string; from: number; to: number; whole: boolean }
type Run = { writer: Writer; blocks: Typed[]; start: number; cps: number; end: number }
type Meta = { type: 'start'; writer: Writer } | { type: 'tick' }
type State = {
  /** A notice whose update has not come yet. */
  pending: { writer: Writer; until: number } | null
  run: Run | null
  decorations: DecorationSet
}

const key = new PluginKey<State>('agentTyping')
/** How long a notice waits for its update (it comes right after, on the same socket). */
const WAIT_MS = 5000
const TICK_MS = 40
/** Characters a second for a small edit; a large one goes faster, to end within MAX_SECONDS. */
const SPEED = 80
const MAX_SECONDS = 6
const HIDDEN = { style: 'display: none' }
const LEAF = '￼'

/** The top-level blocks, in order. */
function topBlocks(doc: Node) {
  const blocks: { id: string; node: Node; pos: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    blocks.push({ id: String(node.attrs.id), node, pos })
    return false
  })
  return blocks
}

/** A block's units as text: each mention, break or image is one character. */
function unitsOf(block: Node) {
  let text = ''
  block.descendants((node) => {
    if (node.isText) text += node.text
    else if (node.isLeaf) text += LEAF
    return true
  })
  return text
}

/** What changed from `a` to `b`: `b` between what both start and end with. */
function changed(a: string, b: string) {
  let from = 0
  while (from < a.length && from < b.length && a[from] === b[from]) from++
  let tail = 0
  while (tail < a.length - from && tail < b.length - from && a.at(-1 - tail) === b.at(-1 - tail))
    tail++
  return { from, to: b.length - tail }
}

/**
 * The run for the update that turned `before` into `after`: its new blocks
 * (the API replaces each block it changes with a new one), each typed over
 * the block it took the place of, so only what differs gets typed.
 */
function startRun(before: Node, after: Node, writer: Writer, now: number): Run | null {
  const old = topBlocks(before)
  const next = topBlocks(after)
  const had = new Set(old.map((b) => b.id))
  const kept = new Set(next.map((b) => b.id))
  const blocks: Typed[] = []
  let i = 0
  let replaced: Node[] = []
  for (const block of next) {
    if (had.has(block.id)) {
      while (i < old.length && old[i]!.id !== block.id) i++
      i++
      replaced = []
      continue
    }
    if (!replaced.length)
      while (i < old.length && !kept.has(old[i]!.id)) replaced.push(old[i++]!.node)
    const previous = replaced.shift()
    const units = unitsOf(block.node)
    const span = previous ? changed(unitsOf(previous), units) : { from: 0, to: units.length }
    if (span.to > span.from) blocks.push({ id: block.id, ...span, whole: !previous })
  }
  const total = blocks.reduce((sum, b) => sum + b.to - b.from, 0)
  if (!total) return null
  const cps = Math.max(SPEED, total / MAX_SECONDS)
  return { writer, blocks, start: now, cps, end: now + (total / cps) * 1000 }
}

function cursor(writer: Writer) {
  // As BlockNote draws people's cursors, with its label showing.
  const base = document.createElement('span')
  base.className = 'bn-collaboration-cursor__base'
  base.setAttribute('data-active', '')
  base.setAttribute('aria-hidden', 'true')
  const caret = document.createElement('span')
  caret.className = 'bn-collaboration-cursor__caret'
  caret.style.backgroundColor = writer.color
  const label = document.createElement('span')
  label.className = 'bn-collaboration-cursor__label'
  label.style.backgroundColor = writer.color
  label.style.color = 'white'
  label.textContent = writer.name
  caret.append(label)
  base.append('⁠', caret, '⁠')
  return base
}

/** The run at `now`: what is not typed yet is hidden, and the cursor sits where typing is. */
function decorate(doc: Node, run: Run, now: number) {
  const decorations: Decoration[] = []
  const at = new Map(topBlocks(doc).map((b) => [b.id, b]))
  let left = Math.floor(((now - run.start) / 1000) * run.cps)
  let typing = false
  for (const typed of run.blocks) {
    const block = at.get(typed.id)
    // Gone since (someone deleted it), or changed so the span no longer fits.
    if (!block || unitsOf(block.node).length < typed.to) continue
    const length = typed.to - typed.from
    const shown = Math.min(Math.max(left, 0), length)
    left -= length
    if (shown === length) continue
    if (typing && typed.whole) {
      decorations.push(Decoration.node(block.pos, block.pos + block.node.nodeSize, HIDDEN))
      continue
    }
    const hideFrom = typed.from + shown
    let unit = 0
    block.node.descendants((node, offset) => {
      const pos = block.pos + 1 + offset
      if (!node.isText && !node.isLeaf) return true
      const size = node.isText ? node.text!.length : 1
      const from = Math.max(unit, hideFrom)
      const to = Math.min(unit + size, typed.to)
      if (!typing && hideFrom >= unit && hideFrom < unit + size) {
        typing = true
        decorations.push(
          Decoration.widget(node.isText ? pos + hideFrom - unit : pos, () => cursor(run.writer), {
            key: `agent-typing:${run.writer.name}`,
            side: -1,
          }),
        )
      }
      if (from < to)
        decorations.push(
          node.isText
            ? Decoration.inline(pos + from - unit, pos + to - unit, HIDDEN)
            : node.isInline
              ? Decoration.inline(pos, pos + node.nodeSize, HIDDEN)
              : Decoration.node(pos, pos + node.nodeSize, HIDDEN),
        )
      unit += size
      return false
    })
  }
  return decorations
}

const typingPlugin = (onTyping: (writer: Writer | null) => void) =>
  new Plugin<State>({
    key,
    state: {
      init: () => ({ pending: null, run: null, decorations: DecorationSet.empty }),
      apply(tr, state) {
        const meta = tr.getMeta(key) as Meta | undefined
        if (!meta && !tr.docChanged && !state.run && !state.pending) return state
        const now = Date.now()
        let { pending, run } = state
        if (meta?.type === 'start') {
          pending = { writer: meta.writer, until: now + WAIT_MS }
          run = null
        }
        if (pending && now > pending.until) pending = null
        if (pending && tr.docChanged) {
          const started = startRun(tr.before, tr.doc, pending.writer, now)
          if (started) {
            run = started
            pending = null
          }
        }
        if (run && now >= run.end) run = null
        if (!run) return { pending, run, decorations: DecorationSet.empty }
        if (!meta && !tr.docChanged) return { ...state, pending }
        return {
          pending,
          run,
          decorations: DecorationSet.create(tr.doc, decorate(tr.doc, run, now)),
        }
      },
    },
    props: { decorations: (state) => key.getState(state)?.decorations },
    view() {
      let timer: ReturnType<typeof setTimeout> | undefined
      return {
        update(view, previous) {
          const was = key.getState(previous)?.run?.writer ?? null
          const writer = key.getState(view.state)?.run?.writer ?? null
          if (writer !== was) onTyping(writer)
          if (timer || !writer) return
          timer = setTimeout(() => {
            timer = undefined
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { type: 'tick' }))
          }, TICK_MS)
        },
        destroy() {
          clearTimeout(timer)
        },
      }
    },
  })

/** The editor's extension; `onTyping` hears who starts typing, and `null` once all is shown. */
export const agentTyping = (onTyping: (writer: Writer | null) => void) =>
  createExtension({ key: 'agentTyping', prosemirrorPlugins: [typingPlugin(onTyping)] } as const)

/** The collab server's notice that `writer` wrote the update it sends next: type it in. */
export function typeNextUpdate(editor: BlockNoteEditor<any, any, any>, writer: Writer) {
  editor.transact((tr) => {
    tr.setMeta(key, { type: 'start', writer } satisfies Meta)
  })
}
