import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REPORT_FILES_MAX, ScheduleOperation } from '@brigade/contracts'
import { readCommand, reportWithFiles } from '../src/harness/report-files.js'
import { childTools, type ScheduleCaller } from '../src/harness/tools.js'
import { THREAD_HELPER } from '../src/thread-net.js'

const MB = 1024 * 1024
const options = { toolCallId: 'call-1', messages: [] } as never

/** A report call as the report tool makes it, with the paths the teammate named. */
async function reportCall(input: { status: 'report'; summary: string; files?: string[] }) {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = childTools(
    async (call) => {
      sent.push(call)
      return { ok: true }
    },
    { child: true },
  )
  await tools.report!.execute!(input, options)
  return sent[0]!
}

/** reportWithFiles with files read from `files` (path: size), recording what it did. */
function harness(files: Record<string, number>) {
  const did: string[] = []
  const sent: Parameters<ScheduleCaller>[0][] = []
  let n = 0
  const io = {
    read: async (file: string, max: number) => {
      did.push(`read ${file}`)
      const size = files[file]
      if (size === undefined) throw new Error(`Could not read ${file}: No such file or directory`)
      if (size > max) throw new Error('Files sent with a report can be up to 25 MB')
      return Buffer.alloc(size)
    },
    upload: async (name: string) => {
      did.push(`upload ${name}`)
      return `att${++n}`
    },
    send: async (call: Parameters<ScheduleCaller>[0]) => {
      did.push('send')
      sent.push(call)
      return { ok: true }
    },
  }
  return { io, did, sent }
}

test('a file is read as the teammate sees it: in its thread, where its /tmp is its own', () => {
  assert.deepEqual(readCommand('/w/a.md', 10), ['head', ['-c', '11', '--', '/w/a.md']])
  assert.deepEqual(readCommand('/w/a.md', 10, 'bt-cody'), [
    'sudo',
    ['-n', '-u', 'bt-cody', 'head', '-c', '11', '--', '/w/a.md'],
  ])
  // Without -E: the runner's environment never reaches the teammate's processes.
  assert.deepEqual(readCommand('/tmp/review.md', 10, 'bt-cody', 'thread-1'), [
    'sudo',
    [
      '-n',
      THREAD_HELPER,
      'enter',
      'thread-1',
      'bt-cody',
      'head',
      '-c',
      '11',
      '--',
      '/tmp/review.md',
    ],
  ])
})

test('the report tool hands its files on as paths, and leaves them out when there are none', async () => {
  const withFiles = await reportCall({
    status: 'report',
    summary: 'Found two problems.',
    files: ['/tmp/repro.mjs', 'logs/run.log'],
  })
  assert.deepEqual(withFiles.operation, {
    name: 'report',
    status: 'report',
    summary: 'Found two problems.',
    files: ['/tmp/repro.mjs', 'logs/run.log'],
  })
  const without = await reportCall({ status: 'report', summary: 'Nothing wrong.', files: [] })
  assert.deepEqual(without.operation, {
    name: 'report',
    status: 'report',
    summary: 'Nothing wrong.',
  })
})

test("a report's files are all read, then sent, then the report carries their ids", async () => {
  const { io, did, sent } = harness({ '/tmp/review-278/repro.mjs': 5_573, 'logs/run.log': 2_949 })
  const call = await reportCall({
    status: 'report',
    summary: 'Block the merge on finding 1.',
    files: ['/tmp/review-278/repro.mjs', 'logs/run.log'],
  })
  await reportWithFiles(call, io)
  assert.deepEqual(did, [
    'read /tmp/review-278/repro.mjs',
    'read logs/run.log',
    'upload repro.mjs',
    'upload run.log',
    'send',
  ])
  assert.deepEqual(sent[0]!.operation, {
    name: 'report',
    status: 'report',
    summary: 'Block the merge on finding 1.',
    files: ['att1', 'att2'],
  })
  // What the API takes.
  assert.ok(ScheduleOperation.safeParse(sent[0]!.operation).success)
})

test('a file that cannot be read sends nothing, so the teammate can fix it and report again', async () => {
  const { io, did } = harness({ '/tmp/a.mjs': 10 })
  const call = await reportCall({
    status: 'report',
    summary: 'Done.',
    files: ['/tmp/a.mjs', '/tmp/missing.log'],
  })
  await assert.rejects(reportWithFiles(call, io), /Could not read \/tmp\/missing\.log/)
  assert.deepEqual(did, ['read /tmp/a.mjs', 'read /tmp/missing.log'])
})

test('a report sends at most ten files and 50 MB in all', async () => {
  const many = Array.from({ length: REPORT_FILES_MAX + 1 }, (_, i) => `/tmp/${i}.log`)
  const tooMany = harness(Object.fromEntries(many.map((f) => [f, 1])))
  await assert.rejects(
    reportWithFiles(await reportCall({ status: 'report', summary: 'x', files: many }), tooMany.io),
    /at most 10 files/,
  )
  assert.deepEqual(tooMany.did, [])

  const big = ['/tmp/a.bin', '/tmp/b.bin', '/tmp/c.bin']
  const tooBig = harness(Object.fromEntries(big.map((f) => [f, 20 * MB])))
  await assert.rejects(
    reportWithFiles(await reportCall({ status: 'report', summary: 'x', files: big }), tooBig.io),
    /up to 50 MB of files in all/,
  )
  assert.ok(!tooBig.did.some((d) => d.startsWith('upload') || d === 'send'))
})

test('other calls, and a report without files, go as they are', async () => {
  const { io, did, sent } = harness({})
  const plain = await reportCall({ status: 'report', summary: 'Nothing new.' })
  await reportWithFiles(plain, io)
  const list = {
    operation: { name: 'list_children' as const },
    toolCallId: 'call-2',
    toolName: 'list_children',
    input: {},
  }
  await reportWithFiles(list, io)
  assert.deepEqual(did, ['send', 'send'])
  assert.deepEqual(sent, [plain, list])
})
