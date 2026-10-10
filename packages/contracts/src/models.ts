// The models a teammate can run, per harness. The single list: the teammate form's
// picker, the API's validation and the labels shown elsewhere all read it. To add a
// model when it's released, add a line to its harness below; order is display order.
import type { HarnessId } from './runner.js'

export type HarnessModel = {
  /** What the harness CLI takes as its model (Claude Code `--model`, Codex `-m`). */
  id: string
  /** As the vendor names it in its own picker. */
  label: string
  description: string
}

export const HARNESS_MODELS = {
  claude_code: [
    {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Most capable Opus for complex, agentic work.',
    },
    {
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      description: 'Anthropic’s most capable model, for the hardest long tasks.',
    },
    {
      id: 'claude-sonnet-5-5',
      label: 'Sonnet 5.5',
      description: 'Fast and capable for everyday coding and agent work.',
    },
    {
      id: 'claude-haiku-5-5',
      label: 'Haiku 5.5',
      description: 'Fastest and cheapest, for simple tasks.',
    },
  ],
  codex: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      description: 'Latest workhorse model for coding and everyday work.',
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

/** A teammate's model: null runs the account's default model. */
export const isHarnessModel = (harness: HarnessId, model: string | null) =>
  model === null || HARNESS_MODELS[harness].some((m) => m.id === model)

/** The vendor's name for a model id, or the id itself for one no longer listed. */
export const modelLabel = (harness: HarnessId, model: string | null) =>
  model === null ? 'Default' : (HARNESS_MODELS[harness].find((m) => m.id === model)?.label ?? model)
