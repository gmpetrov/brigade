// The Email App's addresses: an agent's (riley@, riley.lovarank@, riley.lovarank.0k3f9a@) and a
// project's inbox (support-lovarank-7f3k@). Turning one on, finding the box a recipient means,
// and the address a thread writes from.
import { HTTPException } from 'hono/http-exception'
import { appFor } from '../apps.js'
import { audit } from '../audit.js'
import { prisma, type Scope, type ScopedDb } from '../db.js'
import type { WorkspaceScope } from '../scope.js'
import {
  addressOf,
  aliasToken,
  candidates,
  nameProblem,
  partsOf,
  slugOf,
} from './names.js'

export type Box = {
  address: {
    id: string
    organizationId: string
    workspaceId: string
    name: string
    kind: 'agent' | 'inbox'
    teammateId: string | null
    projectId: string | null
    connectionId: string | null
    publicAddress: string | null
    displayName: string | null
  }
  /** The variant: riley.<project>@'s project. Null: the address itself. */
  projectId: string | null
  alias: { id: string; sessionId: string | null; waitUntil: Date; local: string } | null
  /** The address the mail came to, as written. */
  local: string
}

export const boxKey = (addressId: string, projectId: string | null) =>
  `${addressId}:${projectId ?? '-'}`

const live = { releasedAt: null, connectionId: { not: null } } as const

/**
 * The box a local part on Brigade's domain means, or null when it means none: an unknown name,
 * one turned off, an unknown project, a sign-up token nobody made. Across all of Brigade.
 */
export async function boxOf(local: string): Promise<Box | null> {
  const alias = await prisma.mailAlias.findUnique({
    where: { local },
    include: { address: true },
  })
  if (alias) {
    if (alias.address.releasedAt || !alias.address.connectionId) return null
    return {
      address: alias.address,
      projectId: alias.projectId,
      alias: { id: alias.id, sessionId: alias.sessionId, waitUntil: alias.waitUntil, local },
      local,
    }
  }
  const { name, rest } = partsOf(local)
  const address = await prisma.mailAddress.findFirst({ where: { name, ...live } })
  if (!address) return null
  if (rest.length === 0) return { address, projectId: null, alias: null, local }
  if (address.kind !== 'agent' || rest.length > 1) return null
  const project = await prisma.mailProject.findFirst({
    where: { workspaceId: address.workspaceId, slug: rest[0] },
  })
  if (!project?.projectId) return null
  return { address, projectId: project.projectId, alias: null, local }
}

/**
 * A project's name in addresses, set the first time it is needed, from its name: kept when the
 * project is renamed, and a slug once used is never another project's. A digit first would read
 * as a sign-up's token, so such a slug starts with "p-".
 */
export async function projectSlug(db: ScopedDb, projectId: string) {
  const existing = await db.mailProject.findFirst({ where: { projectId } })
  if (existing) return existing.slug
  const project = await db.project.findFirst({ where: { id: projectId }, select: { name: true } })
  if (!project) throw new HTTPException(404, { message: 'No such project' })
  let root = slugOf(project.name, 24) || 'project'
  if (/^\d/.test(root)) root = `p-${root}`.slice(0, 24)
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? root : `${root}-${n}`
    try {
      const row = await db.mailProject.create({ data: { slug, projectId } as never })
      return row.slug
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const raced = await db.mailProject.findFirst({ where: { projectId } })
      if (raced) return raced.slug
    }
  }
  throw new Error('No free slug for this project')
}

/** The local part a thread of this project uses on an address: riley, or riley.lovarank. */
export async function variantLocal(
  db: ScopedDb,
  address: { name: string; kind: 'agent' | 'inbox' },
  projectId: string | null,
) {
  if (address.kind === 'inbox' || !projectId) return address.name
  return `${address.name}.${await projectSlug(db, projectId)}`
}

/** An address as a thread shows and sends it, with its name: "Riley · Lovarank <riley.lovarank@…>". */
export async function senderOfBox(
  db: ScopedDb,
  address: Box['address'] & { domain?: { status: string } | null },
  projectId: string | null,
) {
  if (address.kind === 'inbox') {
    const own =
      address.publicAddress && address.domain?.status === 'verified' ? address.publicAddress : null
    const project = address.projectId
      ? await db.project.findFirst({ where: { id: address.projectId }, select: { name: true } })
      : null
    return {
      address: own ?? addressOf(address.name),
      name: address.displayName || project?.name || 'Brigade',
    }
  }
  const [teammate, project] = await Promise.all([
    address.teammateId
      ? db.teammate.findFirst({ where: { id: address.teammateId }, select: { name: true } })
      : null,
    projectId ? db.project.findFirst({ where: { id: projectId }, select: { name: true } }) : null,
  ])
  const name = [teammate?.name ?? address.name, project?.name].filter(Boolean).join(' · ')
  return { address: addressOf(await variantLocal(db, address, projectId)), name }
}

/** The first free name for a teammate: its own, then -2, -3… across all of Brigade. */
export async function suggestName(base: string) {
  for (const name of candidates(base)) {
    if (!(await prisma.mailAddress.findUnique({ where: { name }, select: { id: true } })))
      return name
  }
  throw new HTTPException(409, { message: 'No free name: choose one' })
}

/** The Email App's account for an address: what grants, tools, rules and the journal hang on. */
async function accountFor(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { label: string; externalAccount: string },
) {
  const app = await appFor(db, scope, 'email')
  return db.connection.create({
    data: {
      appId: app.id,
      kind: 'email',
      label: input.label,
      externalAccount: input.externalAccount,
      reach: 'workspace',
      createdByMemberId: scope.memberId,
    } as never,
  })
}

