import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Updating an installed playbook to its template's newer version, against the API's development
// database (apps/api/.env), in an organization of its own removed at the end; skipped when none
// answers:
// - the diff in plain English: skills by content, entries, actions, Apps, settings;
// - an active Support and bugs installed at 1.0.0 (its manifest as PR #230 shipped it) moves to
//   the current template: its answers, levels, trust history, runs and numbers kept, its Gmail
//   trigger changed in place (same id, its inbox subscription and cursor untouched), the setting
//   its runs start with defaulted from its teammate, and the new developer question blocking
//   until it has an answer;
// - an action whose tools change asks first again, a new one starts no higher than asking, a
//   lowered ceiling caps a level, a removed action goes;
// - a skill the workspace edited is kept unless chosen; a paused one stays paused;
// - its owner, an owner or an admin may update it; another member may not.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const { readTemplate, templates } = await import('../src/playbooks.js')
const { compareVersions, describeDiff, playbookDiff, upgradePlaybook } =
  await import('../src/playbook-updates.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

/** apps/api/playbooks/support-bugs/playbook.yaml at 1.0.0 (c7e248b, PR #230), parsed. */
const SUPPORT_1_0_0 = {
  id: 'brigade/support-bugs',
  name: 'Support and bugs',
  version: '1.0.0',
  description:
    'Sorts the support inbox, answers customers, fixes the bugs they report and tells them when it is fixed.',
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { kind: 'github', access: 'read_write' },
    { kind: 'stripe', access: 'read', optional: true },
    { kind: 'mixpanel', access: 'read', optional: true },
  ],
  settings: [
    { key: 'product', type: 'text', ask: 'Which product does this support cover?' },
    {
      key: 'inbox',
      type: 'account',
      app: 'gmail',
      ask: 'Which Gmail account receives the support mail?',
    },
    { key: 'address', type: 'email', ask: 'Which address do customers write to?' },
    { key: 'docs', type: 'url', ask: 'Where is the public documentation?' },
    { key: 'repo', type: 'repository', ask: 'In which repository should bugs be fixed?' },
    { key: 'signature', type: 'text', default: 'The {{product}} team' },
  ],
  entries: [
    {
      trigger: 'gmail.email_received',
      account: '{{inbox}}',
      options: { query: 'to:{{address}}' },
      label: 'Support mail',
    },
    {
      schedule: '0 8 * * 1',
      title: 'Weekly support review',
      instructions:
        "Review last week's support for {{product}}: the cases, what was answered, what is still open, and what the recipe should learn. Write it in a few lines.",
    },
  ],
  skills: ['skills/support-triage', 'skills/bug-fix'],
  actions: [
    {
      key: 'reply',
      label: 'Reply to the customer',
      tools: ['gmail_send'],
      start: 'ask',
      ceiling: 'auto',
      conditions: ['case'],
    },
    {
      key: 'draft',
      label: 'Draft a reply',
      tools: ['gmail_create_draft'],
      start: 'auto',
      ceiling: 'auto',
      conditions: [],
    },
    {
      key: 'label',
      label: 'Label the mail',
      tools: ['gmail_modify_labels'],
      start: 'auto',
      ceiling: 'auto',
      conditions: [],
    },
    {
      key: 'open_pr',
      label: 'Open a pull request',
      tools: ['github_create_pull_request'],
      start: 'auto',
      ceiling: 'auto',
      conditions: [],
    },
    {
      key: 'merge',
      label: 'Merge a pull request',
      tools: ['github_merge_pull_request'],
      start: 'ask',
      ceiling: 'auto',
      conditions: ['checks_passed'],
    },
  ],
  firstResponse: 'reply',
  limits: { runsPerDay: 100 },
  promotion: { decisions: 30, approvedRate: 0.95 },
  dryRun: { replay: { entry: 0, last: 20 } },
  metrics: ['unattended', 'firstResponse', 'bugsFixed'],
}

const SKILL = (name: string, text: string) =>
  `---\nname: ${name}\ndescription: ${name} steps\n---\n\n${text}\n`

