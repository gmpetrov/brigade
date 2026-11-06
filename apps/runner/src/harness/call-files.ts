// The files a connector call sends (an email's attachments, a Drive upload, a file an MCP App
// gets a link to): the teammate names them by path in the operation's files fields, as a list
// or a single one. The harness uploads them and the call carries their ids in the same shape.

/** The paths the field holds, and how to put the ids back in their place. */
export function callFiles(value: unknown): { paths: unknown[]; place: (ids: string[]) => unknown } {
  if (typeof value === 'string') return { paths: [value], place: (ids) => ids[0] }
  return { paths: Array.isArray(value) ? value : [], place: (ids) => ids }
}

/** An operation's fields holding paths of files to send: all of them, or the one of before. */
export const filesFieldsOf = (
  operation: { filesField?: string; filesFields?: string[] } | undefined,
): string[] => operation?.filesFields ?? (operation?.filesField ? [operation.filesField] : [])

/**
 * The call's input with the paths in each files field uploaded (`upload` gives each one's id),
 * in the same shape: the same input when no field holds any.
 */
export async function withUploads(
  input: Record<string, unknown> | null,
  fields: string[],
  upload: (path: string) => Promise<string>,
): Promise<Record<string, unknown> | null> {
  if (!input) return input
  let sent = input
  for (const field of fields) {
    const { paths, place } = callFiles(input[field])
    if (paths.length === 0) continue
    const ids: string[] = []
    for (const path of paths) {
      if (typeof path !== 'string') throw new Error(`${field} lists file paths`)
      ids.push(await upload(path))
    }
    sent = { ...sent, [field]: place(ids) }
  }
  return sent
}
