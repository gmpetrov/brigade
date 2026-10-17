// Teammates' containers on a cloud computer, by thread. In a thread with its
// own network (thread-net.ts), each teammate has a rootless Docker of its own
// there: all its containers are the thread's. Otherwise each teammate runs one
// rootless Docker, shared by its threads (and where those containers stay until
// the computer restarts); a container belongs to the thread whose Compose
// project it is in (composeProject), whose folder its Compose file is in, or
// whose folder it mounts. Containers of a thread gone quiet are stopped (its
// own Docker with them); those of a thread whose folder is archived are
// removed, volumes too; when the disk fills up, what no container uses is pruned.
import { run } from './repos.js'
import { composeProject, teammateHome } from './teammates.js'
import {
  dockerSocket,
  freezeThreadDocker,
  runningThreadDockers,
  stopThreadDocker,
  takeDown,
} from './thread-net.js'

/** What pauseFor paused when the thread has a Docker of its own: all of it, frozen. */
const WHOLE_DOCKER = '*'

type Container = {
  id: string
  running: boolean
  paused: boolean
  /** Its thread, if any: the thread's id (its folder's name), or its Compose project. */
  thread?: string
  volumes: string[]
}

export type Inspected = {
  Id: string
  State?: { Running?: boolean; Paused?: boolean }
  Config?: { Labels?: Record<string, string> | null }
  Mounts?: { Type?: string; Source?: string; Name?: string }[] | null
}

/** The teammate's Docker, when it is running: never started just to look. */
async function docker(user: string) {
  const uid = (await run('id', ['-u', user]).catch(() => Buffer.alloc(0))).toString().trim()
  if (!/^\d+$/.test(uid)) return null
  const socket = `/run/user/${uid}/docker.sock`
  const up = await run('test', ['-S', socket], { runAs: user }).then(
    () => true,
    () => false,
  )
  if (!up) return null
  return cli(user, { XDG_RUNTIME_DIR: `/run/user/${uid}`, DOCKER_HOST: `unix://${socket}` })
}

type DockerCli = (...args: string[]) => Promise<string>

/** The teammate's Docker in a thread, when it is running: never started just to look. */
async function threadDocker(user: string, sessionId: string): Promise<DockerCli | null> {
  if (!(await runningThreadDockers(user)).includes(sessionId)) return null
  return cli(user, { DOCKER_HOST: `unix://${dockerSocket(sessionId, user)}` })
}

const cli =
  (user: string, env: Record<string, string>): DockerCli =>
  (...args) =>
    run('docker', args, { runAs: user, env, timeout: 5 * 60_000 }).then((out) =>
      out.toString().trim(),
    )

/** The teammate's containers (running ones only, unless `all`), each with its thread. */
async function containers(
  dockerCli: NonNullable<Awaited<ReturnType<typeof docker>>>,
  user: string,
  all: boolean,
): Promise<Container[]> {
  const ids = (await dockerCli('ps', '-q', '--no-trunc', ...(all ? ['-a'] : [])))
    .split('\n')
    .filter(Boolean)
  if (ids.length === 0) return []
  const inspected = JSON.parse(await dockerCli('inspect', ...ids)) as Inspected[]
  return inspected.map((c) => describe(c, `${teammateHome(user)}/threads/`))
}

/** A container as `docker inspect` gives it, with its thread when it has one under `root`. */
export function describe(c: Inspected, root: string): Container {
  const labels = c.Config?.Labels ?? {}
  const mounts = c.Mounts ?? []
  const inThread = (path: string | undefined) =>
    path?.startsWith(root) ? path.slice(root.length).split('/')[0] : undefined
  const project = labels['com.docker.compose.project']
  // Where its Compose file is, what it mounts, then its project: one named with -p is not the thread's.
  const thread =
    inThread(labels['com.docker.compose.project.working_dir']) ??
    mounts.map((m) => (m.Type === 'bind' ? inThread(m.Source) : undefined)).find(Boolean) ??
    (project && /^t[a-z0-9]+$/.test(project) ? project : undefined)
  return {
    id: c.Id,
    running: Boolean(c.State?.Running),
    paused: Boolean(c.State?.Paused),
    ...(thread ? { thread } : {}),
    volumes: mounts.filter((m) => m.Type === 'volume' && m.Name).map((m) => m.Name!),
  }
}

/** Whether a container's thread is this one: its Compose project, or its folder's name. */
const ofThread = (container: Container, sessionId: string) =>
  container.thread === sessionId || container.thread === composeProject(sessionId)

/**
 * Stop the running containers of the threads `quiet` says may lose them.
 * Resolves to those threads, by the id `quiet` was asked about. A thread's own
 * Docker with no container at all stops as soon as nobody works in the thread
 * (`idle`): each costs some memory, and starts again at the thread's next turn.
 */
