// Types a website login into the teammate's browser, so the password never
// passes through the model. Runs as the teammate's Linux user (the only user
// that can reach its browser), on a tab the thread opened itself, and only on a
// page whose host is the credential's own or one of its subdomains.
//
// Usage: credential-fill <chrome-port> <tabs-file>
// stdin:  { host, check?, username?, password?, submit? }   (one JSON object)
// stdout: { ok, url?, fields?, filled?, submitted?, error? }
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

type Input = {
  /** The credential's host, from its URL in the vault. */
  host: string
  /** Only report whether a tab is ready; nothing is typed. */
  check?: boolean
  username?: string
  password?: string
  submit?: boolean
}
type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string }

const [port, tabsFile] = process.argv.slice(2)

const out = (result: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')
/** The credential's host or a subdomain of it: accounts.google.com for google.com. */
const matches = (pageHost: string, host: string) =>
  bare(pageHost) === bare(host) || bare(pageHost).endsWith(`.${bare(host)}`)
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// Marks the visible sign-in fields with data-brigade-fill and reports which exist.
const FIND = `(() => {
  for (const el of document.querySelectorAll('[data-brigade-fill]')) el.removeAttribute('data-brigade-fill')
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly
  }
  const inputs = [...document.querySelectorAll('input')].filter(visible)
  const password = inputs.find((i) => i.type === 'password' && i.autocomplete !== 'new-password')
    ?? inputs.find((i) => i.type === 'password')
  const texty = (i) => ['text', 'email', 'tel', ''].includes(i.type)
  const named = (i) => /username|email/.test(i.autocomplete) || i.type === 'email' ||
    /user|email|login|account|identifier/i.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label') ?? ''].join(' '))
  let username = inputs.find((i) => texty(i) && named(i))
  if (!username && password) {
    const before = inputs.filter((i) => texty(i) && i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)
    username = before[before.length - 1]
  }
  if (username) username.setAttribute('data-brigade-fill', 'username')
  if (password) password.setAttribute('data-brigade-fill', 'password')
  return { host: location.hostname, url: location.href, username: Boolean(username), password: Boolean(password) }
})()`

const focus = (field: string) => `(() => {
  const el = document.querySelector('[data-brigade-fill="${field}"]')
  if (!el) return false
  el.focus()
  el.select?.()
  return document.activeElement === el
})()`

const UNMARK = `for (const el of document.querySelectorAll('[data-brigade-fill]')) el.removeAttribute('data-brigade-fill')`

async function main() {
  if (!port || !tabsFile)
    return out({ ok: false, error: 'usage: credential-fill <port> <tabs-file>' })
  const input = JSON.parse(readFileSync(0, 'utf8')) as Input
  let owned: string[] = []
  try {
    owned = JSON.parse(readFileSync(tabsFile, 'utf8')) as string[]
  } catch {}
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]
  const mine = targets.filter((t) => t.type === 'page' && owned.includes(t.id))
  const target = mine.find((t) => matches(hostOf(t.url), input.host))
  if (!target?.webSocketDebuggerUrl)
    return out({
      ok: false,
      error: `None of your tabs is on ${input.host}. Open its sign-in page first.${
        mine.length ? ` Your tabs: ${mine.map((t) => t.url).join(', ')}` : ''
      }`,
    })

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
  let nextId = 1
  const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>()
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number; result?: any; error?: { message: string } }
    if (m.id !== undefined) waiting.get(m.id)?.(m)
  })
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression: string) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value

  try {
    const page = (await evaluate(FIND)) as {
      host: string
      url: string
      username: boolean
      password: boolean
    }
    // The page may have moved since the tab was listed: check the host it is on now.
    if (!matches(page.host, input.host))
      return out({ ok: false, error: `The tab is on ${page.host} now, not ${input.host}.` })
    const fields = [...(page.username ? ['username'] : []), ...(page.password ? ['password'] : [])]
    if (input.check) return out({ ok: true, url: page.url, fields })

    const values: Record<string, string | undefined> = {
      username: input.username,
      password: input.password,
    }
    const fill = fields.filter((f) => values[f])
    if (fill.length === 0)
      return out({
        ok: false,
        url: page.url,
        error: `No sign-in field to fill on ${page.url}${
          fields.length
            ? ` (found ${fields.join(' and ')}, but the credential has no value for it)`
            : ''
        }.`,
      })
    await send('Page.bringToFront').catch(() => undefined)
    for (const field of fill) {
      if (!(await evaluate(focus(field))))
        return out({ ok: false, url: page.url, error: `Could not focus the ${field} field.` })
      await send('Input.insertText', { text: values[field] })
    }
    await evaluate(UNMARK)
    if (input.submit) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    return out({ ok: true, url: page.url, filled: fill, submitted: Boolean(input.submit) })
  } finally {
    ws.close()
  }
}

main().catch((error) =>
  out({ ok: false, error: error instanceof Error ? error.message : String(error) }),
)
