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

/** What an operation gets: an authorised fetch. The credential stays inside the API. */
export type ConnectorContext = { fetch: (url: string, init?: RequestInit) => Promise<Response> }

export type ConnectorDefinition = {
  kind: 'gmail' | 'google_calendar' | 'stripe'
  label: string
  operations: Record<string, Operation>
}

export const op = <I extends z.ZodType>(o: Operation<I>) => o as unknown as Operation

export class ConnectorError extends Error {}

/** Fetch JSON from a vendor API and turn its errors into readable ones. */
export async function json<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.ok) {
    let message = body.slice(0, 500)
    try {
      message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      // not JSON
    }
    throw new ConnectorError(`${response.status}: ${message}`)
  }
  return (body ? JSON.parse(body) : {}) as T
}
