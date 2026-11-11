'use client'

// A thread's goal (docs/goals.md), at its top: the contract to approve in one click while it is
// proposed; then the measurement and its curve, the target, the deadline, the budget spent and
// the writes allowed in advance, with pause, stop and withdrawing a permission at any time; once
// over, the final measurement and the teammate's summary.
import {
  GOAL_LIMITS,
  type GoalContract,
  type GoalMeasurementView,
  type GoalTarget,
  type GoalView,
} from '@brigade/contracts'
import { Check, ChevronDown, Pause, Play, Square, Target, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActivityIndicator } from '@/components/ui/activity-indicator'
import { Hint } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

/** "in 2 days", "in 5 hours", "passed". */
function left(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'passed'
  const hours = ms / 3_600_000
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (hours < 48) return `in ${Math.round(hours)} h`
  return `in ${Math.round(hours / 24)} days`
}

const EXIT: GoalTarget = { comparison: 'at_least', value: 1 }
const targetOf = (c: GoalContract) =>
  c.target ?? (c.recipe.kind === 'command' && c.recipe.read === 'exit_code' ? EXIT : undefined)
const exitCode = (c: GoalContract) => c.recipe.kind === 'command' && c.recipe.read === 'exit_code'

function targetText(c: GoalContract) {
  if (exitCode(c)) return 'Exits 0'
  const t = c.target
  if (!t) return null
  return `${t.comparison === 'at_least' ? 'At least' : 'At most'} ${plain.format(t.value)}${t.unit ? ` ${t.unit}` : ''}`
}

function valueText(c: GoalContract, value: number | null) {
  if (value === null) return '—'
  if (exitCode(c)) return value >= 1 ? 'Passing' : 'Failing'
  return `${plain.format(value)}${c.target?.unit ? ` ${c.target.unit}` : ''}`
}

function recipeText(c: GoalContract, accounts: Record<string, string>) {
  const r = c.recipe
  if (r.kind === 'command')
    return (
      <>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{r.command}</code>
        {r.read === 'exit_code' ? ' passes' : ', its last number'}, after each turn
      </>
    )
  if (r.kind === 'app')
    return `${r.operation.replace(/_/g, ' ')} on ${accounts[r.connectionId] ?? 'an App account'}, every ${r.everyMinutes} min and after each turn`
  if (r.kind === 'list') return `Ticked lines of ${r.path}`
  return 'Your judgment, at the deadline or before'
}

const END_TEXT: Record<string, string> = {
  deadline: 'Its deadline passed',
  budget: 'Its budget is spent',
  duration: 'It ran for its longest duration',
  stalled: 'Nothing moved for too many turns',
  stopped: 'Stopped',
  not_met: 'Judged not reached',
}

