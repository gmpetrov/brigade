// Brigade's collab server: one Durable Object per document people edit in the
// dashboard, syncing their editors over Yjs (y-partyserver). It stores the
// live state, and the API stores the Markdown: the room asks the API for the
// stored text (as a Yjs update) and saves what people edited back to it. The
// API owns every conversion and every write; this only syncs and persists.
import { routePartykitRequest, type Connection, type ConnectionContext } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'

/** Who an editor is, from the token the API signed for them. */
type Editor = { member: string; name: string }
type Token = Editor & { room: string; exp: number }

const EDITOR_HEADER = 'x-brigade-editor'
const SHA = 'x-collab-sha'
/** The teammate who wrote what the API sends (URI-encoded JSON), when one did. */
const WRITER = 'x-collab-writer'

const encoder = new TextEncoder()

function fromBase64Url(text: string) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** The editor a token names, if the API signed it and it has not expired. */
async function verify(token: string | null, secret: string): Promise<Token | null> {
  const [payload, signature] = token?.split('.') ?? []
  if (!payload || !signature) return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature),
      encoder.encode(payload),
    )
    if (!valid) return null
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Token
    return data.exp > Date.now() / 1000 ? data : null
  } catch {
    return null
  }
}

/** Whether a request carries the shared secret: the API's calls. */
async function fromApi(request: Request, secret: string) {
  const given = request.headers.get('authorization') ?? ''
  const digest = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  const [a, b] = await Promise.all([digest(given), digest(`Bearer ${secret}`)])
  return a.every((byte, i) => byte === b[i])
}

const buffer = (bytes: Uint8Array) => bytes.slice().buffer

export class DocRoom extends YServer<Env> {
  static options = { hibernate: true }
  static callbackOptions = { debounceWait: 1500, debounceMaxWait: 8000, timeout: 10_000 }

  /** The state when it last matched the stored text, and that text's SHA-256 (from the API). */
  #base: Uint8Array | null = null
  #sha = ''
  /** Members who changed the document since the last save, for the audit log. */
  #editors = new Set<string>()
  #deleted = false
  /** Saves and reconciles, one at a time. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.document.on('update', (_update: Uint8Array, origin: unknown) => {
      const member = (origin as Connection<Editor> | null)?.state?.member
      if (typeof member === 'string') this.#editors.add(member)
    })
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }

  #api(path: string, init: RequestInit & { headers?: Record<string, string> }) {
    return fetch(`${this.env.API_URL}/collab/documents/${encodeURIComponent(this.name)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.env.COLLAB_SECRET}`, ...init.headers },
    })
  }

  #persist(state: Uint8Array) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO doc (id, state, base, sha) VALUES (1, ?, ?, ?)',
      buffer(state),
      this.#base ? buffer(this.#base) : null,
      this.#sha,
    )
  }

  async onLoad() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY, state BLOB NOT NULL, base BLOB, sha TEXT NOT NULL)',
    )
    const row = this.ctx.storage.sql
      .exec<{ state: ArrayBuffer; base: ArrayBuffer | null; sha: string }>(
        'SELECT state, base, sha FROM doc WHERE id = 1',
      )
      .toArray()[0]
    if (!row) return
    Y.applyUpdate(this.document, new Uint8Array(row.state))
    this.#base = row.base ? new Uint8Array(row.base) : null
    this.#sha = row.sha
  }

  /**
   * Merge the stored text into the document when it changed since the room
   * last matched it: on first load, after a teammate wrote to it, or a missed
   * notice. People's edits since then are kept.
   */
  async #reconcile() {
    const response = await this.#api('/reconcile', {
      method: 'POST',
      headers: { [SHA]: this.#sha },
      body: buffer(this.#base ?? Y.encodeStateAsUpdate(new Y.Doc())),
    })
    if (response.status === 204) return
    if (response.status === 404) return this.#forget()
    if (!response.ok) throw new Error(`reconcile returned ${response.status}`)
    const update = new Uint8Array(await response.arrayBuffer())
    // A teammate's edit to a document people have open: say whose it is just
    // before it goes out, so their editors type it in. Not on a first load.
    const writer = response.headers.get(WRITER)
    if (writer && this.#base) {
      try {
        const notice = { type: 'typing', writer: JSON.parse(decodeURIComponent(writer)) }
        this.broadcastCustomMessage(JSON.stringify(notice))
      } catch (error) {
        console.warn(`${this.name}: unreadable writer`, error)
      }
    }
    Y.applyUpdate(this.document, update, 'api')
    const base = new Y.Doc()
    if (this.#base) Y.applyUpdate(base, this.#base)
    Y.applyUpdate(base, update)
    this.#base = Y.encodeStateAsUpdate(base)
    this.#sha = response.headers.get(SHA) ?? ''
    this.#persist(Y.encodeStateAsUpdate(this.document))
  }

