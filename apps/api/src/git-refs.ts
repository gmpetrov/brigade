// Which refs a teammate may push, from the push's commands alone: branches under
// brigade/, and new tags. git.ts adds what needs GitHub (a tag's commit is on the
// default branch) and the write cap.

/** Teammates push only to branches under this prefix; a pull request takes them further. */
export const PUSH_PREFIX = 'refs/heads/brigade/'
/** Where the runner backs up uncommitted work when a thread goes idle. */
export const BACKUP_PREFIX = 'refs/heads/brigade/wip/'
export const TAG_PREFIX = 'refs/tags/'

const ZERO = /^0+$/
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

export type PushRule =
  { kind: 'branch' } | { kind: 'tag'; name: string } | { kind: 'refused'; reason: string }

/**
 * A tag is only ever created: moving or deleting one would change a release
 * (a desktop-v* tag publishes Brigade.app to every installed copy).
 */
export function pushRule(command: { old: string; new: string; ref: string }): PushRule {
  const { ref } = command
  if (ref.includes('..')) return { kind: 'refused', reason: 'this ref name is not allowed' }
  if (ref.startsWith(PUSH_PREFIX)) return { kind: 'branch' }
  if (ref.startsWith(TAG_PREFIX)) {
    const name = ref.slice(TAG_PREFIX.length)
    if (!TAG.test(name)) return { kind: 'refused', reason: `the tag name ${name} is not allowed` }
    if (!ZERO.test(command.old))
      return {
        kind: 'refused',
        reason: 'teammates only create tags: an existing tag is never moved or deleted',
      }
    return { kind: 'tag', name }
  }
  return {
    kind: 'refused',
    reason:
      'teammates push only to branches under brigade/ and new tags; open a pull request for the rest',
  }
}

/** GitHub's compare of default...commit: the commit is on the default branch. */
export const onDefaultBranch = (status: string | undefined) =>
  status === 'behind' || status === 'identical'

/** How a push reads in the connection's log: brigade/x, tag desktop-v1. */
export const refLabel = (ref: string) =>
  ref.startsWith(TAG_PREFIX)
    ? `tag ${ref.slice(TAG_PREFIX.length)}`
    : ref.replace(/^refs\/heads\//, '')