export async function stopQuiet(
  user: string,
  sessionIds: string[],
  quiet: (sessionId: string) => boolean,
  idle: (sessionId: string) => boolean = () => false,
): Promise<string[]> {
  const stopped: string[] = []
  // A quiet thread's own Docker stops, its containers with it.
  for (const sessionId of await runningThreadDockers(user)) {
    if (!sessionIds.includes(sessionId)) continue
    if (quiet(sessionId)) {
      await stopThreadDocker(sessionId, user)
      stopped.push(sessionId)
      console.log(`stopped the Docker of quiet thread ${sessionId} for ${user}`)
    } else if (idle(sessionId)) {
      const own = await threadDocker(user, sessionId)
      if (own && !(await own('ps', '-aq'))) await stopThreadDocker(sessionId, user)
    }
  }
  // Its own namespaces too (thread-net.ts), once none of its processes is left.
  for (const sessionId of sessionIds) if (quiet(sessionId)) await takeDown(sessionId)
  const dockerCli = await docker(user)
  if (!dockerCli) return stopped
  const running = await containers(dockerCli, user, false)
  for (const sessionId of sessionIds) {
    if (!quiet(sessionId)) continue
    const ids = running.filter((c) => ofThread(c, sessionId)).map((c) => c.id)
    if (ids.length === 0) continue
    await dockerCli('stop', ...ids)
    if (!stopped.includes(sessionId)) stopped.push(sessionId)
    console.log(`stopped ${ids.length} container(s) of quiet thread ${sessionId} for ${user}`)
  }
  return stopped
}

/**
 * Pause the running containers of a thread whose preview is frozen (its
 * database, say): no CPU, and the kernel can take back their memory. Resolves
 * to their ids, for unpause.
 */
export async function pauseFor(user: string, sessionId: string): Promise<string[]> {
  // The thread's own Docker: frozen whole, the daemon too (docker pause needs cgroups it lacks).
  if (await threadDocker(user, sessionId)) {
    await freezeThreadDocker(sessionId, user, true)
    return [WHOLE_DOCKER]
  }
  const dockerCli = await docker(user)
  if (!dockerCli) return []
  const ids = (await containers(dockerCli, user, false))
    .filter((c) => !c.paused && ofThread(c, sessionId))
    .map((c) => c.id)
  if (ids.length > 0) await dockerCli('pause', ...ids)
  return ids
}

/** Run containers pauseFor paused again; those gone or no longer paused are left as they are. */
export async function unpause(user: string, sessionId: string, ids: string[]) {
  if (ids.includes(WHOLE_DOCKER)) return freezeThreadDocker(sessionId, user, false)
  const dockerCli = await docker(user)
  if (!dockerCli || ids.length === 0) return
  await dockerCli('unpause', ...ids).catch(async () => {
    // One of them is gone or running: the others, one by one.
    for (const id of ids) await dockerCli('unpause', id).catch(() => undefined)
  })
}

/**
 * Remove a thread's containers and their volumes (its databases among them):
 * its folder is archived, and the teammate sets them up again when it is back.
 */
export async function removeFor(user: string, sessionId: string) {
  // Its own Docker: stopped, and all it kept deleted.
  await stopThreadDocker(sessionId, user, true).catch((error: { stderr?: string } & Error) =>
    console.warn(
      `could not delete the Docker of ${sessionId} for ${user}: ${(error.stderr || error.message).trim()}`,
    ),
  )
  // Its namespaces and its /tmp, unless another teammate still works in the thread.
  await takeDown(sessionId, true)
  const dockerCli = await docker(user)
  if (!dockerCli) return
  const mine = (await containers(dockerCli, user, true)).filter((c) => ofThread(c, sessionId))
  if (mine.length > 0) await dockerCli('rm', '--force', '--volumes', ...mine.map((c) => c.id))
  const project = await dockerCli(
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${composeProject(sessionId)}`,
  )
  const volumes = new Set([...mine.flatMap((c) => c.volumes), ...project.split('\n')])
  // A volume another container still uses (one shared before threads had their own projects) stays.
  for (const volume of [...volumes].filter(Boolean))
    await dockerCli('volume', 'rm', volume).catch(() => undefined)
  if (mine.length > 0)
    console.log(`removed ${mine.length} container(s) of archived thread ${sessionId} for ${user}`)
}

/**
 * Free disk in the teammate's Docker: images, networks, volumes and build
 * cache no container uses. Stopped containers keep theirs.
 */
export async function prune(user: string) {
  const dockers: [string, DockerCli | null][] = [
    ...(await Promise.all(
      (await runningThreadDockers(user)).map(
        async (sessionId) =>
          [`${user}'s Docker in ${sessionId}`, await threadDocker(user, sessionId)] as [
            string,
            DockerCli | null,
          ],
      ),
    )),
    [`${user}'s Docker`, await docker(user)],
  ]
  for (const [name, dockerCli] of dockers) {
    if (!dockerCli) continue
    const report = await dockerCli('system', 'prune', '--all', '--force', '--volumes')
    const freed = report.match(/Total reclaimed space: (.+)$/m)?.[1]
    if (freed) console.log(`pruned ${name}: ${freed}`)
  }
}
