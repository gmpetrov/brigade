import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { challengeOf, desktopSignIn } from '../src/desktop-sign-in.js'

// Brigade.app's sign-in through the browser (src/desktop-sign-in.ts), on better-auth with an
// in-memory database: the browser's session issues a code, the app's window redeems it.
const ORIGIN = 'http://localhost:3000'

function setup() {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  }
  const auth = betterAuth({
    baseURL: 'http://localhost:3001',
    basePath: '/api/auth',
    secret: 'test-secret-test-secret-test-secret',
    trustedOrigins: [ORIGIN],
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    session: {
      additionalFields: {
        // The organization plugin's, in the API.
        activeOrganizationId: { type: 'string', required: false, input: false },
        activeWorkspaceId: { type: 'string', required: false, input: false },
      },
    },
    plugins: [desktopSignIn()],
  })
  const call = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`http://localhost:3001/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          ...(cookie && { cookie }),
        },
        body: JSON.stringify(body),
      }),
    )
  return { db, call }
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

async function signedIn(call: ReturnType<typeof setup>['call']) {
  const response = await call('/sign-up/email', {
    email: 'ada@example.com',
    password: 'correct-horse-battery',
    name: 'Ada',
  })
  assert.equal(response.status, 200)
  return cookieOf(response)
}

const newVerifier = () => randomBytes(32).toString('base64url')

test('a code issued in the browser signs the app in with a session of its own', async () => {
  const { db, call } = setup()
  const browser = await signedIn(call)
  // In a second organization: without it, /me would fall back to the first one.
  db.session[0]!.activeOrganizationId = 'organization-b'
  db.session[0]!.activeWorkspaceId = 'workspace-b'
  const verifier = newVerifier()
  const issued = await call('/desktop/code', { challenge: challengeOf(verifier) }, browser)
  assert.equal(issued.status, 200)
  const { code } = (await issued.json()) as { code: string }

  const redeemed = await call('/desktop/redeem', { code, verifier })
  assert.equal(redeemed.status, 200)
  const app = cookieOf(redeemed)
  assert.match(app, /better-auth\.session_token=/)
  assert.equal(db.session.length, 2)
  assert.notEqual(app, browser)
  // In the browser's organization and workspace.
  assert.equal(db.session[1]!.activeOrganizationId, 'organization-b')
  assert.equal(db.session[1]!.activeWorkspaceId, 'workspace-b')

  // Used once.
  const again = await call('/desktop/redeem', { code, verifier })
  assert.equal(again.status, 400)
})

test('a code needs a signed-in browser', async () => {
  const { call } = setup()
  const issued = await call('/desktop/code', { challenge: challengeOf(newVerifier()) })
  assert.equal(issued.status, 401)
})

test('a wrong verifier gets nothing, and the code is spent', async () => {
  const { db, call } = setup()
  const browser = await signedIn(call)
  const verifier = newVerifier()
  const issued = await call('/desktop/code', { challenge: challengeOf(verifier) }, browser)
  const { code } = (await issued.json()) as { code: string }

  const wrong = await call('/desktop/redeem', { code, verifier: newVerifier() })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.headers.getSetCookie().length, 0)
  const right = await call('/desktop/redeem', { code, verifier })
  assert.equal(right.status, 400)
  assert.equal(db.session.length, 1)
})
