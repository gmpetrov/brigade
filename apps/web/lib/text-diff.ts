/**
 * The one change that turns `before` into `after`: what lies between their common
 * start and end. Applied to an editor, it keeps the cursor and scroll where the
 * text did not change, as when a file is reloaded after someone else edited it.
 */
export function textChange(before: string, after: string) {
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let end = 0
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  )
    end++
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}
