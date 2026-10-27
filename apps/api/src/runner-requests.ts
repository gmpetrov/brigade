// Requests a person's view makes of a thread's computer, answered by its runner: a file of a
// teammate's working folder, an edit to one, the code panel's listings, where a preview's element
// is written. Each goes through the computer's workspace hub (askRunner) and never wakes a
// stopped computer: offline, it fails at once.
import { randomUUID } from 'node:crypto'
import type { ApiToRunner, RunnerToApi } from '@brigade/contracts'
import { hubs } from './hub.js'

type Computer = { id: string; workspaceId: string }
type Answer<T extends RunnerToApi['type']> = Extract<RunnerToApi, { type: T }>
type Ask<T extends ApiToRunner['type']> = Omit<
  Extract<ApiToRunner, { type: T }>,
  'type' | 'requestId'
>

/** Ask, and take its answer of that type; any other outcome is a failed answer, with why. */
async function ask<R extends RunnerToApi['type']>(
  computer: Computer,
  message: Extract<ApiToRunner, { requestId: string }>,
  answer: R,
  timeoutMs: number,
): Promise<Answer<R>> {
  const result = await hubs.get(computer.workspaceId).askRunner(computer.id, message, timeoutMs)
  if ('type' in result && result.type === answer) return result as Answer<R>
  return {
    type: answer,
    requestId: message.requestId,
    ok: false,
    error: 'error' in result && result.error ? result.error : 'The computer did not answer',
  } as Answer<R>
}

/**
 * Read a file a thread mentions from its computer (a teammate's working folder or the library
 * mirror), for a person viewing it.
 */
export const readThreadFile = (computer: Computer, request: Ask<'thread.file.read'>) =>
  ask(
    computer,
    { type: 'thread.file.read', requestId: randomUUID(), ...request },
    'thread.file.result',
    10_000,
  )

/** Save a text file of a teammate's working folder that a person edited (CODE_EDIT_PROTOCOL). */
export const writeThreadFile = (computer: Computer, request: Ask<'thread.file.write'>) =>
  ask(
    computer,
    { type: 'thread.file.write', requestId: randomUUID(), ...request },
    'thread.file.written',
    15_000,
  )

/** Where an element of a thread's preview is written, by its text (CODE_EDIT_PROTOCOL). */
export const findSource = (computer: Computer, request: Ask<'thread.source.find'>) =>
  ask(
    computer,
    { type: 'thread.source.find', requestId: randomUUID(), ...request },
    'thread.source.result',
    // Each of up to six searches may take up to 15 s on the runner.
    30_000,
  )

/**
 * The code panel's view of a teammate's working folder: a folder's entries, files by name, lines
 * by text, open files' hashes (CODE_TREE_PROTOCOL).
 */
export const codeFiles = (computer: Computer, request: Ask<'thread.code'>) =>
  ask(
    computer,
    { type: 'thread.code', requestId: randomUUID(), ...request },
    'thread.code.result',
    20_000,
  )
