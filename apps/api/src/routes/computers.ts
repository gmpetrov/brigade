import { randomBytes } from 'node:crypto'
import { RunnerLink, type RunnerLinkResult } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { personOfMember, trackLater } from '../analytics.js'
import { audit } from '../audit.js'
import { billingEnabled, cloudEntitled, requireCloudPlan } from '../billing.js'
import { cloudAvailable, createWorkspaceComputer, desktopUrl } from '../cloud.js'
import { lastReplacement, replaceComputer } from '../cloud-replace.js'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { hashToken, hubs } from '../hub.js'
import { issueLinkCode, redeemLinkCode } from '../link-codes.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { runnerBundle } from './runner-install.js'

/**
 * Whether a connected runner runs the bundle this API serves (`current`) or will
 * update to it once no turn is running (`waiting`). Null when either is unknown:
 * offline, started from source, or no bundle built.
 */
export function runnerUpdate(served: string | null, installed: string | undefined) {
  if (!served || !installed) return null
  return installed === served ? ('current' as const) : ('waiting' as const)
}

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
    const served = await runnerBundle()
    const presence = await hubs.get(c.var.scope.workspaceId).presence(rows.map((r) => r.id))
    return c.json({
      cloudAvailable: cloudAvailable(),
      // With billing on, the cloud computer comes with the workspace's Cloud plan.
      billing: billingEnabled(),
      cloudEntitled: await cloudEntitled(c.var.scope.workspaceId),
      computers: await Promise.all(
        rows.map(async ({ providerRef: _ref, ...row }) => ({
          ...row,
          online: presence[row.id]?.online ?? false,
          // Its runner restarts into an update: online all along, but not working for a minute.
          restarting: presence[row.id]?.restarting ?? false,
          runnerUpdate: runnerUpdate(served, presence[row.id]?.bundle),
          // Its latest move onto a new VM (cloud-replace.ts), under way or done.
          replacement: row.kind === 'cloud' ? await lastReplacement(row.id) : null,
        })),
      ),
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
      // The machine the member chose, as their browser says (the code is for this one).
      track: { kind: osOfAgent(c.req.header('user-agent')) },
    })
    const bin = '~/.brigade/bin/brigade-runner'
    return c.json({
      code,
      expiresAt,
      command: `curl -fsSL ${env.API_URL}/runner/install.sh | sh && ${bin} link ${code} --api ${env.API_URL} && ${bin} start`,
      // Opens Brigade.app (apps/desktop), which asks before it installs and links the runner.
      appLink: `brigade://link?${new URLSearchParams({
        code,
        api: env.API_URL,
        dashboard: new URL('/app', env.WEB_URL[0]).toString(),
      })}`,
    })
  })

  /** Create the workspace computer, for a workspace that does not have one yet. */
  .post('/cloud', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!cloudAvailable())
      throw new HTTPException(409, { message: 'No cloud computer provider is configured' })
    await requireCloudPlan(c.var.scope.workspaceId)
    const computer = await createWorkspaceComputer({
      id: c.var.scope.workspaceId,
      organizationId: c.var.scope.organizationId,
    })
    trackLater(personOfMember(c.var.scope.memberId), 'computer_chosen', c.var.scope, {
      feature: 'onboarding',
      kind: 'cloud',
    })
    return c.json({ id: computer!.id }, 201)
  })

  .post('/:id/start', async (c) => {
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await hubs.get(computer.workspaceId).ensureRunning(computer.id)
    return c.json({ ok: true })
  })

  .post('/:id/stop', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await hubs
      .get(computer.workspaceId)
      .stopComputer(computer, { type: 'member', id: c.var.scope.memberId })
    return c.json({ ok: true })
  })

  /**
   * The cloud computer on a new VM: what lives only on the old one's disk comes from its backups,
   * and the old VM is kept, stopped, with the provider (cloud-replace.ts).
   */
  .post('/:id/replace', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!cloudAvailable())
      throw new HTTPException(409, { message: 'No cloud computer provider is configured' })
    const { scope } = c.var
    const row = await replaceComputer(
      { organizationId: scope.organizationId, workspaceId: scope.workspaceId },
      c.req.param('id'),
      scope.memberId,
    )
    return c.json({ id: row.id }, 202)
  })

  /** Takeover: the computer's live desktop. Resumes a stopped computer first. */
  .post('/:id/desktop', async (c) => {
    const computer = await c.var.db.computer.findFirst({
      where: { id: c.req.param('id'), kind: 'cloud' },
    })
    if (!computer) throw new HTTPException(404, { message: 'Computer not found' })
    await hubs.get(computer.workspaceId).ensureRunning(computer.id)
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
/** The kind of machine a browser runs on, for computer_chosen. */
function osOfAgent(agent: string | undefined) {
  if (/iPhone|iPad|Android/.test(agent ?? '')) return 'mobile'
  if (/Mac/.test(agent ?? '')) return 'mac'
  if (/Linux|X11|CrOS/.test(agent ?? '')) return 'linux'
  if (/Windows/.test(agent ?? '')) return 'windows'
  return 'other'
}

export const runnerLink = new Hono().post('/link', async (c) => {
  const input = await parseBody(c.req.raw, RunnerLink)
  const grant = await redeemLinkCode(input.code)
  if (!grant) throw new HTTPException(404, { message: 'This link code is invalid or has expired' })

  // Its workspace first: the API's front routes the runner's socket to that workspace's hub by it
  // (src/front.ts), before anything is looked up. The whole token is the secret, hashed.
  const token = `${grant.workspaceId}.${randomBytes(32).toString('base64url')}`
  const { computer, workspace } = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findFirstOrThrow({
      where: { id: grant.workspaceId, organizationId: grant.organizationId },
    })
    // A machine linked again (a reinstall, Brigade.app after the terminal) keeps its computer
    // when the member and workspace are the same; else it is a new one. The machine ID finds
    // it even when runner.json is gone; the computer runner.json named, from older runners.
    const mine =
      grant.kind === 'cloud'
        ? null
        : {
            workspaceId: workspace.id,
            kind: 'member_machine' as const,
            memberId: grant.memberId,
            status: { not: 'destroyed' as const },
          }
    const previous = !mine
      ? null
      : ((input.machineId
          ? await tx.computer.findFirst({
              where: { ...mine, machineId: input.machineId },
              orderBy: { createdAt: 'desc' },
            })
          : null) ??
        (input.computerId
          ? await tx.computer.findFirst({ where: { ...mine, id: input.computerId } })
          : null))
    const computer =
      grant.kind === 'cloud'
        ? await tx.computer.findFirstOrThrow({
            where: { id: grant.computerId, workspaceId: workspace.id, kind: 'cloud' },
          })
        : previous
          ? await tx.computer.update({
              where: { id: previous.id },
              data: {
                name: input.name,
                ...(input.machineId ? { machineId: input.machineId } : {}),
              },
            })
          : await tx.computer.create({
              data: {
                organizationId: grant.organizationId,
                workspaceId: grant.workspaceId,
                kind: 'member_machine',
                memberId: grant.memberId,
                name: input.name,
                machineId: input.machineId ?? null,
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
    {
      token,
      computerId: computer.id,
      workspaceName: workspace.name,
      workspaceId: workspace.id,
    } satisfies RunnerLinkResult,
    201,
  )
})
