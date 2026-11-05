'use client'
// Chief's daily pass on Today (docs/chief-answers.md): what it settled in the person's name this
// morning (each answer may be marked wrong), what is still theirs with what Chief would do (one
// click takes its pick, as theirs), what it noticed across their threads, and rules it proposes
// from their answers. Shown only to a person whose pass ran lately.
import type { ChiefPassView } from '@brigade/contracts'
import { ArrowUpRight, Crown } from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, useApi } from '@/lib/api'

type Thread = ChiefPassView['decisions'][number]['thread']

function ThreadLink({ thread }: { thread: Thread }) {
  if (!thread) return null
  return (
    <Link
      href={`/app/threads/${thread.id}`}
      className="group inline-flex min-w-0 items-center gap-1 text-sm font-semibold hover:underline"
    >
      <span className="truncate">{thread.title}</span>
      <ArrowUpRight className="size-3.5 flex-none text-muted-foreground" aria-hidden />
    </Link>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="divide-y">{children}</ul>
    </div>
  )
}

/** A button that runs its action once, then says how it went. */
function Act({
  label,
  done,
  variant = 'outline',
  run,
}: {
  label: string
  done: string
  variant?: 'outline' | 'default' | 'ghost'
  run: () => Promise<unknown>
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string>()
  if (state === 'done') return <span className="text-xs text-muted-foreground">{done}</span>
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy')
          setError(undefined)
          run()
            .then(() => setState('done'))
            .catch((e: Error) => {
              setError(e.message)
              setState('idle')
            })
        }}
      >
        {label}
      </Button>
      {error && <span className="text-xs text-destructive-text">{error}</span>}
    </span>
  )
}

const answerState = (s: ChiefPassView['settled'][number]) =>
  s.outcome === 'overruled'
    ? 'You marked it wrong.'
    : s.status === 'superseded'
      ? 'You answered first: it did not go.'
      : s.status === 'escalated'
        ? 'Left to you: it answered there three times in a row.'
        : null

export function ChiefPassSection() {
  // Read again as threads change: the pass's own as it reports, the others' as they are answered.
  const { data } = useApi<{ pass: ChiefPassView | null }>('/me/chief/pass', ['thread.updated'])
  const pass = data?.pass
  if (!pass) return null
  const how = pass.threadId && (
    <Link
      href={`/app/threads/${pass.threadId}`}
      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      How Chief worked
    </Link>
  )
  const rules = pass.rules.filter((r) => r.state !== 'refused')
  return (
    <section aria-labelledby="chief-pass" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="chief-pass" className="flex items-center gap-2 text-lg font-bold">
          <Crown className="size-4 text-muted-foreground" aria-hidden />
          Chief&apos;s pass
        </h2>
        {how}
      </div>
      {pass.status === 'running' ? (
        <p className="text-sm text-muted-foreground">Chief is going through what waits on you…</p>
      ) : (
        <Card className="gap-0 overflow-hidden py-0 shadow-none">
          {pass.status === 'failed' && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Chief&apos;s pass stopped before it was done: what it did is below, the rest waits on
              you as usual.
            </p>
          )}
          {pass.decisions.length > 0 && (
            <Group title="For you to decide">
              {pass.decisions.map((d, i) => (
                <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <ThreadLink thread={d.thread} />
                    <p className="text-xs text-muted-foreground">{d.what}</p>
                    <p className="text-sm">{d.recommendation}</p>
                  </div>
                  {d.option && d.open && d.thread && !d.option.design && (
                    <Act
                      label={`Use it: ${d.option.label}`}
                      done="Sent as yours"
                      variant="default"
                      run={() =>
                        api(`/threads/${d.thread!.id}/messages`, {
                          body: { text: d.option!.message },
                        })
                      }
                    />
                  )}
                </li>
              ))}
            </Group>
          )}
          {pass.settled.length > 0 && (
            <Group title="Settled in your name">
              {pass.settled.map((s, i) => (
                <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <ThreadLink thread={s.thread} />
                    <p className="text-sm">
                      {s.kind === 'answered' ? `Answered “${s.what}”` : s.what}
                      {s.reason ? ` · ${s.reason}` : ''}
                    </p>
                    {s.rule && (
                      <p className="text-xs text-muted-foreground">By your rule: {s.rule}</p>
                    )}
                    {answerState(s) && (
                      <p className="text-xs text-muted-foreground">{answerState(s)}</p>
                    )}
                  </div>
                  {s.kind === 'answered' &&
                    s.decisionId &&
                    s.thread &&
                    s.status === 'answered' &&
                    s.outcome !== 'overruled' && (
                      <Act
                        label="Mark as wrong"
                        done="Its teammate was told to stop"
                        run={() =>
                          api(`/threads/${s.thread!.id}/chief/${s.decisionId}/wrong`, { body: {} })
                        }
                      />
                    )}
                </li>
              ))}
            </Group>
          )}
          {pass.notes.length > 0 && (
            <Group title="Worth knowing">
              {pass.notes.map((n, i) => (
                <li key={i} className="flex flex-col gap-0.5 px-4 py-2.5">
                  <ThreadLink thread={n.thread} />
                  <p className="text-sm">{n.text}</p>
                </li>
              ))}
            </Group>
          )}
          {rules.length > 0 && (
            <Group title="Rules you may want">
              {rules.map((r) => (
                <li key={r.line} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm font-semibold">{r.line}</p>
                    <p className="text-xs text-muted-foreground">{r.why}</p>
                  </div>
                  {r.state === 'added' ? (
                    <span className="text-xs text-muted-foreground">In your rules</span>
                  ) : (
                    <span className="flex gap-2">
                      <Act
                        label="Add to my rules"
                        done="Added"
                        variant="default"
                        run={() => api('/me/chief/rules', { body: { line: r.line, add: true } })}
                      />
                      <Act
                        label="Not this one"
                        done="Chief won't propose it again"
                        variant="ghost"
                        run={() => api('/me/chief/rules', { body: { line: r.line, add: false } })}
                      />
                    </span>
                  )}
                </li>
              ))}
            </Group>
          )}
          {pass.status === 'done' &&
            !pass.decisions.length &&
            !pass.settled.length &&
            !pass.notes.length &&
            !rules.length && (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Nothing to settle or flag this morning.
              </p>
            )}
        </Card>
      )}
    </section>
  )
}
