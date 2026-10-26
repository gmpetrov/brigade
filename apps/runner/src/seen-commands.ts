// The commands this runner took, by commandId (OUTBOX_PROTOCOL): the API sends again what it has
// not seen acknowledged (a reconnect, an ack lost with a dying connection), and one taken already
// is acknowledged again and ignored, so a message is never answered twice. Kept on disk, so a
// restart of the runner between taking a command and its ack ignores it too.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The API gives up on a command after a day: ids are kept a little longer. */
const KEEP_MS = 2 * 24 * 60 * 60_000
/** At most this many ids, the newest. */
const KEEP_MAX = 20_000

export class SeenCommands {
  private seen = new Map<string, number>()

  constructor(
    private readonly file: string,
    private readonly now = () => Date.now(),
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
      for (const [id, at] of Object.entries(saved)) this.seen.set(id, at)
    } catch {
      // None yet, or a file cut short: an id seen before may be taken again, as before this file.
    }
  }

  has(id: string) {
    return this.seen.has(id)
  }

  /** Remember an id, on disk before it returns. */
  add(id: string) {
    const now = this.now()
    this.seen.set(id, now)
    for (const [old, at] of this.seen) {
      if (now - at <= KEEP_MS && this.seen.size <= KEEP_MAX) break
      this.seen.delete(old)
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.seen)), { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
