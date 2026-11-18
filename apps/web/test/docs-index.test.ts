import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onSiteDocsLinks } from '../lib/docs-index'
import { SITE_URL } from '../lib/page-metadata'

test('the links of Mintlify’s docs index point to the site', () => {
  const text =
    '- [Email](https://brigade.mintlify.dev/docs/email.md): Addresses.\n' +
    '- [Apps](https://brigade.mintlify.site/docs/apps.md)'
  assert.equal(
    onSiteDocsLinks(text),
    `- [Email](${SITE_URL}/docs/email.md): Addresses.\n- [Apps](${SITE_URL}/docs/apps.md)`,
  )
})

test('other links stay as they are', () => {
  const text = 'Built on [Mintlify](https://mintlify.com), not https://brigade.mintlifyx.dev'
  assert.equal(onSiteDocsLinks(text), text)
})
