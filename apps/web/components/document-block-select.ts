// Whole lines selected, as in Notion, beside the text selection. A drag started in the margin
// (anywhere but a line's text) draws a box that selects the lines it touches; Escape selects the
// line the cursor is in, and Escape again lets go of it. Shift with a click or ↑/↓ extends it,
// ↑/↓ alone moves it. While lines are selected: Backspace or Delete removes them, ⌘C, ⌘X and
// ⌘V copy, cut and paste (after them), ⌘D duplicates them, Tab and Shift+Tab indent and outdent
// them, their handle drags them all, and typing, Enter or a click elsewhere lets go of them
// (typing and Enter go on at the end of the last one).
//
// The selection is BlockNote's own for dragging several lines (`MultipleNodeSelection`, read
// through its JSON id since BlockNote does not export it): its handle then drags them all, and
// its copy and cut carry them whole. It spans whole lines of one level, so lines picked at
// several levels select the lines that hold them. Lines a list's filter hides are left out of
// what is removed, copied or duplicated: only what the person sees selected is.
import { createExtension, type BlockNoteEditor } from '@blocknote/core'
import { Fragment, Slice, type Node, type ResolvedPos } from '@tiptap/pm/model'
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

/** The lines the person anchored the selection on and moves its end with, by id. */
type Ends = { anchor: string; head: string }

const key = new PluginKey<Ends | null>('blockSelect')

/** BlockNote's selection of whole lines (its `MultipleNodeSelection`). */
export const isBlockSelection = (selection: Selection) =>
  (selection as Selection & { jsonID?: string }).jsonID === 'multiple-node'

type LinesClass = new ($anchor: ResolvedPos, $head: ResolvedPos) => Selection
let linesClass: LinesClass | undefined

/**
 * BlockNote's `MultipleNodeSelection`, which it registers under its JSON id but does not
 * export. ProseMirror's `Selection.fromJSON` hands the JSON to the class registered for it,
 * as `cls.fromJSON`; this class has none of its own, so that is `Selection.fromJSON` again,
 * called on the class: for one call, that call names it.
 */
function multipleNodeSelection(doc: Node): LinesClass {
  if (linesClass) return linesClass
  const original = Selection.fromJSON
  const found = new Error('found')
  Selection.fromJSON = function (this: unknown, ...args: Parameters<typeof original>) {
    if (this !== Selection) {
      linesClass = this as LinesClass
      throw found
    }
    return original.apply(this, args)
  }
  try {
    Selection.fromJSON(doc, { type: 'multiple-node', anchor: 0, head: 0 })
  } catch (error) {
    if (error !== found) throw error
  } finally {
    Selection.fromJSON = original
  }
  if (!linesClass) throw new Error("BlockNote's selection of lines is not registered")
  return linesClass
}

/** Whole lines, from just before the first (`from`) to just after the last (`to`), one level. */
export const blockSelection = (doc: Node, from: number, to: number) => {
  const Lines = multipleNodeSelection(doc)
  return new Lines(doc.resolve(from), doc.resolve(to))
}

/** The rect of a line's own content, not its sub-lines; none when a list's filter hides it. */
export function contentRect(view: EditorView, pos: number) {
  const rect = (view.nodeDOM(pos) as HTMLElement | null)
    ?.querySelector(':scope > .bn-block > .bn-block-content')
    ?.getBoundingClientRect()
  return rect && rect.height > 0 ? rect : undefined
}

const isLine = (node: Node) => node.type.name === 'blockContainer'

/** Where the line with this id is (just before it). */
export function linePos(doc: Node, id: string) {
  let at: number | undefined
  doc.descendants((node, pos) => {
    if (at !== undefined) return false
    if (isLine(node) && node.attrs.id === id) {
      at = pos
      return false
    }
    return true
  })
  return at
}

/** The line a position is in (just before it), the innermost. */
function lineAround($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--)
    if (isLine($pos.node(depth))) return $pos.before(depth)
  return undefined
}

/**
 * The lines from the one at `a` to the one at `b` (positions just before them, in any order),
 * whole: at the level of the group that holds both, so a line picked inside another selects
 * that one, with its sub-lines.
 */
