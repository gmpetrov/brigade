// What happened in a thread outside a turn, told to the thread (thread.note): a
// line people see, which settles the buttons asked before it, and what each
// teammate is told at the start of its next turn.
import { NOTE_PROTOCOL } from '@brigade/contracts'
import { prisma, type ScopedDb } from './db.js'
import { runnerProtocol, sendToRunner } from './hub.js'

/** Best effort: a computer that is offline, or whose runner is too old, is not told. */
export async function noteInThread(db: ScopedDb, sessionId: string, text: string) {
  const session = await db.session.findFirst({
    where: { id: sessionId },
    select: { computerId: true },
  })
  if (!session) return
  const protocol = runnerProtocol(session.computerId)
  if (protocol === undefined || protocol < NOTE_PROTOCOL) return
  sendToRunner(session.computerId, { type: 'thread.note', sessionId, text })
}

/** "#158 was merged by Ada.": by whom when a member did it in Brigade. */
export async function pullNote(
  pull: { repository: string; number: number },
  state: 'merged' | 'closed',
  memberId?: string,
) {
  const member = memberId
    ? await prisma.member.findFirst({
        where: { id: memberId },
        select: { user: { select: { name: true } } },
      })
    : null
  const what = state === 'merged' ? 'was merged' : 'was closed without merging'
  const by = member?.user.name ? ` by ${member.user.name}` : ''
  return `Pull request #${pull.number} in ${pull.repository} ${what}${by}.`
}
