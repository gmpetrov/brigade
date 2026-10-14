import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Dev tunnels that serve this dashboard (see apps/web/.env.local).
  allowedDevOrigins: (process.env.DEV_ORIGINS ?? '').split(',').filter(Boolean),
  // brigade.lol is www.brigade.lol: the API trusts one dashboard origin.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: '^brigade\\.lol$' }],
        destination: 'https://www.brigade.lol/:path*',
        permanent: true,
      },
    ]
  },
}

export default nextConfig
