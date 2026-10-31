import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { blockDropCursor, blockDropExtension, dropTarget } from '../components/document-block-drop'

// BlockNote's nesting, without its content types: a line holds its text, then its sub-lines.
const schema = new Schema({
  nodes: {
    doc: { content: 'blockGroup' },
    blockGroup: { content: 'blockContainer+' },
    blockContainer: { content: 'paragraph blockGroup?' },
    paragraph: { content: 'text*' },
    text: { group: 'inline' },
  },
})
const line = (text: string, children: Node[] = []) =>
  schema.node('blockContainer', null, [
    schema.node('paragraph', null, schema.text(text)),
    ...(children.length ? [schema.node('blockGroup', null, children)] : []),
  ])
const outline = (doc: Node): string =>
  doc.type.name === 'blockContainer'
    ? doc.firstChild!.textContent + (doc.childCount > 1 ? `(${outline(doc.lastChild!)})` : '')
    : doc.type.name === 'blockGroup'
      ? Array.from({ length: doc.childCount }, (_, i) => outline(doc.child(i))).join(', ')
      : outline(doc.firstChild!)

const ROW = 30
const INDENT = 24
const LEFT = 100

/**
 * An editor over `lines` with the first `dragged` line dragged by its handle: each line's
 * text a row of 24 px from the top, indented by its depth. Lines whose text starts with `~`
 * are hidden, as a list's filter hides them: they take no row.
 */
function dragging(lines: Node[], dragged: number) {
  const doc = schema.node('doc', null, schema.node('blockGroup', null, lines))
  const rects = new Map<number, DOMRect>()
  const starts: number[] = []
  let row = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const depth = (doc.resolve(pos).depth - 1) / 2
    const hidden = node.firstChild!.textContent.startsWith('~')
    const top = hidden ? 0 : row++ * ROW
    const height = hidden ? 0 : 24
    rects.set(pos, {
      top,
      bottom: top + height,
      height,
      left: LEFT + depth * INDENT,
      right: 800,
    } as DOMRect)
    starts.push(pos)
    return true
  })
  let state = EditorState.create({ doc, selection: NodeSelection.create(doc, starts[dragged]!) })
  const slice = state.selection.content()
  const view = {
    get state() {
      return state
    },
    dragging: { slice, move: true },
    nodeDOM: (pos: number) => ({
      querySelector: () => ({ getBoundingClientRect: () => rects.get(pos) }),
    }),
    dispatch: (tr: Parameters<typeof state.apply>[0]) => void (state = state.apply(tr)),
  }
  const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as DragEvent
  return {
    /** The gap and the drop line for the pointer at (x, y). */
    target: (x: number, y: number) => dropTarget(view as unknown as EditorView, x, y),
    /** The height of the drop line for the pointer at (x, y). */
    lineY: (x: number, y: number) => dropTarget(view as unknown as EditorView, x, y)?.line.y,
    /** Where the drop line goes for the pointer at (x, y). */
    line: (x: number, y: number) =>
      blockDropCursor().hooks!.computeDropPosition!({
        view: view as unknown as EditorView,
        event: at(x, y),
        defaultPosition: null,
      } as never)?.pos,
    /** Drops there (twice, as a drop beside the lines reaches the editor), then the outline. */
    drop: (x: number, y: number) => {
      const handleDrop = blockDropExtension()({} as never).prosemirrorPlugins[0]!.props.handleDrop!
      const transfer = {} as DataTransfer
      for (let i = 0; i < 2; i++)
        handleDrop.call(
          null as never,
          view as unknown as EditorView,
          { ...at(x, y), dataTransfer: transfer } as DragEvent,
          slice,
          true,
        )
      return outline(state.doc)
    },
  }
}

const A = () => line('A')
const BwithC = () => line('B', [line('C')])

test('a line dropped in the top half of another goes before it', () => {
  // Rows: A 0, B 30, C 60, D 90.
  const editor = dragging([A(), BwithC(), line('D')], 0)
  assert.equal(editor.drop(LEFT + 50, 95), 'B(C), A, D')
})

test('a line dropped in the bottom half of one goes after it', () => {
  const editor = dragging([A(), line('B'), line('D')], 0)
  assert.equal(editor.drop(LEFT + 50, 50), 'B, A, D')
})