  /** Save what people edited (debounced by y-partyserver). */
  async onSave() {
    if (this.#deleted) return
    await this.#serial(async () => {
      const state = Y.encodeStateAsUpdate(this.document)
      // Kept here first, so nothing is lost while the API is unreachable.
      this.#persist(state)
      // Never matched the stored text: nothing to save against yet.
      if (!this.#base) return
      const editors = [...this.#editors]
      const save = (body: Uint8Array) =>
        this.#api('', {
          method: 'PUT',
          headers: { [SHA]: this.#sha, 'x-collab-editors': editors.join(',') },
          body: buffer(body),
        })
      let sent = state
      let response = await save(sent)
      if (response.status === 409) {
        // A teammate wrote to it meanwhile: take that in, then save both.
        await this.#reconcile()
        sent = Y.encodeStateAsUpdate(this.document)
        response = await save(sent)
      }
      if (response.status === 404) return this.#forget()
      if (!response.ok)
        throw new Error(`save returned ${response.status}: ${await response.text()}`)
      const { sha } = (await response.json()) as { sha: string }
      for (const member of editors) this.#editors.delete(member)
      this.#base = sent
      this.#sha = sha
      this.#persist(Y.encodeStateAsUpdate(this.document))
    })
  }

  async onConnect(connection: Connection<Editor>, ctx: ConnectionContext) {
    if (this.#deleted) return connection.close(4404, 'This document was deleted')
    const editor = JSON.parse(ctx.request.headers.get(EDITOR_HEADER) ?? '{}') as Editor
    connection.setState((previous) => ({ ...previous, member: editor.member, name: editor.name }))
    try {
      await this.#serial(() => this.#reconcile())
    } catch (error) {
      console.error(`${this.name}: could not load from the API`, error)
      // Without the stored text to build on, edits here could not be saved safely.
      if (!this.#base) return connection.close(4503, 'Could not load the document')
    }
    if (this.#deleted) return
    return super.onConnect(connection, ctx)
  }

  /** The API's notices: the stored text changed, or the document is gone. */
  async onRequest(request: Request) {
    if (request.method !== 'POST') return new Response('Not found', { status: 404 })
    const { action } = (await request.json()) as { action?: string }
    if (action === 'delete') {
      await this.#forget()
      return new Response(null, { status: 204 })
    }
    if (action !== 'refresh') return new Response('Unknown action', { status: 400 })
    // Never opened, or not since it was last saved: the next open loads the new text.
    const open = [...this.getConnections()].length > 0
    if (!this.#base && !open) return new Response(null, { status: 204 })
    await this.#serial(() => this.#reconcile())
    return new Response(null, { status: 204 })
  }

  async #forget() {
    this.#deleted = true
    for (const connection of this.getConnections())
      connection.close(4404, 'This document was deleted')
    await this.ctx.storage.deleteAll()
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Without the shared secret nothing here can be verified: serve nothing.
    if (!env.COLLAB_SECRET || env.COLLAB_SECRET.length < 32)
      return new Response('COLLAB_SECRET is not set', { status: 503 })
    const response = await routePartykitRequest(request, env, {
      // Editors connect with a token the API signed for this room.
      async onBeforeConnect(request, lobby) {
        const token = await verify(
          new URL(request.url).searchParams.get('token'),
          env.COLLAB_SECRET,
        )
        if (!token || token.room !== lobby.name)
          return new Response('Unauthorized', { status: 401 })
        const headers = new Headers(request.headers)
        headers.set(EDITOR_HEADER, JSON.stringify({ member: token.member, name: token.name }))
        return new Request(request, { headers })
      },
      // Plain requests are the API's notices.
      async onBeforeRequest(request) {
        if (!(await fromApi(request, env.COLLAB_SECRET)))
          return new Response('Unauthorized', { status: 401 })
      },
    })
    return response ?? new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
