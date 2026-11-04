// Secrets masked in a thread's events before they are stored (src/secrets.ts): each kind the
// list knows, at any depth of an event, the rest of it left as it was; and what only looks like
// one (fixtures, placeholders, signed URLs) left alone. Every secret here is made up, in the
// shape of a real one.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { maskDeltas, maskSecrets, maskSecretsIn, MaskedStream, secretIn } from '../src/secrets.js'

// Built from parts, so this file holds no string a secret scanner takes for a real key.
const r = (n: number, seed = 7) => {
  const chars = 'aB3cD5eF7gH9iJ2kL4mN6pQ8rS1tU0vW'
  let out = ''
  let x = seed
  for (let i = 0; i < n; i++) out += chars[(x = (x * 31 + 17) % 9973) % chars.length]
  return out
}
const NEON = `npg_${r(12)}`
const cases: [string, string, string][] = [
  // [what, text holding it, what it reads once masked]
  [
    'a Postgres URL’s password, user and host kept',
    `DATABASE_URL=postgres://neondb_owner:${NEON}@ep-dry-sky-123.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
    'DATABASE_URL=postgres://neondb_owner:[redacted: a Neon password]@ep-dry-sky-123.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ],
  [
    'a MySQL URL’s password',
    `mysql://admin:${r(16)}@db.internal:3306/app`,
    'mysql://admin:[redacted: a database password]@db.internal:3306/app',
  ],
  ['a Neon password alone', `PGPASSWORD is ${NEON}.`, 'PGPASSWORD is [redacted: a Neon password].'],
  ['a Stripe live secret key', `key: sk_live_${r(24)}`, 'key: [redacted: a Stripe secret key]'],
  ['a Stripe restricted key', `rk_live_${r(24)}`, '[redacted: a Stripe secret key]'],
  [
    'a webhook signing secret',
    `{"secret":"whsec_${r(32)}"}`,
    '{"secret":"[redacted: a webhook signing secret]"}',
  ],
  [
    'a Resend API key',
    `"token": "re_${r(8)}_${r(24, 3)}"`,
    '"token": "[redacted: a Resend API key]"',
  ],
  [
    'an Anthropic key',
    `ANTHROPIC=sk-ant-api03-${r(90)}`,
    'ANTHROPIC=[redacted: an Anthropic API key]',
  ],
  ['an OpenAI key', `sk-${r(48)}`, '[redacted: an OpenAI API key]'],
  ['an OpenAI project key', `sk-proj-${r(100)}`, '[redacted: an OpenAI API key]'],
  ['a GitHub token', `ghp_${r(36)}`, '[redacted: a GitHub token]'],
  ['a GitHub app token', `ghs_${r(36)}`, '[redacted: a GitHub token]'],
  ['a GitHub OAuth token', `gho_${r(36)}`, '[redacted: a GitHub token]'],
  ['a GitHub user token', `ghu_${r(36)}`, '[redacted: a GitHub token]'],
  ['a GitHub fine-grained token', `github_pat_${r(82)}`, '[redacted: a GitHub token]'],
  ['a Slack token', `xoxb-1234567890-${r(24)}`, '[redacted: a Slack token]'],
  [
    'an AWS access key',
    `id=${['AKIA', 'J7Q2L4M6N8P0R2S4'].join('')}`,
    'id=[redacted: an AWS access key]',
  ],
  [
    'a Bearer token in a curl header',
    `curl -H "Authorization: Bearer r8_${r(36)}" https://api.replicate.com/v1/models`,
    'curl -H "Authorization: Bearer [redacted: a token]" https://api.replicate.com/v1/models',
  ],
  [
    'a Bearer token in a JSON header',
    `{"Authorization": "Bearer eyJ${r(40)}.${r(30, 5)}"}`,
    '{"Authorization": "Bearer [redacted: a token]"}',
  ],
  [
    'a secret in an environment variable, as ps lists it',
    `root 812 node server.js BOAT_API_KEY=${r(40)} PORT=3000`,
    'root 812 node server.js BOAT_API_KEY=[redacted: a secret] PORT=3000',
  ],
  [
    'secrets in an env file, whatever their name ends with',
    `TOKEN=${r(20)}\nAWS_SECRET_ACCESS_KEY="${r(40, 9)}"\nDB_PASSWORD=${r(14, 4)}`,
    'TOKEN=[redacted: a secret]\nAWS_SECRET_ACCESS_KEY="[redacted: a secret]"\nDB_PASSWORD=[redacted: a secret]',
  ],
  [
    'a secret passed as a flag',
    `boat deploy --api-key ${r(32)} --yes`,
    'boat deploy --api-key [redacted: a secret] --yes',
  ],
]

