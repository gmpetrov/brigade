// Where a line dragged by its handle lands: in the gap between lines nearest the pointer,
// by height alone, as the drop line shows it. BlockNote places both the line and the drop
// from the text position under the pointer (ProseMirror's `dropPoint`), which follows the
// characters rather than what is on screen: the line lagged half a line behind the pointer,
// vanished over some lines, and in the margin beside the lines differed between BlockNote's
// two passes over each `dragover`, so it moved on every event. Text dragged within a line
// keeps BlockNote's handling.
import { createExtension } from '@blocknote/core'
import type { DropCursorOptions } from '@blocknote/core/extensions'
import type { Slice } from '@tiptap/pm/model'
import { Plugin, Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Whole lines (blocks), as a drag from their handle carries them. */
const isBlocks = (slice: Slice | undefined) =>
  !!slice && slice.content.firstChild?.type.name === 'blockContainer'

/** The rect of a line's own content, not its sub-lines. */
const contentRect = (view: EditorView, pos: number) =>
  (view.nodeDOM(pos) as HTMLElement | null)
    ?.querySelector(':scope > .bn-block > .bn-block-content')
    ?.getBoundingClientRect()

/**
 * The gap nearest to the pointer at (`x`, `y`, viewport px): before the line whose own
 * content (not its sub-lines) is nearest `y`, when `y` is in its top half; else after it,
 * which for a line with sub-lines is before its first one, where the gap shows. Below a
 * last sub-line, the gap is also its parent's end: the pointer left of the sub-line's text
 * takes it out a level, and on, as in Notion. (BlockNote moves a drop beside the lines onto
 * their left edge, so the margin beside them is the outermost level.)
 */
export function dropTarget(view: EditorView, x: number, y: number) {
  let best: { pos: number; distance: number; below: boolean } | undefined
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const rect = contentRect(view, pos)
    // A line a list's filter hides takes no room.
    if (!rect || rect.height === 0) return true
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    if (!best || distance < best.distance)
      best = { pos, distance, below: y >= (rect.top + rect.bottom) / 2 }
    return true
  })
  if (!best) return undefined
  const { doc } = view.state
  let pos = best.pos
  let node = doc.nodeAt(pos)!
  if (!best.below) return pos
  if (node.childCount > 1) return pos + 1 + node.firstChild!.nodeSize + 1
  for (;;) {
    const $pos = doc.resolve(pos)
    const last = $pos.index() === $pos.parent.childCount - 1
    const left = contentRect(view, pos)?.left
    // The root group sits in the document: a line there has no parent line.
    if (!last || $pos.depth < 3 || left === undefined || x >= left) break
    pos = $pos.before($pos.depth - 1)
    node = doc.nodeAt(pos)!
  }
  return pos + node.nodeSize
}

/** The drop line, at the gap `dropTarget` picks. */
export const blockDropCursor = (): DropCursorOptions => ({
  hooks: {
    computeDropPosition: ({ view, event, defaultPosition }) => {
      if (!isBlocks(view.dragging?.slice)) return defaultPosition
      const pos = dropTarget(view, event.clientX, event.clientY)
      return pos === undefined ? defaultPosition : { pos, orientation: 'block-horizontal' }
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
            const target = dropTarget(view, event.clientX, event.clientY)
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
