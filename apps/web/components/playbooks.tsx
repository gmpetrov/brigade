'use client'
import {
  withinCeiling,
  type PlaybookActionView,
  type PlaybookAutoCallView,
  type PlaybookInstallationView,
  type PlaybookLevel,
  type PlaybookMetrics,
  type PlaybookNumbers,
  type PlaybookRunView,
  type PlaybookTemplate,
  type PlaybookUpdateQuestion,
  type PlaybookUpgradeResult,
} from '@brigade/contracts'
import {
  ArrowLeft,
  BookOpenCheck,
  EllipsisVertical,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { isAdmin, TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { AppLogos, AppRowBody } from '@/components/playbook-apps'
import { ProjectTag } from '@/components/projects'
import { ProviderLogo, type ProviderKind } from '@/components/provider-logo'
import { describeCron, scheduleTime, zoneName } from '@/components/schedules'
import { StatusDot } from '@/components/status-badge'
import { NewThread, useThreadDraft } from '@/components/new-thread'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api, projectQuery, useApi } from '@/lib/api'
import { useLive } from '@/lib/use-live'
import { cn } from '@/lib/utils'

const STATUS_WORDS: Record<PlaybookInstallationView['status'], string> = {
  setup: 'Being set up',
  dry_run: 'Dry run',
  active: 'Active',
  paused: 'Paused',
}
/** The dot's tone, from StatusDot's words. */
const STATUS_DOTS: Record<PlaybookInstallationView['status'], string> = {
  setup: 'pending',
  dry_run: 'running',
  active: 'active',
  paused: 'paused',
}
const LEVEL_WORDS: Record<PlaybookLevel, string> = {
  ask: 'Asks first',
  auto: 'On its own',
  deny: 'Never',
}
const LEVELS: PlaybookLevel[] = ['ask', 'auto', 'deny']
const RUN_DOTS: Record<PlaybookRunView['status'], string> = {
  running: 'running',
  waiting_person: 'waiting',
  waiting_event: 'pending',
  done: 'done',
  failed: 'failed',
}

/** "Active · 46 runs this week · 91% unattended". */
function statusLine(p: PlaybookInstallationView) {
  return [
    STATUS_WORDS[p.status],
    `${p.runsThisWeek} run${p.runsThisWeek === 1 ? '' : 's'} this week`,
    p.unattended !== null && `${Math.round(p.unattended * 100)}% unattended`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function PlaybookRow({
  playbook: p,
  showProject,
}: {
  playbook: PlaybookInstallationView
  showProject: boolean
}) {
  return (
    <li>
      <Link
        href={`/app/routines/playbooks/${p.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted"
      >
        <AppLogos apps={p.apps} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{p.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={STATUS_DOTS[p.status]} className="size-1.5" />
            <span className="truncate">{statusLine(p)}</span>
          </span>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          {showProject && <ProjectTag project={p.project} />}
          <TeammateAvatar teammate={p.teammate} className="size-4" />
          {p.teammate.name}
        </span>
      </Link>
    </li>
  )
}

/** Playbooks: whole jobs installed in the workspace, above the schedules. In a project, its own. */
export function PlaybookList({ projectId, filter }: { projectId?: string; filter?: string }) {
  const playbooks = useApi<PlaybookInstallationView[]>(
    `/playbooks${projectQuery(projectId ?? filter)}`,
  )
  const catalog = useApi<PlaybookTemplate[]>('/playbooks/catalog')
  const reload = playbooks.reload
  useLive((message) => {
    if (message.type === 'thread.updated' || message.type === 'schedule.updated') void reload()
  })
  const [installing, setInstalling] = useState<PlaybookTemplate>()
  const list = playbooks.data ?? []
  const available = (catalog.data ?? []).filter((t) => !list.some((p) => p.playbookKey === t.id))

  return (
    <section aria-labelledby="playbooks" className="flex flex-col gap-3">
      <h2 id="playbooks" className="flex items-center gap-2 text-sm font-bold">
        <BookOpenCheck className="size-4 text-muted-foreground" aria-hidden />
        Playbooks
      </h2>
      {!playbooks.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.length > 0 ? (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl bg-muted/60">
          {list.map((p) => (
            <PlaybookRow key={p.id} playbook={p} showProject={!projectId} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No playbooks yet. A playbook is a whole job (support, releases…) a teammate runs on its
          own.
        </p>
      )}
      {available.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-medium text-muted-foreground">Catalog</h3>
          <ul className="flex flex-col divide-y rounded-xl border">
            {available.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <AppLogos apps={t.apps} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{t.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.source === 'brigade' ? 'Brigade' : t.source} · v{t.version} · {t.description}
                  </span>
                </div>
                <Button size="sm" variant="outline" onClick={() => setInstalling(t)}>
                  Install
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {installing && (
        <InstallDialog
          template={installing}
          projectId={projectId ?? (filter && filter !== 'none' ? filter : undefined)}
          onClose={() => setInstalling(undefined)}
        />
      )}
      {playbooks.error && (
        <p className="text-sm text-destructive-text">{playbooks.error.message}</p>
      )}
    </section>
  )
}

/**
 * Installing happens in the chat: a new thread to the chief (or a teammate picked), its
 * message ready to send. The teammate asks for its settings there, tries it, then activates it.
 */
function InstallDialog({
  template,
  projectId,
  onClose,
}: {
  template: PlaybookTemplate
  projectId?: string
  onClose: () => void
}) {
  const { teammates } = useDashboard()
  const chief = teammates.find((t) => t.kind === 'chief') ?? teammates[0]
  const [chosen, setChosen] = useState(chief?.id)
  const teammate = teammates.find((t) => t.id === chosen) ?? chief
  const draft = useThreadDraft()
  const { setText } = draft
  useEffect(() => {
    setText(`Install the playbook “${template.name}” (${template.id}).`)
  }, [setText, template])
  if (!teammate) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Install {template.name}</DialogTitle>
        <DialogDescription className="sr-only">
          A teammate installs it with you in a new thread: its settings, a dry run, then activation.
        </DialogDescription>
        <NewThread
          layout="dialog"
          teammate={teammate}
          rows={3}
          draft={draft}
          autoFocus
          projectId={projectId}
          picker={teammates.length > 1 ? { teammates, onChange: setChosen } : undefined}
          placeholder={`Chat with ${teammate.name}`}
        />
      </DialogContent>
    </Dialog>
  )
}

/** The kinds of setting the update dialog asks itself; the others are answered in a chat. */
const SIMPLE: PlaybookUpdateQuestion['type'][] = ['text', 'url', 'email', 'choice', 'amount']

/**
 * Updating to its template's newer version: what changes, what happens to autonomy (it never
 * grows), the skills kept because the workspace edited them, then the Update button. New
 * required settings of a simple kind are asked here; a teammate, account or repository is
 * answered in a chat with the chief, its message ready to send.
 */
function UpdateDialog({
  playbook: p,
  onClose,
  onUpdated,
}: {
  playbook: PlaybookInstallationView
  onClose: () => void
  onUpdated: () => Promise<void>
}) {
  const update = p.update!
  const { teammates } = useDashboard()
  const chief = teammates.find((t) => t.kind === 'chief') ?? teammates[0]
  const draft = useThreadDraft()
  const { setText } = draft
  const [chat, setChat] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [replace, setReplace] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (chat) setText(`Update the playbook “${p.name}” to ${update.version}.`)
  }, [chat, setText, p.name, update.version])

  const required = update.newSettings.filter((s) => !s.optional)
  const inChat = required.filter((s) => !SIMPLE.includes(s.type))
  const unanswered = required.some((s) => SIMPLE.includes(s.type) && !answers[s.key]?.trim())

  async function apply() {
    setError(undefined)
    setBusy(true)
    try {
      const result = await api<PlaybookUpgradeResult>(`/playbooks/${p.id}/update`, {
        body: { settings: answers, ...(replace.length ? { replaceSkills: replace } : {}) },
      })
      if (!result.updated) {
        setError(`Still needs an answer: ${result.missing.map((m) => m.ask).join(', ')}`)
        return
      }
      await onUpdated()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (chat && chief)
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">Update {p.name} in a chat</DialogTitle>
          <DialogDescription className="sr-only">
            {chief.name} asks the new settings in a new thread, then updates it.
          </DialogDescription>
          <NewThread
            layout="dialog"
            teammate={chief}
            rows={3}
            draft={draft}
            autoFocus
            projectId={p.project?.id}
            placeholder={`Chat with ${chief.name}`}
          />
        </DialogContent>
      </Dialog>
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-lg">
        <div className="flex flex-col gap-1">
          <DialogTitle>Update to {update.version}</DialogTitle>
          <DialogDescription>
            {p.name} moves from {p.version} to {update.version}.{' '}
            {p.status === 'active' || p.status === 'paused'
              ? `Its runs, numbers and history stay, and it stays ${STATUS_WORDS[p.status].toLowerCase()}.`
              : 'Its answers are kept, and its triggers, schedules and skills are made again.'}
          </DialogDescription>
        </div>
        {update.changes.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">What changes</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {update.changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {update.autonomy.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">Autonomy</h3>
            <p className="text-xs text-muted-foreground">An update never gives more.</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {update.autonomy.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {update.keptSkills.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Skills you edited</h3>
            <p className="text-xs text-muted-foreground">
              Kept as they are, unless you take the new version.
            </p>
            {update.keptSkills.map((name) => (
              <Label key={name} className="flex items-center gap-2 text-sm font-normal">
                <Checkbox
                  checked={replace.includes(name)}
                  onCheckedChange={(checked) =>
                    setReplace((list) =>
                      checked ? [...list, name] : list.filter((n) => n !== name),
                    )
                  }
                />
                Take the new version of {name}
              </Label>
            ))}
          </section>
        )}
        {required.length > 0 && (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">New settings</h3>
            {required
              .filter((s) => SIMPLE.includes(s.type))
              .map((s) => (
                <div key={s.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={`setting-${s.key}`} className="text-sm font-normal">
                    {s.ask}
                  </Label>
                  {s.type === 'choice' ? (
                    <Select
                      value={answers[s.key]}
                      onValueChange={(value) => setAnswers((a) => ({ ...a, [s.key]: value }))}
                    >
                      <SelectTrigger id={`setting-${s.key}`} className="w-full">
                        <SelectValue placeholder="Choose one" />
                      </SelectTrigger>
                      <SelectContent>
                        {(s.options ?? []).map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`setting-${s.key}`}
                      type={
                        s.type === 'url'
                          ? 'url'
                          : s.type === 'email'
                            ? 'email'
                            : s.type === 'amount'
                              ? 'number'
                              : 'text'
                      }
                      inputMode={s.type === 'amount' ? 'decimal' : undefined}
                      value={answers[s.key] ?? ''}
                      onChange={(e) => setAnswers((a) => ({ ...a, [s.key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            {inChat.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {inChat.map((s) => s.ask).join(' ')} {chief?.name ?? 'A teammate'} asks{' '}
                {inChat.length === 1 ? 'it' : 'them'} in a chat, then updates it.
              </p>
            )}
          </section>
        )}
        {(update.blocked || error) && (
          <p className="text-sm text-destructive-text">{update.blocked ?? error}</p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          {inChat.length > 0 ? (
            <Button disabled={!!update.blocked || !chief} onClick={() => setChat(true)}>
              Answer in a chat
            </Button>
          ) : (
            <Button disabled={!!update.blocked || busy || unanswered} onClick={() => void apply()}>
              {busy ? 'Updating…' : 'Update'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col divide-y rounded-xl bg-muted/60">{children}</div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm">{children}</div>
}

/** A quiet row's dot, in the tone of what it says (also on hover). */
function Dot({
  tone,
  label,
}: {
  tone: 'success' | 'warning' | 'destructive' | 'neutral'
  label: string
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'success'
          ? 'bg-success'
          : tone === 'warning'
            ? 'bg-warning'
            : tone === 'destructive'
              ? 'bg-destructive'
              : 'bg-muted-foreground',
      )}
    />
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md border bg-card px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  )
}

/** What limits it on its own, in a few words: "only for documented_question, at most 20 a day". */
function limitsWords(a: PlaybookActionView) {
  const { conditions: c, limits } = a
  return [
    c.cases?.length && `only for ${c.cases.join(', ')}`,
    (c.checksPassed || a.needsChecks) && 'when checks pass',
    ...Object.entries(c.max ?? {}).map(([argument, max]) => `up to ${max} ${argument}`),
    limits.count !== undefined && `at most ${limits.count} a day`,
    limits.amount && `at most ${limits.amount.max} ${limits.amount.argument} a day`,
  ]
    .filter(Boolean)
    .join(', ')
}

/** Its one line: why it asks again, people's decisions, its limits and what it did today. */
function actionLine(a: PlaybookActionView) {
  const decided = a.approved + a.denied
  const line = [
    a.level === 'ask' &&
      a.demotedReason === 'flagged' &&
      'Asks again since a call was marked as wrong',
    decided > 0 && `${a.approved}/${decided} approved`,
    a.promotionTicketId && 'proposed to act on its own, waiting for a decision',
    a.level === 'auto' && limitsWords(a),
    a.autoToday > 0 && `${a.autoToday} on its own today`,
  ]
    .filter(Boolean)
    .join(' · ')
  return line || (a.level === 'deny' ? 'Never done' : 'Nothing yet')
}

/** An action: its level as one chip, its numbers, and a ⋮ to change the level within its ceiling. */
function ActionRow({
  action: a,
  admin,
  onLevel,
}: {
  action: PlaybookActionView
  admin: boolean
  onLevel: (a: PlaybookActionView, level: PlaybookLevel) => void
}) {
  // A merge on its own waits for GitHub's checks, and only an owner or admin sets it.
  const choices = LEVELS.filter(
    (level) => withinCeiling(level, a.ceiling) && (level !== 'auto' || !a.needsChecks || admin),
  )
  return (
    <Row>
      {a.promotionTicketId ? (
        <Dot tone="warning" label="Waiting for a decision" />
      ) : (
        <Dot tone={a.level === 'auto' ? 'success' : 'neutral'} label={LEVEL_WORDS[a.level]} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{a.label}</span>
        <span className="truncate text-xs text-muted-foreground">{actionLine(a)}</span>
      </div>
      <Chip>{LEVEL_WORDS[a.level]}</Chip>
      {a.canChange && choices.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${a.label} options`}>
              <EllipsisVertical aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {a.label}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={a.level}
              onValueChange={(level) => onLevel(a, level as PlaybookLevel)}
            >
              {choices.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {level === 'auto' && a.needsChecks
                    ? 'On its own when checks pass'
                    : LEVEL_WORDS[level]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Row>
  )
}

/** "45 sec", "12 min", "2.5 h", "1.5 days". */
function duration(minutes: number) {
  const one = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 })
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`
  if (minutes < 60) return `${Math.round(minutes)} min`
  if (minutes < 24 * 60) return `${one(minutes / 60)} h`
  const days = one(minutes / (24 * 60))
  return `${days} day${days === '1' ? '' : 's'}`
}
const percent = (share: number | null) => (share === null ? null : `${Math.round(share * 100)}%`)
const decimal = (n: number | null) =>
  n === null ? null : n.toLocaleString(undefined, { maximumFractionDigits: 1 })
/** A triage case as the recipe names it, read as words: "documented question". */
const caseName = (name: string | null) => (name === null ? 'No case yet' : name.replace(/_/g, ' '))

type Figure = { label: string; value: (n: PlaybookNumbers) => string | null }

/** The figures it shows: a first response only when it times one, bugs only when it can fix some. */
function figures(m: PlaybookMetrics): Figure[] {
  const all: (Figure | false)[] = [
    { label: 'Runs', value: (n) => String(n.runs) },
    { label: 'Unattended', value: (n) => percent(n.unattended) },
    m.responds && {
      label: 'First response',
      value: (n) => (n.firstResponseMinutes === null ? null : duration(n.firstResponseMinutes)),
    },
    { label: 'Interventions per run', value: (n) => decimal(n.interventionsPerRun) },
    { label: 'Escalated', value: (n) => String(n.escalations) },
    { label: 'Writes denied', value: (n) => String(n.denied) },
    m.fixesBugs && { label: 'Bugs fixed', value: (n) => String(n.bugsFixed) },
    { label: 'Session minutes', value: (n) => String(Math.round(n.minutes)) },
  ]
  return all.filter((f): f is Figure => !!f)
}

/**
 * Its numbers over the last 7 days, each with the 7 days before when it ran then, and a small
 * table by triage case. First response is the median; session minutes are on its owner's plan.
 */
function Numbers({ metrics: m }: { metrics: PlaybookMetrics }) {
  const sorted = m.cases.some((c) => c.case !== null)
  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-sm font-medium text-muted-foreground">This week</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/60 px-4 py-3 sm:grid-cols-4">
          {figures(m).map((f) => {
            const last = m.lastWeek && f.value(m.lastWeek)
            return (
              <div key={f.label} className="flex min-w-0 flex-col">
                <dt className="truncate text-xs text-muted-foreground">{f.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{f.value(m.week) ?? '—'}</dd>
                {last && (
                  <dd className="truncate text-xs text-muted-foreground tabular-nums">
                    {last} last week
                  </dd>
                )}
              </div>
            )
          })}
        </dl>
      </section>
      {sorted && (
        <section className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-medium text-muted-foreground">By case</h3>
          <div className="rounded-xl bg-muted/60 pb-1.5">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 pt-3 pb-1 text-left font-normal">Case</th>
                  <th className="px-2 pt-3 pb-1 text-right font-normal">Runs</th>
                  <th className="px-2 pt-3 pb-1 text-right font-normal">Unattended</th>
                  {m.responds && (
                    <th className="px-4 pt-3 pb-1 text-right font-normal">First response</th>
                  )}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {m.cases.map((c) => (
                  <tr key={c.case ?? ''}>
                    <td className="w-full max-w-0 truncate px-4 py-1.5">{caseName(c.case)}</td>
                    <td className="px-2 py-1.5 text-right">{c.runs}</td>
                    <td className="px-2 py-1.5 text-right">{percent(c.unattended) ?? '—'}</td>
                    {m.responds && (
                      <td className="px-4 py-1.5 text-right whitespace-nowrap">
                        {c.firstResponseMinutes === null ? '—' : duration(c.firstResponseMinutes)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

/** A write it made on its own: its thread, and a ⋮ to mark it as wrong. */
function AutoCallRow({
  call: c,
  manages,
  onFlag,
}: {
  call: PlaybookAutoCallView
  manages: boolean
  onFlag: (c: PlaybookAutoCallView) => void
}) {
  return (
    <Row>
      <Dot
        tone={c.flagged ? 'destructive' : 'success'}
        label={c.flagged ? 'Marked as wrong' : 'Done'}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link href={`/app/threads/${c.threadId}`} className="truncate hover:underline">
          {c.action}
        </Link>
        <span className="truncate text-xs text-muted-foreground">
          {c.target} · {timeAgo(c.at)}
        </span>
      </div>
      {c.flagged && <Chip>Marked as wrong</Chip>}
      {manages && !c.flagged && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${c.action} options`}>
              <EllipsisVertical aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem asChild>
              <Link href={`/app/threads/${c.threadId}`}>Open the thread</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onFlag(c)}>Mark as wrong</DropdownMenuItem>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {c.action} then asks first again.
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Row>
  )
}

