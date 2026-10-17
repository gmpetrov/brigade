import assert from 'node:assert/strict'
import { test } from 'node:test'
import { organizationsName, redact } from '../src/connectors/types.js'

test('an account of Neon or Supabase shows as its organization', () => {
  // Neon's list_organizations gives an array, Supabase's an object holding one.
  assert.equal(organizationsName([{ id: 'org-1', name: 'Acme' }]), 'Acme')
  assert.equal(
    organizationsName({ organizations: [{ name: 'Acme' }, { name: 'Beta' }, { name: 'Gamma' }] }),
    'Acme +2',
  )
  assert.equal(organizationsName({ organizations: [] }), null)
  assert.equal(organizationsName('nothing'), null)
})

test('Neon and Supabase keys never leave the API', () => {
  assert.equal(redact('bad key napi_abc123XYZ'), 'bad key [redacted key]')
  assert.equal(redact('token sbp_0123abcd'), 'token [redacted key]')
})
