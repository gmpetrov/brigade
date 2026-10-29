// Which audit entries become product analytics events (docs/analytics.md), and with what.
// Pure: src/analytics.ts sends them. Never any content: no text, title, name, path, address or
// repository. A property is kept only when its key is in SAFE_KEYS and its value is a number,
// a boolean or a short word of a closed list (ENUM_VALUE), whatever a rule returns.

export type AnalyticsValue = string | number | boolean
export type AnalyticsProps = Record<string, AnalyticsValue>

export type Emission = { event: string; feature: string; properties: AnalyticsProps }

export type AuditInput = {
  action: string
  actorType: 'member' | 'teammate' | 'runner' | 'system'
  data?: unknown
  /** What the caller adds for analytics alone (audit()'s `track`): enums and counts. */
  track?: AnalyticsProps
}

/**
 * The events that carry `first`: true for a person's first one, false after. People who were
 * here before analytics have them all (prisma/migrations/20261028120000_analytics): a new event
 * here needs its own backfill for them.
 */
export const FIRST_EVENTS = new Set([
  'workspace_created',
  'computer_chosen',
  'ai_account_connected',
  'runner_connected',
  'teammate_created',
  'thread_started',
  'message_sent',
  'turn_completed',
  'pull_request_opened',
  'preview_started',
  'ticket_answered',
  'checkout_started',
  'subscription_started',
])

/** The only property keys an event may carry. */
export const SAFE_KEYS = new Set([
  'feature',
  'first',
  'origin',
  'harness',
  'kind',
  'provider',
  'plan',
  'os',
  'via',
  'from',
  'by',
  'method',
  'outcome',
  'duration_s',
  'response_s',
  'count',
  'repo_count',
  'joined_count',
  'fields_count',
  'app',
  'playbook',
  'role',
  'manual',
  'channel',
  'currency',
  'amount',
  'months_active',
  'reason',
  'status',
])

/** A value of a closed list: a short word, as enums and slugs are. */
export const ENUM_VALUE = /^[a-z0-9][a-z0-9_.-]{0,39}$/

/** Only what is safe to send: known keys, numbers, booleans and enum-like words. */
export function safeProps(props: Record<string, unknown>): AnalyticsProps {
  const out: AnalyticsProps = {}
  for (const [key, value] of Object.entries(props)) {
    if (!SAFE_KEYS.has(key)) continue
    if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string' && ENUM_VALUE.test(value)) out[key] = value
  }
  return out
}

type Data = Record<string, unknown>
type Rule = (data: Data, input: AuditInput) => Partial<Emission> | Partial<Emission>[] | null

const length = (value: unknown) => (Array.isArray(value) ? value.length : undefined)
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The operating system in a runner's platform ("darwin-arm64", "linux x64"…). */
export function osOf(platform: unknown) {
  const p = str(platform)?.toLowerCase() ?? ''
  if (p.startsWith('darwin') || p.startsWith('mac')) return 'mac'
  if (p.startsWith('linux')) return 'linux'
  if (p.startsWith('win')) return 'windows'
  return 'other'
}

/** The App of a trigger's event ("gmail.email_received" → gmail), or custom. */
function appOfEvent(event: unknown) {
  const app = str(event)?.split('.')[0]
  return app && /^[a-z_]{2,30}$/.test(app) ? app : 'custom'
}

const by = (input: AuditInput) => (input.actorType === 'member' ? 'member' : 'teammate')

const event =
  (
    name: string,
    feature: string,
    props?: (data: Data, input: AuditInput) => AnalyticsProps | Data,
  ): Rule =>
  (data, input) => ({
    event: name,
    feature,
    properties: (props?.(data, input) ?? {}) as AnalyticsProps,
  })

const answered = (outcome: string): Rule => event('ticket_answered', 'tickets', () => ({ outcome }))

