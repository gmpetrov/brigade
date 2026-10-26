// The files a connector call sends (an email's attachments, a Drive upload): the teammate
// names them by path in the operation's files field, as a list or a single one. The
// harness uploads them and the call carries their ids in the same shape.

/** The paths the field holds, and how to put the ids back in their place. */
export function callFiles(value: unknown): { paths: unknown[]; place: (ids: string[]) => unknown } {
  if (typeof value === 'string') return { paths: [value], place: (ids) => ids[0] }
  return { paths: Array.isArray(value) ? value : [], place: (ids) => ids }
}
