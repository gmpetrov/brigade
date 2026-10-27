// The logins of the accounts signed in through Brigade on a cloud computer (a Claude token, a
// Claude or Codex login file), backed up to the API as they change, which seals them with the
// vault's key: a computer that replaces this one is signed in without anyone signing in again.
// Codex rotates its refresh token at each refresh, the previous one dying then: so each change is
// sent, not a copy now and then, and only the computer the API has for the account gets them
// back. The runner owns these folders (ACCOUNTS_DIR); teammates write in them too, so a file is
// read without following a link, and written by renaming a new file over it.
import { createHash, randomUUID } from 'node:crypto'
import { constants, watch } from 'node:fs'
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ACCOUNT_LOGIN_FILES, type AccountLogin } from '@brigade/contracts'
import { ACCOUNTS_DIR, CLOUD } from './config.js'
import { shareAccount } from './teammates.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE_MAX = 64 * 1024
/** Only the runner reads it (accounts.ts): written last, after the folder is shared. */
const TOKEN_FILE = '.oauth-token'

/** An account's login files as they are now, or null without any. */
export async function readLogin(dir: string): Promise<AccountLogin | null> {
  const files: AccountLogin['files'] = []
  for (const name of ACCOUNT_LOGIN_FILES) {
    const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      () => null,
    )
    if (!handle) continue
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > FILE_MAX) continue
      files.push({ name, content: (await handle.readFile()).toString('base64') })
    } finally {
      await handle.close()
    }
  }
  if (files.length === 0) return null
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { files, sha256 }
}

/**
 * Write an account's login files back into its folder, made if needed, as this computer's
 * runner had them. Each file is a new one renamed over whatever is there, so a link a teammate
 * planted is replaced, never followed.
 */
export async function writeLogin(dir: string, accountId: string, login: AccountLogin) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const put = async (name: string, content: string, mode: number) => {
    const temp = join(dir, `.restore-${randomUUID()}`)
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(Buffer.from(content, 'base64'))
    } finally {
      await handle.close()
    }
    await chmod(temp, mode)
    await rename(temp, join(dir, name)).catch(async (error: unknown) => {
      await rm(temp, { force: true })
      throw error
    })
  }
  for (const file of login.files)
    if (file.name !== TOKEN_FILE) await put(file.name, file.content, 0o660)
  // Teammate users reach the login files through the folder's group (link-account).
  if (CLOUD) await shareAccount(accountId)
  const token = login.files.find((file) => file.name === TOKEN_FILE)
  if (token) await put(TOKEN_FILE, token.content, 0o600)
}

/**
 * Keep the API's copy of each account's login as it is here: on any change in the accounts'
 * folders (a debounced watch), and each minute in case a change went unseen.
 */
export class AccountBackups {
  private timer: NodeJS.Timeout | undefined
  private syncing: Promise<void> | undefined
  private again = false

  constructor(
    private readonly options: {
      put: (accountId: string, login: AccountLogin) => Promise<void>
      /** What was last sent (or put back) for an account, kept across restarts. */
      sent: (accountId: string) => string | undefined
      noteSent: (accountId: string, sha256: string) => void
      /** Nothing is sent until this resolves: a computer putting backups back has none yet. */
      ready: () => Promise<void>
    },
  ) {}

  start() {
    setInterval(() => this.soon(0), 60_000).unref()
    try {
      watch(ACCOUNTS_DIR, { recursive: true }, () => this.soon(2_000)).on('error', () => undefined)
    } catch (error) {
      console.warn(`not watching account logins: ${String(error)}`)
    }
    this.soon(5_000)
  }

  /** Each account's login sent, when it changed since. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.syncing = this.syncAll().finally(() => {
      this.syncing = undefined
      if (this.again) {
        this.again = false
        this.soon(0)
      }
    })
    return this.syncing
  }

  private soon(ms: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync().catch(() => undefined), ms)
    this.timer.unref()
  }

  private async syncAll() {
    await this.options.ready()
    const ids = (await readdir(ACCOUNTS_DIR).catch(() => [] as string[])).filter((id) =>
      SAFE_ID.test(id),
    )
    for (const accountId of ids) {
      const login = await readLogin(join(ACCOUNTS_DIR, accountId)).catch(() => null)
      if (!login || this.options.sent(accountId) === login.sha256) continue
      try {
        await this.options.put(accountId, login)
      } catch (error) {
        // Another computer's account, or one removed: not sent again until it changes.
        if ((error as { status?: number }).status !== 404) {
          console.warn(`could not back up the login of ${accountId}: ${String(error)}`)
          continue
        }
      }
      this.options.noteSent(accountId, login.sha256)
    }
  }
}
