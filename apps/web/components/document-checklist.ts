// A checklist line as it reads in the document editor (lib/checklist-look): the notes on
// lines of their own at its end, smaller and grey; and a long line that starts with a title
// (`Title: details…`) folded under it, its details reduced to one grey line that fades out.
// A line opens with its caret or a click on its details, and while the cursor is in it, so
// nothing is ever edited unseen; it folds again from its caret, or once the cursor leaves
// it. A selection opens only the line it starts in: one dragged or extended across folded
// lines leaves them folded, so the page does not jump under the pointer. Decorations only: the document, its Markdown and what teammates read keep the line as
// it is.
import { createExtension } from '@blocknote/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { checklistLook, type Piece } from '@/lib/checklist-look'

const LEAF = '￼'

/** A line whose details fold: where it sits, and its details' range in its text. */
type Foldable = {
  id: string
  /** The line's node: its position and size. */
  pos: number
  size: number
  /** Its details, as positions in the document. */
  from: number
  to: number
  /** Its details' text, on one line, for the folded preview. */
  peek: string
}

type State = {
  /** The notes' decorations, and the lines that fold: both change only with the document. */
  notes: Decoration[]
  lines: Foldable[]
  /** The lines opened with their caret or details. */
  open: Set<string>
  focused: boolean
  set: DecorationSet
}

type Meta = { toggle: string } | { focused: boolean }

const key = new PluginKey<State>('checklistLook')

function read(doc: Node) {
  const notes: Decoration[] = []
  const lines: Foldable[] = []
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== 'checkListItem') return true
    const pieces: Piece[] = []
    node.forEach((child) => {
      const marks = child.marks.map((m) => m.type.name)
      pieces.push({
        text: child.isText
          ? child.text!
          : child.type.name === 'hardBreak'
            ? '\n'
            : LEAF.repeat(child.nodeSize),
        italic: marks.includes('italic'),
        code: marks.includes('code'),
        aside: child.type.name === 'item',
      })
    })
    const { note, detail } = checklistLook(pieces)
    const start = pos + 1
    if (note)
      notes.push(Decoration.inline(start + note.from, start + note.to, { class: 'bn-note' }))
    const id = parent?.attrs.id as string | undefined
    if (detail && id) {
      const text = pieces.map((p) => p.text).join('')
      lines.push({
        id,
        pos,
        size: node.nodeSize,
        from: start + detail.from,
        to: start + detail.to,
        peek: text
          .slice(detail.from, detail.to)
          .replaceAll(LEAF, '')
          .replace(/^\s*:\s*/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      })
    }
    return false
  })
  return { notes, lines }
}

/** Whether the cursor is in the line: the caret, or where a selection starts. */
const holds = (line: Foldable, state: EditorState) =>
  state.selection.anchor >= line.pos && state.selection.anchor <= line.pos + line.size

/** Whether a line shows its details: opened, or the cursor is in it. */
const isOpen = (line: Foldable, s: Pick<State, 'open' | 'focused'>, state: EditorState) =>
  s.open.has(line.id) || (s.focused && holds(line, state))

function toggle(view: EditorView, id: string, opening: boolean) {
  view.dispatch(view.state.tr.setMeta(key, { toggle: id } satisfies Meta))
  // Folding the line the cursor is in: the cursor leaves the editor, or it would hold it open.
  if (!opening && view.hasFocus()) {
    const line = key.getState(view.state)?.lines.find((l) => l.id === id)
    if (line && holds(line, view.state)) (view.dom as HTMLElement).blur()
  }
}

/** Whether the line shows its details now, as the editor's state says. */
function openNow(view: EditorView, id: string) {
  const s = key.getState(view.state)
  const line = s?.lines.find((l) => l.id === id)
  return !!s && !!line && isOpen(line, s, view.state)
}

/**
 * Takes the press, so the editor neither moves its cursor nor opens the keyboard. `opening`:
 * what a click does, or, unset, the opposite of how the line stands when it comes (the caret
 * stays the same element as its line opens and folds, so it keeps the keyboard's focus).
 */
function button(view: EditorView, id: string, el: HTMLElement, opening?: boolean) {
  el.addEventListener('mousedown', (e) => e.preventDefault())
  el.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggle(view, id, opening ?? !openNow(view, id))
  })
  return el
}

/** Each caret says whether its line is open: it is kept as the line opens and folds. */
function syncCarets(view: EditorView) {
  for (const caret of view.dom.querySelectorAll<HTMLElement>('.bn-fold[data-line]')) {
    const open = openNow(view, caret.dataset.line!)
    caret.setAttribute('aria-expanded', String(open))
    caret.setAttribute('aria-label', open ? 'Fold details' : 'Show details')
  }
}

function decorations(s: Omit<State, 'set'>, state: EditorState) {
  const all = [...s.notes]
  for (const line of s.lines) {
    const open = isOpen(line, s, state)
    all.push(
      Decoration.widget(
        line.pos + 1,
        (view) => {
          const caret = document.createElement('button')
          caret.type = 'button'
          caret.className = 'bn-fold'
          caret.contentEditable = 'false'
          caret.dataset.line = line.id
          caret.setAttribute('aria-expanded', String(open))
          caret.setAttribute('aria-label', open ? 'Fold details' : 'Show details')
          return button(view, line.id, caret)
        },
        { side: -1, key: `fold:${line.id}`, ignoreSelection: true, stopEvent: () => true },
      ),
    )
    if (open) continue
    all.push(Decoration.inline(line.from, line.to, { class: 'bn-detail' }))
    all.push(
      Decoration.widget(
        line.from,
        (view) => {
          const peek = document.createElement('span')
          peek.className = 'bn-detail-peek'
          peek.contentEditable = 'false'
          peek.textContent = line.peek
          peek.title = 'Show details'
          return button(view, line.id, peek, true)
        },
        {
          side: 1,
          key: `peek:${line.id}:${line.peek}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    )
  }
  return DecorationSet.create(state.doc, all)
}

function next(tr: Transaction, s: State, state: EditorState): State {
  const meta = tr.getMeta(key) as Meta | undefined
  if (!tr.docChanged && !tr.selectionSet && !meta) return s
  let { notes, lines, open, focused } = s
  if (tr.docChanged) ({ notes, lines } = read(tr.doc))
  if (meta && 'focused' in meta) focused = meta.focused
  if (meta && 'toggle' in meta) {
    open = new Set(open)
    const line = lines.find((l) => l.id === meta.toggle)
    if (line && isOpen(line, s, state)) open.delete(meta.toggle)
    else open.add(meta.toggle)
  }
  const kept = { notes, lines, open, focused }
  return { ...kept, set: decorations(kept, state) }
}

export const checklistLookExtension = () =>
  createExtension({
    key: 'checklistLook',
    prosemirrorPlugins: [
      new Plugin<State>({
        key,
        state: {
          init: (_, state) => {
            const s = { ...read(state.doc), open: new Set<string>(), focused: false }
            return { ...s, set: decorations(s, state) }
          },
          apply: (tr, s, _old, state) => next(tr, s, state),
        },
        view: (view) => {
          syncCarets(view)
          return { update: syncCarets }
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
          handleDOMEvents: {
            focus: (view) => {
              view.dispatch(view.state.tr.setMeta(key, { focused: true } satisfies Meta))
              return false
            },
            blur: (view) => {
              view.dispatch(view.state.tr.setMeta(key, { focused: false } satisfies Meta))
              return false
            },
          },
        },
      }),
    ],
  } as const)