/** A small template of its own, at two versions: what each case changes. */
const inbox = (version: string, change: (m: Record<string, any>) => void = () => {}) => {
  const manifest: Record<string, any> = {
    id: 'brigade/test-updates',
    name: 'Inbox',
    version,
    description: 'Answers the inbox.',
    apps: [{ kind: 'gmail', access: 'read_write' }],
    settings: [
      { key: 'inbox', type: 'account', app: 'gmail' },
      { key: 'address', type: 'email' },
    ],
    entries: [
      {
        trigger: 'gmail.email_received',
        account: '{{inbox}}',
        options: { query: 'to:{{address}}' },
      },
      { schedule: '0 8 * * 1', title: 'Review', instructions: 'Review {{address}}.' },
    ],
    skills: ['skills/triage', 'skills/tone'],
    actions: [
      { key: 'reply', label: 'Reply', tools: ['gmail_send'], start: 'ask', ceiling: 'auto' },
      {
        key: 'label',
        label: 'Label',
        tools: ['gmail_modify_labels'],
        start: 'auto',
        ceiling: 'auto',
      },
      {
        key: 'draft',
        label: 'Draft',
        tools: ['gmail_create_draft'],
        start: 'auto',
        ceiling: 'auto',
      },
      { key: 'old', label: 'Old', tools: ['gmail_search'], start: 'auto', ceiling: 'auto' },
    ],
    limits: { runsPerDay: 10 },
  }
  change(manifest)
  return readTemplate('test-updates', {
    manifest,
    files: {
      'skills/triage/SKILL.md': SKILL('triage', `Triage ${version}.`),
      'skills/tone/SKILL.md': SKILL('tone', `Tone ${version}.`),
    },
  })
}
const V1 = inbox('1.0.0')
const V2 = inbox('1.1.0', (m) => {
  // reply now also drafts (its tools change), draft goes no further than asking, old goes,
  // archive is new and would start on its own, and a new required question.
  m.actions[0].tools = ['gmail_send', 'gmail_create_draft']
  m.actions[2].ceiling = 'ask'
  m.actions[2].start = 'ask'
  m.actions.splice(3, 1, {
    key: 'archive',
    label: 'Archive',
    tools: ['gmail_read_message'],
    start: 'auto',
    ceiling: 'auto',
  })
  m.entries[0].options = { query: 'to:{{address}} -category:promotions', automated: 'skip' }
  m.entries[1].schedule = '0 9 * * 1'
  m.settings.push({ key: 'product', type: 'text', ask: 'Which product?' })
})

test('versions compare as semver', () => {
  assert.ok(compareVersions('1.3.0', '1.0.0') > 0)
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0)
})

test('the diff says what changes, and what happens to autonomy, in plain English', () => {
  const settings = { inbox: 'c1', address: 'help@acme.test' }
  const diff = playbookDiff({
    from: V1.manifest,
    to: V2,
    before: settings,
    after: settings,
    levels: { reply: 'auto', label: 'auto', draft: 'auto', old: 'auto' },
    skills: [
      {
        id: 's1',
        name: 'triage',
        description: 'triage steps',
        instructions: 'Triage 1.0.0.',
        files: [],
        edited: false,
      },
      {
        id: 's2',
        name: 'tone',
        description: 'tone steps',
        instructions: 'Our own tone.',
        files: [],
        edited: true,
      },
    ],
  })
  assert.deepEqual(
    diff.actions.map((a) => [a.key, a.change, a.to]),
    [
      ['reply', 'changed', 'ask'],
      ['label', 'same', 'auto'],
      ['draft', 'ceiling', 'ask'],
      ['archive', 'added', 'ask'],
    ],
  )
  assert.deepEqual(diff.removedActions, [{ key: 'old', label: 'Old' }])
  assert.deepEqual(
    diff.skills.map((s) => [s.name, s.step]),
    [
      ['triage', 'replace'],
      ['tone', 'keep'],
    ],
  )
  const { changes, autonomy } = describeDiff(diff, V1.manifest, V2.manifest, settings, settings)
  assert.deepEqual(changes, [
    'Updates the skill triage',
    'Keeps your edited tone; the new version differs',
    '“Inbox: Email received”: only emails matching becomes “to:help@acme.test -category:promotions”; automatic mail becomes “skip” (same trigger, nothing missed)',
    '“Review”: runs at “0 9 * * 1”',
    'Reply: its tools or conditions change',
    'New action: Archive',
    'Removes the action old',
    'New setting: Which product?',
  ])
  assert.deepEqual(autonomy, [
    'Reply goes back to Asks first, as its tools or conditions change; its history is kept',
    'Draft can go no further than Asks first now',
    'Archive starts at Asks first',
    'The other actions keep their level, limits and history',
  ])
  // Taking the new version of an edited skill, when chosen.
  const chosen = playbookDiff({
    from: V1.manifest,
    to: V2,
    before: settings,
    after: settings,
    levels: {},
    skills: diff.skills.map((s) => s.row!),
    replaceSkills: ['tone'],
  })
  assert.equal(chosen.skills.find((s) => s.name === 'tone')!.step, 'replace')
})