export function lineRange(doc: Node, a: number, b: number) {
  if (b < a) [a, b] = [b, a]
  const $a = doc.resolve(a)
  const $b = doc.resolve(b)
  let depth = $a.sharedDepth(b)
  while (depth > 0 && $a.node(depth).type.name !== 'blockGroup') depth--
  const from = depth === $a.depth ? a : $a.before(depth + 1)
  const to = depth === $b.depth ? b + doc.nodeAt(b)!.nodeSize : $b.after(depth + 1)
  return { from, to }
}

/** The lines a selection of lines holds, each with its sub-lines. */
export function selectedLines(doc: Node, from: number, to: number) {
  const lines: { pos: number; node: Node }[] = []
  const $from = doc.resolve(from)
  const group = $from.parent
  for (let i = $from.index(), pos = from; pos < to && i < group.childCount; i++) {
    const node = group.child(i)
    lines.push({ pos, node })
    pos += node.nodeSize
  }
  return lines
}

/** Every line on screen (just before each), in the document's order, sub-lines included. */
export function shownLines(doc: Node, shown: (pos: number) => boolean) {
  const all: number[] = []
  doc.descendants((node, pos) => {
    if (!isLine(node)) return true
    if (shown(pos)) all.push(pos)
    return true
  })
  return all
}

/**
 * Where the end of the selection goes with Shift+↑/↓: past the selection when it grows (the
 * end is on that side of the anchor, or on it), else to the line after or before the end.
 */
export function extendTo(
  doc: Node,
  lines: number[],
  ends: { anchor: number; head: number },
  down: boolean,
) {
  const { anchor, head } = ends
  const range = lineRange(doc, anchor, head)
  if (down)
    return head >= anchor
      ? lines.find((p) => p >= range.to)
      : lines.find((p) => p >= head + doc.nodeAt(head)!.nodeSize)
  return head <= anchor ? lines.findLast((p) => p < range.from) : lines.findLast((p) => p < head)
}

/** Where ↑/↓ alone moves the selection: the line on screen after or before it. */
export function moveTo(lines: number[], ends: { anchor: number; head: number }, down: boolean) {
  const { anchor, head } = ends
  return down
    ? (lines.find((p) => p > Math.max(anchor, head)) ?? Math.max(anchor, head))
    : (lines.findLast((p) => p < Math.min(anchor, head)) ?? Math.min(anchor, head))
}

/** The cursor at the end of a line's own text. */
function endOf(doc: Node, pos: number) {
  const line = doc.nodeAt(pos)
  if (!line?.firstChild) return Selection.near(doc.resolve(Math.min(pos, doc.content.size)))
  return Selection.near(doc.resolve(pos + 1 + line.firstChild.nodeSize - 1), -1)
}

/** The ends of the selection of lines in `state`, as positions: the anchored ones, else its first and last. */
function endsOf(state: EditorState) {
  const { selection, doc } = state
  if (!isBlockSelection(selection)) return undefined
  const lines = selectedLines(doc, selection.from, selection.to)
  if (!lines.length) return undefined
  const ids = key.getState(state)
  const inside = (pos: number | undefined) =>
    pos !== undefined && pos >= selection.from && pos < selection.to ? pos : undefined
  const anchor = ids ? inside(linePos(doc, ids.anchor)) : undefined
  const head = ids ? inside(linePos(doc, ids.head)) : undefined
  if (anchor !== undefined && head !== undefined) return { anchor, head }
  return { anchor: lines[0]!.pos, head: lines.at(-1)!.pos }
}

/** Selects the lines from the one at `anchor` to the one at `head`. */
function select(view: EditorView, anchor: number, head: number) {
  const { doc } = view.state
  const { from, to } = lineRange(doc, anchor, head)
  const ends: Ends = {
    anchor: doc.nodeAt(anchor)!.attrs.id as string,
    head: doc.nodeAt(head)!.attrs.id as string,
  }
  const tr = view.state.tr.setSelection(blockSelection(doc, from, to)).setMeta(key, ends)
  view.dispatch(tr.scrollIntoView())
}

/** Lets go of the lines: the cursor at the end of the last one moved to, the editor's focus as it is. */
function release(view: EditorView) {
  const { selection, doc } = view.state
  if (!isBlockSelection(selection)) return
  const ends = endsOf(view.state)
  view.dispatch(
    view.state.tr.setSelection(
      ends ? endOf(doc, ends.head) : Selection.near(doc.resolve(selection.from)),
    ),
  )
}

