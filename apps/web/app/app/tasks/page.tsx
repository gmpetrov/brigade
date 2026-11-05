import { redirect } from 'next/navigation'

// The Tasks board is gone (docs/hand-offs.md): its links (old notifications, bookmarks) open the
// Board, in the workspace they name.
export default async function Tasks({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await searchParams
  redirect(typeof workspace === 'string' ? `/app/board?workspace=${encodeURIComponent(workspace)}` : '/app/board')
}
