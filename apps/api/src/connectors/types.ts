import type { z } from 'zod'

/** One thing a connector can do. Each declares whether it reads or writes and what it touches. */
export type Operation<I extends z.ZodType = z.ZodType> = {
  description: string
  write: boolean
  input: I
  /** The exact object a call touches, for approvals and the call log. */
  target: (input: z.infer<I>) => string
  run: (ctx: ConnectorContext, input: z.infer<I>) => Promise<unknown>
}

/**
 * What an operation gets: an authorised fetch, and the call's id for vendor
 * idempotency keys. The credential stays inside the API.
 */
export type ConnectorContext = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  callId: string
}

export type ConnectorKind = 'gmail' | 'google_calendar' | 'stripe' | 'github' | 'webhook'

/** A vendor API key, entered once in the dashboard and kept in the vault. */
export type ApiKeyCredential = { apiKey: string }

/** A trigger option, shown as a text field. */
export type TriggerOption = {
  name: string
  label: string
  placeholder?: string
  help?: string
  required?: boolean
}

/** A vendor event, as the ingress or the change reader hands it to the triggers. */
export type VendorEvent = {
  /** The vendor's id for this event, so a retried delivery starts nothing twice. */
  id: string
  /** The vendor's event type, e.g. payment_intent.succeeded or issues.opened. */
  type: string
  // biome-ignore lint: vendor payloads are untyped JSON
  payload: any
}

/** One kind of event that can start a thread, from a connector's catalog. */
export type TriggerDefinition = {
  label: string
  description: string
  options?: TriggerOption[]
  /** The vendor event types it listens to. */
  events: string[]
  /** Whether an event of a listed type concerns this trigger, given its options. */
  matches?: (
    event: VendorEvent,
    options: Record<string, string>,
    ctx: { fetch: ConnectorContext['fetch'] },
  ) => boolean | Promise<boolean>
  /** What the teammate reads first: a title and a few lines, before the raw payload. */
  describe: (event: VendorEvent) => { title: string; summary: string }
  /** The conversation an event belongs to (e.g. a Gmail thread): its later events continue the same thread. */
  conversation?: (event: VendorEvent) => string | undefined
}

export type ConnectorDefinition = {
  kind: ConnectorKind
  label: string
  /** The events that can start threads, by id. */
  triggers?: Record<string, TriggerDefinition>
  /**
   * google: OAuth tokens refreshed by the API. api_key: a key entered in the dashboard.
   * github_app: an installation of Brigade's GitHub App; tokens are minted per call.
   */
  auth: 'google' | 'api_key' | 'github_app'
  operations: Record<string, Operation>
}

export const op = <I extends z.ZodType>(o: Operation<I>) => o as unknown as Operation

export class ConnectorError extends Error {}

/**
 * Vendors may echo part of a credential in errors (Stripe shows a masked key).
 * Nothing that looks like a key or token leaves the API, even masked.
 */
export function redact(text: string) {
  return text
    .replace(/\b(sk|rk|pk|whsec)_(test_|live_)?[A-Za-z0-9*]+/g, '[redacted key]')
    .replace(/\bya29\.[\w-]+/g, '[redacted token]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]+|github_pat_\w+)/g, '[redacted token]')
    .replace(/\bBearer\s+[\w.*-]+/gi, 'Bearer [redacted]')
}

/** Fetch JSON from a vendor API and turn its errors into readable ones. */
export async function json<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.ok) {
    let message = body.slice(0, 500)
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
      message = parsed.error?.message ?? parsed.message ?? message
    } catch {
      // not JSON
    }
    throw new ConnectorError(redact(`${response.status}: ${message}`))
  }
  return (body ? JSON.parse(body) : {}) as T
}