/** Whether a line is on screen (a list's filter hides some). */
const isShown = (view: EditorView) => (pos: number) => {
  const dom = view.nodeDOM(pos) as HTMLElement | null
  return !!dom && dom.getClientRects().length > 0
}

/** The selected lines on screen: those removed, copied or duplicated. */
function chosen(view: EditorView) {
  const { selection, doc } = view.state
  if (!isBlockSelection(selection)) return []
  const shown = isShown(view)
  return selectedLines(doc, selection.from, selection.to).filter((l) => shown(l.pos))
}

type Editor = BlockNoteEditor<any, any, any>

/** The selected lines on screen as the clipboard carries them: whole, for BlockNote; HTML and Markdown elsewhere. */
function toClipboard(view: EditorView, editor: Editor, data: DataTransfer) {
  const lines = chosen(view)
  if (!lines.length) return false
  const slice = new Slice(Fragment.from(lines.map((l) => l.node)), 0, 0)
  const blocks = lines.map((l) => editor.getBlock(l.node.attrs.id as string)).filter((b) => !!b)
  data.clearData()
  data.setData('blocknote/html', view.serializeForClipboard(slice).dom.innerHTML)
  data.setData('text/html', editor.blocksToHTMLLossy(blocks))
  data.setData('text/plain', editor.blocksToMarkdownLossy(blocks))
  return true
}

function remove(view: EditorView, editor: Editor) {
  const lines = chosen(view)
  if (!lines.length) return
  const from = lines[0]!.pos
  editor.removeBlocks(lines.map((l) => l.node.attrs.id as string))
  const { doc } = view.state
  view.dispatch(
    view.state.tr.setSelection(Selection.near(doc.resolve(Math.min(from, doc.content.size)))),
  )
}

/** A block as BlockNote reads it, without its ids, so its copy gets new ones. */
type Copy = { id?: string; children?: Copy[] }
const withoutIds = ({ id: _id, children, ...block }: Copy): Copy => ({
  ...block,
  children: children?.map(withoutIds),
})

function duplicate(view: EditorView, editor: Editor) {
  const lines = chosen(view)
  if (!lines.length) return
  const blocks = lines.map((l) => editor.getBlock(l.node.attrs.id as string)).filter((b) => !!b)
  const copies = editor.insertBlocks(
    blocks.map((b) => withoutIds(b as Copy)) as never,
    lines.at(-1)!.node.attrs.id as string,
    'after',
  ) as { id: string }[]
  if (!copies.length) return
  const { doc } = view.state
  const first = linePos(doc, copies[0]!.id)
  const last = linePos(doc, copies.at(-1)!.id)
  if (first !== undefined && last !== undefined) select(view, first, last)
}

/** Indents (or outdents) the selected lines, as Tab does over text across them, and keeps them selected. */
function indent(view: EditorView, editor: Editor, out: boolean) {
  const ends = endsOf(view.state)
  if (!ends) return
  const { doc } = view.state
  const ids = {
    anchor: doc.nodeAt(ends.anchor)!.attrs.id as string,
    head: doc.nodeAt(ends.head)!.attrs.id as string,
  }
  const { from, to } = view.state.selection
  const lines = selectedLines(doc, from, to)
  const start = Selection.near(doc.resolve(from + 1))
  const end = endOf(doc, lines.at(-1)!.pos)
  view.dispatch(view.state.tr.setSelection(TextSelection.between(start.$from, end.$to)))
  if (out) editor.unnestBlock()
  else if (editor.canNestBlock()) editor.nestBlock()
  const after = view.state.doc
  const anchor = linePos(after, ids.anchor)
  const head = linePos(after, ids.head)
  if (anchor !== undefined && head !== undefined) select(view, anchor, head)
}

/** Escape over text: the lines the cursor or the selection is in. */
function selectAround(view: EditorView) {
  const { selection, doc } = view.state
  const node = selection instanceof NodeSelection ? selection.node : undefined
  const anchor = node && isLine(node) ? selection.from : lineAround(doc.resolve(selection.from))
  const head = node && isLine(node) ? selection.from : lineAround(doc.resolve(selection.to))
  if (anchor === undefined || head === undefined) return false
  select(view, anchor, head)
  return true
}

