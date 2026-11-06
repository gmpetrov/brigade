// Where a line dragged by its handle lands: in the gap between lines nearest the pointer,
// by height alone, as the drop line shows it. BlockNote places both the line and the drop
// from the text position under the pointer (ProseMirror's `dropPoint`), which follows the
// characters rather than what is on screen: the line lagged half a line behind the pointer,
// vanished over some lines, and in the margin beside the lines differed between BlockNote's
// two passes over each `dragover`, so it moved on every event. Lines a list's filter hides
// take no room: the gap goes past them, and the drop line is drawn here, from the lines on
// screen, since BlockNote draws it from the lines on either side, hidden ones included. An open
// toggle with no sub-lines takes a drop into it, as in Notion: over its lower half or the "Add
// block" button BlockNote shows under it. Text dragged within a line keeps BlockNote's handling.
import { createExtension } from '@blocknote/core'
import type { DropCursorOptions } from '@blocknote/core/extensions'
import { Fragment, type Slice } from '@tiptap/pm/model'
import { Plugin, Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import {
  blockSelection,
  contentRect,
  isBlockSelection,
  selectedLines,
} from '@/components/document-block-select'

/** Whole lines (blocks), as a drag from their handle carries them. */
const isBlocks = (slice: Slice | undefined) =>
  !!slice && slice.content.firstChild?.type.name === 'blockContainer'

/** Where a drop goes, and the drop line for it (viewport px). */
type Target = { pos: number; line: { y: number; left: number; right: number } }

/**
 * The room an open toggle with no sub-lines keeps for them: the "Add block" button BlockNote
 * shows under it (viewport px). None for any other line.
 */
function emptyToggle(view: EditorView, pos: number) {
  const rect = (view.nodeDOM(pos) as HTMLElement | null)
    ?.querySelector(':scope > .bn-block > .bn-toggle-frame > .bn-toggle-add-block-button')
    ?.getBoundingClientRect()
  return rect && rect.height > 0 ? rect : undefined
}

/**
 * The gap nearest to the pointer at (`x`, `y`, viewport px): before the line whose own
 * content (not its sub-lines) is nearest `y`, when `y` is in its top half; else after it,
 * which for a line with sub-lines is before its first one, where the gap shows. Below the
 * last line on screen of a group, the gap is also its parent's end: the pointer left of the
 * line's text takes it out a level, and on, as in Notion. (BlockNote moves a drop beside the
 * lines onto their left edge, so the margin beside them is the outermost level.) After a
 * line, the gap is past the hidden lines that follow it: they belong with it. An open toggle
 * with no sub-lines reaches down to its "Add block" button: from its middle to there, the drop
 * goes into it, as its first sub-line; below that, after it.
 */
export function dropTarget(view: EditorView, x: number, y: number): Target | undefined {
  const { doc } = view.state
  const shown: { pos: number; rect: DOMRect; bottom: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const rect = contentRect(view, pos)
    if (rect) shown.push({ pos, rect, bottom: emptyToggle(view, pos)?.bottom ?? rect.bottom })
    return true
  })
  if (!shown.length) return undefined
  const distance = (s: (typeof shown)[number]) =>
    y < s.rect.top ? s.rect.top - y : y > s.bottom ? y - s.bottom : 0
  let i = 0
  shown.forEach((s, j) => {
    if (distance(s) < distance(shown[i]!)) i = j
  })
  const { pos, rect, bottom } = shown[i]!
  // The drop line, between two lines on screen: from the bottom of the one above to the top of
  // the one below.
  const between = (above: number | undefined, below: number | undefined, level: DOMRect) => ({
    y: above !== undefined && below !== undefined ? (above + below) / 2 : (above ?? below!),
    left: level.left,
    right: level.right,
  })
  if (y < (rect.top + rect.bottom) / 2)
    return { pos, line: between(shown[i - 1]?.bottom, rect.top, rect) }
  const node = doc.nodeAt(pos)!
  // An open toggle with no sub-lines: into it, above the middle of its "Add block" button.
  const room = emptyToggle(view, pos)
  if (room && y < (room.top + room.bottom) / 2)
    return { pos: pos + node.nodeSize - 1, line: between(rect.bottom, room.top, rect) }
  const line = (level: DOMRect) => between(bottom, shown[i + 1]?.rect.top, level)
  // Sub-lines on screen: before the first one (hidden ones belong with the line), at its level.
  const next = shown[i + 1]
  if (node.childCount > 1 && next && next.pos < pos + node.nodeSize)
    return { pos: pos + 1 + node.firstChild!.nodeSize + 1, line: line(next.rect) }
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

/** Whether only lines a list's filter hides lie between `from` and `to`, in one group. */
function onlyHidden(view: EditorView, from: number, to: number) {
  if (to <= from) return false
  const $from = view.state.doc.resolve(from)
  const $to = view.state.doc.resolve(to)
  if ($from.parent !== $to.parent) return false
  for (let i = $from.index(), pos = from; i < $to.index(); pos += $from.parent.child(i++).nodeSize)
    if (contentRect(view, pos)) return false
  return true
}

/** The drop line, at the gap `dropTarget` picks. */
export const blockDropCursor = (): DropCursorOptions => ({
  // A thin line in the brand's colour (globals.css), rather than BlockNote's thick pale one.
  width: 3,
  color: false,
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
    // Before BlockNote's own drop into a toggle, which the drop line can show at the same place:
    // this one also knows the lines a list's filter hides, and keeps lines selected together.
    runsBefore: ['dropCursor'],
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
            // Lines selected together (document-block-select) stay selected where they land.
            const together = moved && isBlockSelection(tr.selection)
            let content = slice.content
            if (moved) {
              const { from, to } = tr.selection
              // Onto themselves, or past only hidden lines: nothing moves.
              if ((target >= from && target <= to) || onlyHidden(view, to, target)) return true
              if (together) {
                // Only the lines on screen move: lines a list's filter hides between them stay.
                const shown = selectedLines(tr.doc, from, to).filter((l) =>
                  contentRect(view, l.pos),
                )
                content = Fragment.from(shown.map((l) => l.node))
                for (const l of shown.reverse()) tr.delete(l.pos, l.pos + l.node.nodeSize)
              } else tr.deleteSelection()
            }
            let at = tr.mapping.map(target)
            // Into a line with no sub-lines yet (an open toggle): they start its group.
            if (tr.doc.resolve(at).parent.type.name === 'blockContainer') {
              tr.insert(at, tr.doc.type.schema.nodes.blockGroup!.create(null, content))
              at += 1
            } else tr.insert(at, content)
            tr.setSelection(
              together
                ? blockSelection(tr.doc, at, at + content.size)
                : Selection.near(tr.doc.resolve(at + 1)),
            )
            view.dispatch(tr.setMeta('uiEvent', 'drop'))
            return true
          },
        },
      }),
    ],
  } as const)
}
