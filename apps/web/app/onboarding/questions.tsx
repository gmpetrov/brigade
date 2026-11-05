'use client'
import { ONBOARDING_QUESTIONS, type OnboardingAnswers } from '@brigade/contracts'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Shell } from './shell'

type Option = { id: string; label: string }

/** A question's options in a random order, `other` kept last; a scale stays in its order. */
function ordered(question: (typeof ONBOARDING_QUESTIONS)[number]): Option[] {
  const options = [...question.options] as Option[]
  if (!question.shuffle) return options
  const other = options.filter((o) => o.id === 'other')
  const rest = options.filter((o) => o.id !== 'other')
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return [...rest, ...other]
}

/** How long the picked row shows its check before the next question. */
const ADVANCE_MS = 250

/**
 * Onboarding's questions, one at a time, for someone who just made their project: a pick
 * moves on, Skip leaves a question out. What they say about themselves goes into the chief's
 * first message (setupMessage); all of it is kept once (POST /me/onboarding).
 */
export function Questions({ onDone }: { onDone: () => void }) {
  // Drawn once: Back shows the same order.
  const [lists] = useState(() => ONBOARDING_QUESTIONS.map(ordered))
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<OnboardingAnswers>({})
  const [sending, setSending] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const question = ONBOARDING_QUESTIONS[step]!
  const options = lists[step]!
  const picked = answers[question.key]?.id

  async function next(nextAnswers: OnboardingAnswers) {
    if (step + 1 < ONBOARDING_QUESTIONS.length) return setStep(step + 1)
    setSending(true)
    // Never in the way: answers that fail to save only leave the chief's message plain.
    await api('/me/onboarding', { body: nextAnswers }).catch(() => undefined)
    onDone()
  }

  function pick(option: Option, index: number) {
    if (sending) return
    const nextAnswers = { ...answers, [question.key]: { id: option.id, position: index + 1 } }
    setAnswers(nextAnswers)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void next(nextAnswers), ADVANCE_MS)
  }

  function skip() {
    if (sending) return
    clearTimeout(timer.current)
    const { [question.key]: _, ...rest } = answers
    setAnswers(rest)
    void next(rest)
  }

  function back() {
    clearTimeout(timer.current)
    setStep(step - 1)
  }

  return (
    <Shell
      title="Let's tailor Brigade to you"
      description="Four quick taps, and Chief suggests the teammates that fit your work."
    >
      <Card>
        <CardContent className="flex flex-col gap-5">
          <div className="flex gap-1" aria-hidden>
            {ONBOARDING_QUESTIONS.map((q, i) => (
              <span
                key={q.key}
                className={cn('h-1 flex-1 rounded-full', i <= step ? 'bg-primary' : 'bg-border')}
              />
            ))}
          </div>
          <h2 id="onboarding-question" className="text-lg font-semibold">
            {question.title}
          </h2>
          <div
            role="radiogroup"
            aria-labelledby="onboarding-question"
            className="flex flex-col overflow-hidden rounded-lg border"
          >
            {options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={picked === option.id}
                disabled={sending}
                onClick={() => pick(option, index)}
                className={cn(
                  'flex items-center justify-between border-t px-4 py-2.5 text-left text-sm transition-colors first:border-t-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                  picked === option.id && 'bg-primary/10 hover:bg-primary/10',
                )}
              >
                {option.label}
                <Check
                  className={cn('size-4 text-primary', picked !== option.id && 'invisible')}
                  strokeWidth={3}
                />
              </button>
            ))}
          </div>
          <div className="flex justify-between text-sm text-muted-foreground">
            {step > 0 ? (
              <button type="button" className="hover:text-foreground" onClick={back}>
                Back
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="hover:text-foreground"
              disabled={sending}
              onClick={skip}
            >
              Skip
            </button>
          </div>
        </CardContent>
      </Card>
    </Shell>
  )
}
