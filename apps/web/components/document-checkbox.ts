// Ticking a checklist line's box leaves the text alone: ProseMirror would otherwise take
// the tap as a click in the document, move the cursor there and focus the editor, which
// on a phone opens the keyboard. The box ticks as it does natively (BlockNote saves it on
// `change`); only the editor's own handling of the press is skipped.
import { createExtension } from '@blocknote/core'
import { Plugin } from '@tiptap/pm/state'

const onBox = (event: Event) =>
  event.target instanceof HTMLInputElement &&
  event.target.type === 'checkbox' &&
  !!event.target.closest('[data-content-type="checkListItem"]')

export const checkboxTapExtension = () =>
  createExtension({
    key: 'checkboxTap',
    prosemirrorPlugins: [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: (_, event) => onBox(event),
            touchstart: (_, event) => onBox(event),
          },
        },
      }),
    ],
  } as const)
