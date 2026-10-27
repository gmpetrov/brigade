// A cloud computer's disk is a cache: whatever lives only there is backed up to Brigade
// (BACKUP_PROTOCOL), so that losing it (a VM that no longer starts) costs minutes of work, and a
// computer that replaces it (the API's cloud-replace.ts) carries on where it was:
// - thread folders, used since their last backup, every few minutes (folders.ts);
// - each teammate's crontab and user services, and its browser's sign-ins while Chrome is closed
//   (teammate-backups.ts), as often;
// - account logins as they change (account-backups.ts);
// - all of it at once when the API asks (computer.backup), before an idle stop or a replacement,
//   browsers closed first so they are backed up too.
// On the computer that replaces another, the welcome's restore puts the logins and each
// teammate's tasks and browser back before any turn or browser starts there (ready()); thread
// folders come back as each thread arrives (folders.ts arrive). What did not come back is told to
// the API, and to the teammate at its next turn.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ApiToRunner } from '@brigade/contracts'
import { AccountBackups, writeLogin } from './account-backups.js'
import { BackupRefused, type BackupStore } from './backup-store.js'
import { stopBrowser } from './browsers.js'
import { ACCOUNTS_DIR } from './config.js'
import type { Folders } from './folders.js'
import { owners } from './repos.js'
import {
  browserRunning,
  browserStamp,
  noTasks,
  packBrowser,
  readTasks,
  readTasksFile,
  unpackBrowser,
  writeTasks,
  writeTasksFile,
} from './teammate-backups.js'
import { ensureUser, teammateUser } from './teammates.js'

/** How often what changed is backed up while the computer runs. */
const EVERY_MS = 10 * 60_000
/** The first pass, once the runner has settled after a start. */
const FIRST_AFTER_MS = 2 * 60_000

type Restore = NonNullable<Extract<ApiToRunner, { type: 'welcome' }>['restore']>
export type Problem = { teammateId?: string; text: string }

type State = {
  /** Per teammate user: what of its tasks was last backed up (their JSON's hash). */
  tasks: Record<string, string>
  /** Per teammate user: its browser's newest sign-in file when last backed up. */
  browser: Record<string, number>
  /** Per account: the login last sent or put back (its SHA-256). */
  logins: Record<string, string>
  /** Restores done here, by id: each once. */
  restored: string[]
  /** Per teammate: what did not come back, told at its next turn. */
  notes: Record<string, string[]>
}

export class ComputerBackups {
  private state: State = { tasks: {}, browser: {}, logins: {}, restored: [], notes: {} }
  private loaded: Promise<void>
  /** The restore under way: nothing starts until it is done. */
  private restoring: Promise<unknown> = Promise.resolve()
  private pass: Promise<string[]> | undefined
  private readonly logins: AccountBackups

  constructor(
    private readonly options: {
      store: BackupStore
      folders: Pick<Folders, 'backUp' | 'ready'>
      stateFile: string
      tempDir: string
    },
  ) {
    this.loaded = readFile(options.stateFile, 'utf8').then(
      (text) => {
        this.state = { ...this.state, ...(JSON.parse(text) as Partial<State>) }
      },
      () => undefined,
    )
    this.logins = new AccountBackups({
      put: (accountId, login) => options.store.putLogin(accountId, login),
      sent: (accountId) => this.state.logins[accountId],
      noteSent: (accountId, sha256) => {
        this.state.logins[accountId] = sha256
        void this.save().catch(() => undefined)
      },
      ready: () => this.ready(),
    })
  }

  /** Back up now and then; account logins as they change. */
  start() {
    this.logins.start()
    const backUp = () =>
      void this.backUp({ closeBrowsers: false }).catch((error) =>
        console.warn(`backup failed: ${String(error)}`),
      )
    setTimeout(backUp, FIRST_AFTER_MS).unref()
    setInterval(backUp, EVERY_MS).unref()
  }

  /** Once the restore under way, if any, is done: before a turn, before a browser starts. */
  async ready() {
    await this.restoring.catch(() => undefined)
  }

  /**
   * Back up what changed; with closeBrowsers, browsers that run are closed first so theirs is
   * backed up too (the computer is about to stop). A pass asked for while one runs follows it.
   * Resolves to what could not be backed up.
   */
  backUp(options: { closeBrowsers: boolean }): Promise<string[]> {
    const next = (this.pass ?? Promise.resolve([]))
      .catch(() => [])
      .then(() => this.backUpNow(options.closeBrowsers))
    this.pass = next
    void next.finally(() => {
      if (this.pass === next) this.pass = undefined
    })
    return next
  }

  private async backUpNow(closeBrowsers: boolean) {
    await this.ready()
    await this.loaded
    const failed = await this.options.folders.backUp()
    for (const runAs of await owners()) {
      if (!runAs) continue
      const teammateId = runAs.slice('bt-'.length)
      await this.backUpTasks(runAs, teammateId).catch((error: unknown) =>
        refusedOr(error, () => failed.push(`the tasks of ${runAs}: ${String(error)}`)),
      )
      if (closeBrowsers) await stopBrowser(runAs).catch(() => undefined)
      await this.backUpBrowser(runAs, teammateId).catch((error: unknown) =>
        refusedOr(error, () => failed.push(`the browser of ${runAs}: ${String(error)}`)),
      )
    }
    await this.logins.sync().catch((error) => failed.push(`account logins: ${String(error)}`))
    await this.save()
    return failed
  }

