import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type ContainerCreate,
  dechunk,
  DockerProxy,
  publishesAll,
  rewriteCreate,
  THREAD_LABEL,
} from '../src/docker-proxy.js'

test('a container created in a thread publishes on its address, labelled with it', () => {
  const create: ContainerCreate = {
    Image: 'postgres:17',
    Labels: { 'com.docker.compose.project': 'tcmthread1' },
    HostConfig: {
      PortBindings: {
        // -p 5432:5432, then -p 127.0.0.1:6379:6379 -p [::1]:6379:6379, then -p 80
        '5432/tcp': [{ HostIp: '', HostPort: '5432' }],
        '6379/tcp': [
          { HostIp: '127.0.0.1', HostPort: '6379' },
          { HostIp: '::1', HostPort: '6379' },
        ],
        '80/tcp': [{ HostIp: '', HostPort: '' }],
      },
      NetworkMode: 'bridge',
    },
  }
  assert.deepEqual(rewriteCreate(create, 'cmthread1', '127.231.0.7'), {
    Image: 'postgres:17',
    Labels: { 'com.docker.compose.project': 'tcmthread1', [THREAD_LABEL]: 'cmthread1' },
    HostConfig: {
      PortBindings: {
        '5432/tcp': [{ HostIp: '127.231.0.7', HostPort: '5432' }],
        '6379/tcp': [{ HostIp: '127.231.0.7', HostPort: '6379' }],
        '80/tcp': [{ HostIp: '127.231.0.7', HostPort: '' }],
      },
      NetworkMode: 'bridge',
      PublishAllPorts: false,
    },
  })
})

test('-P publishes what the image and the container expose, on the thread address', () => {
  const create: ContainerCreate = {
    Image: 'nginx',
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: { PublishAllPorts: true, PortBindings: { '443/tcp': [{ HostPort: '8443' }] } },
  }
  assert.equal(publishesAll(create), true)
  assert.deepEqual(rewriteCreate(create, 't', '127.231.0.7', ['80/tcp', '443/tcp']).HostConfig, {
    PublishAllPorts: false,
    PortBindings: {
      '443/tcp': [{ HostIp: '127.231.0.7', HostPort: '8443' }],
      '8080/tcp': [{ HostIp: '127.231.0.7', HostPort: '' }],
      '80/tcp': [{ HostIp: '127.231.0.7', HostPort: '' }],
    },
  })
})

test("a container on the host's network or another's publishes nothing, and keeps its settings", () => {
  for (const NetworkMode of ['host', 'container:abc']) {
    const create: ContainerCreate = {
      HostConfig: { NetworkMode, PublishAllPorts: true, PortBindings: null },
    }
    assert.equal(publishesAll(create), false)
    assert.deepEqual(rewriteCreate(create, 't', '127.231.0.7'), {
      ...create,
      Labels: { [THREAD_LABEL]: 't' },
    })
  }
  // No HostConfig at all (an old client): only the label.
  assert.deepEqual(rewriteCreate({ Image: 'busybox' }, 't', '127.231.0.7'), {
    Image: 'busybox',
    Labels: { [THREAD_LABEL]: 't' },
  })
})

test('a chunked body is read whole, or not yet', () => {
  const body = Buffer.from('4\r\n{"a"\r\n3\r\n:1}\r\n0\r\n\r\nGET /next')
  assert.deepEqual(dechunk(body), { body: Buffer.from('{"a":1}'), used: body.length - 9 })
  assert.equal(dechunk(body.subarray(0, 12)), null)
  assert.equal(dechunk(Buffer.from('4\r\n{"a"\r\n0\r\n')), null)
})

type Seen = { creates: ContainerCreate[]; starts: number[]; requests: string[] }

/**
 * A Docker that answers what the CLI asks here: creates (recorded), starts,
 * an image's exposed ports, events (EVENTS, then held open), and an exec it
 * takes over, which echoes what the client sends and, once its client stopped
 * sending, prints "late" and closes; with ?open, it closes at once without
 * waiting for its client.
 */
