// For end-to-end checks only (scripts/playbooks-e2e.mjs): answers Google's token endpoint and the
// Gmail API in this process, from a mailbox kept in a JSON file the check writes
// (FAKE_GMAIL=<file>: { "mails": [{ id, threadId, historyId, from, to, subject, body }] }, history
// ids in milliseconds, so they only grow from one check to the next). Every other
// request goes out as usual. Load it with node --import before the API.
import { readFileSync } from 'node:fs'

const file = process.env.FAKE_GMAIL
if (!file) throw new Error('FAKE_GMAIL is not set')
const mails = () => {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')).mails ?? []).filter((m) => m.historyId)
  } catch {
    return []
  }
}
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const message = (m) => ({
  id: m.id,
  threadId: m.threadId,
  labelIds: ['INBOX'],
  internalDate: String(m.at ?? m.historyId),
  snippet: m.body.slice(0, 100),
  historyId: String(m.historyId),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: m.from },
      { name: 'To', value: m.to },
      { name: 'Subject', value: m.subject },
      { name: 'Date', value: new Date().toUTCString() },
      { name: 'Message-ID', value: `<${m.id}@fake.test>` },
    ],
    body: { data: Buffer.from(m.body).toString('base64url'), size: m.body.length },
  },
})

const real = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token')
    return json({ access_token: 'fake', expires_in: 3600 })
  if (url.host !== 'gmail.googleapis.com') return real(input, init)
  const path = url.pathname.replace('/gmail/v1/users/me', '')
  const all = mails()
  if (path === '/profile')
    return json({ emailAddress: 'support@acme.test', historyId: String(Date.now()) })
  if (path === '/history') {
    const start = Number(url.searchParams.get('startHistoryId'))
    const added = all
      .filter((m) => m.historyId > start)
      .map((m) => ({
        id: String(m.historyId),
        messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: ['INBOX'] } }],
      }))
    return json({
      history: added,
      historyId: String(Math.max(start, ...all.map((m) => m.historyId))),
    })
  }
  if (path === '/messages') {
    // A trigger's search: "(to:x) rfc822msgid:<id>" matches that mail when it is to x.
    const q = url.searchParams.get('q') ?? ''
    const to = q.match(/to:([^\s)]+)/)?.[1]
    const rfc = q.match(/rfc822msgid:<?([^@\s>]+)/)?.[1]
    // Newest first, as Gmail lists them, up to maxResults (a dry run's replay).
    const max = Number(url.searchParams.get('maxResults') ?? 100)
    const found = all
      .filter((m) => (!to || m.to.includes(to)) && (!rfc || m.id === rfc))
      .sort((a, b) => b.historyId - a.historyId)
      .slice(0, max)
    return json({ messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) })
  }
  const one = path.match(/^\/messages\/([^/]+)$/)
  if (one) {
    const m = all.find((x) => x.id === decodeURIComponent(one[1]))
    return m ? json(message(m)) : new Response('{}', { status: 404 })
  }
  return new Response(JSON.stringify({ error: `fake gmail: ${path}` }), { status: 501 })
}