test('below a line with sub-lines, it goes before its first sub-line', () => {
  const editor = dragging([A(), line('B', [line('C'), line('E')])], 0)
  assert.equal(editor.drop(LEFT + 50, 50), 'B(A, C, E)')
})

test('below a last sub-line, over its text, it becomes the last sub-line', () => {
  const editor = dragging([A(), BwithC()], 0)
  assert.equal(editor.drop(LEFT + INDENT + 10, 80), 'B(C, A)')
})

test('below a last sub-line, left of its text, it goes after the parent line', () => {
  const editor = dragging([A(), BwithC()], 0)
  assert.equal(editor.drop(LEFT + 5, 80), 'B(C), A')
  // In the margin beside the lines too, from the line and the drop alike.
  const again = dragging([A(), BwithC()], 0)
  assert.equal(again.line(LEFT - 40, 80), again.line(LEFT, 80))
  assert.equal(again.drop(LEFT - 40, 80), 'B(C), A')
})

test('out of several levels, as far as the pointer is left', () => {
  const lines = () => [A(), line('B', [line('C', [line('E')])])]
  assert.equal(dragging(lines(), 0).drop(LEFT + 2 * INDENT + 5, 110), 'B(C(E, A))')
  assert.equal(dragging(lines(), 0).drop(LEFT + INDENT + 5, 110), 'B(C(E), A)')
  assert.equal(dragging(lines(), 0).drop(LEFT + 5, 110), 'B(C(E)), A')
})

test('dropped onto itself, nothing moves', () => {
  const editor = dragging([A(), line('B')], 1)
  assert.equal(editor.drop(LEFT + 50, 35), 'A, B')
  assert.equal(editor.drop(LEFT + 50, 50), 'A, B')
})

test('with lines hidden by a filter, a drop after a line goes past its hidden ones', () => {
  // On screen: H1 0, H2 30, H3 60; each heading's paragraph hidden.
  const lines = () => [line('H1'), line('~p1'), line('H2'), line('~p2'), line('H3')]
  // H1 moves alone (its hidden paragraph stays): after H2's paragraph, before H3.
  assert.equal(dragging(lines(), 0).drop(LEFT + 50, 50), '~p1, H2, ~p2, H1, H3')
})

test('with lines hidden by a filter, the drop line sits in the gap on screen', () => {
  const editor = dragging([line('H1'), line('~p1'), line('H2'), line('~p2'), line('H3')], 0)
  // Below H2 (30–54), above H3 (60–84): halfway between them.
  assert.equal(editor.lineY(LEFT + 50, 50), 57)
  // Above H2: between H1 (0–24) and H2.
  assert.equal(editor.lineY(LEFT + 50, 35), 27)
  // Below the last line: at its bottom.
  assert.equal(editor.lineY(LEFT + 50, 80), 84)
})

test('a line whose sub-lines are all hidden: the drop goes after them', () => {
  const editor = dragging([line('A'), line('B', [line('~c')]), line('D')], 0)
  assert.equal(editor.drop(LEFT + 50, 50), 'B(~c), A, D')
})

test('with lines hidden by a filter, dropped onto itself, nothing moves', () => {
  // Its lower half: the gap past its hidden paragraph, still its own place.
  const lines = () => [line('H1'), line('~p1'), line('H2')]
  assert.equal(dragging(lines(), 0).drop(LEFT + 50, 20), 'H1, ~p1, H2')
  assert.equal(dragging(lines(), 0).drop(LEFT + 50, 5), 'H1, ~p1, H2')
  // Just above the next line on screen: the same gap.
  assert.equal(dragging(lines(), 0).drop(LEFT + 50, 32), 'H1, ~p1, H2')
})

test('the gap before a first sub-line is drawn at its level, from either side', () => {
  const editor = dragging([line('A'), line('B', [line('C')])], 0)
  // B's lower half (30–54) and C's upper half (60–84).
  assert.deepEqual(editor.target(LEFT + 50, 50), editor.target(LEFT + 50, 65))
  assert.equal(editor.target(LEFT + 50, 50)?.line.left, LEFT + INDENT)
})
