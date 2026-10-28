import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants'
import { fetchProofNumbers } from './lib/github-proof'

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

// The landing's GitHub numbers (lib/github-proof.ts), asked once per build (or dev server)
// and inlined into the code, so the page never calls GitHub while serving. Kept in the
// environment so the build workers that load this file again don't ask a second time.
async function landingProof(phase: string) {
  if (process.env.BRIGADE_LANDING_PROOF !== undefined) return process.env.BRIGADE_LANDING_PROOF
  if (phase !== PHASE_PRODUCTION_BUILD && phase !== PHASE_DEVELOPMENT_SERVER) return ''
  const proof = JSON.stringify(await fetchProofNumbers())
  process.env.BRIGADE_LANDING_PROOF = proof
  return proof
}

// The public demo's build (docs/demo.md): the dashboard on recorded data, nothing else.
const DEMO = process.env.NEXT_PUBLIC_DEMO === '1'

const nextConfig = async (phase: string): Promise<NextConfig> => ({
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
    // Always set, so the build sees through `process.env.NEXT_PUBLIC_DEMO === '1'` and leaves
    // the demo out of other builds (lib/config.ts).
    NEXT_PUBLIC_DEMO: DEMO ? '1' : '',
    BRIGADE_LANDING_PROOF: DEMO ? '' : await landingProof(phase),
  },
  // A sample workspace is not something to find in a search engine.
  ...(DEMO && {
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            { key: 'X-Robots-Tag', value: 'noindex' },
            // Shown in a frame on the landing page (components/landing/live-demo.tsx), and
            // nowhere else; localhost for working on the landing.
            {
              key: 'Content-Security-Policy',
              value:
                "frame-ancestors 'self' https://www.brigade.lol https://brigade.lol http://localhost:*",
            },
          ],
        },
      ]
    },
  }),
  // The dashboard, built: no other site may show it in a frame, where a page of theirs could
  // lead a member's clicks on it (an approval, a merge). Not `next dev`: a thread's preview of
  // Brigade shows its dashboard in www.brigade.lol's frame.
  ...(!DEMO &&
    phase !== PHASE_DEVELOPMENT_SERVER && {
      async headers() {
        return [
          {
            source: '/:path*',
            headers: [
              { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
              { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
            ],
          },
        ]
      },
    }),
  // Another build folder, beside a dev server that holds .next (scripts/demo/record.sh).
  ...(process.env.NEXT_DIST_DIR && { distDir: process.env.NEXT_DIST_DIR }),
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
    // The demo (lib/demo/flag.ts) is the dashboard alone: it opens on Home, and the pages
    // to sign up or read about Brigade are www.brigade.lol's.
    if (DEMO)
      return [
        { source: '/', destination: '/app', permanent: false },
        { source: '/:page(sign-in|onboarding)', destination: '/app', permanent: false },
        { source: '/sign-up', destination: 'https://www.brigade.lol/sign-up', permanent: false },
        {
          source: '/:page(how-it-works|privacy|terms|dpa|subprocessors|legal)',
          destination: 'https://www.brigade.lol/:page',
          permanent: false,
        },
      ]
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
})

export default nextConfig