describe('secrets masked in events', () => {
  for (const [what, text, masked] of cases)
    test(what, () => {
      assert.equal(maskSecrets(text), masked)
      assert.equal(maskSecrets(masked), masked, 'masking again changes nothing')
    })

  test('a private key block with a body: the body goes, the markers stay', () => {
    const body = Array.from({ length: 6 }, (_, i) => r(64, i + 2)).join('\n')
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    assert.equal(
      maskSecrets(`key:\n${pem}\nend`),
      'key:\n-----BEGIN RSA PRIVATE KEY-----[redacted: a private key]-----END RSA PRIVATE KEY-----\nend',
    )
    // As a JSON text holds it, its line breaks escaped; and cut off before its end.
    const escaped = `"-----BEGIN PRIVATE KEY-----\\n${body.replaceAll('\n', '\\n')}\\n-----END PRIVATE KEY-----"`
    assert.equal(
      maskSecrets(escaped),
      '"-----BEGIN PRIVATE KEY-----[redacted: a private key]-----END PRIVATE KEY-----"',
    )
    assert.equal(
      maskSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`),
      '-----BEGIN OPENSSH PRIVATE KEY-----[redacted: a private key]',
    )
  })

  test('several secrets in one string, each masked', () => {
    const text = `A=${NEON} B=ghp_${r(36)} postgres://u:${r(20)}@h/db`
    assert.equal(
      maskSecrets(text),
      'A=[redacted: a Neon password] B=[redacted: a GitHub token] postgres://u:[redacted: a database password]@h/db',
    )
  })

  test('what only looks like a secret is left alone', () => {
    const left = [
      // A fixture with a key's markers and no key.
      '-----BEGIN RSA PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----',
      'assert(text.includes("-----BEGIN RSA PRIVATE KEY-----"))',
      // Fake keys in tests.
      'ANTHROPIC_API_KEY=sk-ant-fake-key-for-tests',
      'const key = "sk-ant-fake-key-0123456789abcdefghij"',
      'AKIAIOSFODNN7EXAMPLE',
      'sk_live_xxxxxxxxxxxxxxxxxxxx',
      // Signed URLs: their token is short-lived, and the link is the point.
      'https://bucket.r2.dev/file.png?X-Amz-Signature=abc123&token=eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1JJJW8opsbCGfG_HACGpVUMN_a9IV7pAx_Zmeo',
      'https://app.example.com/join?jwt=eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1JJJW8opsbCGfG_HACGpVUMN_a9IV7pAx_Zmeo',
      // HTML anchors, comments and long options.
      '<a href="#section--intro">Intro</a> <!-- note --> npm test -- --watch --token-file=x',
      // Names, not secrets.
      'function re_render_component_tree() {}',
      'class="sk-skeleton-loader-placeholder"',
      'ghp_ is how a GitHub personal token starts',
      // A URL without a password, and one with a variable or stars in its place.
      'postgres://localhost:5432/brigade',
      'postgresql://neondb_owner:${PGPASSWORD}@ep-dry-sky.neon.tech/neondb',
      'postgres://neondb_owner:****@ep-dry-sky.neon.tech/neondb',
      // A header with a variable, and a variable named for a secret set from another.
      'curl -H "Authorization: Bearer $REPLICATE_API_TOKEN" https://api.replicate.com',
      'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}',
      'password: string',
    ]
    for (const text of left) assert.equal(maskSecrets(text), text, text)
  })

  test('at any depth of an event, of any type; the rest of it as it was', () => {
    const token = `ghp_${r(36)}`
    const event = {
      at: '2026-11-04T10:00:00.000Z',
      type: 'raw',
      source: 'claude',
      teammateId: 'tm_1',
      value: {
        message: {
          content: [
            { type: 'text', text: 'Done.' },
            { type: 'tool_result', content: [{ type: 'text', text: `token ${token}` }] },
          ],
        },
        n: 3,
        ok: true,
        none: null,
      },
    }
    const masked = maskSecretsIn(event)
    assert.deepEqual(masked, {
      ...event,
      value: {
        ...event.value,
        message: {
          content: [
            { type: 'text', text: 'Done.' },
            {
              type: 'tool_result',
              content: [{ type: 'text', text: 'token [redacted: a GitHub token]' }],
            },
          ],
        },
      },
    })
    // The event itself is left as it was, and what holds no secret is the same object.
    assert.equal(event.value.message.content[1]!.content![0]!.text, `token ${token}`)
    assert.equal(masked.value.message.content[0], event.value.message.content[0])
  })

  test('a tool’s input and output', () => {
    const started = {
      type: 'tool.started',
      toolCallId: 'c1',
      toolName: 'Bash',
      input: { command: `export STRIPE_KEY=sk_live_${r(24)} && node run.js` },
    }
    assert.equal(
      maskSecretsIn(started).input.command,
      'export STRIPE_KEY=[redacted: a Stripe secret key] && node run.js',
    )
    const finished = {
      type: 'tool.finished',
      toolCallId: 'c2',
      toolName: 'stripe_api_write',
      output: [{ id: 'we_1', secret: `whsec_${r(32)}` }],
      isError: false,
    }
    assert.deepEqual(maskSecretsIn(finished).output, [
      { id: 'we_1', secret: '[redacted: a webhook signing secret]' },
    ])
  })

  test('an event with no secret is returned as it is, not copied', () => {
    const event = {
      type: 'tool.finished',
      output: { stdout: 'https://github.com/a/b -- ok', lines: ['a', 'b'], deep: [{ x: 1 }] },
    }
    assert.equal(maskSecretsIn(event), event)
  })

  test('cheap on text with no candidate: a long tool output', () => {
    const output = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20_000)
    const start = performance.now()
    for (let i = 0; i < 10; i++) assert.equal(maskSecrets(output), output)
    // About 1 MB each: a few milliseconds, far from what storing it costs.
    assert.ok(performance.now() - start < 500, `took ${performance.now() - start} ms`)
  })
})