  private async backUpTasks(runAs: string, teammateId: string) {
    const tasks = await readTasks(runAs)
    const json = JSON.stringify(tasks)
    const hash = sha256(json)
    // Never had any: nothing to keep. Had some and none now: that is what to keep.
    if (this.state.tasks[runAs] === hash || (!this.state.tasks[runAs] && noTasks(tasks))) return
    const file = await this.temp()
    try {
      await writeTasksFile(file, tasks)
      await this.options.store.putTeammate(teammateId, 'tasks', file)
    } finally {
      await rm(file, { force: true })
    }
    this.state.tasks[runAs] = hash
  }

  private async backUpBrowser(runAs: string, teammateId: string) {
    // Its databases are only whole with Chrome closed.
    if (await browserRunning(runAs)) return
    const stamp = await browserStamp(runAs)
    if (stamp === null || this.state.browser[runAs] === stamp) return
    const file = await this.temp()
    try {
      const size = await packBrowser(runAs, file)
      if (size === null) return
      // Started again while it was packed: what was packed may not be whole.
      if (await browserRunning(runAs)) return
      await this.options.store.putTeammate(teammateId, 'browser', file)
    } finally {
      await rm(file, { force: true })
    }
    this.state.browser[runAs] = stamp
  }

  /**
   * This computer replaces another (the welcome's restore): put back the account logins, then
   * each teammate's tasks and browser, before anything runs. Once per restore. Resolves to what
   * did not come back.
   */
  restore(restore: Restore): Promise<Problem[]> {
    const done = this.restoreNow(restore)
    this.restoring = done
    return done
  }

  private async restoreNow(restore: Restore): Promise<Problem[]> {
    await this.loaded
    if (this.state.restored.includes(restore.id)) return []
    const problems: Problem[] = []
    for (const accountId of restore.accountIds) {
      try {
        const login = await this.options.store.getLogin(accountId)
        if (!login) continue
        await writeLogin(join(ACCOUNTS_DIR, accountId), accountId, login)
        this.state.logins[accountId] = login.sha256
      } catch (error) {
        problems.push({
          text: `The login of account ${accountId} did not come back: ${String(error)}`,
        })
      }
    }
    for (const teammateId of restore.teammateIds) {
      const runAs = teammateUser(teammateId)
      const note = (text: string) => problems.push({ teammateId, text })
      const file = await this.temp()
      try {
        if (await this.options.store.getTeammate(teammateId, 'tasks', file)) {
          const tasks = await readTasksFile(file)
          // Its jobs may run in its thread folders: those come back first, not at their next turn.
          // On a new VM its user is not there yet: made first, as its folders are unpacked as it.
          if (!noTasks(tasks)) await ensureUser(runAs)
          if (!noTasks(tasks))
            for (const folder of restore.folders.filter((f) => f.teammateId === teammateId))
              await this.options.folders
                .ready(folder)
                .catch((error: unknown) =>
                  note(
                    `The folder of thread ${folder.sessionId} did not come back before its crontab ` +
                      `and user services started: ${String(error)}`,
                  ),
                )
          for (const text of await writeTasks(runAs, tasks)) note(text)
          this.state.tasks[runAs] = sha256(JSON.stringify(tasks))
        }
      } catch (error) {
        note(`Its crontab and user services did not come back: ${String(error)}`)
      } finally {
        await rm(file, { force: true })
      }
      try {
        if (await this.options.store.getTeammate(teammateId, 'browser', file)) {
          await unpackBrowser(runAs, file)
          const stamp = await browserStamp(runAs)
          if (stamp !== null) this.state.browser[runAs] = stamp
        }
      } catch (error) {
        note(`Its browser's sign-ins did not come back: ${String(error)}`)
      } finally {
        await rm(file, { force: true })
      }
    }
    for (const problem of problems) {
      console.warn(`restore: ${problem.teammateId ?? 'computer'}: ${problem.text}`)
      if (problem.teammateId) (this.state.notes[problem.teammateId] ??= []).push(problem.text)
    }
    this.state.restored.push(restore.id)
    await this.save()
    return problems
  }

  /** For a teammate's turn: what did not come back from the computer this one replaced, once. */
  async takeNote(teammateId: string) {
    await this.loaded
    const notes = this.state.notes[teammateId]
    if (!notes?.length) return undefined
    delete this.state.notes[teammateId]
    await this.save()
    return (
      'Note from Brigade: the cloud computer was replaced by a new one, and your crontab, ' +
      'user services and browser sign-ins were put back on it, but not all of them:\n' +
      notes.map((text) => `- ${text}`).join('\n') +
      '\nSet up again what you still need.'
    )
  }

  private async temp() {
    await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 })
    return join(this.options.tempDir, randomUUID())
  }

  private async save() {
    await this.loaded
    const temp = `${this.options.stateFile}.${randomUUID()}.tmp`
    await mkdir(dirname(this.options.stateFile), { recursive: true, mode: 0o700 })
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 })
    await rename(temp, this.options.stateFile)
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A refusal while a replacement restores (409) is no failure: it is backed up once it is done. */
function refusedOr(error: unknown, otherwise: () => void) {
  if (error instanceof BackupRefused && error.status === 409) return
  otherwise()
}
