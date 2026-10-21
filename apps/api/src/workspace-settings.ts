// A workspace's own settings: its name and logo (Settings › Workspace). Each
// version of the logo has a bucket key of its own, and the row changes only
// from the logo this change started from, so two changes that cross never
// leave the row naming bytes that are gone.
import type { UpdateWorkspace } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit } from './audit.js'
import { workspaceLogoKey } from './bucket.js'
import { prisma } from './db.js'
import { removeLogo, storeLogo } from './logos.js'
import type { WorkspaceScope } from './scope.js'

/** Rename the workspace or change its logo (null: back to its letter). Owners and admins: the route checks. */
export async function updateWorkspace(
  scope: WorkspaceScope,
  input: z.infer<typeof UpdateWorkspace>,
) {
  const before = await prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
  const logo =
    input.logo === undefined
      ? undefined
      : input.logo === null
        ? null
        : await storeLogo(input.logo, (version) => workspaceLogoKey(scope, version))
  const { count } = await prisma.workspace.updateMany({
    where: { id: scope.workspaceId, ...(logo !== undefined && { logo: before.logo }) },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(logo !== undefined && { logo }),
    },
  })
  if (count === 0) {
    // Another change of the logo came first: it stays, and this one's bytes go.
    if (logo) await removeLogo(workspaceLogoKey(scope, logo))
    throw new HTTPException(409, { message: 'The logo just changed: try again' })
  }
  if (logo !== undefined && before.logo) await removeLogo(workspaceLogoKey(scope, before.logo))
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'workspace.updated',
    target: { type: 'workspace', id: scope.workspaceId },
    data: {
      ...(input.name !== undefined &&
        input.name !== before.name && { name: { from: before.name, to: input.name } }),
      ...(logo !== undefined && { logo: logo ? 'changed' : 'removed' }),
    },
  })
  return prisma.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId } })
}
