import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'
import { importSkill } from '../src/skill-import.js'

const SKILL =
  '---\nname: Release Notes\ndescription: Write release notes from merged PRs\n---\n\nSteps.\n'

test('imports a SKILL.md', () => {
  assert.deepEqual(importSkill('SKILL.md', strToU8(SKILL)), {
    name: 'release-notes',
    description: 'Write release notes from merged PRs',
    instructions: 'Steps.',
    files: [],
    skipped: [],
  })
})

test('imports a zipped folder: its files beside SKILL.md, text only', () => {
  const zip = zipSync({
    'release-notes/SKILL.md': strToU8(SKILL),
    'release-notes/template.md': strToU8('# {version}'),
    'release-notes/scripts/prs.sh': strToU8('gh pr list'),
    'release-notes/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    'release-notes/.DS_Store': strToU8('x'),
    '__MACOSX/release-notes/._SKILL.md': strToU8('x'),
  })
  const skill = importSkill('release-notes.skill', zip)
  assert.equal(skill.name, 'release-notes')
  assert.deepEqual(skill.files.map((f) => f.path).sort(), ['scripts/prs.sh', 'template.md'])
  assert.deepEqual(skill.skipped, ['logo.png'])
})

test('names a skill without one after its folder', () => {
  const zip = zipSync({ 'triage/SKILL.md': strToU8('---\ndescription: Sort issues\n---\nDo it.') })
  assert.equal(importSkill('upload.zip', zip).name, 'triage')
})

test('refuses a zip without SKILL.md', () => {
  const zip = zipSync({ 'notes.md': strToU8('hi') })
  assert.throws(() => importSkill('x.zip', zip), HTTPException)
})
