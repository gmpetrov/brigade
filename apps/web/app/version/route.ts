// The build this server runs, for open dashboards to tell they are behind
// (components/update-pill.tsx). Never cached: a deploy must show at once.
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
