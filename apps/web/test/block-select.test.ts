import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import {
  blockSelection,
  extendTo,
  isBlockSelection,
  linePos,
  lineRange,
  moveTo,
  selectedLines,
  shownLines,
} from '../components/document-block-select'

// BlockNote's nesting, without its content types: a line holds its text, then its sub-lines.
const schema = new Schema({
  nodes: {
    doc: { content: 'blockGroup' },
    blockGroup: { content: 'blockContainer+' },
    blockContainer: { content: 'paragraph blockGroup?', attrs: { id: { default: null } } },
    paragraph: { content: 'text*' },
    text: { group: 'inline' },
  },
})
const line = (text: string, children: Node[] = []) =>
  schema.node('blockContainer', { id: text }, [
    schema.node('paragraph', null, schema.text(text)),
    ...(children.length ? [schema.node('blockGroup', null, children)] : []),
  ])
const docOf = (lines: Node[]) => schema.node('doc', null, schema.node('blockGroup', null, lines))
const at = (doc: Node, id: string) => linePos(doc, id)!
const texts = (doc: Node, range: { from: number; to: number }) =>
  selectedLines(doc, range.from, range.to).map((l) => l.node.attrs.id as string)

// a, b (b1, b2 (b2x)), c, d
const doc = docOf([
  line('a'),
  line('b', [line('b1'), line('b2', [line('b2x')])]),
  line('c'),
  line('d'),
])

test('lines of one level select the lines between them', () => {
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'a'), at(doc, 'c'))), ['a', 'b', 'c'])
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'c'), at(doc, 'a'))), ['a', 'b', 'c'])
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'b1'), at(doc, 'b2'))), ['b1', 'b2'])
})

test('lines at several levels select the lines that hold them', () => {
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'b1'), at(doc, 'c'))), ['b', 'c'])
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'a'), at(doc, 'b2x'))), ['a', 'b'])
  // A line and its own sub-line: the line, whole.
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'b'), at(doc, 'b2x'))), ['b'])
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'b2x'), at(doc, 'b2x'))), ['b2x'])
})

test("the selection is BlockNote's, whole lines its handle drags together", () => {
  const range = lineRange(doc, at(doc, 'b'), at(doc, 'c'))
  const selection = blockSelection(doc, range.from, range.to)
  assert.ok(isBlockSelection(selection))
  assert.ok(!isBlockSelection(TextSelection.create(doc, 3)))
  assert.deepEqual(
    selection.content().content.content.map((n) => n.attrs.id as string),
    ['b', 'c'],
  )
  // It survives an edit before it.
  const state = EditorState.create({ doc, selection })
  const next = state.apply(state.tr.insertText('x', 3))
  assert.ok(isBlockSelection(next.selection))
  assert.deepEqual(texts(next.doc, next.selection), ['b', 'c'])
})

const all = shownLines(doc, () => true)
const ends = (anchor: string, head: string) => ({ anchor: at(doc, anchor), head: at(doc, head) })
const id = (pos: number | undefined) => (pos === undefined ? undefined : doc.nodeAt(pos)!.attrs.id)

test('Shift+↓ and Shift+↑ grow the selection past its end, and shrink it back', () => {
  assert.equal(id(extendTo(doc, all, ends('a', 'a'), true)), 'b')
  // Past the sub-lines of the line it ends on, which are selected with it.
  assert.equal(id(extendTo(doc, all, ends('a', 'b'), true)), 'c')
  assert.equal(id(extendTo(doc, all, ends('c', 'c'), false)), 'b2x')
  assert.deepEqual(texts(doc, lineRange(doc, at(doc, 'c'), at(doc, 'b2x'))), ['b', 'c'])
  // Shrinking: the end comes back toward the anchor.
  assert.equal(id(extendTo(doc, all, ends('a', 'c'), false)), 'b2x')
  assert.equal(id(extendTo(doc, all, ends('d', 'b'), true)), 'c')
  // At the document's edge: nowhere further.
  assert.equal(extendTo(doc, all, ends('a', 'd'), true), undefined)
})

test('↑ and ↓ move to the line on screen after or before, skipping hidden ones', () => {
  assert.equal(id(moveTo(all, ends('a', 'a'), true)), 'b')
  assert.equal(id(moveTo(all, ends('b', 'b'), true)), 'b1')
  assert.equal(id(moveTo(all, ends('a', 'c'), true)), 'd')
  assert.equal(id(moveTo(all, ends('d', 'd'), true)), 'd')
  const shown = shownLines(doc, (pos) => !['b1', 'b2'].includes(doc.nodeAt(pos)!.attrs.id))
  assert.equal(id(moveTo(shown, ends('b', 'b'), true)), 'b2x')
  assert.equal(id(moveTo(shown, ends('c', 'c'), false)), 'b2x')
})
