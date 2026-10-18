// An update restarts the runner without stopping the turns running then: each one's harness
// (its bridge, the CLI it drives, the commands it runs) is left running, and the next runner
// attaches to it where it is (HarnessThread.handOver, then attach). This notes those process
// groups for the next runner, which keeps them instead of stopping them as leftovers
// (process-groups.ts), and stops those no thread took up after a while.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './config.js'
import { stopGroup } from './harness/local-sandbox.js'

/** A harness's process group, left running for the next runner; runAs: whose it is on a cloud computer. */
export type HandedOver = { pgid: number; runAs?: string }

const FILE = join(paths.state, 'hand-over.json')
/** A note older than this is from another restart: what it names is not ours to keep. */
const FRESH_MS = 10 * 60_000
/** A handed-over harness no thread took up by then is stopped. */
const UNCLAIMED_MS = 10 * 60_000

/** Note the groups handed over, just before the runner restarts. */
export function noteHandOver(groups: HandedOver[]) {
  if (groups.length === 0) return
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 })
    writeFileSync(`${FILE}.tmp`, JSON.stringify({ at: Date.now(), groups }), { mode: 0o600 })
    renameSync(`${FILE}.tmp`, FILE)
  } catch (error) {
    console.warn(`could not note the turns handed over: ${String(error)}`)
  }
}

const handed = new Map<number, HandedOver>()

/**
 * On start: the groups the runner before this one handed over, which it keeps. Those no
 * thread claims are stopped after a while: their turn ended meanwhile, or went elsewhere.
 */
export function takeHandOver(): Set<number> {
  const taken = new Set<number>()
  try {
    const note = JSON.parse(readFileSync(FILE, 'utf8')) as { at: number; groups: HandedOver[] }
    rmSync(FILE, { force: true })
    if (Date.now() - note.at < FRESH_MS)
      for (const group of note.groups) {
        handed.set(group.pgid, group)
        taken.add(group.pgid)
      }
  } catch {
    // None.
  }
  if (taken.size > 0)
    setTimeout(() => {
      for (const pgid of taken) {
        const group = handed.get(pgid)
        if (!group) continue
        console.log(`stopping a harness handed over that no thread took up (${pgid})`)
        stopGroup(pgid, group.runAs)
        handed.delete(pgid)
      }
    }, UNCLAIMED_MS).unref()
  return taken
}

/** A thread takes up its harness: it is the thread's to stop from now on. */
export function claimHandOver(pgid: number) {
  return handed.delete(pgid)
}