/** Menus and dialogs that take Escape first (as the side panels' Escape knows them). */
const OPEN_LAYER =
  '.bn-suggestion-menu, .bn-grid-suggestion-menu, .bn-panel, .bn-menu-dropdown, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** Over the editor, not around it (the editor may sit in a dialog). */
const layerOpen = (view: EditorView) =>
  [...document.querySelectorAll(OPEN_LAYER)].some((el) => !el.contains(view.dom))

function onKeyDown(view: EditorView, editor: Editor, event: KeyboardEvent) {
  if (event.isComposing || !view.editable) return
  // A selection the browser has just made (a click) and ProseMirror not yet read: read it now.
  const observer = (view as EditorView & { domObserver?: { flush?: () => void } }).domObserver
  observer?.flush?.()
  const take = () => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const blocks = isBlockSelection(view.state.selection)
  if (event.key === 'Escape') {
    if (layerOpen(view)) return
    if (blocks) {
      release(view)
      view.dom.blur()
    } else if (!selectAround(view)) return
    take()
    return
  }
  if (!blocks) return
  const ends = endsOf(view.state)
  if (!ends) return
  const mod = event.metaKey || event.ctrlKey
  const { doc } = view.state
  if (event.key === 'Backspace' || event.key === 'Delete') {
    take()
    remove(view, editor)
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !mod && !event.altKey) {
    take()
    const down = event.key === 'ArrowDown'
    const lines = shownLines(doc, isShown(view))
    if (event.shiftKey) {
      const head = extendTo(doc, lines, ends, down)
      if (head !== undefined) select(view, ends.anchor, head)
    } else {
      const to = moveTo(lines, ends, down)
      select(view, to, to)
    }
  } else if (event.key === 'Tab' && !mod && !event.altKey) {
    take()
    indent(view, editor, event.shiftKey)
  } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
    take()
    duplicate(view, editor)
  } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
    take()
    const top = selectedLines(doc, 1, doc.content.size - 1)
    if (top.length) select(view, top[0]!.pos, top.at(-1)!.pos)
  } else if (event.key === 'Enter' && !mod) {
    take()
    release(view)
  } else if (
    (event.key.length === 1 && !mod && !event.altKey) ||
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight'
  ) {
    // Typing goes on at the end of the last line moved to.
    release(view)
  }
}

/**
 * Where a press starts a box rather than text: not on a line's text, a control or a menu. Beside
 * the editor too, on the page or panel around it, level with it: its own margin holds the
 * lines' handles.
 */
function inMargin(view: EditorView, area: Element, target: Element, y: number) {
  if (target !== area && target.contains(area)) {
    const rect = area.getBoundingClientRect()
    return y >= rect.top && y <= rect.bottom
  }
  if (!area.contains(target)) return false
  if (target.closest('.bn-block-content, button, a, input, textarea, select, [role="button"]'))
    return false
  // The editor's own surface, or the room around it, not its menus and toolbars.
  return (
    view.dom.contains(target) || !target.closest('.bn-container') || target.matches('.bn-container')
  )
}

/** The nearest element that scrolls, for the box to scroll the page past its edge. */
function scroller(el: Element | null): Element {
  for (let node = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node
  }
  return document.scrollingElement ?? document.documentElement
}

/** The lines on screen whose own content the box (viewport px) touches: the first and last. */
function touched(
  view: EditorView,
  box: { left: number; right: number; top: number; bottom: number },
) {
  let first: number | undefined
  let last: number | undefined
  view.state.doc.descendants((node, pos) => {
    if (!isLine(node)) return true
    const rect = contentRect(view, pos)
    if (
      rect &&
      rect.bottom >= box.top &&
      rect.top <= box.bottom &&
      rect.right >= box.left &&
      rect.left <= box.right
    ) {
      first ??= pos
      last = pos
    }
    return true
  })
  return first === undefined || last === undefined ? undefined : { first, last }
}

/** The line at a height on screen, or the nearest one. */
function lineAt(view: EditorView, y: number) {
  let best: { pos: number; distance: number } | undefined
  view.state.doc.descendants((node, pos) => {
    if (!isLine(node)) return true
    const rect = contentRect(view, pos)
    if (!rect) return true
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    if (!best || distance < best.distance || (distance === 0 && best.distance === 0))
      best = { pos, distance }
    return true
  })
  return best?.pos
}