/**
 * Turn on a teammate's address, with the name asked for (or the first free one). The name is
 * taken for good the first time: turned off and on again, the teammate keeps it, and no one else
 * ever gets it. The address is granted to that teammate alone.
 */
export async function enableAgentAddress(
  db: ScopedDb,
  scope: WorkspaceScope,
  teammate: { id: string; name: string },
  asked?: string,
) {
  const existing = await db.mailAddress.findFirst({ where: { teammateId: teammate.id } })
  if (existing && !existing.releasedAt && existing.connectionId) return existing
  if (existing) {
    // Its name stays its own: a new account, on the same name.
    const connection = await accountFor(db, scope, {
      label: teammate.name,
      externalAccount: addressOf(existing.name),
    })
    await db.grant.create({
      data: { teammateId: teammate.id, connectionId: connection.id, scope: 'read_write' } as never,
    })
    const row = await db.mailAddress.update({
      where: { id: existing.id },
      data: { connectionId: connection.id, releasedAt: null },
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'email.address.enabled',
      target: { type: 'teammate', id: teammate.id },
      data: { name: row.name },
    })
    return row
  }
  const name = asked ? asked.toLowerCase() : await suggestName(teammate.name)
  const problem = nameProblem(name)
  if (problem) throw new HTTPException(400, { message: problem })
  const connection = await accountFor(db, scope, {
    label: teammate.name,
    externalAccount: addressOf(name),
  })
  let row
  try {
    row = await db.mailAddress.create({
      data: {
        name,
        kind: 'agent',
        teammateId: teammate.id,
        connectionId: connection.id,
        createdByMemberId: scope.memberId,
      } as never,
    })
  } catch (error) {
    await db.connection.deleteMany({ where: { id: connection.id } })
    if ((error as { code?: string }).code === 'P2002')
      throw new HTTPException(409, {
        message: `${addressOf(name)} is taken. Try ${await suggestName(name)}.`,
      })
    throw error
  }
  await db.grant.create({
    data: { teammateId: teammate.id, connectionId: connection.id, scope: 'read_write' } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.address.enabled',
    target: { type: 'teammate', id: teammate.id },
    data: { name },
  })
  return row
}

/**
 * Turn an address off: it receives nothing more and its account goes, rules and grants with it.
 * Its name stays reserved; the mail it holds stays until it expires.
 */
export async function disableAddress(db: ScopedDb, scope: WorkspaceScope, addressId: string) {
  const address = await db.mailAddress.findFirst({ where: { id: addressId } })
  if (!address) throw new HTTPException(404, { message: 'No such address' })
  if (address.connectionId) {
    await db.trigger.deleteMany({ where: { connectionId: address.connectionId } })
    await db.grant.deleteMany({ where: { connectionId: address.connectionId } })
    await db.connection.updateMany({
      where: { id: address.connectionId },
      data: { status: 'removed' },
    })
  }
  await db.mailAddress.update({
    where: { id: address.id },
    data: { releasedAt: new Date(), connectionId: null },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.address.disabled',
    target: { type: 'mail_address', id: address.id },
    data: { name: address.name },
  })
}

/**
 * A project's inbox, on a generated name nobody guesses (support-lovarank-7f3k): customers write
 * to the project's own address, forwarded here. Rules on it decide which teammate answers.
 */
export async function createInbox(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { projectId: string; label: string; displayName?: string },
) {
  const project = await db.project.findFirst({
    where: { id: input.projectId },
    select: { id: true, name: true },
  })
  if (!project) throw new HTTPException(404, { message: 'No such project' })
  const base = `${slugOf(input.label, 10) || 'inbox'}-${slugOf(project.name, 12) || 'project'}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `${base}-${aliasToken().slice(2, 6)}`.replace(/--+/g, '-')
    if (nameProblem(name)) continue
    const connection = await accountFor(db, scope, {
      label: `${input.label} · ${project.name}`,
      externalAccount: addressOf(name),
    })
    try {
      const row = await db.mailAddress.create({
        data: {
          name,
          kind: 'inbox',
          projectId: project.id,
          connectionId: connection.id,
          displayName: input.displayName ?? `${project.name}`,
          createdByMemberId: scope.memberId,
        } as never,
      })
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'email.inbox.created',
        target: { type: 'mail_address', id: row.id },
        data: { name, projectId: project.id },
      })
      return row
    } catch (error) {
      await db.connection.deleteMany({ where: { id: connection.id } })
      if ((error as { code?: string }).code !== 'P2002') throw error
    }
  }
  throw new HTTPException(409, { message: 'Could not find a free name, try again' })
}

/** A sign-up address for a thread: its mail goes to the thread for a while, then to its box. */
export async function newAlias(
  db: ScopedDb,
  input: {
    address: { id: string; name: string; kind: 'agent' | 'inbox' }
    projectId: string | null
    sessionId: string
    teammateId: string
    purpose: string
    waitMinutes: number
  },
) {
  if (input.address.kind !== 'agent')
    throw new HTTPException(400, { message: 'Sign-up addresses are made on an agent’s address' })
  const base = await variantLocal(db, input.address, input.projectId)
  for (let attempt = 0; attempt < 5; attempt++) {
    const local = `${base}.${aliasToken()}`
    try {
      return await db.mailAlias.create({
        data: {
          local,
          addressId: input.address.id,
          projectId: input.projectId,
          sessionId: input.sessionId,
          teammateId: input.teammateId,
          purpose: input.purpose.slice(0, 200),
          waitUntil: new Date(Date.now() + input.waitMinutes * 60_000),
        } as never,
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
    }
  }
  throw new Error('Could not make a sign-up address')
}

export type { Scope }
