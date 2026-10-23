// Unsaved edits of files in teammates' working folders, by thread, teammate and path.
// Kept outside the file panel, which unmounts when another file, the preview or a
// document takes its place: the file opens again with them. Leaving or reloading the
// page while any is left asks first.

export type CodeDraft = {
  text: string
  /** The hash of the file the edits started from, which a save expects to find. */
  base?: string
}

const drafts = new Map<string, CodeDraft>()

export const draftKey = (threadId: string, teammateId: string, path: string) =>
  JSON.stringify([threadId, teammateId, path])

export const getDraft = (key: string) => drafts.get(key)

export function setDraft(key: string, draft: CodeDraft | undefined) {
  if (draft) drafts.set(key, draft)
  else drafts.delete(key)
}

if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (drafts.size) e.preventDefault()
  })
