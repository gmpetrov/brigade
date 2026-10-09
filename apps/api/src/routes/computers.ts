import { randomBytes } from 'node:crypto'
import { RunnerLink, type RunnerLinkResult } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import {
  cloudAvailable,
  createWorkspaceComputer,
  desktopUrl,
  ensureRunning,
  stopComputer,
} from '../cloud.js'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { hashToken, isOnline } from '../hub.js'
import { issueLinkCode, redeemLinkCode } from '../link-codes.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Dashboard routes: list computers, link a machine, manage the workspace computer. */
export const computers = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    // The cloud computer, and this member's own machines. Other members' machines are theirs alone.
    const rows = await c.var.db.computer.findMany({
      where: {
        status: { not: 'destroyed' },
        OR: [{ kind: 'cloud' }, { memberId: c.var.scope.memberId }],
      },
      include: { runner: { select: { version: true, platform: true, lastSeenAt: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return c.json({
      cloudAvailable: cloudAvailable(),
      computers: rows.map(({ providerRef: _ref, ...row }) => ({
        ...row,
        online: isOnline(row.id),
      })),
    })
  })

  .post('/link-code', async (c) => {
    const { code, expiresAt } = await issueLinkCode({
      kind: 'member_machine',
      organizationId: c.var.scope.organizationId,
      workspaceId: c.var.scope.workspaceId,
      memberId: c.var.scope.memberId,
    })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'runner.link_code_issued',
      target: { type: 'member', id: c.var.scope.memberId },
    })
    const bin = '~/.brigade/bin/brigade-runner'
    return c.json({
      code,
      expiresAt,
      command: `curl -fsSL ${env.API_URL}/runner/install.sh | sh && ${bin} link ${code} --api ${env.API_URL} && ${bin} start`,
    })
  })

  /** Create the workspace computer, for a workspace that does not have one yet. */
  .post('/cloud', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!cloudAvailable())
      throw new HTTPException(409, { message: 'No cloud computer provider is configured' })
    const computer = await createWorkspaceComputer({
      id: c.var.scope.workspaceId,
      organizationId: c.var.scope.organizationId,
    })
    return c.json({ id: computer!.id }, 201)
  })

  .post('/:id/start', async (c) => {
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await ensureRunning(computer.id)
    return c.json({ ok: true })
  })

  .post('/:id/stop', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await stopComputer(computer, { type: 'member', id: c.var.scope.memberId })
    return c.json({ ok: true })
  })

  /** Takeover: the computer's live desktop. Resumes a stopped computer first. */
  .post('/:id/desktop', async (c) => {
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await ensureRunning(computer.id)
    const url = await desktopUrl(computer)
    if (!url)
      throw new HTTPException(409, {
        message: 'The desktop is not available yet. Try again in a moment.',
      })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'takeover.desktop_opened',
      target: { type: 'computer', id: computer.id },
    })
    return c.json({ url })
  })

/** Called by the runner command with a link code. No browser session. */
export const runnerLink = new Hono().post('/link', async (c) => {
  const input = await parseBody(c.req.raw, RunnerLink)
  const grant = await redeemLinkCode(input.code)
  if (!grant) throw new HTTPException(404, { message: 'This link code is invalid or has expired' })

  const token = randomBytes(32).toString('base64url')
  const { computer, workspace } = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findFirstOrThrow({
      where: { id: grant.workspaceId, organizationId: grant.organizationId },
    })
    const computer =
      grant.kind === 'cloud'
        ? await tx.computer.findFirstOrThrow({
            where: { id: grant.computerId, workspaceId: workspace.id, kind: 'cloud' },
          })
        : await tx.computer.create({
            data: {
              organizationId: grant.organizationId,
              workspaceId: grant.workspaceId,
              kind: 'member_machine',
              memberId: grant.memberId,
              name: input.name,
              status: 'pending',
            },
          })
    // One runner per computer: a re-install replaces the old token.
    await tx.runner.deleteMany({ where: { computerId: computer.id } })
    await tx.runner.create({
      data: {
        organizationId: grant.organizationId,
        workspaceId: grant.workspaceId,
        computerId: computer.id,
        tokenHash: hashToken(token),
        version: input.version,
        platform: input.platform,
      },
    })
    return { computer, workspace }
  })

  await audit({
    organizationId: grant.organizationId,
    workspaceId: grant.workspaceId,
    actor:
      grant.kind === 'cloud'
        ? { type: 'system', id: 'brigade' }
        : { type: 'member', id: grant.memberId },
    action: 'computer.linked',
    target: { type: 'computer', id: computer.id },
    data: { name: input.name, platform: input.platform },
  })
  return c.json(
    { token, computerId: computer.id, workspaceName: workspace.name } satisfies RunnerLinkResult,
    201,
  )
})
