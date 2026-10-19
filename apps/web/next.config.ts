import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

// Which build this is: the commit, else the time it was built. The pages carry it and
// /version answers it, so a dashboard left open learns a new one was deployed.
const buildId =
  process.env.BRIGADE_BUILD_ID ||
  (() => {
    try {
      return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return String(Date.now())
    }
  })()
// Next loads this file again in its build workers: they must agree on the time.
process.env.BRIGADE_BUILD_ID = buildId

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  // Dev tunnels that serve this dashboard (see apps/web/.env.local).
  allowedDevOrigins: (process.env.DEV_ORIGINS ?? '').split(',').filter(Boolean),
  // The VPS image (deploy/vps/Dockerfile) runs Next's own server, with the files it
  // needs traced from the repository root. OpenNext builds its own way.
  ...(process.env.NEXT_STANDALONE && {
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  }),
  // brigade.lol is www.brigade.lol: the API trusts one dashboard origin.
  // The root has its own rule: on OpenNext, a destination whose `:path*` matched
  // nothing keeps the `:path*` as it is.
  async redirects() {
    const apex = [{ type: 'host' as const, value: '^brigade\\.lol$' }]
    return [
      { source: '/', has: apex, destination: 'https://www.brigade.lol/', permanent: true },
      {
        source: '/:path+',
        has: apex,
        destination: 'https://www.brigade.lol/:path+',
        permanent: true,
      },
      // Automations became Routines: links saved before still open the page.
      { source: '/app/automations', destination: '/app/routines', permanent: false },
      {
        source: '/app/projects/:id/automations',
        destination: '/app/projects/:id/routines',
        permanent: false,
      },
    ]
  },
}

export default nextConfig
