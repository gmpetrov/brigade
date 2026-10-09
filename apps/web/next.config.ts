import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Dev tunnels that serve this dashboard (see apps/web/.env.local).
  allowedDevOrigins: (process.env.DEV_ORIGINS ?? '').split(',').filter(Boolean),
}

export default nextConfig