const THRESHOLD = 4
const EDGE = 40

/** A press in the margin: a box once it moves, else a click (the cursor where it fell, as before). */
function onMouseDown(view: EditorView, event: MouseEvent) {
  if (event.button !== 0 || !view.editable) return
  const area = view.dom.closest('[data-block-select]') ?? view.dom
  const target = event.target as Element | null
  if (!target) return
  const margin = inMargin(view, area, target, event.clientY)
  const blocks = isBlockSelection(view.state.selection)
  if (!margin && !area.contains(target)) {
    // A press elsewhere lets go of the lines, unless on the editor's menus or a dialog.
    if (
      blocks &&
      !target.closest(`.bn-container, [data-radix-popper-content-wrapper], ${OPEN_LAYER}`)
    )
      release(view)
    return
  }
  // Shift+click extends the lines selected to the line clicked.
  if (blocks && event.shiftKey && (margin || view.dom.contains(target))) {
    const ends = endsOf(view.state)
    const head = lineAt(view, event.clientY)
    if (ends && head !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      select(view, ends.anchor, head)
      return
    }
  }
  if (!margin) {
    // A press on a line's text lets go of the lines first, for the editor to place its cursor.
    if (blocks && view.dom.contains(target)) release(view)
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const scrolling = scroller(area)
  const startX = event.clientX
  const startY = event.clientY + scrolling.scrollTop
  let x = event.clientX
  let y = event.clientY
  let box: HTMLDivElement | undefined
  let frame = 0
  let picked = ''

  const update = () => {
    frame = 0
    if (!box) return
    // Past the top or bottom edge, the page scrolls on under the box.
    const edge =
      scrolling === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scrolling.getBoundingClientRect()
    const speed =
      y < edge.top + EDGE
        ? -(edge.top + EDGE - y)
        : y > edge.bottom - EDGE
          ? y - (edge.bottom - EDGE)
          : 0
    if (speed) scrolling.scrollTop += Math.max(-24, Math.min(24, speed / 2))
    const top = Math.min(startY - scrolling.scrollTop, y)
    const bottom = Math.max(startY - scrolling.scrollTop, y)
    const left = Math.min(startX, x)
    const right = Math.max(startX, x)
    Object.assign(box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    })
    const hit = touched(view, { left, right, top, bottom })
    const next = hit ? `${hit.first}:${hit.last}` : ''
    if (next !== picked) {
      picked = next
      if (hit) select(view, hit.first, hit.last)
      else release(view)
    }
    if (speed) frame = requestAnimationFrame(update)
  }

  const move = (e: MouseEvent) => {
    x = e.clientX
    y = e.clientY
    if (!box) {
      if (Math.hypot(x - startX, y - (startY - scrolling.scrollTop)) < THRESHOLD) return
      box = document.createElement('div')
      box.className = 'block-select-box'
      document.body.appendChild(box)
    }
    e.preventDefault()
    if (!frame) frame = requestAnimationFrame(update)
  }

  const up = (e: MouseEvent) => {
    window.removeEventListener('mousemove', move, true)
    window.removeEventListener('mouseup', up, true)
    cancelAnimationFrame(frame)
    if (box) {
      box.remove()
      if (isBlockSelection(view.state.selection)) view.focus()
      return
    }
    // A click: the cursor where it fell in the editor, as ProseMirror would put it; around it, nothing.
    if (view.dom.contains(target)) {
      const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (at) {
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at.pos))))
        view.focus()
        return
      }
    }
    if (isBlockSelection(view.state.selection)) release(view)
  }

  window.addEventListener('mousemove', move, true)
  window.addEventListener('mouseup', up, true)
}

/**
 * Pasting over selected lines puts what is pasted after them, rather than in their place:
 * the selection becomes the gap after the last one, where BlockNote's paste then lands.
 */
