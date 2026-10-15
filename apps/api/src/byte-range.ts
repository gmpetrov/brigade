/** The part of the bytes a `Range: bytes=…` header asks for, as [start, end], or null when it can't be served. */
export function byteRange(header: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const [start, end] = match[1]
    ? [Number(match[1]), match[2] ? Math.min(Number(match[2]), size - 1) : size - 1]
    : [Math.max(size - Number(match[2]), 0), size - 1]
  return start <= end && start < size ? [start, end] : null
}
