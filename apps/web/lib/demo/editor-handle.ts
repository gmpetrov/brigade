// What the demo's walkthrough (lib/demo/tour.ts) does in a document, through the editor itself
// rather than the page's selection: Safari let the editor keep its own caret when the page's
// selection was set, so the walkthrough typed into the line above the one it added and waited
// for a toolbar that never came. The editor registers it while it shows a document, in the demo
// only (components/document-editor-view.tsx).

export type DemoEditorHandle = {
  /** The caret at the end of the document's last checklist line; that line's element. */
  caretAtLastLine: () => HTMLElement | undefined
  /** A new empty checklist line after the last one, the caret in it. */
  newLineAtEnd: () => void
  /** Text typed where the caret is. */
  insertText: (text: string) => void
  /** The text of the checklist line that has `text` selected, so its toolbar shows. */
  selectLine: (text: string) => boolean
}

let current: DemoEditorHandle | null = null

/** Registers the editor shown; the function it returns takes it back. */
export function setDemoEditor(handle: DemoEditorHandle) {
  current = handle
  return () => {
    if (current === handle) current = null
  }
}

export const demoEditor = () => current
