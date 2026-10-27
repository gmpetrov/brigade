// Where a cloud computer's backups go: Brigade's bucket, sealed with the workspace's backup key
// (sealed.ts), through signed URLs the API hands out, never through the API's memory; account
// logins to the API itself, which seals them with the vault's key. The routes are the API's
// routes/runner-folders.ts (thread folders) and routes/runner-computer.ts (the rest).
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type {
  AccountLogin,
  BackgroundWork,
  FolderBackupDone,
  TeammateBackupKind,
} from '@brigade/contracts'
import type { FolderName } from './folders.js'
import { seal, unseal } from './sealed.js'
import type { Api } from './uploads.js'

/** The API refused a backup step; `status` is its HTTP status (409 while a replacement restores, say). */
export class BackupRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export type FolderBackupInfo = { takenAt: string; size: number; background: BackgroundWork[] }

export class BackupStore {
  private key: Promise<Buffer> | undefined

  constructor(
    private readonly api: Api,
    /** Where files are sealed and unsealed on their way, only the runner's. */
    private readonly tempDir: string,
  ) {}

  /**
   * A thread folder's backup, packed in `file`: sealed, uploaded, and kept by the API. `file` is
   * removed once sealed, so the disk holds one copy at a time.
   */
  async putFolder(name: FolderName, file: string, done: Omit<FolderBackupDone, 'size'>) {
    await this.put(folderPath(name, '/backup'), file, (size) => ({ ...done, size }))
  }

  /** A thread folder's latest backup into `file`, packed; null when it has none. */
  async getFolder(name: FolderName, file: string): Promise<FolderBackupInfo | null> {
    const info = await this.request(folderPath(name, '/backup/info'))
    if (info.status === 404 || info.status === 410) return null
    if (!info.ok) throw await refused('the folder backup', info)
    const found = (await info.json()) as FolderBackupInfo
    return (await this.get(folderPath(name, '/backup'), file)) ? found : null
  }

  async putTeammate(teammateId: string, kind: TeammateBackupKind, file: string) {
    await this.put(teammatePath(teammateId, kind), file, (size) => ({ size }))
  }

  async getTeammate(teammateId: string, kind: TeammateBackupKind, file: string) {
    return this.get(teammatePath(teammateId, kind), file)
  }

  async putLogin(accountId: string, login: AccountLogin) {
    const response = await this.request(loginPath(accountId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(login),
    })
    if (!response.ok) throw await refused('the login backup', response)
  }

  async getLogin(accountId: string): Promise<AccountLogin | null> {
    const response = await this.request(loginPath(accountId))
    if (response.status === 404) return null
    if (!response.ok) throw await refused('the login backup', response)
    return (await response.json()) as AccountLogin
  }

  /** The workspace's backup key, asked for once. */
  private backupKey() {
    this.key ??= (async () => {
      const response = await this.request('/runner/computer/backup-key')
      if (!response.ok) throw await refused('the backup key', response)
      const { key } = (await response.json()) as { key: string }
      return Buffer.from(key, 'base64')
    })()
    this.key.catch(() => (this.key = undefined))
    return this.key
  }

  /** Seal `file` (removed then), upload it where the API says, then tell the API it is there. */
  private async put(path: string, file: string, done: (size: number) => object) {
    const sealed = await this.temp()
    try {
      const size = await seal(file, sealed, await this.backupKey()).finally(() =>
        rm(file, { force: true }),
      )
      const json = (body: object): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const ticket = await this.request(`${path}/upload`, json({ size }))
      if (!ticket.ok) throw await refused('the backup', ticket)
      const { url, headers } = (await ticket.json()) as {
        url: string
        headers?: Record<string, string>
      }
      // Signed: never with the runner's token.
      const upload = await fetch(new URL(url, this.api.apiUrl), {
        method: 'PUT',
        headers: { ...headers, 'content-length': String(size) },
        body: Readable.toWeb(createReadStream(sealed)) as ReadableStream,
        duplex: 'half',
      } as RequestInit)
      await upload.body?.cancel().catch(() => undefined)
      if (!upload.ok) throw new BackupRefused(`the bucket refused the backup`, upload.status)
      const kept = await this.request(`${path}/done`, json(done(size)))
      if (!kept.ok) throw await refused('the backup', kept)
    } finally {
      await rm(sealed, { force: true })
    }
  }

  /** Download and unseal into `file`; false when there is nothing there. */
  private async get(path: string, file: string) {
    let response = await this.request(path, { redirect: 'manual' })
    const location = response.headers.get('location')
    // The bucket's signed URL, followed without the runner's token.
    if (response.status >= 300 && response.status < 400 && location)
      response = await fetch(location)
    if (response.status === 404 || response.status === 410) return false
    if (!response.ok || !response.body) throw await refused('the backup', response)
    const sealed = await this.temp()
    try {
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream),
        createWriteStream(sealed, { mode: 0o600 }),
      )
      await unseal(sealed, file, await this.backupKey())
      return true
    } catch (error) {
      await rm(file, { force: true })
      throw error
    } finally {
      await rm(sealed, { force: true })
    }
  }

  private request(path: string, init: RequestInit = {}) {
    return fetch(new URL(path, this.api.apiUrl), {
      ...init,
      headers: { authorization: `Bearer ${this.api.token}`, ...init.headers },
    })
  }

  private async temp() {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
    return join(this.tempDir, `${randomUUID()}.sealed`)
  }
}

const folderPath = (name: FolderName, path: string) =>
  `/runner/folders/${encodeURIComponent(name.sessionId)}/${encodeURIComponent(name.teammateId)}${path}`
const teammatePath = (teammateId: string, kind: TeammateBackupKind) =>
  `/runner/computer/teammates/${encodeURIComponent(teammateId)}/${kind}`
const loginPath = (accountId: string) =>
  `/runner/computer/accounts/${encodeURIComponent(accountId)}/login`

async function refused(what: string, response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
  const why = body.error ?? body.message
  return new BackupRefused(
    `the API refused ${what} (${response.status}${why ? `: ${why}` : ''})`,
    response.status,
  )
}
