/**
 * Saves one value at a time, always the latest asked for: one asked for while a save runs
 * waits for it, in place of any other waiting, so the saves reach the server in the order
 * they were asked for and the last one wins. A save that fails calls `onError`, unless a newer
 * one waits: that one carries what to keep.
 */
export function latestSave<T>(
  save: (value: T) => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  let waiting: { value: T } | undefined
  let running = false
  return async function ask(value: T) {
    waiting = { value }
    if (running) return
    running = true
    try {
      while (waiting) {
        const next = waiting.value
        waiting = undefined
        try {
          await save(next)
        } catch (error) {
          if (!waiting) onError(error)
        }
      }
    } finally {
      running = false
    }
  }
}