describe('real secrets that hold a placeholder word inside them', () => {
  test('a word inside random characters is not a placeholder', () => {
    assert.equal(
      maskSecrets('postgres://admin:LatestRelease9@db/app'),
      'postgres://admin:[redacted: a database password]@db/app',
    )
    assert.equal(
      maskSecrets('whsec_Ab3Cd5Ef7testH9iJ2kL4mN6p'),
      '[redacted: a webhook signing secret]',
    )
    assert.equal(maskSecrets(`ghp_${r(10)}example${r(20)}`), '[redacted: a GitHub token]')
    assert.equal(
      maskSecrets(`sk-ant-api03-${r(30)}fake${r(40)}`),
      '[redacted: an Anthropic API key]',
    )
    assert.equal(maskSecrets(`sk_test_${r(24)}`), '[redacted: a Stripe secret key]')
  })
})

describe('headers as a tool’s input holds them', () => {
  test('an Authorization or API key header in an object', () => {
    const token = `r8_${r(32)}`
    const event = {
      type: 'tool.started',
      input: {
        url: 'https://api.replicate.com/v1/predictions',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': r(40, 3),
          api_key: r(32, 5),
          'Content-Type': 'application/json',
        },
      },
    }
    assert.deepEqual(maskSecretsIn(event).input.headers, {
      Authorization: 'Bearer [redacted: a token]',
      'x-api-key': '[redacted: a token]',
      api_key: '[redacted: a token]',
      'Content-Type': 'application/json',
    })
    assert.deepEqual(maskSecretsIn({ headers: { Authorization: 'Bearer $TOKEN' } }), {
      headers: { Authorization: 'Bearer $TOKEN' },
    })
  })

  test('the same in text, whatever its case', () => {
    assert.equal(
      maskSecrets(`authorization: bEaReR r8_${r(32)}`),
      'authorization: bEaReR [redacted: a token]',
    )
    assert.equal(maskSecrets(`-H "X-Api-Key: ${r(40)}"`), '-H "X-Api-Key: [redacted: a token]"')
    assert.equal(maskSecrets(`{"api_key": "${r(40)}"}`), '{"api_key": "[redacted: a token]"}')
  })

  test('mail: case-insensitive patterns are found whatever the case', () => {
    assert.equal(secretIn('pAsSwOrD: Ab3Cd5Ef7Gh9'), 'a password')
    assert.equal(secretIn(`AUTHORIZATION: BEARER ${r(32)}`), 'a token')
  })
})

