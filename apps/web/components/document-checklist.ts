// A checklist line as it reads in the document editor (lib/checklist-look): its priority
// dot hidden, its closing note on a line of its own. Decorations only: the document,
// its Markdown and what teammates read keep the dot and the note as they are.
import { createExtension } from '@blocknote/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { checklistLook, type Piece } from '@/lib/checklist-look'

const key = new PluginKey<DecorationSet>('checklistLook')
const LEAF = '￼'

function noteBreak() {
  const span = document.createElement('span')
  span.className = 'bn-note-break'
  return span
}

function decorate(doc: Node) {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'checkListItem') return true
    const pieces: Piece[] = []
    node.forEach((child) => {
      const marks = child.marks.map((m) => m.type.name)
      pieces.push({
        text: child.isText ? child.text! : LEAF.repeat(child.nodeSize),
        italic: marks.includes('italic'),
        code: marks.includes('code'),
        aside: child.type.name === 'item',
      })
    })
    const { hide, note } = checklistLook(pieces)
    const start = pos + 1
    if (hide) decorations.push(Decoration.inline(start, start + hide, { class: 'bn-priority' }))
    if (note) {
      // Outside any mark the text before it ends with, so the break is never inside its code.
      decorations.push(
        Decoration.widget(start + note.from, noteBreak, { side: -1, key: 'note', marks: [] }),
        Decoration.inline(start + note.from, start + note.to, { class: 'bn-note' }),
      )
    }
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