test('the 1.0.0 Support and bugs against the current template', () => {
  const current = templates().get('brigade/support-bugs')!
  const settings = {
    product: 'Acme',
    inbox: 'c1',
    address: 'support@acme.test',
    docs: 'https://docs.acme.test',
    repo: 'acme/app',
    signature: 'The Acme team',
  }
  const diff = playbookDiff({
    from: SUPPORT_1_0_0 as never,
    to: current,
    before: settings,
    after: { ...settings, support: 't1' },
    levels: {},
    skills: [],
  })
  assert.equal(diff.entries[0]!.kind, 'same')
  assert.deepEqual(
    diff.settings.added.map((s) => s.key),
    ['support', 'developer', 'analytics'],
  )
  assert.deepEqual(
    diff.apps.removed.map((r) => r.name),
    ['mixpanel'],
  )
  assert.deepEqual(
    diff.apps.added.map((r) => r.name),
    ['analytics'],
  )
  assert.deepEqual(
    diff.apps.changed.map((c) => c.to.name),
    ['github'],
  )
  assert.ok(diff.actions.every((a) => a.change === 'same'))
  const { changes } = describeDiff(
    diff,
    SUPPORT_1_0_0 as never,
    current.manifest,
    settings,
    settings,
  )
  assert.ok(
    changes.includes(
      'github: held by the teammate who answers “Which teammate fixes the bugs in the code?”',
    ),
    changes.join('\n'),
  )
  assert.ok(changes.includes('New setting: Which teammate fixes the bugs in the code?'))
  assert.ok(
    changes.some((c) => c.startsWith('“Support mail”: only emails matching becomes')),
    changes.join('\n'),
  )
})

