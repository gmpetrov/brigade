import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

let dir: string
let bin: string
const path = process.env.PATH

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-sandbox-'))
  // As a teammate, file operations go through sudo: here a stand-in that runs them as this user,
  // so the shell commands a cloud computer runs are the ones tested.
  bin = await mkdtemp(join(tmpdir(), 'local-sandbox-bin-'))
  await writeFile(
    join(bin, 'sudo'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --) shift; break;; -u) shift 2;; -*) shift;; *) break;; esac; done\nexec "$@"\n',
  )
  await chmod(join(bin, 'sudo'), 0o755)
  process.env.PATH = `${bin}:${path}`
})

after(async () => {
  process.env.PATH = path
  await rm(dir, { recursive: true, force: true })
  await rm(bin, { recursive: true, force: true })
})

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

for (const runAs of [undefined, 'teammate']) {
  describe(runAs ? 'as a teammate' : 'as the runner', () => {
    const sandbox = () =>
      createLocalSandboxSession({
        id: 'files',
        workingDirectory: dir,
        port: 0,
        env: {},
        ...(runAs ? { runAs } : {}),
      }).restricted()
    const folder = runAs ?? 'runner'

    before(async () => {
      await mkdir(join(dir, folder, 'sub'), { recursive: true })
      await writeFile(join(dir, folder, 'a.txt'), 'hello')
      await writeFile(join(dir, folder, 'empty'), '')
      await symlink('a.txt', join(dir, folder, 'link'))
      await symlink('sub', join(dir, folder, 'dirlink'))
      await symlink('nowhere', join(dir, folder, 'dangling'))
    })

    test('stat says what a path is and its size, following links', async () => {
      const s = sandbox()
      assert.deepEqual(await s.stat({ path: `${folder}/a.txt` }), { type: 'file', size: 5 })
      assert.deepEqual(await s.stat({ path: `${folder}/empty` }), { type: 'file', size: 0 })
      assert.equal((await s.stat({ path: `${folder}/sub` }))?.type, 'directory')
      assert.deepEqual(await s.stat({ path: `${folder}/link` }), { type: 'file', size: 5 })
      assert.equal((await s.stat({ path: `${folder}/dirlink` }))?.type, 'directory')
      // Absolute paths too.
      assert.equal((await s.stat({ path: join(dir, folder, 'a.txt') }))?.size, 5)
    })

    test('stat of a path that is not there is null', async () => {
      const s = sandbox()
      assert.equal(await s.stat({ path: `${folder}/missing` }), null)
      assert.equal(await s.stat({ path: `${folder}/dangling` }), null)
      // A file where a folder of the path should be.
      assert.equal(await s.stat({ path: `${folder}/a.txt/inside` }), null)
    })

    test('a listing names each entry with its type, links not followed', async () => {
      const entries = await sandbox().listDirectory({ path: folder })
      assert.deepEqual(
        entries?.sort((a, b) => a.name.localeCompare(b.name)),
        [
          { name: 'a.txt', type: 'file' },
          { name: 'dangling', type: 'symlink' },
          { name: 'dirlink', type: 'symlink' },
          { name: 'empty', type: 'file' },
          { name: 'link', type: 'symlink' },
          { name: 'sub', type: 'directory' },
        ],
      )
      assert.deepEqual(await sandbox().listDirectory({ path: `${folder}/sub` }), [])
      // A link to a folder lists the folder.
      assert.deepEqual(await sandbox().listDirectory({ path: `${folder}/dirlink` }), [])
    })

    test('a listing of a missing folder is null, and of a file fails', async () => {
      assert.equal(await sandbox().listDirectory({ path: `${folder}/missing` }), null)
      await assert.rejects(() => sandbox().listDirectory({ path: `${folder}/a.txt` }))
    })

    test('deleting a file says whether there was one, and never deletes a folder', async () => {
      const s = sandbox()
      await writeFile(join(dir, folder, 'gone.txt'), 'x')
      assert.equal(await s.deleteFile({ path: `${folder}/gone.txt` }), true)
      await assert.rejects(() => stat(join(dir, folder, 'gone.txt')))
      assert.equal(await s.deleteFile({ path: `${folder}/gone.txt` }), false)
      await assert.rejects(() => s.deleteFile({ path: `${folder}/sub` }))
      assert.equal((await stat(join(dir, folder, 'sub'))).isDirectory(), true)
    })

    test('deleting a link deletes the link, not what it points to', async () => {
      const s = sandbox()
      await writeFile(join(dir, folder, 'target.txt'), 'kept')
      await symlink('target.txt', join(dir, folder, 'to-target'))
      assert.equal(await s.deleteFile({ path: `${folder}/to-target` }), true)
      assert.equal(await readFile(join(dir, folder, 'target.txt'), 'utf8'), 'kept')
      await symlink('nowhere', join(dir, folder, 'dangling-gone'))
      assert.equal(await s.deleteFile({ path: `${folder}/dangling-gone` }), true)
      // A link to a folder is a file to delete.
      await symlink('sub', join(dir, folder, 'dirlink-gone'))
      assert.equal(await s.deleteFile({ path: `${folder}/dirlink-gone` }), true)
      assert.equal((await stat(join(dir, folder, 'sub'))).isDirectory(), true)
    })
  })
}

test('a process spawned with stdin reads what is written to it', async () => {
  const sandbox = createLocalSandboxSession({
    id: 'stdin',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  try {
    const child = await sandbox.spawn({ command: 'tr a-z A-Z', stdin: true })
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode('hello '))
    await writer.write(new TextEncoder().encode('there'))
    await writer.close()
    const [out, { exitCode }] = await Promise.all([text(child.stdout), child.wait()])
    assert.equal(out, 'HELLO THERE')
    assert.equal(exitCode, 0)
  } finally {
    await sandbox.destroy()
  }
})

test('without stdin, a process reads nothing and has no stdin stream', async () => {
  const sandbox = createLocalSandboxSession({
    id: 'no-stdin',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  try {
    const child = await sandbox.spawn({ command: 'cat; echo done' })
    assert.equal('stdin' in child, false)
    const [out, { exitCode }] = await Promise.all([text(child.stdout), child.wait()])
    assert.equal(out, 'done\n')
    assert.equal(exitCode, 0)
    const ran = await sandbox.run({ command: 'cat; echo ran' })
    assert.deepEqual(ran, { exitCode: 0, stdout: 'ran\n', stderr: '' })
  } finally {
    await sandbox.destroy()
  }
})
