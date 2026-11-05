// The questions a new project's creator answers during onboarding (User.onboardingAnswers):
// who they are, which feeds the chief's first message, and where they heard of Brigade.
import { z } from 'zod'

type Option = {
  id: string
  label: string
  /** How the chief's first message says it, when it says it. */
  phrase?: string
}

type Question = {
  key: 'role' | 'teamSize' | 'firstWork' | 'heardFrom'
  title: string
  /** Shown in a random order, `other` last, so no answer wins by being first. */
  shuffle: boolean
  options: readonly Option[]
}

export const ONBOARDING_QUESTIONS = [
  {
    key: 'role',
    title: "What's your role?",
    shuffle: true,
    options: [
      { id: 'founder', label: 'Founder', phrase: "I'm a founder" },
      { id: 'developer', label: 'Developer', phrase: "I'm a developer" },
      { id: 'product', label: 'Product', phrase: 'I work in product' },
      { id: 'marketing', label: 'Marketing', phrase: 'I work in marketing' },
      { id: 'sales', label: 'Sales', phrase: 'I work in sales' },
      { id: 'support', label: 'Support', phrase: 'I work in support' },
      { id: 'operations', label: 'Operations', phrase: 'I work in operations' },
      { id: 'agency', label: 'Agency / freelancer', phrase: 'I run an agency or freelance' },
      { id: 'other', label: 'Other' },
    ],
  },
  {
    key: 'teamSize',
    title: 'How big is your team?',
    // A scale reads in its order.
    shuffle: false,
    options: [
      { id: 'solo', label: 'Just me', phrase: 'working solo' },
      { id: '2-10', label: '2–10', phrase: 'on a team of 2–10' },
      { id: '11-50', label: '11–50', phrase: 'on a team of 11–50' },
      { id: '50-plus', label: '50+', phrase: 'on a team of more than 50' },
    ],
  },
  {
    key: 'firstWork',
    title: 'What should your team take on first?',
    shuffle: true,
    options: [
      { id: 'support', label: 'Support', phrase: 'customer support' },
      { id: 'code', label: 'Code', phrase: 'code' },
      { id: 'marketing', label: 'Marketing & SEO', phrase: 'marketing and SEO' },
      { id: 'sales', label: 'Sales', phrase: 'sales' },
      { id: 'operations', label: 'Ops & admin', phrase: 'operations and admin' },
      { id: 'other', label: 'Other' },
    ],
  },
  {
    key: 'heardFrom',
    title: 'How did you hear about Brigade?',
    shuffle: true,
    options: [
      { id: 'twitter', label: 'X / Twitter' },
      { id: 'linkedin', label: 'LinkedIn' },
      { id: 'youtube', label: 'YouTube' },
      { id: 'reddit', label: 'Reddit' },
      { id: 'hacker_news', label: 'Hacker News' },
      { id: 'product_hunt', label: 'Product Hunt' },
      { id: 'google', label: 'Google' },
      { id: 'ai_assistant', label: 'ChatGPT / AI' },
      { id: 'friend', label: 'A friend' },
      { id: 'other', label: 'Other' },
    ],
  },
] as const satisfies readonly Question[]

export type OnboardingQuestion = (typeof ONBOARDING_QUESTIONS)[number]
export type OnboardingKey = OnboardingQuestion['key']

type OptionId<K extends OnboardingKey> = Extract<
  OnboardingQuestion,
  { key: K }
>['options'][number]['id']

const ids = <K extends OnboardingKey>(key: K) =>
  ONBOARDING_QUESTIONS.find((q) => q.key === key)!.options.map((o) => o.id) as [
    OptionId<K>,
    ...OptionId<K>[],
  ]

/** One answer: the option picked, and where it showed in the list (1 is the top). */
const answer = <K extends OnboardingKey>(key: K) =>
  z.object({ id: z.enum(ids(key)), position: z.number().int().min(1).max(20) }).optional()

/** What the person answered; a question skipped is absent. All skipped is `{}`. */
export const OnboardingAnswers = z.object({
  role: answer('role'),
  teamSize: answer('teamSize'),
  firstWork: answer('firstWork'),
  heardFrom: answer('heardFrom'),
})
export type OnboardingAnswers = z.infer<typeof OnboardingAnswers>

const phraseOf = (key: OnboardingKey, id: string | undefined) =>
  id
    ? (ONBOARDING_QUESTIONS.find((q) => q.key === key)!.options as readonly Option[]).find(
        (o) => o.id === id,
      )?.phrase
    : undefined

/**
 * The first message of a new workspace's setup thread with the chief, with what the person
 * said of themselves. Nothing answered (or only `other`): the plain one.
 */
export function setupMessage(answers: OnboardingAnswers | null | undefined) {
  const role = phraseOf('role', answers?.role?.id)
  const size = phraseOf('teamSize', answers?.teamSize?.id)
  const work = phraseOf('firstWork', answers?.firstWork?.id)
  const who = [role ?? (size ? "I'm" : undefined), size].filter(Boolean).join(role ? ', ' : ' ')
  return [
    'Hi Chief, I just started on Brigade.',
    who && `${who}.`,
    work && `I'd like my team to start with ${work}.`,
    'Help me set up my team.',
  ]
    .filter(Boolean)
    .join(' ')
}