/** Audit action → its event(s). An action not here sends nothing. */
export const AUDIT_EVENTS: Record<string, Rule> = {
  // Activation
  'workspace.created': event('workspace_created', 'onboarding'),
  'runner.link_code_issued': event('computer_chosen', 'onboarding'),
  'account.added': event('ai_account_connected', 'onboarding', (d) => ({ provider: d.provider })),
  'computer.linked': event('runner_connected', 'onboarding', (d, input) => ({
    kind: input.actorType === 'member' ? 'own_machine' : 'cloud',
    os: osOf(d.platform),
  })),
  // Monetization
  // Paying from onboarding is choosing the cloud computer. Its '' drops checkout's `from`
  // (safeProps keeps no empty value).
  'billing.checkout_started': (_, { track }) => [
    { event: 'checkout_started', feature: 'billing' },
    ...(track?.from === 'onboarding'
      ? [
          {
            event: 'computer_chosen',
            feature: 'onboarding',
            properties: { kind: 'cloud', from: '' },
          },
        ]
      : []),
  ],
  // Threads
  'thread.started': (_, { track }) => [
    { event: 'thread_started', feature: 'threads' },
    // Started by a member typing: that first message is a message sent.
    ...(track?.origin === 'member' ? [{ event: 'message_sent', feature: 'threads' }] : []),
  ],
  'thread.prompted': event('message_sent', 'threads', (d) => ({
    origin: 'member',
    joined_count: length(d.joined) ?? 0,
  })),
  'thread.interrupted': event('thread_interrupted', 'threads'),
  'thread.retried': event('thread_retried', 'threads'),
  'thread.handed_off': event('thread_handed_off', 'threads', (d) => ({ count: length(d.to) ?? 0 })),
  'thread.files_attached': event('files_attached', 'threads', (d) => ({
    count: length(d.attachmentIds) ?? 0,
  })),
  // Teammates
  'teammate.created': event('teammate_created', 'teammates', (d) => ({ harness: d.harness })),
  'teammate.updated': event('teammate_updated', 'teammates', (d) => ({
    fields_count: length(d.fields) ?? 0,
  })),
  'teammate.archived': event('teammate_archived', 'teammates'),
  // Projects
  'project.created': event('project_created', 'projects', (d) => ({
    repo_count: length(d.repositories) ?? 0,
  })),
  'project.repositories_set': event('project_repositories_set', 'projects', (d) => ({
    repo_count: length(d.repositories) ?? 0,
  })),
  // Library
  'library.file_added': event('library_file_created', 'library'),
  'library.file_replaced': event('library_file_edited', 'library'),
  'library.folder_created': event('library_folder_created', 'library'),
  // Designs
  'design.edited': event('design_edited', 'designs'),
  'design.picked': event('design_picked', 'designs'),
  // Previews
  'preview.started': event('preview_started', 'previews'),
  'preview.opened': event('preview_opened', 'previews'),
  // Pull requests (pull_request_opened: src/pull-requests.ts)
  'pull_request.review_requested': event('review_requested', 'pull_requests', (_, input) => ({
    by: by(input),
  })),
  'pull_request.merged': event('pull_request_merged', 'pull_requests', (d, input) => ({
    by: input.actorType === 'member' ? 'button' : 'teammate',
    method: d.method,
  })),
  // Apps
  'connection.created': event('app_connected', 'apps', (d) => ({ app: d.kind })),
  'connection.removed': event('app_removed', 'apps'),
  // Vault
  'credential.created': event('credential_created', 'vault', (d) => ({ kind: d.kind })),
  'credential.released': event('credential_used', 'vault'),
  // Routines
  'schedule.created': event('schedule_created', 'routines'),
  'schedule.run_now': event('schedule_run', 'routines', () => ({ manual: true })),
  'trigger.created': event('trigger_created', 'routines', (d) => ({ app: appOfEvent(d.event) })),
  'trigger.received': event('trigger_received', 'routines', (d) => ({
    app: appOfEvent(d.eventType),
    outcome: d.outcome,
  })),
  // Playbooks: a slug of Brigade's own catalog.
  'playbook.installed': event('playbook_installed', 'playbooks', (d) => ({
    playbook: d.playbookKey,
  })),
  'playbook.dry_run_started': event('playbook_dry_run', 'playbooks'),
  'playbook.activated': event('playbook_activated', 'playbooks'),
  'playbook.uninstalled': event('playbook_uninstalled', 'playbooks', (d) => ({
    playbook: d.playbookKey,
  })),
  // Email
  'email.address.enabled': event('email_address_enabled', 'email'),
  'email.domain.added': event('email_domain_added', 'email'),
  'email.sent': event('email_sent', 'email'),
  // Tickets (ticket_opened: src/analytics.ts, as each ticket is made)
  'ticket.answered': answered('answered'),
  'ticket.declined': answered('declined'),
  'question.answered': answered('answered'),
  'question.declined': answered('declined'),
  'approval.approved': answered('approved'),
  'approval.denied': answered('denied'),
  'cap.allowed': answered('approved'),
  'cap.denied': answered('denied'),
  // Memory and skills
  'memory.written': event('memory_written', 'memory', (d) => ({ kind: d.kind })),
  'skill.proposed': event('skill_proposed', 'skills'),
  'skill.approved': event('skill_approved', 'skills'),
  // Computer
  'takeover.started': event('takeover_started', 'computer'),
  // Team
  'invitation.created': event('member_invited', 'team', (d) => ({ role: d.role })),
  'member.added': event('member_joined', 'team', (d) => ({ role: d.role })),
}

/** The events an audit entry sends, their properties made safe. */
export function emissionsOf(input: AuditInput): Emission[] {
  const rule = AUDIT_EVENTS[input.action]
  if (!rule) return []
  const data = input.data && typeof input.data === 'object' ? (input.data as Data) : {}
  const out = rule(data, input)
  return (Array.isArray(out) ? out : out ? [out] : []).map((e) => ({
    event: e.event!,
    feature: e.feature!,
    // What the caller added for analytics goes with each of its events.
    properties: safeProps({ ...input.track, ...e.properties, feature: e.feature }),
  }))
}
