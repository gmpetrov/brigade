// Installing a playbook from the chat: the tools of the teammate a member asks (Chief by
// default). show_playbook puts its card in the thread, configure_playbook takes the answers one
// by one (the API checks each by its type) and says which Apps are missing, start_dry_run
// replays past events with every write simulated, dry_run_report shows what it found, and
// activate_playbook puts up the card whose Activate button turns it on. It runs on the accounts
// of the member who started the thread, who owns it.
import {
  PLAYBOOK_INSTALL_TOOLS,
  type PlaybookAppStatus,
  type PlaybookManifest,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { usableIn } from './apps.js'
import type { Scope, ScopedDb } from './db.js'
import { latestDryRun, startDryRun } from './playbook-dry-runs.js'
import {
  answerSettings,
  createInstallation,
  getInstallation,
  hasParts,
  isAdminRole,
  requireInstallation,
  templates,
  templateView,
  withDefaults,
} from './playbooks.js'

type PlaybookInstallOperation = Extract<
  ScheduleOperation,
  { name: (typeof PLAYBOOK_INSTALL_TOOLS)[number] }
>

export const isPlaybookInstallOperation = (op: ScheduleOperation): op is PlaybookInstallOperation =>
  (PLAYBOOK_INSTALL_TOOLS as readonly string[]).includes(op.name)

type Session = {
  id: string
  origin: string
  startedByMemberId: string
  computerId: string
  accountId: string | null
  projectId: string | null
  playbookRunId: string | null
}

/** The playbook's Apps as its teammate stands with each, on the owner's accounts. */
export async function appStatuses(
  db: ScopedDb,
  manifest: PlaybookManifest,
  teammateId: string,
  ownerMemberId: string,
): Promise<PlaybookAppStatus[]> {
  const grants = await db.grant.findMany({
    where: {
      teammateId,
      connection: {
        kind: { in: manifest.apps.map((a) => a.kind) as never },
        status: 'active',
      },
    },
    include: { connection: true },
  })
  return manifest.apps.map((app) => {
    const usable = grants.filter(
      (g) =>
        g.connection.kind === app.kind &&
        usableIn(g.connection, { startedByMemberId: ownerMemberId }),
    )
    const writable = usable.filter((g) => g.scope === 'read_write')
    return {
      ...app,
      status: !usable.length
        ? 'missing'
        : app.access === 'read_write' && !writable.length
          ? 'read_only'
          : 'ready',
      accounts: usable.map((g) => g.connection.externalAccount ?? g.connection.label),
    }
  })
}

/** Its installation, if the thread's member owns it. */
async function ownInstallation(db: ScopedDb, session: Session, id: string) {
  const installation = await requireInstallation(db, id)
  if (installation.ownerMemberId !== session.startedByMemberId)
    throw new HTTPException(403, {
      message:
        "That playbook runs on another member's accounts: only a thread of theirs goes on with it",
    })
  return installation
}

/** What to tell the teammate about the Apps: each missing one asked for at the access declared. */
const appsNote = (apps: PlaybookAppStatus[]) => {
  const lacking = apps.filter((a) => a.status !== 'ready' && !a.optional)
  if (!lacking.length) return ''
  return (
    ' Apps it still needs: ' +
    lacking
      .map((a) => `${a.kind} (${a.status === 'missing' ? 'no account' : 'read-only'})`)
      .join(', ') +
    '. For each, open one ticket with an access ask of kind connection and app { kind, scope }, with ' +
    'the scope the playbook declares for it (read or read_write) and no more: the person connects the ' +
    'App there, sign-in included, and grants it.'
  )
}

export async function handlePlaybookCall(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string; name: string },
  op: PlaybookInstallOperation,
): Promise<object | { error: string }> {
  if (session.playbookRunId)
    return {
      error: "This is a playbook's own thread: playbooks are installed from a member's thread.",
    }
  if (session.origin !== 'member')
    return { error: 'Playbooks are installed only from a thread a person started.' }
  const installer = { ...scope, memberId: session.startedByMemberId }
  try {
    if (op.name === 'show_playbook') {
      const all = [...templates().values()]
      if (!op.playbookKey)
        return {
          catalog: all.map((t) => ({
            playbookKey: t.manifest.id,
            name: t.manifest.name,
            version: t.manifest.version,
            description: t.manifest.description,
            apps: t.manifest.apps.map((a) => a.kind),
          })),
          next: 'Call show_playbook again with the playbookKey of the one the person wants, to show its card.',
        }
      const template = templates().get(op.playbookKey)
      if (!template)
        return {
          error: `No playbook ${op.playbookKey}. Those there are: ${all.map((t) => t.manifest.id).join(', ')}`,
        }
      const installed = await db.playbookInstallation.findMany({
        where: { playbookKey: op.playbookKey },
        select: { id: true, status: true, ownerMemberId: true },
      })
      return {
        playbook: templateView(template),
        installed: installed.map((i) => ({
          installationId: i.id,
          status: i.status,
          yours: i.ownerMemberId === session.startedByMemberId,
        })),
        next:
          'Its card shows under your reply: what it does, its Apps, its author and its version. Say in a ' +
          'line or two what it would do for them, and ask whether to install it; when they agree, ' +
          'configure_playbook with its playbookKey starts it.',
      }
    }

    if (op.name === 'configure_playbook') {
      let installation
      if (op.installationId) installation = await ownInstallation(db, session, op.installationId)
      else {
        if (!op.playbookKey)
          return { error: 'Give the playbookKey to start installing, or the installationId to go on' }
        const template = templates().get(op.playbookKey)
        if (!template) return { error: `No playbook ${op.playbookKey}; show_playbook lists them` }
        // One being installed by this member already: go on with it rather than start a second.
        installation =
          (await db.playbookInstallation.findFirst({
            where: {
              playbookKey: op.playbookKey,
              ownerMemberId: session.startedByMemberId,
              status: { in: ['setup', 'dry_run'] },
            },
            orderBy: { createdAt: 'desc' },
          })) ?? null
        if (!installation) {
          const ref = op.teammate
          const runner = ref
            ? ((await db.teammate.findFirst({ where: { id: ref, archivedAt: null } })) ??
              (await db.teammate.findFirst({
                where: { name: { equals: ref, mode: 'insensitive' }, archivedAt: null },
              })))
            : teammate
          if (!runner) return { error: `No teammate is called "${ref}"` }
          installation = await createInstallation(db, installer, {
            template,
            teammateId: runner.id,
            projectId: session.projectId,
            settings: {},
          })
        }
      }
      const missing = await answerSettings(db, installer, installation.id, op.settings)
      const view = await getInstallation(db, installation.id)
      const manifest = (await requireInstallation(db, installation.id)).manifest as PlaybookManifest
      const apps = await appStatuses(db, manifest, view.teammate.id, view.owner.id)
      const questions = manifest.settings
        .filter((s) => missing.includes(s.key))
        .map((s) => ({
          key: s.key,
          type: s.type,
          ask: s.ask ?? s.key,
          ...(s.app ? { app: s.app } : {}),
          ...(s.options ? { options: s.options } : {}),
          ...(s.type === 'account'
            ? { accounts: apps.find((a) => a.kind === s.app)?.accounts ?? [] }
            : {}),
        }))
      return {
        installationId: view.id,
        playbook: view.name,
        status: view.status,
        teammate: view.teammate.name,
        settings: view.settings.filter((s) => s.value !== null),
        missing: questions,
        apps,
        next:
          (questions.length
            ? `Ask the person next: "${questions[0]!.ask}" (${questions[0]!.type}), one question at a time, ` +
              'then call configure_playbook with installationId and the answer, by its key. An account setting takes ' +
              'the account as its row shows it (the Gmail address). Do not guess an answer you were not given.'
            : 'Every setting has an answer: its triggers, schedules and skills are made, and nothing runs yet. ' +
              'Offer a dry run on real past events, where nothing is sent (start_dry_run).') +
          appsNote(apps),
      }
    }

    if (op.name === 'start_dry_run') {
      const installation = await ownInstallation(db, session, op.installationId)
      const manifest = installation.manifest as PlaybookManifest
      const apps = await appStatuses(
        db,
        manifest,
        installation.teammateId,
        installation.ownerMemberId,
      )
      const lacking = apps.filter((a) => a.status === 'missing' && !a.optional)
      if (lacking.length)
        return {
          error: `It needs ${lacking.map((a) => a.kind).join(', ')} first.${appsNote(apps)}`,
        }
      const view = await startDryRun(db, scope, session, teammate, op.installationId, op.last)
      return {
        dryRunId: view.id,
        events: view.events.length,
        next:
          `Started: ${view.events.length} past event${view.events.length === 1 ? '' : 's'} replayed a few at a ` +
          'time, each a run of its own with every write simulated (recorded, never sent) and no push. Its ' +
          'progress shows under your reply. You are woken here with the report once they are all done: end ' +
          'your turn now with one line saying so. Do not wait or poll.',
      }
    }

    if (op.name === 'dry_run_report') {
      await ownInstallation(db, session, op.installationId)
      // Its error field would read as the call's own (schedules.ts): named apart, when there is one.
      const { error: problem, ...view } = await latestDryRun(db, op.installationId)
      return {
        ...view,
        ...(problem ? { problem } : {}),
        events: view.events.map((e) => ({
          ...e,
          // What the teammate reads of each write: clipped, as the card shows it whole.
          writes: e.writes.map((w) => ({
            ...w,
            input: JSON.stringify(w.input ?? null).slice(0, 2_000),
          })),
        })),
        next:
          view.status === 'running'
            ? `It is still going (${view.finished}/${view.events.length}): you are woken when it is done.`
            : 'Its report shows under your reply, one card per event. Say in a few lines what it found, ' +
              'what would have gone wrong, and the cost; propose recipe changes with propose_skill if any; ' +
              'then offer to activate it (activate_playbook).',
      }
    }

    // activate_playbook
    const installation = await ownInstallation(db, session, op.installationId)
    if (installation.status === 'active')
      return { error: 'It is already active; its sheet is on the Routines page.' }
    if (!(await hasParts(db, installation.id))) {
      const { missing } = withDefaults(
        installation.manifest as PlaybookManifest,
        installation.settings as Record<string, string | number>,
      )
      return { error: `Its settings are not all answered yet: ${missing.join(', ')}` }
    }
    const view = await getInstallation(db, installation.id)
    const starter = await db.member.findFirst({
      where: { id: session.startedByMemberId },
      select: { role: true },
    })
    return {
      installationId: view.id,
      playbook: view.name,
      settings: view.settings,
      apps: await appStatuses(
        db,
        installation.manifest as PlaybookManifest,
        view.teammate.id,
        view.owner.id,
      ),
      actions: view.actions.map((a) => ({ label: a.label, level: a.level })),
      owner: view.owner.name,
      next:
        'Its summary card shows under your reply, with an Activate button: every action asks first to ' +
        'begin with. ' +
        (starter && isAdminRole(starter.role)
          ? 'The person is an owner or admin: their click activates it.'
          : 'The person is a member: their click asks an owner or admin, in one ticket.') +
        ' Do not activate it any other way, and do not write that it is active before they click.',
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}
