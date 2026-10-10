// Git's smart HTTP protocol, proxied to github.com for teammates (see ../git.ts).
// The runner points git here; this adds the installation token on the way out.
//   GET  /git/<owner>/<name>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /git/<owner>/<name>.git/git-upload-pack     (clone, fetch)
//   POST /git/<owner>/<name>.git/git-receive-pack    (push)
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  authorize,
  BACKUP_PREFIX,
  GitRefused,
  pushRefusal,
  readPush,
  recordGit,
  refRefusal,
  refusePush,
  upstreamAuthorization,
  type GitRequest,
} from '../git.js'

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack'])

/** The repository a request names, or null. "acme/web" and "acme/web.git" are the same. */
function repoOf(c: Context) {
  const owner = c.req.param('owner')
  const name = c.req.param('name')?.replace(/\.git$/, '')
  if (!owner || !name || ![owner, name].every((p) => NAME.test(p) && p !== '.' && p !== '..'))
    return null
  return { owner, name }
}

/** Git shows a text/plain error body to the person or agent running it, as "remote: ...". */
const refuse = (message: string, status = 403) =>
  new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain' } })

/** Headers git sends that github.com needs. */
const FORWARD = ['content-type', 'accept', 'git-protocol', 'content-encoding']
/** Response headers passed back; fetch has already undone any compression. */
const RETURN = ['content-type', 'cache-control', 'expires', 'pragma']

async function upstream(
  c: Context,
  request: GitRequest,
  path: string,
  body?: ReadableStream<Uint8Array>,
) {
  const send = async (fresh = false) => {
    const headers: Record<string, string> = { 'user-agent': 'git/brigade-proxy' }
    for (const name of FORWARD) {
      const value = c.req.header(name)
      if (value) headers[name] = value
    }
    const authorization = await upstreamAuthorization(request, fresh)
    if (authorization) headers.authorization = authorization
    const url = new URL(c.req.url)
    return fetch(`https://github.com/${request.fullName}.git/${path}${url.search}`, {
      method: c.req.method,
      headers,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit)
  }
  let response = await send()
  // A token revoked early: one more try with a new one, when the body can be sent again.
  if (response.status === 401 && !body) response = await send(true)
  const headers = new Headers()
  for (const name of RETURN) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers })
}

async function refs(c: Context) {
  const repo = repoOf(c)
  const service = c.req.query('service')
  if (!repo || !service || !SERVICES.has(service))
    return refuse('Brigade: only smart HTTP git is supported', 404)
  const request = await authorize(c.req.header('authorization'), repo.owner, repo.name)
  if (service === 'git-receive-pack') {
    const refused = pushRefusal(request)
    if (refused) {
      // Refused before git names any branch: logged like any refused call.
      await recordGit(request, {
        operation: 'git_push',
        write: true,
        target: request.fullName,
        result: 'denied',
        error: refused.replace(/^Brigade: /, ''),
      })
      return refuse(refused)
    }
  } else {
    // One row per clone or fetch: protocol v2 sends several upload-pack posts after this.
    await recordGit(request, {
      operation: 'git_fetch',
      write: false,
      target: request.fullName,
      result: 'ok',
    })
  }
  return upstream(c, request, 'info/refs')
}

async function uploadPack(c: Context) {
  const repo = repoOf(c)
  if (!repo) return refuse('Brigade: unknown repository', 404)
  const request = await authorize(c.req.header('authorization'), repo.owner, repo.name)
  return upstream(c, request, 'git-upload-pack', c.req.raw.body ?? undefined)
}

async function receivePack(c: Context) {
  const repo = repoOf(c)
  if (!repo || !c.req.raw.body) return refuse('Brigade: unknown repository', 404)
  const request = await authorize(c.req.header('authorization'), repo.owner, repo.name)
  const refused = pushRefusal(request)
  if (refused) return refuse(refused)
  if (c.req.header('content-encoding')) return refuse('Brigade: compressed pushes are not proxied')

  const push = await readPush(c.req.raw.body)
  // Before a large push git sends an empty probe, to check it may: not a push of its own.
  if (push.commands.length === 0) return upstream(c, request, 'git-receive-pack', push.body)
  const backup = push.commands.every((command) => command.ref.startsWith(BACKUP_PREFIX))
  const reasons = new Map<string, string>()
  for (const command of push.commands) {
    const reason = await refRefusal(request, command.ref, backup)
    if (reason) reasons.set(command.ref, reason)
  }
  const target = `${request.fullName}: ${push.commands
    .map((command) => command.ref.replace(/^refs\/heads\//, ''))
    .join(', ')}`
  const operation = backup ? 'git_backup' : 'git_push'

  if (reasons.size > 0) {
    // Read the rest of the push first, so git is not cut off mid-send and sees the answer.
    await push.drain()
    await recordGit(request, {
      operation,
      write: true,
      target,
      result: 'denied',
      error: [...new Set(reasons.values())].join('; '),
    })
    return new Response(refusePush(push.commands, push.capabilities, reasons), {
      headers: {
        'content-type': 'application/x-git-receive-pack-result',
        'cache-control': 'no-cache',
      },
    })
  }

  const response = await upstream(c, request, 'git-receive-pack', push.body)
  await recordGit(request, {
    operation,
    write: true,
    target,
    result: response.ok ? 'ok' : 'error',
    ...(response.ok ? {} : { error: `GitHub answered ${response.status}` }),
  })
  return response
}

export const gitProxy = new Hono()
  .onError((error) => {
    if (error instanceof GitRefused) return refuse(error.message)
    console.error('git proxy:', error)
    return refuse('Brigade: the git proxy failed; try again', 502)
  })
  .get('/:owner/:name/info/refs', refs)
  .post('/:owner/:name/git-upload-pack', uploadPack)
  .post('/:owner/:name/git-receive-pack', receivePack)
