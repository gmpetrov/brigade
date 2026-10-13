// A person's changes to a design's pages, on their way to the library. The
// canvas shows a change at once; here it waits a moment for the next ones, then
// goes in one request per page, made on the version of the page the boards
// show (its sha256), whose answer is the version the next request is made on.
// Undo sends the change that puts back what was there.
import type { DesignEditOp, DesignEditResult } from '@brigade/contracts'
import { api, ApiError } from '@/lib/api'

/** One change, and the one that undoes it. */
export type DesignChange = {
  folder: string
  file: string
  ops: DesignEditOp[]
  undo: DesignEditOp[]
  /** Changes with the same key in a row are one step of undo (dragging a colour). */
  coalesce?: string
}

const WAIT_MS = 600
const BATCH = 50
const COALESCE_MS = 1200

const fileKey = (folder: string, file: string) => `${folder}\n${file}`

export class DesignEdits {
  private base = new Map<string, string>()
  private queued = new Map<string, DesignEditOp[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private saving = new Map<string, Promise<void>>()
  private done: (DesignChange & { at: number })[] = []
  private undone: DesignChange[] = []
  /** Versions this canvas saved: a view that reports them is not a reason to reload. */
  readonly own = new Set<string>()

  constructor(
    private events: {
      onSaved: (folder: string, file: string, result: DesignEditResult) => void
      /** The page changed under the person, or a change was refused: show it as saved. */
      onLost: (folder: string, file: string, message: string) => void
      onChange: () => void
    },
  ) {}

  /** The version of a page the boards show, when nothing of it is waiting. */
  seen(folder: string, file: string, sha256: string) {
    const key = fileKey(folder, file)
    if (!this.queued.get(key)?.length && !this.saving.has(key)) this.base.set(key, sha256)
  }

  get canUndo() {
    return this.done.length > 0
  }
  get canRedo() {
    return this.undone.length > 0
  }
  get busy() {
    return this.saving.size > 0 || [...this.queued.values()].some((ops) => ops.length > 0)
  }

  /** A person's change: saved shortly, undoable. */
  push(change: DesignChange) {
    const last = this.done.at(-1)
    const now = Date.now()
    if (
      change.coalesce &&
      last?.coalesce === change.coalesce &&
      last.folder === change.folder &&
      last.file === change.file &&
      now - last.at < COALESCE_MS
    ) {
      // One step: the first one's undo, the latest ops.
      this.done[this.done.length - 1] = { ...change, undo: last.undo, at: now }
    } else this.done.push({ ...change, at: now })
    this.undone = []
    this.queue(change.folder, change.file, change.ops)
  }

  /** The change to show and save to undo the last one. */
  undo(): DesignChange | null {
    const last = this.done.pop()
    if (!last) return null
    this.undone.push(last)
    this.queue(last.folder, last.file, last.undo)
    return { ...last, ops: last.undo, undo: last.ops }
  }

  redo(): DesignChange | null {
    const next = this.undone.pop()
    if (!next) return null
    this.done.push({ ...next, at: 0 })
    this.queue(next.folder, next.file, next.ops)
    return next
  }

  private queue(folder: string, file: string, ops: DesignEditOp[]) {
    const key = fileKey(folder, file)
    this.queued.set(key, [...(this.queued.get(key) ?? []), ...ops])
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => void this.flush(folder, file), WAIT_MS),
    )
    this.events.onChange()
  }

  /** Save what waits now (closing the canvas, leaving the page). */
  flushAll() {
    for (const [key, timer] of this.timers) {
      clearTimeout(timer)
      const [folder, file] = key.split('\n') as [string, string]
      void this.flush(folder, file)
    }
  }

  private async flush(folder: string, file: string) {
    const key = fileKey(folder, file)
    this.timers.delete(key)
    // One request at a time per page: each is made on the version the last one made.
    while (this.saving.has(key)) await this.saving.get(key)
    const ops = this.queued.get(key) ?? []
    if (ops.length === 0) return
    this.queued.set(key, [])
    const run = (async () => {
      try {
        for (let i = 0; i < ops.length; i += BATCH) {
          const sha256 = this.base.get(key)
          if (!sha256) throw new ApiError('The page has not loaded yet', 409)
          const result = await api<DesignEditResult>('/designs/edit', {
            method: 'PATCH',
            body: { path: folder, file, sha256, ops: ops.slice(i, i + BATCH) },
          })
          this.base.set(key, result.sha256)
          this.own.add(result.sha256)
          this.events.onSaved(folder, file, result)
        }
      } catch (error) {
        // What waits and the steps of undo were made on a page that is not there any more.
        this.queued.set(key, [])
        this.done = this.done.filter((c) => fileKey(c.folder, c.file) !== key)
        this.undone = this.undone.filter((c) => fileKey(c.folder, c.file) !== key)
        this.base.delete(key)
        this.events.onLost(folder, file, (error as Error).message)
      }
    })()
    this.saving.set(key, run)
    await run
    this.saving.delete(key)
    this.events.onChange()
  }
}