function onPaste(view: EditorView) {
  const { selection, doc } = view.state
  if (!isBlockSelection(selection)) return
  const before = view.state.doc
  const gap = blockSelection(doc, selection.to, selection.to)
  view.dispatch(view.state.tr.setSelection(gap))
  // Nothing pasted (an empty clipboard, or one BlockNote takes no part of): the lines again.
  setTimeout(() => {
    if (view.isDestroyed || view.state.doc !== before || !view.state.selection.eq(gap)) return
    view.dispatch(view.state.tr.setSelection(blockSelection(before, selection.from, selection.to)))
  })
}

function decorations(state: EditorState) {
  const { selection, doc } = state
  if (!isBlockSelection(selection)) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    selectedLines(doc, selection.from, selection.to).map((l) =>
      Decoration.node(l.pos, l.pos + l.node.nodeSize, { class: 'bn-line-selected' }),
    ),
  )
}

/**
 * BlockNote's selected blocks, for its toolbar and menus (and Hand to): over lines selected
 * whole, those on screen. Its own reading takes the line after the last one too, as the
 * selection ends past it.
 */
function selectedBlocks(editor: Editor) {
  const original = editor.getSelection.bind(editor)
  editor.getSelection = () => {
    const view = editor.prosemirrorView
    if (!view || !isBlockSelection(view.state.selection)) return original()
    const blocks = chosen(view)
      .map((l) => editor.getBlock(l.node.attrs.id as string))
      .filter((b) => !!b)
    return blocks.length ? { blocks } : original()
  }
}

export const blockSelectExtension = createExtension(({ editor }: { editor: Editor }) => {
  selectedBlocks(editor)
  return extension(editor)
})

const extension = (editor: Editor) => ({
  key: 'blockSelect',
  prosemirrorPlugins: [
    new Plugin<Ends | null>({
      key,
      state: {
        init: () => null,
        apply: (tr, ends, _old, state) => {
          const meta = tr.getMeta(key) as Ends | null | undefined
          if (meta !== undefined) return meta
          if (isBlockSelection(state.selection)) return ends
          // A collaborator's edit maps the selection as text: put the lines back (below).
          if (ends && tr.getMeta('y-sync$')) return ends
          return null
        },
      },
      appendTransaction: (_trs, _old, state) => {
        const ends = key.getState(state)
        if (!ends || isBlockSelection(state.selection)) return null
        const anchor = linePos(state.doc, ends.anchor)
        const head = linePos(state.doc, ends.head)
        const tr = state.tr
        if (anchor === undefined || head === undefined) return tr.setMeta(key, null)
        const { from, to } = lineRange(state.doc, anchor, head)
        return tr.setSelection(blockSelection(state.doc, from, to)).setMeta(key, ends)
      },
      view: (view) => {
        const keydown = (e: KeyboardEvent) => onKeyDown(view, editor, e)
        const mousedown = (e: MouseEvent) => onMouseDown(view, e)
        const copy = (e: ClipboardEvent) => {
          if (!isBlockSelection(view.state.selection) || !e.clipboardData) return
          if (!toClipboard(view, editor, e.clipboardData)) return
          e.preventDefault()
          e.stopImmediatePropagation()
          if (e.type === 'cut' && view.editable) remove(view, editor)
        }
        const paste = () => onPaste(view)
        const dom = view.dom
        // Before ProseMirror's and BlockNote's own handling of the same events.
        dom.addEventListener('keydown', keydown, true)
        dom.addEventListener('copy', copy, true)
        dom.addEventListener('cut', copy, true)
        dom.addEventListener('paste', paste, true)
        document.addEventListener('mousedown', mousedown, true)
        return {
          destroy: () => {
            dom.removeEventListener('keydown', keydown, true)
            dom.removeEventListener('copy', copy, true)
            dom.removeEventListener('cut', copy, true)
            dom.removeEventListener('paste', paste, true)
            document.removeEventListener('mousedown', mousedown, true)
          },
        }
      },
      props: {
        decorations,
        // The browser's own selection, read back as it settles (or as it lands on the lines'
        // edges), would turn the lines into text: they stay, unless the pointer is at work.
        createSelectionBetween: (view) =>
          isBlockSelection(view.state.selection) &&
          !(view as EditorView & { input?: { mouseDown?: unknown } }).input?.mouseDown
            ? view.state.selection
            : null,
        attributes: (state): Record<string, string> =>
          isBlockSelection(state.selection) ? { class: 'bn-lines-selected' } : {},
      },
    }),
  ],
})
