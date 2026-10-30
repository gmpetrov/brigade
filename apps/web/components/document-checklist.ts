// A checklist line as it reads in the document editor (lib/checklist-look): the notes on
// lines of their own at its end, smaller and grey. Decorations only: the document, its Markdown and what
// teammates read keep the note as it is.
import { createExtension } from '@blocknote/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { checklistLook, type Piece } from '@/lib/checklist-look'

const key = new PluginKey<DecorationSet>('checklistLook')
const LEAF = '￼'

function decorate(doc: Node) {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
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
    const { note } = checklistLook(pieces)
    const start = pos + 1
    if (note)
      decorations.push(Decoration.inline(start + note.from, start + note.to, { class: 'bn-note' }))
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export const checklistLookExtension = () =>
  createExtension({
    key: 'checklistLook',
    prosemirrorPlugins: [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ],
  } as const)