function fakeDocker(path: string, events: string[] = []) {
  const seen: Seen = { creates: [], starts: [], requests: [] }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.requests.push(`${req.method} ${req.url}`)
      if (req.url?.match(/\/containers\/create(\?|$)/)) {
        seen.creates.push(JSON.parse(body) as ContainerCreate)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end('{"Id":"c1"}')
      }
      if (req.url?.match(/\/containers\/c1\/start$/)) {
        seen.starts.push(Date.now())
        res.writeHead(204)
        return res.end()
      }
      if (req.url === '/images/nginx/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end('{"Config":{"ExposedPorts":{"80/tcp":{}}}}')
      }
      if (req.url?.startsWith('/events')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        for (const event of events) res.write(`${event}\n`)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    })
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    )
    if (req.url?.includes('open')) {
      socket.end('bye')
      return
    }
    socket.on('data', (chunk: Buffer) => socket.write(`got:${chunk.toString()}`))
    socket.on('end', () => setTimeout(() => socket.end('late'), 100))
  })
  return new Promise<{ seen: Seen; server: Server }>((resolve) =>
    server.listen(path, () => resolve({ seen, server })),
  )
}

/**
 * A teammate's threads' folders, as the thread helper makes them: on a tmpfs where there is
 * one, as /run/brigade-docker is. (On a resumed boat computer, /tmp is a FUSE filesystem that
 * refuses a socket made again where one was deleted while it listened.)
 */
function threads(...names: [string, string][]) {
  const base = statSync('/dev/shm', { throwIfNoEntry: false })?.isDirectory()
    ? '/dev/shm'
    : tmpdir()
  const root = mkdtempSync(join(base, 'docker-proxy-'))
  for (const [thread, address] of names) {
    mkdirSync(join(root, thread, 'bt-test'), { recursive: true })
    writeFileSync(join(root, thread, 'bt-test.address'), `${address}\n`)
  }
  return root
}

const socketOf = (root: string, thread: string) => join(root, thread, 'bt-test', 'docker.sock')

function call(
  socketPath: string,
  method: string,
  path: string,
  options: { body?: string; chunked?: boolean; agent?: Agent } = {},
) {
  return new Promise<{ status: number; body: string; at: number }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        agent: options.agent ?? false,
        headers: options.chunked ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, at: Date.now() }))
      },
    )
    req.on('error', reject)
    if (options.body && options.chunked) {
      // Written in parts: sent chunked.
      req.write(options.body.slice(0, 5))
      req.write(options.body.slice(5))
    } else if (options.body) req.setHeader('Content-Length', Buffer.byteLength(options.body))
    req.end(options.chunked ? undefined : options.body)
  })
}

/** Its socket made (bound, so listening): connecting to it would start Docker. */
async function listening(path: string) {
  for (let i = 0; i < 100; i++) {
    if (statSync(path, { throwIfNoEntry: false })?.isSocket()) return
    await sleep(10)
  }
  throw new Error(`nothing listens on ${path}`)
}

test("through a thread's socket, creates are the thread's, the rest passes as is, on one connection", async () => {
  const root = threads(['cmthread1', '127.231.0.7'])
  const upstream = join(root, 'docker.sock')
  const { seen, server } = await fakeDocker(upstream)
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream,
    startDocker: async () => assert.fail('Docker runs already'),
    publish: async () => undefined,
  })
  proxy.scan()
  const socket = socketOf(root, 'cmthread1')
  await listening(socket)
  // One connection, as the docker CLI keeps it.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const create = JSON.stringify({
    Image: 'postgres:17',
    HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '', HostPort: '5432' }] } },
  })
  assert.equal(
    (await call(socket, 'POST', '/v1.47/containers/create', { body: create, agent })).status,
    201,
  )
  assert.equal((await call(socket, 'GET', '/v1.47/containers/json', { agent })).body, 'OK')
  assert.equal(
    (
      await call(socket, 'POST', '/containers/create?name=db', {
        body: create,
        chunked: true,
        agent,
      })
    ).status,
    201,
  )
  // -P: the image's ports, read from Docker.
  const all = JSON.stringify({ Image: 'nginx', HostConfig: { PublishAllPorts: true } })
  assert.equal((await call(socket, 'POST', '/containers/create', { body: all, agent })).status, 201)
  assert.deepEqual(
    seen.creates.map((c) => [c.Labels?.[THREAD_LABEL], c.HostConfig?.PortBindings]),
    [
      ['cmthread1', { '5432/tcp': [{ HostIp: '127.231.0.7', HostPort: '5432' }] }],
      ['cmthread1', { '5432/tcp': [{ HostIp: '127.231.0.7', HostPort: '5432' }] }],
      ['cmthread1', { '80/tcp': [{ HostIp: '127.231.0.7', HostPort: '' }] }],
    ],
  )
  assert.ok(seen.requests.includes('GET /v1.47/containers/json'))
  agent.destroy()
  proxy.close()
  server.closeAllConnections()
  server.close()
})

