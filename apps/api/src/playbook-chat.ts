// Installing a playbook from the chat: the tools of the teammate a member asks (Chief by
// default). show_playbook puts its card in the thread, configure_playbook takes the answers one
// by one (the API checks each by its type) and says which Apps are missing, start_dry_run
// replays past events with every write simulated, dry_run_report shows what it found, and
// activate_playbook puts up the card whose Activate button turns it on. It runs on the accounts
// of the member who started the thread, who owns it.
import {
  MCP_KIND,
  PLAYBOOK_INSTALL_TOOLS,
  playbookRoles,
  type PlaybookAppStatus,
  type PlaybookManifest,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { Scope, ScopedDb } from './db.js'
import { latestDryRun, startDryRun } from './playbook-dry-runs.js'
import { installationToUpdate, upgradePlaybook } from './playbook-updates.js'
import {
  accountChoices,
  answerSettings,
  createInstallation,
  getInstallation,
  hasParts,
  isAdminRole,
  requireInstallation,
  roleStatuses,
  teammateChoices,
  templates,
  templateView,
  upgradeSetup,
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

/** The playbook's Apps and roles as its teammate stands with each, on the owner's accounts. */
const appStatuses = (
  db: ScopedDb,
  installation: { manifest: unknown; settings: unknown; teammateId: string; ownerMemberId: string },
) =>
  roleStatuses(
    db,
    installation.manifest as PlaybookManifest,
    (installation.settings ?? {}) as Record<string, unknown>,
    installation.teammateId,
    installation.ownerMemberId,
  )

/** Those a dry run waits for. An optional App or role without an account blocks nothing: its runs do without it. */
export const missingApps = (apps: PlaybookAppStatus[]) =>
  apps.filter((a) => a.status === 'missing' && !a.optional)

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

/** A role as the teammate reads it: "analytics (mixpanel or an MCP server)". */
const roleWords = (a: PlaybookAppStatus) =>
  a.plain
    ? a.name
    : `${a.name} (${a.kinds.map((k) => (k === MCP_KIND ? 'an MCP server added by its URL' : k)).join(' or ')})`

/**
 * What to tell the teammate about the Apps: each missing one asked for at the access declared,
 * for the teammate that holds it. One whose teammate is not picked yet waits for that answer.
 */
const appsNote = (apps: PlaybookAppStatus[], asker: { id: string }) => {
  const needed = apps.filter((a) => a.status !== 'ready' && !a.optional && a.holder)
  // An account the teammate has but its setting has not picked yet: the question picks it.
  const unpicked = needed.filter((a) => a.picks && !a.chosen && a.accounts.length > 0)
  const lacking = needed.filter((a) => !unpicked.includes(a))
  const pickNote = unpicked.length
    ? ` ${unpicked.map(roleWords).join(', ')}: its account setting picks one of the accounts it has; ` +
      'until it is answered its runs reach none.'
    : ''
  if (!lacking.length) return pickNote
  return (
    pickNote +
    ' Apps it still needs: ' +
    lacking
      .map(
        (a) =>
          `${roleWords(a)} (${a.status === 'missing' ? 'no account' : 'read-only'}` +
          `${a.holder!.id === asker.id ? '' : `, for ${a.holder!.name}`})`,
      )
      .join(', ') +
    '. For each, open one ticket with an access ask of kind connection and app { kind, scope }, with ' +
    'app.teammate set to the teammate it is for when that is not you, ' +
    'the scope the playbook declares for it (read or read_write) and no more, and its account when you ' +
    'know which (the address its mail goes to, say): the person connects the ' +
    'App there, sign-in included, and grants it. A role any of several Apps can hold: first ask which ' +
    'one they use, then ask for that kind (an MCP server: kind mcp with its url).'
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
            apps: playbookRoles(t.manifest.apps).map((r) =>
              r.plain ? r.name : `${r.name} (${r.kinds.join(' or ')})`,
            ),
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
      if (op.installationId) {
        installation = await ownInstallation(db, session, op.installationId)
        // Not active yet: on the template's latest version.
        const template = templates().get(installation.playbookKey)
        if (template) installation = await upgradeSetup(db, installer, installation, template)
      } else {
        if (!op.playbookKey)
          return {
            error: 'Give the playbookKey to start installing, or the installationId to go on',
          }
        const template = templates().get(op.playbookKey)
        if (!template) return { error: `No playbook ${op.playbookKey}; show_playbook lists them` }
        // One being installed by this member already: go on with it rather than start a second,
        // on the template's latest version.
        installation =
          (await db.playbookInstallation.findFirst({
            where: {
              playbookKey: op.playbookKey,
              ownerMemberId: session.startedByMemberId,
              status: { in: ['setup', 'dry_run'] },
            },
            orderBy: { createdAt: 'desc' },
          })) ?? null
        if (installation) installation = await upgradeSetup(db, installer, installation, template)
        else {
          // With teammate settings, the teammate named answers the one its runs start with, and
          // until one does, the one installing it holds the place.
          const first = template.manifest.teammate
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
            settings: first && ref ? { [first]: runner.id } : {},
          })
        }
      }
      const first = (installation.manifest as PlaybookManifest).teammate
      const missing = await answerSettings(db, installer, installation.id, {
        // The teammate named answers the setting its runs start with.
        ...(first && op.teammate && op.installationId ? { [first]: op.teammate } : {}),
        ...op.settings,
      })
      const view = await getInstallation(db, installation.id)
      const current = await requireInstallation(db, installation.id)
      const manifest = current.manifest as PlaybookManifest
      const apps = await appStatuses(db, current)
      const answered = (current.settings ?? {}) as Record<string, unknown>
      const choices = new Map(
        await Promise.all(
          manifest.settings
            .filter((s) => s.type === 'account' && !(s.key in answered))
            .map(async (s) => [s.key, await accountChoices(db, manifest, s)] as const),
        ),
      )
      const crew = manifest.settings.some((s) => s.type === 'teammate' && !(s.key in answered))
        ? await teammateChoices(db)
        : []
      const question = (s: PlaybookManifest['settings'][number]) => ({
        key: s.key,
        type: s.type,
        ask: s.ask ?? s.key,
        ...(s.app ? { app: s.app } : {}),
        ...(s.options ? { options: s.options } : {}),
        ...(s.type === 'account'
          ? {
              // Told apart by App and id: two accounts may show the same name.
              accounts: (choices.get(s.key) ?? []).map((c) => ({
                id: c.id,
                app: c.app,
                name: c.name,
              })),
            }
          : {}),
        ...(s.type === 'teammate' ? { teammates: crew.map((t) => t.name) } : {}),
      })
      const questions = manifest.settings.filter((s) => missing.includes(s.key)).map(question)
      // A question with a set of answers (its options, the accounts it can pick) is picked, not typed.
      const picks = questions[0]
        ? (questions[0].options?.length ?? 0) +
          (questions[0].accounts?.length ?? 0) +
          (questions[0].teammates?.length ?? 0)
        : 0
      // A teammate other than the one its runs start with: the same one, or another that never
      // reads what starts the runs (a customer's mail). The person chooses; say what each means.
      const asked = manifest.settings.find((s) => s.key === questions[0]?.key)
      const runApps = playbookRoles(manifest.apps)
        .filter((r) => !r.teammate)
        .map((r) => r.name)
      const ownApps = playbookRoles(manifest.apps)
        .filter((r) => r.teammate === asked?.key)
        .map((r) => r.name)
      const runAsk = manifest.settings.find((s) => s.key === manifest.teammate)?.ask
      const teammateNote =
        asked?.type !== 'teammate'
          ? ''
          : asked.key === manifest.teammate
            ? 'Its runs start with that teammate, which has its ' +
              `${runApps.join(', ')} alone. Do not pick yourself unless the person asks for you. `
            : `That teammate has its ${ownApps.join(', ')}, in the threads handed to it. Offer the same ` +
              `teammate as for "${runAsk}" (simpler: one teammate holds every App) or another one ` +
              `(safer: the teammate reading ${runApps.join(', ')} never holds ${ownApps.join(', ')}), ` +
              'and let the person choose. '
      // Optional ones with no answer and no default (an analytics tool): asked once, at the end.
      const optional = manifest.settings
        .filter((s) => s.optional && s.default === undefined && !(s.key in answered))
        .map(question)
      // Optional Apps its teammate cannot use yet (Stripe with no account): offered with them, as
      // appsNote speaks of required ones alone. One whose account setting can pick an account it
      // has already is that setting's question.
      // Each for the teammate that holds it; one whose teammate is not picked yet waits.
      const optionalApps = apps.filter(
        (a) =>
          a.optional &&
          a.holder &&
          a.status !== 'ready' &&
          !(a.picks && !a.chosen && a.accounts.length > 0),
      )
      return {
        installationId: view.id,
        playbook: view.name,
        status: view.status,
        teammate: view.teammate.name,
        settings: view.settings.filter((s) => s.value !== null),
        missing: questions,
        ...(optional.length ? { optional } : {}),
        apps,
        next:
          (questions.length
            ? `Ask the person next: "${questions[0]!.ask}" (${questions[0]!.type}), one question at a time, ` +
              'then call configure_playbook with installationId and the answer, by its key. ' +
              teammateNote +
              (picks >= 2 && picks <= 6
                ? 'Its answers are known: end your reply with a choices block, one option per ' +
                  (questions[0]!.accounts?.length
                    ? 'account (labelled as its row shows it, the App in its description)'
                    : questions[0]!.teammates?.length
                      ? 'teammate (by name)'
                      : 'option') +
                  ', so the person picks one rather than typing it. '
                : '') +
              'An account setting takes ' +
              'the account as its row shows it (the Gmail address), or its id from accounts when two share a name ' +
              '(say which App each is). Do not guess an answer you were not given.'
            : 'Every setting it needs has an answer: its triggers, schedules and skills are made, and nothing ' +
              'runs yet. ' +
              (optional.length
                ? `It also has optional settings (${optional.map((o) => `"${o.ask}"`).join(', ')}): ask them ` +
                  'once, in one message, and leave out an account setting whose accounts list is empty; an ' +
                  'answer goes to configure_playbook like the others, and without one it does without. '
                : '') +
              (optionalApps.length
                ? `It can also use optional Apps: ${optionalApps
                    .map(
                      (a) =>
                        `${roleWords(a)} (${a.status === 'missing' ? 'no account' : 'read-only'}` +
                        `${a.holder!.id === teammate.id ? '' : `, for ${a.holder!.name}`})`,
                    )
                    .join(', ')}. Offer them once, in ${optional.length ? 'that same' : 'one'} ` +
                  'message, each with a few words on what it adds to this playbook (say, Stripe: read a ' +
                  "customer's plan and payments when answering), and that they may skip them. For each " +
                  'one they want, open one ticket with an access ask of kind connection and app { kind, ' +
                  'scope }, with app.teammate set to the teammate it is for when that is not you, the ' +
                  'scope the playbook declares for it (read or read_write) and no more ' +
                  '(a role: first ask which App they use); open none they did not ask for. Once it is ' +
                  'granted, configure_playbook again asks its account setting, if it has one. '
                : '') +
              (optional.length || optionalApps.length ? 'Then offer' : 'Offer') +
              ' a dry run on real past events, where nothing is sent (start_dry_run).') +
          appsNote(apps, teammate),
      }
    }

    if (op.name === 'start_dry_run') {
      const installation = await ownInstallation(db, session, op.installationId)
      const apps = await appStatuses(db, installation)
      const lacking = missingApps(apps)
      if (lacking.length)
        return {
          error: `It needs ${lacking.map(roleWords).join(', ')} first.${appsNote(apps, teammate)}`,
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

    if (op.name === 'update_playbook') {
      const starter = await db.member.findFirst({
        where: { id: session.startedByMemberId },
        select: { role: true },
      })
      const who = { memberId: session.startedByMemberId, role: starter?.role ?? 'member' }
      const installation = await installationToUpdate(db, who, op)
      const view = await getInstallation(db, installation.id, who)
      if (!view.update)
        return {
          installationId: view.id,
          playbook: view.name,
          version: view.version,
          error: `${view.name} is already on its latest version, ${view.version}.`,
        }
      if (!op.apply)
        return {
          installationId: view.id,
          playbook: view.name,
          status: view.status,
          from: view.version,
          to: view.update.version,
          changes: view.update.changes,
          autonomy: view.update.autonomy,
          keptSkills: view.update.keptSkills,
          newSettings: view.update.newSettings,
          ...(view.update.blocked ? { blocked: view.update.blocked } : {}),
          next:
            `Tell the person in a few lines what moving from ${view.version} to ${view.update.version} changes ` +
            '(the changes, and that autonomy never grows: the autonomy lines), and ' +
            (view.update.keptSkills.length
              ? `that their edited ${view.update.keptSkills.join(', ')} stay as they are unless they want the new ` +
                'version (then pass replaceSkills). '
              : '') +
            (view.update.newSettings.some((s) => !s.optional)
              ? 'ask the new required settings one at a time (newSettings), then call update_playbook with ' +
                'installationId, apply: true and their answers by key. '
              : 'ask whether to update; when they agree, call update_playbook with installationId and apply: true. ') +
            'Its runs, numbers and history are kept, and it stays active or paused as it is.',
        }
      const result = await upgradePlaybook(db, { ...scope, ...who }, installation.id, {
        settings: op.settings,
        ...(op.replaceSkills ? { replaceSkills: op.replaceSkills } : {}),
      })
      if (!result.updated)
        return {
          installationId: installation.id,
          updated: false,
          missing: result.missing,
          next:
            `Not updated yet: ask the person "${result.missing[0]?.ask}" (${result.missing[0]?.type}), one ` +
            'question at a time, then call update_playbook again with apply: true and every answer so far. ' +
            'A teammate setting takes a teammate by name; an account setting the account as its row shows it.',
        }
      return {
        installationId: installation.id,
        updated: true,
        from: result.from,
        to: result.to,
        keptSkills: result.keptSkills,
        status: result.playbook.status,
        apps: result.playbook.apps.filter((a) => a.status !== 'ready' && !a.optional),
        next:
          `Updated to ${result.to}. Say so in a line` +
          (result.keptSkills.length
            ? `, and that their edited ${result.keptSkills.join(', ')} were kept`
            : '') +
          '. If apps lists an App that is not ready, ask for it with an access ticket at the access the ' +
          'playbook declares, for the teammate that holds it.',
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
      apps: view.apps,
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
