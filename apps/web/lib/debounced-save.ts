// Saving a document a moment after its last change, as the demo's editor does without a Save
// button (components/document-editor-view.tsx). What waits is never lost: closing saves it at
// once, and a change that arrives once closed (its text was still being worked out) goes at once.

export function debouncedSave(save: (text: string) => unknown, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | null = null
  let closed = false
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const text = pending
    pending = null
    if (text !== null) void save(text)
  }
  return {
    /** The text to save once nothing changed for `ms`; at once when closed. */
    schedule(text: string) {
      pending = text
      if (closed) return flush()
      clearTimeout(timer)
      timer = setTimeout(flush, ms)
    },
    /** Saves now what waits, if anything. */
    flush,
    /** Nothing to save after all (the text is back to what was saved): what waited is dropped. */
    cancel() {
      clearTimeout(timer)
      timer = undefined
      pending = null
    },
    /** The editor goes: what waits is saved now, and anything later at once. */
    close() {
      closed = true
      flush()
    },
    /** Whether a text waits to be saved. */
    get pending() {
      return pending !== null
    },
  }
}
