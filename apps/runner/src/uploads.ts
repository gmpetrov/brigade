// Files the runner sends to Brigade go straight to the bucket, never through the API:
// the API signs where to PUT the bytes (a ticket), the runner PUTs them there, then asks
// the API to check what arrived (its size and SHA-256). Without R2 (development) the
// ticket is a signed path of the API's own stand-in, resolved against its address.
// Hub messages then carry only the upload's reference.
import { createHash } from 'node:crypto'
import {
  LIBRARY_SAVE_MAX,
  type FileUploadInfo,
  type RunnerToApi,
  type SkillFileRef,
  type SkillProposal,
} from '@brigade/contracts'
import type { BackupName, BundleStore } from './repos.js'

export type Api = { apiUrl: string; token: string }

/** Where to PUT a file's bytes, and the headers to send with them. */
export type Ticket = { url: string; headers?: Record<string, string> }

/** The API, or the bucket, refused a step of an upload; `status` is its HTTP status. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** POST JSON to the API with the runner's token. */
export function apiPost(api: Api, path: string, body: unknown = {}) {
  return fetch(new URL(path, api.apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The API's JSON answer, or an UploadError saying what `step` it refused and why. */
export async function answer<T>(response: Response, step: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok)
    throw new UploadError(
      `the API refused ${step} (${response.status}${body.error ? `: ${body.error}` : ''})`,
      response.status,
    )
  return body
}

/**
 * PUT the bytes at a ticket's URL: the bucket's, or the API's signed stand-in (a path).
 * Never with the runner's token: the URL is signed.
 */
export async function putBytes(api: Api, ticket: Ticket, bytes: Uint8Array) {
  const url = new URL(ticket.url, api.apiUrl)
  const response = await fetch(url, {
    method: 'PUT',
    headers: ticket.headers ?? {},
    body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const where = url.origin === new URL(api.apiUrl).origin ? 'API' : 'bucket'
    throw new UploadError(`the ${where} refused the upload (${response.status})`, response.status)
  }
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Start, PUT, complete: a ticket from `start`, the bytes PUT there (by `put` when the
 * ticket is not a URL), then `complete`'s answer. A complete refused with 400 (the bytes
 * did not match) is uploaded again, once.
 */
export async function upload<T, K>(
  api: Api,
  bytes: Uint8Array,
  steps: {
    start: () => Promise<K>
    put?: (ticket: K) => Promise<void>
    complete: (ticket: K) => Promise<T>
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const ticket = await steps.start()
    await (steps.put ? steps.put(ticket) : putBytes(api, ticket as Ticket, bytes))
    try {
      return await steps.complete(ticket)
    } catch (error) {
      if (attempt === 0 && error instanceof UploadError && error.status === 400) continue
      throw error
    }
  }
}

/**
 * A teammate's file for the library or one of a skill it proposes (POST /runner/uploads),
 * checked once in. `name`: its library path, or its path in the skill.
 */
export function uploadForTeammate(
  api: Api,
  input: {
    purpose: 'library' | 'skill_file'
    sessionId: string
    teammateId?: string
    name: string
    bytes: Uint8Array
    contentType?: string
  },
): Promise<FileUploadInfo> {
  const { bytes, ...rest } = input
  const sha256 = sha256Hex(bytes)
  return upload(api, bytes, {
    start: async () =>
      answer<Ticket & { id: string }>(
        await apiPost(api, '/runner/uploads', { ...rest, size: bytes.length, sha256 }),
        `the upload of ${input.name}`,
      ),
    complete: async (ticket) =>
      answer<FileUploadInfo>(
        await apiPost(api, `/runner/uploads/${encodeURIComponent(ticket.id)}/complete`),
        `the upload of ${input.name}`,
      ),
  })
}

/**
 * A library operation as the teammate's tools make it: a save holds the file's bytes,
 * a skill proposal its files'. They go to the bucket; the hub message names them.
 */
export type LibraryOperation =
  | Exclude<
      Extract<RunnerToApi, { type: 'library.call' }>['operation'],
      { name: 'save' } | { name: 'skill_proposal' }
    >
  | { name: 'save'; path: string; bytes: Buffer }
  | {
      name: 'skill_proposal'
      proposal: Omit<SkillProposal, 'refs'>
      files: { path: string; bytes: Buffer }[]
    }

/** The operation for the hub: its files uploaded first, named by reference. */
export async function libraryMessage(
  api: Api,
  seat: { sessionId: string; teammateId?: string },
  operation: LibraryOperation,
): Promise<Extract<RunnerToApi, { type: 'library.call' }>['operation']> {
  if (operation.name === 'save') {
    if (operation.bytes.length > LIBRARY_SAVE_MAX)
      throw new Error(`Files saved from a thread can be up to ${LIBRARY_SAVE_MAX / 1024 / 1024} MB`)
    const { id } = await uploadForTeammate(api, {
      purpose: 'library',
      ...seat,
      name: operation.path,
      bytes: operation.bytes,
    })
    return { name: 'save', path: operation.path, upload: { id } }
  }
  if (operation.name === 'skill_proposal') {
    const refs: SkillFileRef[] = []
    for (const file of operation.files) {
      const info = await uploadForTeammate(api, {
        purpose: 'skill_file',
        ...seat,
        name: file.path,
        bytes: file.bytes,
      })
      refs.push({ path: file.path, sha256: info.sha256, size: info.size })
    }
    return { name: 'skill_proposal', proposal: { ...operation.proposal, refs } }
  }
  return operation
}

/**
 * Git backups GitHub would not take, in the API's bucket: put straight there at a signed
 * URL, then checked (size, SHA-256, a git bundle); fetched back through the API.
 */
export function bundleStore(api: Api): BundleStore {
  const path = (b: BackupName) =>
    `/runner/backups/${[...b.repository.split('/'), b.sessionId, b.teammateId, b.folder]
      .map(encodeURIComponent)
      .join('/')}`
  return {
    put: async (backup, bundle) => {
      const body = { size: bundle.length, sha256: sha256Hex(bundle) }
      await upload(api, bundle, {
        start: async () =>
          answer<Ticket>(await apiPost(api, `${path(backup)}/upload`, body), 'the backup'),
        complete: async () =>
          answer(await apiPost(api, `${path(backup)}/done`, body), 'the backup'),
      })
    },
    get: async (backup) => {
      const response = await fetch(new URL(path(backup), api.apiUrl), {
        headers: { authorization: `Bearer ${api.token}` },
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`the API refused the backup (${response.status})`)
      return Buffer.from(await response.arrayBuffer())
    },
  }
}
