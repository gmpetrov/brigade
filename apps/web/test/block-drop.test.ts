import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { blockDropCursor, blockDropExtension } from '../components/document-block-drop'

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
 * text a row of 24 px from the top, indented by its depth.
 */
function dragging(lines: Node[], dragged: number) {
  const doc = schema.node('doc', null, schema.node('blockGroup', null, lines))
  const rects = new Map<number, DOMRect>()
  const starts: number[] = []
  let row = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const depth = (doc.resolve(pos).depth - 1) / 2
    const top = row++ * ROW
    rects.set(pos, { top, bottom: top + 24, height: 24, left: LEFT + depth * INDENT } as DOMRect)
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
