// Dictation in the composers: a recording from the dashboard, turned into text by Whisper
// Large v3 Turbo (cheap and quick), then put in the message box for the person to read before
// sending. Through OpenRouter for now, or Groq's own API: both take OpenAI's transcription
// request. Nothing is kept: the audio goes to the provider and the words come back. It comes
// with Brigade Cloud while billing is on, as the provider charges for each second heard.
import { DICTATION_MAX_BYTES, type DictationResult, type DictationStatus } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { cloudEntitled } from './billing.js'
import { env } from './config.js'

/** Where a recording is heard, and by which model: OpenRouter's name or Groq's own. */
export const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/audio/transcriptions',
    model: 'openai/whisper-large-v3-turbo',
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
} as const

export type Transcriber = { url: string; model: string; key: string }

/** The provider configured: Groq's own API when it has a key, else OpenRouter; none without. */
export function transcriber(): Transcriber | null {
  const [provider, key] = env.GROQ_API_KEY
    ? (['groq', env.GROQ_API_KEY] as const)
    : env.OPENROUTER_API_KEY
      ? (['openrouter', env.OPENROUTER_API_KEY] as const)
      : [null, null]
  if (!provider) return null
  return { ...PROVIDERS[provider], model: env.DICTATION_MODEL ?? PROVIDERS[provider].model, key }
}

export const DICTATION_PLAN_REQUIRED =
  'Dictation comes with Brigade Cloud: an owner or admin subscribes in Settings › Billing'

/**
 * The kinds of audio browsers record (MediaRecorder: WebM/Opus in Chrome and Firefox, MP4/AAC
 * in Safari), by the file name the provider reads the format from.
 */
const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  // Chrome names a recording of a <video>-less stream video/webm at times.
  'video/webm': 'webm',
  'video/mp4': 'mp4',
}

/** The audio's file name for the provider, from its type without codecs; null for a type it does not take. */
export function audioName(type: string) {
  const ext = EXTENSIONS[type.split(';')[0]!.trim().toLowerCase()]
  return ext ? `dictation.${ext}` : null
}

/** Whether the workspace's composers show a working microphone. */
export async function dictationStatus(workspaceId: string): Promise<DictationStatus> {
  if (!transcriber()) return { available: false, reason: 'off' }
  if (!(await cloudEntitled(workspaceId))) return { available: false, reason: 'plan' }
  return { available: true }
}

/** 404 without a provider, 402 without the plan. */
export async function requireDictation(workspaceId: string) {
  const status = await dictationStatus(workspaceId)
  if (status.available) return
  if (status.reason === 'off')
    throw new HTTPException(404, { message: 'Dictation is not set up on this Brigade' })
  throw new HTTPException(402, { message: DICTATION_PLAN_REQUIRED })
}

/** The words in `audio`, by the provider. `fetcher` is for tests. */
export async function transcribe(
  audio: Blob,
  options: { to: Transcriber; fetcher?: typeof fetch; timeoutMs?: number },
): Promise<DictationResult> {
  if (audio.size === 0) throw new HTTPException(400, { message: 'The recording is empty' })
  if (audio.size > DICTATION_MAX_BYTES)
    throw new HTTPException(413, { message: 'Recordings can be up to 20 MB' })
  const name = audioName(audio.type)
  if (!name) throw new HTTPException(415, { message: 'This kind of audio cannot be transcribed' })
  const form = new FormData()
  form.append('file', new File([audio], name, { type: audio.type.split(';')[0]! }))
  form.append('model', options.to.model)
  form.append('response_format', 'json')
  // Low temperature: the words heard, not a guess at better ones.
  form.append('temperature', '0')
  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(options.to.url, {
      method: 'POST',
      // X-Title: how OpenRouter names the app in its activity; Groq ignores it.
      headers: { authorization: `Bearer ${options.to.key}`, 'x-title': 'Brigade' },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
  } catch {
    throw new HTTPException(502, { message: 'Transcription is unreachable, try again' })
  }
  if (response.status === 429)
    throw new HTTPException(429, { message: 'Dictation is busy, try again in a moment' })
  if (!response.ok) {
    // Logged, not shown: the provider's message may name the account (credits, limits).
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null
    console.warn('dictation: the provider answered', response.status, body?.error?.message)
    throw new HTTPException(response.status === 400 ? 422 : 502, {
      message:
        response.status === 400
          ? 'This recording could not be transcribed'
          : 'Transcription failed, try again',
    })
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null
  if (typeof body?.text !== 'string')
    throw new HTTPException(502, { message: 'Transcription failed, try again' })
  return { text: body.text.trim() }
}