describe('updating an installed playbook', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'carol'
    | 'admin'
    | 'chief'
    | 'sam'
    | 'dev'
    | 'gmail'
    | 'computer'
    | 'chat',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const as = (memberId: string, role: string) => ({ ...scope, memberId, role })

  before(async () => {
    ids.org = `org-up-${suffix}`
    await prisma.organization.create({ data: { id: ids.org, name: 'Up', slug: `up-${suffix}` } })
    for (const [key, role] of [
      ['owner', 'owner'],
      ['carol', 'member'],
      ['admin', 'admin'],
    ] as const) {
      await prisma.user.create({
        data: { id: `${key}-${suffix}`, name: key, email: `${key}-${suffix}@test.local` },
      })
      ids[key] = `m-${key}-${suffix}`
      await prisma.member.create({
        data: { id: ids[key], organizationId: ids.org, userId: `${key}-${suffix}`, role },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Up' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop' } as never,
      })
    ).id
    ids.chief = (await db.teammate.create({ data: { name: 'Chief', kind: 'chief' } as never })).id
    ids.sam = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    ids.dev = (await db.teammate.create({ data: { name: 'Dev' } as never })).id
    const app = await db.app.create({
      data: { key: 'gmail', createdByMemberId: ids.owner } as never,
    })
    ids.gmail = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'gmail',
          label: 'support@acme.test',
          externalAccount: 'support@acme.test',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
    // The inbox is listened to: its cursor must not move or go with an update.
    await db.subscription.create({
      data: {
        connectionId: ids.gmail,
        resource: 'inbox',
        mode: 'poll',
        events: ['email'],
        cursor: '4242',
      } as never,
    })
    templates().set(V2.manifest.id, V2)
    // A member's thread with the chief, where a person asks for the update.
    ids.chat = (
      await db.session.create({
        data: {
          teammateId: ids.chief,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: 'Chat',
          origin: 'member',
        } as never,
      })
    ).id
  })

  after(async () => {
    templates().delete(V2.manifest.id)
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: ['owner', 'carol', 'admin'].map((k) => `${k}-${suffix}`) } },
    })
    await prisma.$disconnect()
  })

  /** An installation as an older version made it: its actions, trigger, schedule and recipe. */
  async function installed(input: {
    manifest: Record<string, any>
    settings: Record<string, string>
    levels: Record<string, 'ask' | 'auto' | 'deny'>
    skills: { name: string; description: string; instructions: string }[]
    status?: 'active' | 'paused'
  }) {
    const paused = input.status === 'paused'
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: input.manifest.id,
        version: input.manifest.version,
        manifest: input.manifest,
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        settings: input.settings,
        status: input.status ?? 'active',
        activatedAt: new Date(),
        ...(paused ? { pausedAt: new Date() } : {}),
        createdByMemberId: ids.owner,
      } as never,
    })
    const id = installation.id
    for (const [key, level] of Object.entries(input.levels))
      await db.playbookAction.create({
        data: {
          installationId: id,
          key,
          level,
          ...(key === 'reply' ? { conditions: { cases: ['question'] } } : {}),
        } as never,
      })
    const trigger = await db.trigger.create({
      data: {
        connectionId: ids.gmail,
        teammateId: ids.sam,
        label: input.manifest.entries[0].label ?? 'Inbox: Email received',
        event: 'email_received',
        options: { query: `to:${input.settings.address}` },
        createdByMemberId: ids.owner,
        playbookInstallationId: id,
      } as never,
    })
    const schedule = await db.schedule.create({
      data: {
        teammateId: ids.sam,
        title: input.manifest.entries[1].title,
        instructions: 'Review.',
        cron: input.manifest.entries[1].schedule,
        timezone: 'Europe/Paris',
        ownerMemberId: ids.owner,
        playbookInstallationId: id,
        ...(paused ? { pausedAt: new Date(), nextRunAt: null } : { nextRunAt: new Date() }),
      } as never,
    })
    const pack = await db.skillPack.create({
      data: {
        name: input.manifest.name,
        source: `playbook:${id}`,
        createdByType: 'member',
        createdById: ids.owner,
        playbookInstallationId: id,
      } as never,
    })
    const skills: Record<string, string> = {}
    for (const s of input.skills)
      skills[s.name] = (
        await db.skill.create({
          data: {
            ...s,
            packId: pack.id,
            createdByType: 'member',
            createdById: ids.owner,
            updatedByType: 'member',
            updatedById: ids.owner,
          } as never,
        })
      ).id
    // Its history: runs, and people's decisions on its approvals.
    const run = await db.playbookRun.create({
      data: { installationId: id, case: 'question', outcome: 'resolved', status: 'done' } as never,
    })
    for (let i = 0; i < 3; i++)
      await db.ticket.create({
        data: {
          type: 'approval',
          title: 'Send the reply',
          status: 'approved',
          resolvedAt: new Date(Date.now() - 60_000 * (i + 1)),
          payload: { playbookInstallationId: id, playbookActionKey: 'reply' },
        } as never,
      })
    return { id, trigger: trigger.id, schedule: schedule.id, skills, run: run.id }
  }

  test('an active Support and bugs at 1.0.0 moves to the current template, in place', async () => {
    const current = templates().get('brigade/support-bugs')!
    const settings = {
      product: 'Acme',
      inbox: ids.gmail,
      address: 'support@acme.test',
      docs: 'https://docs.acme.test',
      repo: 'acme/app',
      signature: 'The Acme team',
    }
    const made = await installed({
      manifest: SUPPORT_1_0_0,
      settings,
      levels: { reply: 'auto', draft: 'auto', label: 'auto', open_pr: 'auto', merge: 'ask' },
      skills: [
        { name: 'support-triage', description: 'Old triage', instructions: 'Old.' },
        { name: 'bug-fix', description: 'Old fix', instructions: 'Old.' },
      ],
    })
    // The workspace edited its triage recipe since.
    await db.skill.updateMany({
      where: { id: made.skills['support-triage'] },
      data: { instructions: 'Our own triage.' },
    })
    await db.auditEntry.create({
      data: {
        actorType: 'member',
        actorId: ids.owner,
        action: 'skill.updated',
        targetType: 'skill',
        targetId: made.skills['support-triage']!,
      } as never,
    })

    // Its sheet offers the update, with what changes and the question it needs.
    const { getInstallation } = await import('../src/playbooks.js')
    const view = await getInstallation(db, made.id, { memberId: ids.owner, role: 'owner' })
    assert.equal(view.update?.version, current.manifest.version)
    assert.equal(view.update?.canUpdate, true)
    assert.deepEqual(view.update?.keptSkills, ['support-triage'])
    // Its runs start with its teammate already; who fixes the bugs is asked.
    assert.deepEqual(
      view.update?.newSettings.map((s) => [s.key, s.optional]),
      [
        ['developer', false],
        ['analytics', true],
      ],
    )
    assert.ok(
      view.update!.changes.includes('Keeps your edited support-triage; the new version differs'),
    )
    const carolView = await getInstallation(db, made.id, { memberId: ids.carol, role: 'member' })
    assert.equal(carolView.update?.canUpdate, false)

    // Another member may not.
    await assert.rejects(
      upgradePlaybook(db, as(ids.carol, 'member'), made.id, { settings: {} }),
      /only they or an owner or admin/,
    )
    // Without who fixes the bugs, nothing changes and the question comes back.
    const blocked = await upgradePlaybook(db, as(ids.owner, 'owner'), made.id, { settings: {} })
    assert.equal(blocked.updated, false)
    assert.deepEqual(
      blocked.missing.map((q) => q.key),
      ['developer'],
    )
    const still = await db.playbookInstallation.findFirst({ where: { id: made.id } })
    assert.equal(still!.version, '1.0.0')

    // Answered: it moves.
    const done = await upgradePlaybook(db, as(ids.owner, 'owner'), made.id, {
      settings: { developer: 'Dev' },
    })
    assert.equal(done.updated, true)
    assert.deepEqual([done.from, done.to], ['1.0.0', current.manifest.version])
    assert.deepEqual(done.keptSkills, ['support-triage'])
    const row = await db.playbookInstallation.findFirst({ where: { id: made.id } })
    assert.equal(row!.version, current.manifest.version)
    assert.equal(row!.status, 'active')
    assert.equal(row!.teammateId, ids.sam)
    assert.deepEqual(row!.settings, { ...settings, support: ids.sam, developer: ids.dev })
    assert.equal(done.playbook.update, null)

    // Its trigger: the same one, with the new options; the inbox's cursor untouched.
    const triggers = await db.trigger.findMany({ where: { playbookInstallationId: made.id } })
    assert.deepEqual(
      triggers.map((t) => t.id),
      [made.trigger],
    )
    assert.deepEqual(triggers[0]!.options, {
      query: 'to:support@acme.test -category:promotions -category:social -category:updates',
      automated: 'skip',
    })
    const subscription = await db.subscription.findFirst({ where: { connectionId: ids.gmail } })
    assert.equal(subscription?.cursor, '4242')
    const schedules = await db.schedule.findMany({ where: { playbookInstallationId: made.id } })
    assert.deepEqual(
      schedules.map((s) => [s.id, s.pausedAt]),
      [[made.schedule, null]],
    )
    assert.match(schedules[0]!.instructions, /support for Acme/)

    // Autonomy and history: as they were.
    const actions = await db.playbookAction.findMany({ where: { installationId: made.id } })
    const reply = actions.find((a) => a.key === 'reply')!
    assert.equal(reply.level, 'auto')
    assert.deepEqual(reply.conditions, { cases: ['question'] })
    assert.equal(reply.demotedReason, null)
    assert.equal(actions.find((a) => a.key === 'merge')!.level, 'ask')
    const replyView = done.playbook.actions.find((a) => a.key === 'reply')!
    assert.equal(replyView.approved, 3)
    assert.equal(done.playbook.metrics.week.runs, 1)
    assert.ok(await db.playbookRun.findFirst({ where: { id: made.run } }))

    // Its recipe: the edited skill kept, the other on the new version.
    const skills = await db.skill.findMany({ where: { pack: { playbookInstallationId: made.id } } })
    const triage = skills.find((s) => s.name === 'support-triage')!
    const fix = skills.find((s) => s.name === 'bug-fix')!
    assert.equal(triage.instructions, 'Our own triage.')
    const template = current.skills.find((s) => s.name === 'bug-fix')!
    assert.equal(fix.instructions, template.instructions)
    assert.equal(fix.updatedByType, 'system')

    const entry = await db.auditEntry.findFirst({
      where: { action: 'playbook.upgraded', targetId: made.id },
    })
    assert.deepEqual(
      [(entry?.data as { from?: string })?.from, (entry?.data as { to?: string })?.to],
      ['1.0.0', current.manifest.version],
    )
    await db.playbookInstallation.deleteMany({ where: { id: made.id } })
  })

  test('autonomy never grows; a paused one stays paused; an admin may update it', async () => {
    const made = await installed({
      manifest: V1.manifest,
      settings: { inbox: ids.gmail, address: 'help@acme.test' },
      levels: { reply: 'auto', label: 'auto', draft: 'auto', old: 'auto' },
      skills: V1.skills.map((s) => ({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
      })),
      status: 'paused',
    })
    // A proposal to act on its own, for reply as it was.
    const proposal = await db.ticket.create({
      data: {
        type: 'approval',
        title: 'Let it reply on its own?',
        payload: { playbookPromotion: { installationId: made.id, actionKey: 'reply' } },
      } as never,
    })

    // The new required question blocks, then its answer is checked by kind.
    const blocked = await upgradePlaybook(db, as(ids.admin, 'admin'), made.id, { settings: {} })
    assert.deepEqual([blocked.updated, blocked.missing.map((q) => q.key)], [false, ['product']])
    const done = await upgradePlaybook(db, as(ids.admin, 'admin'), made.id, {
      settings: { product: 'Acme' },
    })
    assert.equal(done.updated, true)
    assert.equal(done.playbook.status, 'paused')

    const actions = await db.playbookAction.findMany({ where: { installationId: made.id } })
    const level = (key: string) => actions.find((a) => a.key === key)
    // Its tools changed: it asks first again, the conditions it allows kept.
    assert.equal(level('reply')!.level, 'ask')
    assert.equal(level('reply')!.demotedReason, 'update')
    assert.ok(level('reply')!.levelChangedAt)
    // Unchanged: as it was.
    assert.equal(level('label')!.level, 'auto')
    assert.equal(level('label')!.demotedReason, null)
    // Its ceiling lowered: capped.
    assert.equal(level('draft')!.level, 'ask')
    // New: no higher than asking, though it would start on its own.
    assert.equal(level('archive')!.level, 'ask')
    // Removed.
    assert.equal(level('old'), undefined)
    const closed = await db.ticket.findFirst({ where: { id: proposal.id } })
    assert.equal(closed!.status, 'resolved')
    // Its history is kept: the decisions still count on its sheet.
    assert.equal(done.playbook.actions.find((a) => a.key === 'reply')!.approved, 3)

    // Its trigger in place, its schedule moved but still paused.
    const trigger = await db.trigger.findFirst({ where: { playbookInstallationId: made.id } })
    assert.equal(trigger!.id, made.trigger)
    assert.deepEqual(trigger!.options, {
      query: 'to:help@acme.test -category:promotions',
      automated: 'skip',
    })
    const schedule = await db.schedule.findFirst({ where: { playbookInstallationId: made.id } })
    assert.equal(schedule!.id, made.schedule)
    assert.equal(schedule!.cron, '0 9 * * 1')
    assert.ok(schedule!.pausedAt)
    assert.equal(schedule!.nextRunAt, null)

    // Unedited skills take the new version.
    const skills = await db.skill.findMany({ where: { pack: { playbookInstallationId: made.id } } })
    assert.deepEqual(skills.map((s) => s.instructions).sort(), ['Tone 1.1.0.', 'Triage 1.1.0.'])

    // On the latest version: nothing more to update.
    await assert.rejects(
      upgradePlaybook(db, as(ids.admin, 'admin'), made.id, { settings: {} }),
      /already on the latest version/,
    )
    await db.playbookInstallation.deleteMany({ where: { id: made.id } })
  })

  test('an edited skill takes the new version when chosen', async () => {
    const made = await installed({
      manifest: V1.manifest,
      settings: { inbox: ids.gmail, address: 'help@acme.test' },
      levels: { reply: 'ask', label: 'auto', draft: 'auto', old: 'auto' },
      skills: [
        { name: 'triage', description: 'triage steps', instructions: 'Edited.' },
        { name: 'tone', description: 'tone steps', instructions: 'Edited too.' },
      ],
    })
    for (const id of Object.values(made.skills))
      await db.auditEntry.create({
        data: {
          actorType: 'member',
          actorId: ids.owner,
          action: 'skill.updated',
          targetType: 'skill',
          targetId: id,
        } as never,
      })
    const done = await upgradePlaybook(db, as(ids.owner, 'owner'), made.id, {
      settings: { product: 'Acme' },
      replaceSkills: ['tone'],
    })
    assert.deepEqual(done.keptSkills, ['triage'])
    const skills = await db.skill.findMany({ where: { pack: { playbookInstallationId: made.id } } })
    assert.equal(skills.find((s) => s.name === 'triage')!.instructions, 'Edited.')
    assert.equal(skills.find((s) => s.name === 'tone')!.instructions, 'Tone 1.1.0.')
    // Written by the playbook: no longer counted as the workspace's edit.
    const { installedSkills } = await import('../src/playbook-updates.js')
    const after = await installedSkills(db, made.id)
    assert.deepEqual(
      after.map((s) => [s.name, s.edited]),
      [
        ['triage', true],
        ['tone', false],
      ],
    )
    await db.playbookInstallation.deleteMany({ where: { id: made.id } })
  })

  test('a teammate updates it from the chat: what changes first, then its answers', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const made = await installed({
      manifest: V1.manifest,
      settings: { inbox: ids.gmail, address: 'help@acme.test' },
      levels: { reply: 'auto', label: 'auto', draft: 'auto', old: 'auto' },
      skills: [],
    })
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    const chief = { id: ids.chief, name: 'Chief' }
    const call = (op: object) =>
      handlePlaybookCall(db, scope, session!, chief, {
        name: 'update_playbook',
        settings: {},
        apply: false,
        ...op,
      } as never) as Promise<Record<string, any>>
    const shown = await call({ playbookKey: V2.manifest.id })
    assert.equal(shown.installationId, made.id)
    assert.deepEqual([shown.from, shown.to], ['1.0.0', '1.1.0'])
    assert.ok(shown.changes.includes('New setting: Which product?'))
    assert.deepEqual(
      shown.newSettings.map((q: { key: string }) => q.key),
      ['product'],
    )
    const unanswered = await call({ installationId: made.id, apply: true })
    assert.equal(unanswered.updated, false)
    assert.match(unanswered.next, /Which product\?/)
    const done = await call({ installationId: made.id, apply: true, settings: { product: 'Acme' } })
    assert.equal(done.updated, true, JSON.stringify(done))
    assert.equal(done.to, '1.1.0')
    const again = await call({ installationId: made.id })
    assert.match(again.error, /already on its latest version/)
    await db.playbookInstallation.deleteMany({ where: { id: made.id } })
  })

  test('a change landing between planning an update and writing it is never undone', async () => {
    const { changeAction } = await import('../src/playbook-autonomy.js')
    const made = await installed({
      manifest: V1.manifest,
      settings: { inbox: ids.gmail, address: 'help@acme.test' },
      levels: { reply: 'auto', label: 'auto', draft: 'auto', old: 'auto' },
      skills: [],
    })
    const owner = { ...as(ids.owner, 'owner'), userId: `owner-${suffix}` } as never
    const done = await upgradePlaybook(
      db,
      as(ids.owner, 'owner'),
      made.id,
      { settings: { product: 'Acme' } },
      {
        // Planned with every action on its own; then a person restricts three of them.
        beforeApply: async () => {
          await changeAction(db, owner, made.id, 'reply', { level: 'deny' })
          await changeAction(db, owner, made.id, 'draft', { level: 'deny' })
          await changeAction(db, owner, made.id, 'label', { level: 'ask' })
        },
      },
    )
    assert.equal(done.updated, true)
    const actions = await db.playbookAction.findMany({ where: { installationId: made.id } })
    const level = (key: string) => actions.find((a) => a.key === key)?.level
    // Its tools changed, but never back up from Never to Asks first.
    assert.equal(level('reply'), 'deny')
    // Its ceiling lowered to Asks first: Never stays Never.
    assert.equal(level('draft'), 'deny')
    // Unchanged: the person's lowering stays.
    assert.equal(level('label'), 'ask')
    assert.equal(level('archive'), 'ask')
    await db.playbookInstallation.deleteMany({ where: { id: made.id } })
  })
})
