// The document editor's schema, shared by the dashboard (which renders it) and
// the API (which converts it to and from Markdown). Both must agree: a
// document's Yjs state holds nodes of exactly these types.
import {
  BlockNoteSchema,
  createInlineContentSpec,
  defaultInlineContentSpecs,
  type CustomInlineContentConfig,
} from '@blocknote/core'

/**
 * Something in the workspace a document refers to with `@`: a library file,
 * a teammate, a thread. Written to Markdown as `@[label](kind:id)`, the form
 * messages use, which teammates already read.
 */
export const mentionConfig = {
  type: 'mention',
  propSchema: {
    kind: { default: 'document' },
    id: { default: '' },
    label: { default: '' },
  },
  content: 'none',
} as const satisfies CustomInlineContentConfig

/** A plain rendering, for the API; the dashboard renders its own chip. */
export const mentionSpec = createInlineContentSpec(mentionConfig, {
  render: (mention) => {
    const dom = document.createElement('span')
    dom.dataset.mentionKind = mention.props.kind
    dom.textContent =
      mention.props.kind === 'teammate' ? `@${mention.props.label}` : mention.props.label
    return { dom }
  },
})

export const documentSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionSpec },
})
