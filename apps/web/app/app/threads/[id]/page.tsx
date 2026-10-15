import { latestPagePath, sendAhead, threadPath } from '@/lib/page-requests'

// A thread's address: the threads panel shows it expanded, in this page's place
// (components/thread-panel.tsx). The page itself shows nothing; its HTML asks for the
// thread and its latest page as it arrives (lib/page-requests.ts).
export default async function ThreadPage({ params }: PageProps<'/app/threads/[id]'>) {
  const { id } = await params
  sendAhead([threadPath(id), latestPagePath(id)])
  return null
}