describe('a reply streamed over several deltas', () => {
  const delta = (seq: number, text: string, id = 'm1') => ({
    seq,
    event: { type: 'message.delta', id, text, at: '2026-11-04T10:00:00.000Z' },
  })
  const texts = (events: { event: { text?: string } }[]) => events.map((e) => e.event.text)
  const token = 'ghp_aB3cD5eF7gH9iJ2kL4mN6pQ8rS1tU0vWxY2z'

  test('a token split in two deltas, in one batch or two: no part of it is stored', () => {
    const one = maskDeltas(new Map(), 's', [
      delta(1, 'Here: ghp_'),
      delta(2, token.slice(4)),
      delta(3, ' done'),
    ])
    assert.equal(texts(one).join(''), 'Here: [redacted: a GitHub token] ')
    const streams = new Map<string, MaskedStream>()
    const first = maskDeltas(streams, 's', [delta(1, 'Here: ghp_')])
    const second = maskDeltas(streams, 's', [delta(2, token.slice(4))])
    const third = maskDeltas(streams, 's', [delta(3, '\nNext')])
    const stored = texts([...first, ...second, ...third]).join('')
    assert.equal(stored, 'Here: [redacted: a GitHub token]\n')
    assert.ok(!stored.includes('aB3c') && !stored.includes('ghp_'))
  })

  test('token by token, as a model streams: each piece of the secret is held, then masked', () => {
    const text = `Use Authorization: Bearer r8_${r(32)} and postgres://u:${r(16)}@h/db then -----BEGIN RSA PRIVATE KEY-----\n${r(64)}\n${r(64, 3)}\n-----END RSA PRIVATE KEY----- ok `
    const pieces = text.match(/[\s\S]{1,3}/g)!
    const out = maskDeltas(
      new Map(),
      's',
      pieces.map((p, i) => delta(i + 1, p)),
    )
    const stored = texts(out).join('')
    assert.match(
      stored,
      /Bearer \[redacted: a token\] and postgres:\/\/u:\[redacted: a database password\]@h\/db/,
    )
    assert.match(
      stored,
      /PRIVATE KEY-----\s*\[redacted: a private key\]-----END RSA PRIVATE KEY----- ok $/,
    )
    for (const piece of [r(32), r(16), r(64), r(64, 3)])
      assert.ok(!stored.includes(piece.slice(0, 8)))
  })

  test('a 4096-bit key’s block, streamed: no line of it is stored', () => {
    const lines = Array.from({ length: 52 }, (_, i) => r(64, i + 11))
    const text = `Key:\n-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----\nDone `
    const pieces = text.match(/[\s\S]{1,5}/g)!
    const stored = texts(
      maskDeltas(
        new Map(),
        's',
        pieces.map((p, i) => delta(i + 1, p)),
      ),
    ).join('')
    for (const line of lines) assert.ok(!stored.includes(line.slice(0, 12)), line)
    assert.match(stored, /\[redacted: a private key\]-----END RSA PRIVATE KEY-----\nDone $/)
  })

  test('cut short before its end: only the held word is missing; plain text goes out as it comes', () => {
    const out = maskDeltas(new Map(), 's', [delta(1, 'Hello the'), delta(2, 're, ghp_aB3c')])
    assert.deepEqual(texts(out), ['Hello ', 'there, '])
  })

  test('a delta sent again is not stored twice; a done ends its stream', () => {
    const streams = new Map<string, MaskedStream>()
    assert.deepEqual(texts(maskDeltas(streams, 's', [delta(1, 'a b ')])), ['a b '])
    assert.deepEqual(texts(maskDeltas(streams, 's', [delta(1, 'a b ')])), [''])
    maskDeltas(streams, 's', [{ seq: 2, event: { type: 'message.done', id: 'm1', text: 'a b' } }])
    assert.equal(streams.size, 0)
  })

  test('replies of two messages stream apart', () => {
    const out = maskDeltas(new Map(), 's', [
      delta(1, 'ghp_', 'a'),
      delta(2, 'x y ', 'b'),
      delta(3, `${token.slice(4)} `, 'a'),
    ])
    assert.deepEqual(texts(out), ['', 'x y ', '[redacted: a GitHub token] '])
  })
})

describe('the same list blocks mail', () => {
  test('a placeholder counts there: mail is not a place for anything like a secret', () => {
    assert.equal(secretIn('Here: sk_live_abcdefghijklmnop'), 'a Stripe secret key')
    assert.equal(secretIn('-----BEGIN RSA PRIVATE KEY-----'), 'a private key')
    assert.equal(secretIn('password: hunter2hunter2'), 'a password')
    assert.equal(
      secretIn(`postgres://neondb_owner:${NEON}@ep-dry-sky.neon.tech/db`),
      'a Neon password',
    )
    assert.equal(secretIn('Your order #4821 ships today.'), null)
  })
})
