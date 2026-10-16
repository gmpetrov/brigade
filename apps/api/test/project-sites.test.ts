import assert from 'node:assert/strict'
import { test } from 'node:test'

// project-sites.ts reads the API's config when imported; nothing here reaches a database or a site.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { imageType, readPage } = await import('../src/project-sites.js')

const HTML = `<!doctype html><html><head>
  <title>Acme | Furniture for offices</title>
  <meta name="description" content="Desks and chairs for small teams.">
  <link rel="icon" href="/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple.png">
  <link rel="manifest" href="/site.webmanifest">
  <script>window.secret = 'not text'</script>
</head><body>
  <nav><a href="/pricing">Pricing</a><a href="https://other.com/about">Elsewhere</a><a href="/about/">About</a></nav>
  <h1>Office furniture,   delivered</h1>
  <p>Order online, get it in a week.</p>
  <style>.x{}</style>
</body></html>`

test('a page gives its name, description, icons, more pages and text', () => {
  const page = readPage(HTML, 'https://acme.com/')
  assert.equal(page.name, 'Acme')
  assert.equal(page.description, 'Desks and chairs for small teams.')
  assert.deepEqual(page.icons, [
    { href: 'https://acme.com/favicon-32.png', size: 32 },
    { href: 'https://acme.com/apple.png', size: 180 },
  ])
  assert.equal(page.manifest, 'https://acme.com/site.webmanifest')
  assert.deepEqual(page.more, ['https://acme.com/pricing', 'https://acme.com/about/'])
  assert.match(page.text, /Office furniture, delivered\nOrder online, get it in a week\./)
  assert.doesNotMatch(page.text, /secret|\.x\{\}/)
})

test('the site name wins over the title', () => {
  const page = readPage(
    '<html><head><title>Home - Welcome</title><meta property="og:site_name" content="Acme Inc"></head></html>',
    'https://acme.com/',
  )
  assert.equal(page.name, 'Acme Inc')
})

test('an image is known by its bytes, not what the server says', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(imageType(png), 'image/png')
  assert.equal(imageType(new Uint8Array([0, 0, 1, 0, 1, 0])), 'image/x-icon')
  const svg = new TextEncoder().encode(
    '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  )
  assert.equal(imageType(svg), 'image/svg+xml')
  assert.equal(imageType(new TextEncoder().encode('<!doctype html><html>')), null)
})
