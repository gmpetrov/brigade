// Files a teammate names by path, read as it sees them, and the ones a child's report
// sends its parent. The parent cannot read them where they are: a thread's /tmp is its
// own (thread-net.ts), and its folder is its teammate's. So the harness reads them all,
// sends them to the API, then the report with their ids; the API gives them to the parent.
import { basename } from 'node:path'
import { ATTACHMENT_MAX, ATTACHMENTS_TOTAL_MAX, REPORT_FILES_MAX } from '@brigade/contracts'
import { THREAD_HELPER } from '../thread-net.js'
import type { ScheduleCaller } from './tools.js'

/** What a thread with its own namespaces has of its own (thread-net.ts): seen only inside them. */
const OWN_MOUNTS = /^\/(?:tmp|var\/tmp|dev\/shm)(?:\/|$)/

/**
 * How to read a file's first `max` + 1 bytes as the teammate: as its user, and from its
 * thread's own /tmp, /var/tmp or /dev/shm in its thread's namespaces, when it has them.
 * Without -E: the runner's environment stays out of the teammate's processes.
 */
export function readCommand(
  file: string,
  max: number,
  runAs?: string,
  thread?: string,
): [string, string[]] {
  const head = ['-c', String(max + 1), '--', file]
  if (!runAs) return ['head', head]
  if (thread && OWN_MOUNTS.test(file))
    return ['sudo', ['-n', THREAD_HELPER, 'enter', thread, runAs, 'head', ...head]]
  return ['sudo', ['-n', '-u', runAs, 'head', ...head]]
}

/** A schedule call as the harness makes it: a report's files sent first, by id. */
export async function reportWithFiles(
  call: Parameters<ScheduleCaller>[0],
  io: {
    /** The file as the teammate sees it, up to `max` bytes (else an error). */
    read: (file: string, max: number) => Promise<Buffer>
    /** Sent to the API: its id there. */
    upload: (name: string, bytes: Buffer) => Promise<string>
    send: ScheduleCaller
  },
) {
  const { operation } = call
  if (operation.name !== 'report' || !operation.files?.length) return io.send(call)
  if (operation.files.length > REPORT_FILES_MAX)
    throw new Error(`A report sends at most ${REPORT_FILES_MAX} files`)
  // All read before any is sent: a wrong path sends nothing.
  const files: { name: string; bytes: Buffer }[] = []
  let total = 0
  for (const file of operation.files) {
    const bytes = await io.read(file, ATTACHMENT_MAX)
    total += bytes.byteLength
    if (total > ATTACHMENTS_TOTAL_MAX)
      throw new Error(
        `A report sends up to ${ATTACHMENTS_TOTAL_MAX / (1024 * 1024)} MB of files in all`,
      )
    files.push({ name: basename(file), bytes })
  }
  const ids: string[] = []
  for (const file of files) ids.push(await io.upload(file.name, file.bytes))
  return io.send({ ...call, operation: { ...operation, files: ids } })
}
