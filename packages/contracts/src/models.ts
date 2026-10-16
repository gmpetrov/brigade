// The models a teammate can run, per harness. The single list: the teammate form's
// picker, the API's validation and the labels shown elsewhere all read it. To add a
// model when it's released, add a line to its harness below; order is display order.
import type { Effort, HarnessId } from './runner.js'

export type HarnessModel = {
  /** What the harness CLI takes as its model (Claude Code `--model`, Codex `-m`). */
  id: string
  /** As the vendor names it in its own picker. */
  label: string
  description: string
  /**
   * The effort the CLI runs it at when Brigade sends none, from the vendor's docs
   * (Claude Code's model config, OpenAI's model guide). Unset where they don't say.
   */
  effort?: Effort
}

export const HARNESS_MODELS = {
  claude_code: [
    {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Most capable Opus for complex, agentic work.',
      effort: 'medium',
    },
    {
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      description: 'Anthropic’s most capable model, for the hardest long tasks.',
      effort: 'high',
    },
    {
      id: 'claude-sonnet-5-5',
      label: 'Sonnet 5.5',
      description: 'Fast and capable for everyday coding and agent work.',
      effort: 'medium',
    },
    {
      id: 'claude-haiku-5-5',
      label: 'Haiku 5.5',
      description: 'Fastest and cheapest, for simple tasks.',
      effort: 'medium',
    },
  ],
  codex: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      description: 'Latest workhorse model for coding and everyday work.',
      effort: 'medium',
    },
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Frontier intelligence for the most demanding work.',
    },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: 'Previous generation workhorse model.' },
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
    },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Older generation workhorse model.' },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Older balanced model for straightforward work.',
    },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Older fast and efficient model.' },
  ],
} as const satisfies Record<HarnessId, readonly HarnessModel[]>

/**
 * What a Codex teammate on Default runs, and the image tool. The Codex adapter's
 * own default (GPT-5.5) was retired for ChatGPT sign-ins on 2026-10-14.
 */
export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol'

/** The model a turn asks for: on Default, Claude Code runs the account's own, Codex ours. */
export const runModel = (harness: HarnessId, model: string | null) =>
  model ?? (harness === 'codex' ? CODEX_DEFAULT_MODEL : null)

/** A teammate's model: null is Default (runModel). */
export const isHarnessModel = (harness: HarnessId, model: string | null) =>
  model === null || HARNESS_MODELS[harness].some((m) => m.id === model)

/** The vendor's name for a model id, or the id itself for one no longer listed. */
export const modelLabel = (harness: HarnessId, model: string | null) =>
  model === null ? 'Default' : (HARNESS_MODELS[harness].find((m) => m.id === model)?.label ?? model)

/** A thread's effort choices, lowest first, as Claude Code and Codex name them. */
export const EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
] as const satisfies readonly { id: Effort; label: string }[]

/** An effort's name, or Default for none. */
export const effortLabel = (effort: Effort | null) =>
  EFFORTS.find((e) => e.id === effort)?.label ?? 'Default'

/**
 * The effort a thread with none runs at, for the slider's Default mark: the model's own,
 * else Medium, the level of today's models (and a guess for the account's own model).
 */
export const defaultEffort = (harness: HarnessId, model: string | null): Effort => {
  const id = runModel(harness, model)
  const models: readonly HarnessModel[] = HARNESS_MODELS[harness]
  return models.find((m) => m.id === id)?.effort ?? 'medium'
}
