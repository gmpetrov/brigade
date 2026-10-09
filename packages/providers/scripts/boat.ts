// Development helper for boat computers. Reads BOAT_API_KEY from apps/api/.env.
//   pnpm --filter @brigade/providers boat <limits|create|info|ssh-key|exec|desktop|stop|resume|delete> [...]
import { readFileSync } from 'node:fs'
import { boatClient, createBoatProvider } from '../src/boat/index.js'

process.loadEnvFile(new URL('../../../apps/api/.env', import.meta.url).pathname)
const apiKey = process.env.BOAT_API_KEY
if (!apiKey) throw new Error('Set BOAT_API_KEY in apps/api/.env')
const boat = boatClient(apiKey)
const provider = createBoatProvider({
  apiKey,
  autoStopSeconds: Number(process.env.BOAT_AUTO_STOP_SECONDS ?? 7200),
})
const [command, id = '', ...rest] = process.argv.slice(2)
const ref = { provider: 'boat', id }

try {
  switch (command) {
    case 'limits': {
      const l = await boat.limits()
      console.log({
        canStart: l.canStart,
        startBlockedReason: l.startBlockedReason,
        activeSandboxes: l.activeSandboxes,
        plan: l.planName,
      })
      break
    }
    case 'create':
      console.log(await provider.create({ workspaceId: id || 'spike', size: '4x8' }))
      break
    case 'info': {
      const { sandbox } = await boat.get({ sandboxId: id })
      console.log({
        id: sandbox.id,
        name: sandbox.name,
        state: sandbox.state,
        type: sandbox.type,
        ip: sandbox.ip,
      })
      break
    }
    case 'ssh-key': {
      const r = await boat.sshKey({ sandboxId: id, key: readFileSync(rest[0]!, 'utf8').trim() })
      console.log({ machineIp: r.machineIp, sshUser: r.sshUser })
      break
    }
    case 'exec': {
      const r = await provider.exec(ref, rest.join(' '))
      process.stdout.write(r.stdout)
      process.stderr.write(r.stderr)
      process.exitCode = r.exitCode
      break
    }
    case 'upload': {
      // upload <id> <local file> <remote path under /home/user or /tmp>
      const r = await boat.writeFile({
        sandboxId: id,
        path: rest[1]!,
        content: readFileSync(rest[0]!).toString('base64'),
        encoding: 'base64',
      })
      console.log({ path: r.path, size: r.size })
      break
    }
    case 'desktop':
      // The URL carries a token: printed only for the person running this locally.
      console.log(await provider.desktopUrl(ref))
      break
    case 'status':
      console.log(await provider.status(ref))
      break
    case 'stop':
      await provider.stop(ref)
      console.log('stopping')
      break
    case 'resume':
      await provider.start(ref)
      console.log('running')
      break
    case 'delete':
      await provider.destroy(ref)
      console.log('deleted')
      break
    default:
      console.error(
        'usage: boat <limits|create|info|ssh-key|exec|desktop|status|stop|resume|delete> [id] [...]',
      )
      process.exitCode = 1
  }
} catch (error) {
  const response = (error as { response?: Response }).response
  console.error(response ? `boat ${response.status}: ${await response.text()}` : error)
  process.exitCode = 1
}
