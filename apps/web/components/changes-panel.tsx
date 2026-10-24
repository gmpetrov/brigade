'use client'
// The code panel on its own beside a thread, without a preview: opened from Outputs,
// on Changes, the files the teammate changed on its branch, committed or not
// (lib/code-changes.ts). With a preview running, the code beside it is the same panel.
import { useEffect } from 'react'
import { CodeWorkspace } from '@/components/code-workspace'
import { PanelExpandButton, SidePanel } from '@/components/side-panel'
import { setCodePanel } from '@/lib/code-tabs'

/** The panel's name among those beside a page. */
export const CHANGES_PANEL = 'changes'

export function ChangesPanel({
  threadId,
  teammateId,
  teammateName,
  mayEdit,
  onClose,
}: {
  threadId: string
  /** Whose working folder: the teammate that checked out the code. */
  teammateId: string
  teammateName: (id: string) => string
  mayEdit: boolean
  onClose: () => void
}) {
  // Opened on Changes, with the list showing: what it is opened for.
  useEffect(() => {
    setCodePanel(threadId, { side: 'changes', tree: true })
  }, [threadId])

  return (
    <SidePanel
      aria-label="Changes"
      name={CHANGES_PANEL}
      onClose={onClose}
      rememberFull={`brigade:changes-full:${threadId}`}
    >
      <CodeWorkspace
        threadId={threadId}
        teammateId={teammateId}
        teammateName={teammateName}
        mayEdit={mayEdit}
        inPreview={false}
        onClose={onClose}
        actions={<PanelExpandButton />}
        className="min-h-0 flex-1"
      />
    </SidePanel>
  )
}
