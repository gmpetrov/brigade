// A GitHub access ticket that names a repository: the account given must reach it,
// or the teammate gets access that still can't check it out.
import { HTTPException } from 'hono/http-exception'

type Account = { id: string; label: string; externalAccount: string | null }

/**
 * The GitHub account to give for a repository: the one the person picked, else
 * the only one that reaches it. reaching: the ids of the accounts whose
 * installation reaches the repository.
 */
export function accountReaching<T extends Account>(
  repository: string,
  usable: T[],
  reaching: Set<string>,
  connectionId: string | undefined,
): T {
  const owner = repository.split('/')[0]
  const named = connectionId ? usable.find((c) => c.id === connectionId) : undefined
  if (named && !reaching.has(named.id))
    throw new HTTPException(409, {
      message:
        `${named.externalAccount ?? named.label} does not reach ${repository}. Add the repository to ` +
        `that installation on GitHub, or install the GitHub app on ${owner}, then answer again.`,
    })
  if (named) return named
  const candidates = usable.filter((c) => reaching.has(c.id))
  if (candidates.length === 0)
    throw new HTTPException(409, {
      message:
        `No GitHub account you can give reaches ${repository}. Install the GitHub app on ${owner}, ` +
        'or add the repository to an installation, then answer again.',
    })
  if (candidates.length > 1)
    throw new HTTPException(400, { message: `Pick the GitHub account to give for ${repository}` })
  return candidates[0]!
}
