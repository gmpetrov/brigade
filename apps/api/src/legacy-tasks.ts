// The Tasks board is gone (docs/hand-offs.md), but a runner before protocol 52 still offers its
// teammates the task tools until it updates, and sends them as task.call. Each is answered with
// what replaced it: create_task for a teammate starts a thread for it (start_thread), a comment is
// message_thread, complete_task declares the thread done (complete_thread), a playbook's idea goes
// to its ideas list (file_idea). The board's own changes are refused, saying what to do instead.
// Goes once no runner older than protocol 52 connects.
import type { ApiToRunner, RunnerToApi } from '@brigade/contracts'
import { scoped, type Scope } from './db.js'
import { fileIdea } from './playbook-ideas.js'
import { messageThread, startThreadFrom } from './started-threads.js'
import { completeThread } from './thread-done.js'
import { actingTeammate } from './thread-spec.js'

type Runner = { computerId: string; organizationId: string; workspaceId: string }

const GONE =
  'There is no Tasks board any more: work lives in threads. To keep something for later, add a line ' +
  'to a list (add_item).'

/** An older runner's task tool call, from a thread on its computer. */
export async function handleTaskCall(
  runner: Runner,
  call: Extract<RunnerToApi, { type: 'task.call' }>,
  reply: (message: ApiToRunner) => void,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const done = (output: unknown) =>
    reply({ type: 'connector.result', callId: call.callId, ok: true, output })
  const fail = (error: string) =>
    reply({ type: 'connector.result', callId: call.callId, ok: false, error })
  const answer = (output: object | { error: string }) =>
    'error' in output ? fail(output.error) : done(output)

  const session = await db.session.findFirst({
    where: { id: call.sessionId, computerId: runner.computerId },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')
  const op = call.operation

  switch (op.name) {
    case 'list': {
      const teammates = await db.teammate.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
      return done({
        tasks: [],
        teammates: teammates.map((t) => ({ ...t, you: t.id === teammate.id })),
        note: GONE,
      })
    }

    case 'create': {
      // A playbook's run kept a customer's idea in the Backlog: it goes to its ideas list now.
      if (session.playbookRunId) {
        if (op.assignee !== 'none')
          return fail(
            'A playbook\'s run hands no work to a teammate: create the task with assignee "none", or start a child thread.',
          )
        const text = [op.title, op.description].filter(Boolean).join(': ').replace(/\s+/g, ' ')
        return answer(await fileIdea(db, scope, session, teammate, { text: text.slice(0, 1_000) }))
      }
      if (op.assignee === 'none') return fail(GONE)
      if (op.assignee === 'self')
        return done({
          note:
            'There is no Tasks board any more: do the work here, and end the reply that delivers it ' +
            'with its done block.',
        })
      return answer(
        await startThreadFrom(db, scope, session, teammate, {
          name: 'start_thread',
          title: op.title.slice(0, 120),
          brief: op.description || op.title,
          teammate: op.assignee,
          ...(op.project !== undefined ? { project: op.project } : {}),
        }),
      )
    }

    case 'comment': {
      if (op.threadId)
        return answer(
          await messageThread(db, scope, session, teammate, {
            threadId: op.threadId,
            text: op.text,
          }),
        )
      // A task's thread, by its task: under message_thread's rules, as any other thread.
      const thread = await db.session.findFirst({
        where: { taskId: op.taskId! },
        select: { id: true },
      })
      if (!thread) return fail(GONE)
      return answer(
        await messageThread(db, scope, session, teammate, { threadId: thread.id, text: op.text }),
      )
    }

    case 'complete':
      if (op.taskId) return fail(GONE)
      return answer(
        await completeThread(db, scope, session, teammate, {
          name: 'complete_thread',
          summary: op.summary.replace(/\s+/g, ' ').slice(0, 300),
        }),
      )

    default:
      return fail(GONE)
  }
}