/** A playbook's sheet: its state, actions, entries, settings and recent runs. */
export function PlaybookSheet({ id }: { id: string }) {
  const router = useRouter()
  const { me } = useDashboard()
  const playbook = useApi<PlaybookInstallationView>(`/playbooks/${id}`)
  const reload = playbook.reload
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [updating, setUpdating] = useState(false)
  useLive((message) => {
    if (message.type === 'thread.updated' || message.type === 'schedule.updated') void reload()
  })

  if (playbook.error)
    return <p className="text-sm text-destructive-text">{playbook.error.message}</p>
  const p = playbook.data
  if (!p) return <Skeleton className="h-64 w-full" />
  const manages = p.owner.id === me.memberId || isAdmin(me)
  const waiting = p.status === 'setup' || p.status === 'dry_run'

  async function act(init: { method: string; body?: unknown }) {
    setError(undefined)
    try {
      await api(`/playbooks/${id}`, init)
      if (init.method === 'DELETE') router.push('/app/routines')
      else await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Its owner, an owner or an admin; a merge on its own always waits for its checks.
  async function setLevel(a: PlaybookActionView, level: PlaybookLevel) {
    setError(undefined)
    try {
      await api(`/playbooks/${id}/actions/${a.key}`, {
        method: 'PATCH',
        body: {
          level,
          ...(level === 'auto' && a.needsChecks
            ? { conditions: { ...a.conditions, checksPassed: true } }
            : {}),
        },
      })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // A write it made on its own was wrong: its action asks first again.
  async function flag(c: PlaybookAutoCallView) {
    setError(undefined)
    try {
      await api(`/playbooks/${id}/calls/${c.id}/flag`, { body: {} })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // An owner or admin activates it; a member asks one, in one ticket.
  async function activate() {
    setError(undefined)
    try {
      await api(`/playbooks/${id}/activate`, { body: {} })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/app/routines"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Routines
      </Link>

      <header className="flex items-start gap-4">
        <AppLogos apps={p.apps} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-2xl font-extrabold tracking-tight">{p.name}</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>
              {p.source === 'brigade' ? 'Brigade' : p.source} · Version {p.version}
              {p.update && ` · ${p.update.version} available`}
            </span>
            {p.update?.canUpdate && (
              <Button size="xs" variant="outline" onClick={() => setUpdating(true)}>
                Update
              </Button>
            )}
          </p>
          <p className="flex items-center gap-1.5 text-sm">
            <StatusDot status={STATUS_DOTS[p.status]} />
            {statusLine(p)}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <TeammateAvatar teammate={p.teammate} className="size-4" />
              <span className="font-medium text-foreground">{p.teammate.name}</span>
            </span>
            <span>on {p.owner.id === me.memberId ? 'your' : `${p.owner.name}'s`} accounts</span>
            <ProjectTag project={p.project} />
          </p>
        </div>
        {confirm ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="destructive" onClick={() => void act({ method: 'DELETE' })}>
              Uninstall
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More" disabled={!manages}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {p.status === 'active' ? (
                <DropdownMenuItem
                  onSelect={() => void act({ method: 'PATCH', body: { paused: true } })}
                >
                  <Pause aria-hidden />
                  Pause
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={waiting && (!p.ready || (!!p.activationTicketId && !isAdmin(me)))}
                  onSelect={() =>
                    void (waiting ? activate() : act({ method: 'PATCH', body: { paused: false } }))
                  }
                >
                  <Play aria-hidden />
                  {!waiting ? 'Resume' : isAdmin(me) ? 'Activate' : 'Ask to activate'}
                </DropdownMenuItem>
              )}
              {p.update?.canUpdate && (
                <DropdownMenuItem onSelect={() => setUpdating(true)}>
                  <RefreshCw aria-hidden />
                  Update to {p.update.version}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                <Trash2 aria-hidden />
                Uninstall
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      {updating && p.update && (
        <UpdateDialog playbook={p} onClose={() => setUpdating(false)} onUpdated={reload} />
      )}
      {confirm && (
        <p className="-mt-3 text-sm text-muted-foreground">
          Its triggers, schedules and skills go with it. Runs nobody took part in leave Threads.
        </p>
      )}
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <p className="text-sm">{p.description}</p>

      {(p.metrics.week.runs > 0 || p.metrics.lastWeek) && <Numbers metrics={p.metrics} />}

      {p.actions.length > 0 && (
        <Section title="Actions">
          {p.actions.map((a) => (
            <ActionRow
              key={a.key}
              action={a}
              admin={isAdmin(me)}
              onLevel={(action, level) => void setLevel(action, level)}
            />
          ))}
        </Section>
      )}

      {(p.autoCalls.length > 0 || p.actions.some((a) => a.level === 'auto')) && (
        <Section title="Done on its own">
          {p.autoCalls.length === 0 ? (
            <Row>
              <span className="text-muted-foreground">Nothing yet.</span>
            </Row>
          ) : (
            p.autoCalls.map((c) => (
              <AutoCallRow
                key={c.id}
                call={c}
                manages={manages}
                onFlag={(call) => void flag(call)}
              />
            ))
          )}
        </Section>
      )}

      {p.apps.length > 0 && (
        <Section title="Apps">
          {p.apps.map((a) => (
            <Row key={a.name}>
              <AppRowBody app={a} />
            </Row>
          ))}
        </Section>
      )}

      <Section title="Entries">
        {p.entries.map((e) =>
          e.kind === 'trigger' ? (
            <Row key={e.id}>
              <ProviderLogo kind={e.app as ProviderKind} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {e.account && (
                <span className="truncate text-xs text-muted-foreground">{e.account}</span>
              )}
            </Row>
          ) : (
            <Row key={e.id}>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {describeCron(e.cron)} ({zoneName(e.timezone)})
                {e.nextRunAt && ` · next ${scheduleTime(e.nextRunAt, e.timezone)}`}
              </span>
            </Row>
          ),
        )}
      </Section>

      {p.settings.length > 0 && (
        <Section title="Settings">
          {p.settings.map((s) => (
            <Row key={s.key}>
              <span className="min-w-0 flex-1 truncate">{s.ask ?? s.key}</span>
              <span className="max-w-[50%] truncate text-muted-foreground">
                {s.value === null ? '—' : String(s.value)}
              </span>
            </Row>
          ))}
        </Section>
      )}

      <Section title="Recent runs">
        {p.recentRuns.length === 0 ? (
          <Row>
            <span className="text-muted-foreground">No runs yet.</span>
          </Row>
        ) : (
          p.recentRuns.map((r) => {
            const body = (
              <>
                <StatusDot status={RUN_DOTS[r.status]} />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                {r.case && <span className="text-xs text-muted-foreground">{r.case}</span>}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(r.startedAt)}
                </span>
              </>
            )
            return r.threadId ? (
              <Link
                key={r.id}
                href={`/app/threads/${r.threadId}`}
                className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted"
              >
                {body}
              </Link>
            ) : (
              <Row key={r.id}>{body}</Row>
            )
          })
        )}
      </Section>
    </div>
  )
}
