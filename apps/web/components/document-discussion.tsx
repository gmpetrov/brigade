'use client'
// Talking with a teammate about a library file, from the file: in the thread that
// last changed it, which knows why it says what it says, else in a new thread. The
// thread opens as the page, the file stays beside it, and the reply box holds the
// file's mention (and the passage asked about) for the person to finish and send.
import { formatMention } from '@brigade/contracts'
import { useCallback, useMemo } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useThreadPanel } from '@/components/thread-panel'
import { api, useApi, type LibraryVersion, type Thread } from '@/lib/api'
import { addToReply, replyDraft } from '@/lib/reply-drafts'

export type DocumentDiscussion = {
  /** Who answers: the teammate that last changed the file, else the one picked last. */
  teammate: { id: string; name: string } | null
  /** Opens the thread with the file, and `passage` quoted, in its reply box. */
  ask: (passage?: string) => Promise<void>
}

/** A passage as a quote, a line each, blank lines dropped. */
const quote = (passage: string) =>
  passage
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join('\n')

/** Who saved the latest version made in a thread (versions come newest first). */
const lastFromThread = (versions: LibraryVersion[]) =>
  versions.find((v) => v.by.type === 'teammate' && v.by.sessionId)?.by

/** For a library file; null for anything else (memory). */
export function useDocumentDiscussion(
  file: { id: string; path: string } | null,
): DocumentDiscussion | null {
  const { teammates } = useDashboard()
  const panel = useThreadPanel()
  const versions = useApi<LibraryVersion[]>(file ? `/library/${file.id}/versions` : null, [
    'library.updated',
  ])
  const last = versions.data && lastFromThread(versions.data)
  const fallback = teammates.find((t) => t.id === panel.teammateId) ?? teammates[0]
  const teammate = useMemo(
    () =>
      last && teammates.some((t) => t.id === last.id)
        ? { id: last.id, name: last.name }
        : fallback
          ? { id: fallback.id, name: fallback.name }
          : null,
    [last, teammates, fallback],
  )

  const { openThread, draft, chooseTeammate, newThreadPage } = panel
  const ask = useCallback(
    async (passage?: string) => {
      if (!file) return
      const mention = formatMention({ kind: 'document', id: file.id, label: file.path })
      // The file once per message; a passage on its own lines, the cursor on the next.
      const text = (has: string) => {
        const named = has.includes(`(document:${file.id})`)
        if (!passage) return named ? '' : `${mention} `
        return [...(named ? [] : [mention]), quote(passage)].join('\n') + '\n'
      }
      // The thread that last changed it, while this member may still write there.
      const latest =
        versions.data ??
        (await api<LibraryVersion[]>(`/library/${file.id}/versions`).catch(() => []))
      const threadId = lastFromThread(latest)?.sessionId
      const thread = threadId ? await api<Thread>(`/threads/${threadId}`).catch(() => null) : null
      if (thread?.mayPrompt && threadId) {
        const added = text(replyDraft(threadId))
        if (added) addToReply(threadId, added)
        openThread(threadId)
        return
      }
      if (teammate) chooseTeammate(teammate.id)
      const current = draft.text.trimEnd()
      const added = text(current)
      if (added) draft.setText(current ? `${current}\n${added}` : added)
      newThreadPage()
    },
    [file, versions.data, teammate, openThread, draft, chooseTeammate, newThreadPage],
  )
  return useMemo(() => (file ? { teammate, ask } : null), [file, teammate, ask])
}
