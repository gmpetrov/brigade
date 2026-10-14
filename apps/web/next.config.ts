import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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
    ]
  },
}

export default nextConfig
