// Where a line dragged by its handle lands: in the gap between lines nearest the pointer,
// by height alone, as the drop line shows it. BlockNote places both the line and the drop
// from the text position under the pointer (ProseMirror's `dropPoint`), which follows the
// characters rather than what is on screen: the line lagged half a line behind the pointer,
// vanished over some lines, and in the margin beside the lines differed between BlockNote's
// two passes over each `dragover`, so it moved on every event. Lines a list's filter hides
// take no room: the gap goes past them, and the drop line is drawn here, from the lines on
// screen, since BlockNote draws it from the lines on either side, hidden ones included. Text
// dragged within a line keeps BlockNote's handling.
import { createExtension } from '@blocknote/core'
import type { DropCursorOptions } from '@blocknote/core/extensions'
import type { Slice } from '@tiptap/pm/model'
import { Plugin, Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Whole lines (blocks), as a drag from their handle carries them. */
const isBlocks = (slice: Slice | undefined) =>
  !!slice && slice.content.firstChild?.type.name === 'blockContainer'

/** The rect of a line's own content, not its sub-lines; none when a list's filter hides it. */
function contentRect(view: EditorView, pos: number) {
  const rect = (view.nodeDOM(pos) as HTMLElement | null)
    ?.querySelector(':scope > .bn-block > .bn-block-content')
    ?.getBoundingClientRect()
  return rect && rect.height > 0 ? rect : undefined
}

/** Where a drop goes, and the drop line for it (viewport px). */
type Target = { pos: number; line: { y: number; left: number; right: number } }

/**
 * The gap nearest to the pointer at (`x`, `y`, viewport px): before the line whose own
 * content (not its sub-lines) is nearest `y`, when `y` is in its top half; else after it,
 * which for a line with sub-lines is before its first one, where the gap shows. Below the
 * last line on screen of a group, the gap is also its parent's end: the pointer left of the
 * line's text takes it out a level, and on, as in Notion. (BlockNote moves a drop beside the
 * lines onto their left edge, so the margin beside them is the outermost level.) After a
 * line, the gap is past the hidden lines that follow it: they belong with it.
 */
export function dropTarget(view: EditorView, x: number, y: number): Target | undefined {
  const { doc } = view.state
  const shown: { pos: number; rect: DOMRect }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const rect = contentRect(view, pos)
    if (rect) shown.push({ pos, rect })
    return true
  })
  if (!shown.length) return undefined
  const distance = (r: DOMRect) => (y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0)
  let i = 0
  shown.forEach((s, j) => {
    if (distance(s.rect) < distance(shown[i]!.rect)) i = j
  })
  const { pos, rect } = shown[i]!
  // The drop line, between two lines on screen.
  const between = (above: DOMRect | undefined, below: DOMRect | undefined, level: DOMRect) => ({
    y: above && below ? (above.bottom + below.top) / 2 : (above?.bottom ?? below!.top),
    left: level.left,
    right: level.right,
  })
  if (y < (rect.top + rect.bottom) / 2)
    return { pos, line: between(shown[i - 1]?.rect, rect, rect) }
  const line = (level: DOMRect) => between(rect, shown[i + 1]?.rect, level)
  const node = doc.nodeAt(pos)!
  // Sub-lines on screen: before the first one (hidden ones belong with the line).
  const next = shown[i + 1]
  if (node.childCount > 1 && next && next.pos < pos + node.nodeSize)
    return { pos: pos + 1 + node.firstChild!.nodeSize + 1, line: line(rect) }
  let at = pos
  let level = rect
  for (;;) {
    // Past the hidden lines that follow, to the next one on screen or the group's end.
    const $at = doc.resolve(at)
    const group = $at.parent
    let index = $at.index()
    let end = at + group.child(index).nodeSize
    while (++index < group.childCount && !contentRect(view, end)) end += group.child(index).nodeSize
    const last = index === group.childCount
    // The root group sits in the document: a line there has no parent line.
    if (!last || $at.depth < 3 || x >= level.left) return { pos: end, line: line(level) }
    at = $at.before($at.depth - 1)
    level = contentRect(view, at) ?? level
  }
}

/**
 * BlockNote's drop line, moved to `line`. It draws it from the lines on either side of the
 * gap, and a hidden one has no place on screen. Written only when it moves: each write
 * makes the next `dragover` recompute the page's styles.
 */
function placeLine(view: EditorView, line: Target['line']) {
  const parent = view.dom?.offsetParent as HTMLElement | null
  const element = parent?.querySelector<HTMLElement>(':scope > .prosemirror-dropcursor-block')
  if (!parent || !element) return
  const box = parent.getBoundingClientRect()
  const height = element.offsetHeight
  const style = {
    left: `${line.left - box.left + parent.scrollLeft}px`,
    top: `${line.y - height / 2 - box.top + parent.scrollTop}px`,
    width: `${line.right - line.left}px`,
  }
  for (const [key, value] of Object.entries(style))
    if (element.style[key as 'left'] !== value) element.style[key as 'left'] = value
}

/** The drop line, at the gap `dropTarget` picks. */
export const blockDropCursor = (): DropCursorOptions => ({
  hooks: {
    computeDropPosition: ({ view, event, defaultPosition }) => {
      if (!isBlocks(view.dragging?.slice)) return defaultPosition
      const target = dropTarget(view, event.clientX, event.clientY)
      if (!target) return defaultPosition
      // After BlockNote has drawn it, in this same event.
      queueMicrotask(() => placeLine(view, target.line))
      return { pos: target.pos, orientation: 'block-horizontal' }
    },
  },
})

/**
 * The drop, at the same gap. A drop can reach the editor twice (at the pointer, and again
 * moved onto the lines when it is beside them): the first one moves the lines.
 */
export const blockDropExtension = () => {
  const done = new WeakSet<DataTransfer>()
  return createExtension({
    key: 'blockDrop',
    prosemirrorPlugins: [
      new Plugin({
        props: {
          handleDrop: (view, event, slice, moved) => {
            if (!isBlocks(slice)) return false
            const transfer = event.dataTransfer
            if (transfer && done.has(transfer)) return true
            const target = dropTarget(view, event.clientX, event.clientY)?.pos
            if (target === undefined) return false
            if (transfer) done.add(transfer)
            const tr = view.state.tr
            if (moved) {
              const { from, to } = tr.selection
              // Onto themselves: nothing moves.
              if (target >= from && target <= to) return true
              tr.deleteSelection()
            }
            const at = tr.mapping.map(target)
            tr.insert(at, slice.content)
            tr.setSelection(Selection.near(tr.doc.resolve(at + 1)))
            view.dispatch(tr.setMeta('uiEvent', 'drop'))
            return true
          },
        },
      }),
    ],
  } as const)
}
