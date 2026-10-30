// Handing list lines to a thread that runs already (docs/lists.md): attached quietly, then handed
// over as the person's own message, which starts its teammate on them. When that message can't go
// (a decision or a daily cap pending, its computer off), a note tells its teammate at its next
// turn instead, with the person's note in it.
import { handOffMessage } from '@brigade/contracts'

type Call = (path: string, init: { body: unknown }) => Promise<unknown>

export async function handToThread(
  call: Call,
  file: { id: string; path: string },
  threadId: string,
  items: { id: string; text: string }[],
  note: string,
) {
  await call(`/lists/${file.id}/link`, { body: { sessionId: threadId, items, quiet: true } })
  const text = handOffMessage(
    file,
    items.map((i) => i.text),
    note,
  )
  try {
    await call(`/threads/${threadId}/messages`, { body: { text } })
  } catch (e) {
    await call(`/lists/${file.id}/link`, {
      body: { sessionId: threadId, items, ...(note.trim() ? { note: note.trim() } : {}) },
    }).catch(() => {})
    throw new Error(
      `Added to the thread, but its teammate could not start on them now: ${(e as Error).message}`,
    )
  }
}