/** The measurement's curve, with the target as a dashed line. */
function Curve({ points, target }: { points: GoalMeasurementView[]; target?: GoalTarget }) {
  const values = points.flatMap((p) => (p.status === 'ok' && p.value !== null ? [p.value] : []))
  if (values.length < 2) return null
  const all = target ? [...values, target.value] : values
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const w = 120
  const h = 32
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4)
  const line = values.map((v, i) => `${(i / (values.length - 1)) * w},${y(v)}`).join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-8 w-[120px] shrink-0 overflow-visible text-primary"
      aria-label={`Measurements: ${values.join(', ')}`}
      role="img"
    >
      {target && (
        <line
          x1={0}
          x2={w}
          y1={y(target.value)}
          y2={y(target.value)}
          className="stroke-muted-foreground/50"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

export function GoalBanner({
  threadId,
  goal,
  onChange,
}: {
  threadId: string
  goal: GoalView | null | undefined
  onChange: () => Promise<unknown> | void
}) {
  const [open, setOpen] = useState(true)
  // One request at a time: every control waits while one is on its way.
  const [busy, setBusy] = useState<string>()
  if (!goal || goal.status === 'declined' || goal.status === 'superseded') return null
  const c = goal.contract
  const target = targetOf(c)
  const base = `/threads/${threadId}/goal/${goal.id}`
  const act = async (key: string, path: string, init?: { method?: string; body?: unknown }) => {
    if (busy) return
    setBusy(key)
    try {
      await api(path, {
        method: init?.method ?? 'POST',
        ...(init?.body ? { body: init.body } : {}),
      })
      await onChange()
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  const spin = (key: string) => busy === key && <ActivityIndicator className="size-3.5" />
  const latest = [...goal.measurements].reverse().find((m) => m.status !== 'pending') ?? null
  const measuring = goal.measurements.at(-1)?.status === 'pending'
  const proposed = goal.status === 'proposed'
  const live = goal.status === 'active' || goal.status === 'paused'
  const over = goal.status === 'achieved' || goal.status === 'ended'

  const heading = proposed
    ? 'Goal proposed'
    : goal.status === 'achieved'
      ? 'Goal reached'
      : goal.status === 'ended'
        ? `Goal over · ${END_TEXT[goal.endReason ?? ''] ?? 'Ended'}`
        : goal.status === 'paused'
          ? 'Goal paused'
          : goal.heldUntil
            ? 'Goal waiting for usage'
            : 'Goal'

  const permissions = c.permissions.length ? (
    <ul className="flex flex-col gap-1">
      {c.permissions.map((p) => {
        const withdrawn = goal.revoked.includes(p.id)
        return (
          <li key={p.id} className="flex items-center gap-2">
            <span
              className={cn('min-w-0 flex-1', withdrawn && 'text-muted-foreground line-through')}
            >
              {p.label}
              <span className="text-muted-foreground">
                {' '}
                · {accountsLine(goal.accounts, p.connectionId)}
                {!proposed && !withdrawn && ` · ${goal.usedToday[p.id] ?? 0}/${p.perDay} today`}
              </span>
            </span>
            {live && goal.mayAct && !withdrawn && (
              <Hint label="Withdraw: its writes ask you again">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={`Withdraw ${p.label}`}
                  disabled={!!busy}
                  onClick={() =>
                    void act(`revoke-${p.id}`, `${base}/permissions/${p.id}`, { method: 'DELETE' })
                  }
                >
                  {spin(`revoke-${p.id}`) || <X className="size-3.5" />}
                </Button>
              </Hint>
            )}
          </li>
        )
      })}
    </ul>
  ) : (
    <span className="text-muted-foreground">None: every write asks you as usual</span>
  )

  const budgetShare = Math.min(1, goal.budget.used / goal.budget.tokens)

  return (
    <section
      aria-label="Goal"
      className={cn('mb-4 rounded-2xl border bg-card shadow-sm', proposed && 'border-primary/40')}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px]"
      >
        {goal.status === 'achieved' ? (
          <Check aria-hidden className="size-4 shrink-0 text-success" />
        ) : (
          <Target aria-hidden className="size-4 shrink-0" />
        )}
        <span className="shrink-0 font-semibold">{heading}</span>
        <span className="min-w-0 truncate text-muted-foreground">· {c.outcome}</span>
        {!proposed && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {measuring && !latest ? '…' : valueText(c, latest?.value ?? null)}
            {target && !exitCode(c) && ` / ${plain.format(target.value)}`}
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            proposed && 'ml-auto',
            !open && '-rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          {!proposed && (
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold tabular-nums">
                  {valueText(c, latest?.value ?? null)}
                  {targetText(c) && (
                    <span className="text-sm font-normal text-muted-foreground">
                      {' '}
                      · target {targetText(c)?.toLowerCase()}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {measuring ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ActivityIndicator className="size-3" label="Measuring" /> Measuring
                    </span>
                  ) : latest ? (
                    latest.status === 'failed' ? (
                      `Last measurement failed: ${latest.detail ?? 'no value'}`
                    ) : (
                      `Measured by Brigade ${when(latest.at)}`
                    )
                  ) : c.recipe.kind === 'person' ? (
                    'You judge it'
                  ) : (
                    'Not measured yet'
                  )}
                </div>
              </div>
              <Curve points={goal.measurements} target={target} />
            </div>
          )}
          {goal.holdReason && live && (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
              {goal.holdReason}
              {goal.heldUntil && ` It resumes ${when(goal.heldUntil)}.`}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {proposed && <Row label="Result">{c.outcome}</Row>}
            {proposed && targetText(c) && <Row label="Target">{targetText(c)}</Row>}
            {c.deadline && (
              <Row label="Deadline">
                {when(c.deadline)}
                {!over && <span className="text-muted-foreground"> · {left(c.deadline)}</span>}
              </Row>
            )}
            <Row label="Measured by">{recipeText(c, goal.accounts)}</Row>
            <Row label="Budget">
              {proposed ? (
                `${compact.format(c.budget.tokens)} tokens of your subscription, ${c.budget.hours} h at most`
              ) : (
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-primary/15">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(budgetShare * 100)}%` }}
                    />
                  </span>
                  <span className="tabular-nums">
                    {compact.format(goal.budget.used)} / {compact.format(goal.budget.tokens)} tokens
                  </span>
                  {goal.budget.endsAt && !over && (
                    <span className="text-muted-foreground">
                      · ends {when(goal.budget.endsAt)} at the latest
                    </span>
                  )}
                </span>
              )}
            </Row>
            {!proposed && !over && (
              <Row label="No progress">
                {goal.stalledTurns} of {c.stallTurns} turns before it stops
              </Row>
            )}
            {proposed && (
              <Row label="Stops after">{c.stallTurns} turns in a row without progress</Row>
            )}
            <Row label="Allowed">{permissions}</Row>
          </div>
          {proposed && (
            <p className="text-xs text-muted-foreground">
              Never lifted by a contract:{' '}
              {GOAL_LIMITS.map((l) =>
                l
                  .replace(/ \(.*\)\.?$/, '')
                  .replace(/\.$/, '')
                  .toLowerCase(),
              ).join('; ')}
              .
            </p>
          )}
          {over && goal.report && (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
              <p>{goal.report.summary}</p>
              {goal.report.worked.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground">What worked</div>
                  <ul className="list-disc pl-5">
                    {goal.report.worked.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {goal.report.didNotWork.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground">
                    What did nothing
                  </div>
                  <ul className="list-disc pl-5">
                    {goal.report.didNotWork.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {proposed && goal.mayApprove && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => void act('approve', `${base}/approve`)}
              >
                {spin('approve')}
                Approve and start
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void act('decline', `${base}/decline`)}
              >
                {spin('decline')}
                Decline
              </Button>
              <span className="text-xs text-muted-foreground">
                To correct it, write what to change.
              </span>
            </div>
          )}
          {live && (goal.mayAct || goal.mayApprove) && (
            <div className="flex flex-wrap items-center gap-2">
              {c.recipe.kind === 'person' && goal.mayApprove && (
                <>
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() => void act('met', `${base}/judge`, { body: { met: true } })}
                  >
                    {spin('met')}
                    Reached
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void act('unmet', `${base}/judge`, { body: { met: false } })}
                  >
                    {spin('unmet')}
                    Not reached
                  </Button>
                </>
              )}
              {goal.status === 'active' && goal.mayAct && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void act('pause', `${base}/pause`)}
                >
                  {spin('pause') || <Pause className="size-3.5" />}
                  Pause
                </Button>
              )}
              {goal.status === 'paused' && goal.mayApprove && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void act('resume', `${base}/resume`)}
                >
                  {spin('resume') || <Play className="size-3.5" />}
                  Resume
                </Button>
              )}
              {goal.mayAct && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Stop this goal for good? Its teammate takes no more turn for it, and its permissions end.',
                      )
                    )
                      void act('stop', `${base}/stop`)
                  }}
                >
                  {spin('stop') || <Square className="size-3.5" />}
                  Stop
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const accountsLine = (accounts: Record<string, string>, id: string) =>
  accounts[id] ?? 'an App account'