test("a container's start is answered once its ports are the thread's", async () => {
  const root = threads(['cmthread1', '127.231.0.7'])
  const upstream = join(root, 'docker.sock')
  const { seen, server } = await fakeDocker(upstream)
  const published: [string, number][] = []
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream,
    startDocker: async () => undefined,
    publish: async (thread) => {
      await sleep(150)
      published.push([thread, Date.now()])
    },
  })
  proxy.scan()
  const socket = socketOf(root, 'cmthread1')
  await listening(socket)
  const started = await call(socket, 'POST', '/v1.47/containers/c1/start')
  assert.equal(started.status, 204)
  const ports = published.find(([thread]) => thread === 'cmthread1')
  assert.ok(ports, 'its ports were published')
  assert.ok(seen.starts[0]! <= ports[1] && ports[1] <= started.at)
  proxy.close()
  server.closeAllConnections()
  server.close()
})

/** An exec Docker takes over, through the proxy: what the client receives, and whether it ended. */
function exec(socket: string, path: string, write: (client: Socket) => void) {
  return new Promise<{ received: string; ended: boolean }>((resolve) => {
    const client = connect({ path: socket, allowHalfOpen: true })
    let received = ''
    let ended = false
    client.on('connect', () => {
      client.write(
        `POST ${path} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
      )
      write(client)
    })
    client.on('data', (chunk: Buffer) => (received += chunk.toString()))
    // As the docker CLI does once its output ends.
    client.on('end', () => {
      ended = true
      client.destroy()
    })
    client.on('close', () => resolve({ received, ended }))
    setTimeout(() => client.destroy(), 3000).unref()
  })
}

test('a connection Docker takes over keeps its output after the client stops sending, and ends with it', async () => {
  const root = threads(['cmthread1', '127.231.0.7'])
  const upstream = join(root, 'docker.sock')
  const { server } = await fakeDocker(upstream)
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream,
    startDocker: async () => undefined,
    publish: async () => undefined,
  })
  proxy.scan()
  const socket = socketOf(root, 'cmthread1')
  await listening(socket)
  // docker exec -i with its input closed: what it prints after still arrives.
  const closed = await exec(socket, '/v1.47/exec/e1/start', (client) => {
    setTimeout(() => client.end('hi'), 50)
  })
  assert.match(closed.received, /^HTTP\/1\.1 101 UPGRADED\r\n/)
  assert.match(closed.received, /got:hi/)
  assert.match(closed.received, /late$/)
  assert.equal(closed.ended, true)
  // Its input left open (docker compose exec): it still ends when Docker is done.
  const open = await exec(socket, '/v1.47/exec/e1/start?open', () => undefined)
  assert.match(open.received, /bye$/)
  assert.equal(open.ended, true)
  proxy.close()
  server.closeAllConnections()
  server.close()
})

test("the teammate's Docker starts on its first use, once for clients at the same time", async () => {
  const root = threads(['cmthread1', '127.231.0.7'], ['cmthread2', '127.231.0.8'])
  const upstream = join(root, 'docker.sock')
  let starts = 0
  let docker: Server | undefined
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream,
    startDocker: async () => {
      starts++
      // It answers a moment later.
      setTimeout(() => void fakeDocker(upstream).then(({ server }) => (docker = server)), 200)
    },
    publish: async () => undefined,
  })
  proxy.scan()
  await listening(socketOf(root, 'cmthread1'))
  await listening(socketOf(root, 'cmthread2'))
  const [one, two] = await Promise.all([
    call(socketOf(root, 'cmthread1'), 'GET', '/_ping'),
    call(socketOf(root, 'cmthread2'), 'GET', '/_ping'),
  ])
  assert.deepEqual([one.body, two.body, starts], ['OK', 'OK', 1])
  proxy.close()
  docker?.closeAllConnections()
  docker?.close()
})

test('a Docker that does not start says so to its client', async () => {
  const root = threads(['cmthread1', '127.231.0.7'])
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream: join(root, 'docker.sock'),
    startDocker: async () => {
      throw new Error('no user session')
    },
    publish: async () => undefined,
  })
  proxy.scan()
  await listening(socketOf(root, 'cmthread1'))
  const answer = await call(socketOf(root, 'cmthread1'), 'GET', '/_ping')
  assert.equal(answer.status, 503)
  assert.match(answer.body, /Docker did not start: no user session/)
  proxy.close()
})

test("a thread's container that starts or stops by itself puts its ports right", async () => {
  const root = threads(['cmthread1', '127.231.0.7'])
  const upstream = join(root, 'docker.sock')
  const events = [
    JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: { Attributes: { [THREAD_LABEL]: 'cmthread1' } },
    }),
    // Another teammate's thread, or none: not this proxy's.
    JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { Attributes: { [THREAD_LABEL]: 'cmother' } },
    }),
  ]
  const { server } = await fakeDocker(upstream, events)
  const published: string[] = []
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream,
    startDocker: async () => undefined,
    publish: async (thread) => void published.push(thread),
  })
  proxy.scan()
  await listening(socketOf(root, 'cmthread1'))
  // Watched from its first use on.
  await call(socketOf(root, 'cmthread1'), 'GET', '/_ping')
  await sleep(300)
  assert.ok(published.includes('cmthread1'))
  assert.ok(!published.includes('cmother'))
  // Docker stops: every thread's ports put right (none left).
  published.length = 0
  server.closeAllConnections()
  server.close()
  await sleep(300)
  assert.deepEqual(published, ['cmthread1'])
  proxy.close()
})

test('the proxy follows its threads: a new folder gets a socket, one gone loses it, none left ends it', async (t) => {
  const root = threads(['cmthread1', '127.231.0.7'])
  let empty = 0
  const proxy = new DockerProxy({
    user: 'bt-test',
    root,
    upstream: join(root, 'docker.sock'),
    startDocker: async () => undefined,
    publish: async () => undefined,
    onEmpty: () => empty++,
  })
  t.after(() => proxy.close())
  proxy.scan()
  assert.deepEqual(proxy.threads(), ['cmthread1'])
  mkdirSync(join(root, 'cmthread2', 'bt-test'), { recursive: true })
  writeFileSync(join(root, 'cmthread2', 'bt-test.address'), '127.231.0.8\n')
  // A folder without its address yet, another teammate's, and a name the helper never makes.
  mkdirSync(join(root, 'cmthread3', 'bt-test'), { recursive: true })
  mkdirSync(join(root, 'cmthread4', 'bt-other'), { recursive: true })
  writeFileSync(join(root, 'cmthread4', 'bt-other.address'), '127.231.0.9\n')
  mkdirSync(join(root, '.bt-test.lock'), { recursive: true })
  proxy.scan()
  assert.deepEqual(proxy.threads().sort(), ['cmthread1', 'cmthread2'])
  await listening(socketOf(root, 'cmthread2'))
  // Its folder removed and made again before the proxy looked (docker-stop, then docker):
  // its socket is bound again.
  rmSync(join(root, 'cmthread2', 'bt-test'), { recursive: true })
  mkdirSync(join(root, 'cmthread2', 'bt-test'))
  proxy.scan()
  await listening(socketOf(root, 'cmthread2'))
  proxy.scan()
  await listening(socketOf(root, 'cmthread2'))
  rmSync(join(root, 'cmthread1'), { recursive: true })
  proxy.scan()
  assert.deepEqual(proxy.threads(), ['cmthread2'])
  assert.equal(empty, 0)
  rmSync(join(root, 'cmthread2'), { recursive: true })
  proxy.scan()
  assert.equal(empty, 1)
  proxy.close()
})
