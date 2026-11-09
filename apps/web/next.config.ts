import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

// The product's version (docs/versions.md): the root package.json's, whose minor goes up with
// each weekly release. Shown with the build at the foot of Preferences, and answered by /version.
const version: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version

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

// Where Mintlify serves the public docs (apps/docs): its project's subdomain.
const MINTLIFY = 'https://brigade.mintlify.site'

/**
 * The dashboard's Content-Security-Policy. Scripts and styles only from here, inline (Next's
 * own inline scripts), Cloudflare Turnstile and PostHog; the three CDNs are for teammates'
 * widgets, whose srcdoc frames inherit this policy (components/widget-frame.tsx). What a page
 * shows of members' content stays open: images and fonts in mail and messages, previews in
 * frames (brigade.surf, a provider's address, or <thread>.localhost on a member's Mac), uploads
 * straight to R2. No upgrade-insecure-requests: it would break those localhost previews.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://eu-assets.i.posthog.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' blob: data: https: http://localhost:* http://*.localhost:*",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const nextConfig = async (phase: string): Promise<NextConfig> => ({
  // No `X-Powered-By: Next.js`: the framework is nobody's business (Google's CASA scan flags it).
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
    NEXT_PUBLIC_VERSION: version,
    // Always set, so the build sees through `process.env.NEXT_PUBLIC_DEMO === '1'` and leaves
    // the demo out of other builds (lib/config.ts).
    NEXT_PUBLIC_DEMO: DEMO ? '1' : '',
    // The site's analytics (components/landing/site-analytics.tsx): never in the demo's build.
    NEXT_PUBLIC_POSTHOG_KEY: DEMO ? '' : (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? ''),
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
            // Not /docs: Mintlify's pages, proxied (rewrites below), send their own policy.
            source: '/((?!docs(?:/|$)).*)',
            headers: [
              { key: 'Content-Security-Policy', value: CSP },
              { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
              // Also checked by Google's CASA scan: no full URLs leaked to other sites, no camera,
              // location or payment for any page. HSTS and nosniff come from Cloudflare's zone
              // settings for brigade.lol, which also cover the static files Next doesn't serve.
              { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
              { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), payment=()' },
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
          source: '/:page(privacy|terms|dpa|subprocessors|legal)',
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
      // /how-it-works was taken down: links shared before open the home page.
      { source: '/how-it-works', destination: '/', permanent: true },
      // Automations became Routines: links saved before still open the page.
      { source: '/app/automations', destination: '/app/routines', permanent: false },
      {
        source: '/app/projects/:id/automations',
        destination: '/app/projects/:id/routines',
        permanent: false,
      },
      // Playbooks left Routines for a page of their own.
      {
        source: '/app/routines/playbooks/:id',
        destination: '/app/playbooks/:id',
        permanent: false,
      },
    ]
  },
  // The public docs (apps/docs), built and hosted by Mintlify, served at www.brigade.lol/docs
  // as in its dashboard's Custom domain setup (Host at www.brigade.lol/docs): the pages load
  // their scripts and styles under /docs too.
  async rewrites() {
    if (DEMO) return []
    return [
      { source: '/docs', destination: `${MINTLIFY}/docs` },
      { source: '/docs/:path*', destination: `${MINTLIFY}/docs/:path*` },
    ]
  },
})

export default nextConfig
