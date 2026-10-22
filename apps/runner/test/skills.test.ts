import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ThreadSkill, ThreadSpec } from '@brigade/contracts'
import { writeSkills } from '../src/skills.js'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test('a skill file that starts with #! is written executable, the others are not', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'brigade-skills-'))
  dirs.push(workDir)
  const launcher = Buffer.from('#!/bin/sh\necho ok\n')
  const reference = Buffer.from('# Polish\n')
  const files: Record<string, Buffer> = { a: launcher, b: reference }
  const skill: ThreadSkill = {
    name: 'impeccable',
    description: 'Design checks',
    instructions: 'Run scripts/impeccable.',
    files: [],
    refs: [
      { path: 'scripts/impeccable', sha256: 'a', size: launcher.byteLength },
      { path: 'reference/polish.md', sha256: 'b', size: reference.byteLength },
    ],
  }
  const spec = { teammate: { harness: 'claude' } } as unknown as ThreadSpec
  await writeSkills(workDir, spec, [skill], async (sha256) => files[sha256]!)

  const dir = join(workDir, '.claude', 'skills', 'impeccable')
  assert.equal((await stat(join(dir, 'scripts/impeccable'))).mode & 0o111, 0o111)
  assert.equal((await stat(join(dir, 'reference/polish.md'))).mode & 0o111, 0)
  assert.equal((await stat(join(dir, 'SKILL.md'))).mode & 0o111, 0)
  assert.equal(await readFile(join(dir, 'scripts/impeccable'), 'utf8'), '#!/bin/sh\necho ok\n')
})
