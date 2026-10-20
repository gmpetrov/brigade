// Zod schemas shared by api, runner and web. The single source of types.
export * from './api.js'
export * from './attachments.js'
export * from './cards.js'
export * from './chief.js'
export * from './children.js'
export * from './commands.js'
export * from './credentials.js'
export * from './design.js'
export * from './events.js'
export * from './library.js'
export * from './memory.js'
export * from './playbooks.js'
export * from './playbook-approvals.js'
export * from './mentions.js'
export * from './models.js'
export * from './notifications.js'
export * from './previews.js'
export * from './projects.js'
export * from './pulls.js'
export * from './repositories.js'
export * from './runner.js'
export * from './schedules.js'
export * from './wakeups.js'
export * from './search.js'
export * from './skills.js'
export * from './tasks.js'
export * from './thread-history.js'
export * from './trigger-events.js'

/**
 * Bump when the runner protocol changes. 2: threads with several teammates.
 * 3: self-update. 4: the library, memory and search. 5: git through the API's proxy.
 * 6: generated images. 7: attachments. 8: welcome lists running threads, to close lost turns.
 * 9: tasks. 10: schedules. 11: queued messages (cancel, edit, steer) and interrupts by turn.
 * 12: teammates save credentials; approvals that may allow a credential for good.
 * 13: a library mirror per teammate, of only the folders it may read.
 * 14: live previews (an app a teammate runs, for people to open).
 * 15: preview checks (addresses with their token) and saved preview recipes.
 * 16: welcome resumes lost turns and queues lost messages again.
 * 17: people start previews without a turn (preview.start); previews report their steps and checks.
 * 18: the chief: its kind and roster in the spec, handoffs to teammates not yet in the thread.
 * 19: heartbeats, so the API can tell a runner that is gone from a quiet one.
 * 20: skills in the spec (written into the harness's skills folder) and skill proposals.
 * 21: a skill's files by reference (`refs`), fetched from /runner/skill-files.
 * 22: wake-ups (set, list, cancel), sent as schedule.call operations.
 * 23: connectors of any kind in the spec (an MCP App's, e.g. cloudflare), not only the first four.
 * 24: a new project's brief from its website (project.describe).
 * 25: threads move between computers (thread.release, the spec's `moved`).
 * 26: unacknowledged events are sent again after a while, and threads whose events wait are reported (events.waiting).
 * 27: notes from outside a turn (thread.note), such as a pull request merged from its card.
 * 28: child threads (start_child, list_children, read_child, cancel_child and report as schedule.call operations;
 *     the spec's `parent`), and message_thread (a task.call comment to a thread).
 * 29: an updating runner hands its running turns over to the next one (runner.restarting).
 * 30: a thread's tab comes to the front of its teammate's browser while people watch its desktop (browser.focus).
 * 31: playbook threads (the spec's `playbook`, and playbook_triage and playbook_report as schedule.call
 *     operations); follow_thread (a schedule.call operation).
 * 32: a deleted thread's folders are removed (thread.deleted).
 * 33: a turn that failed is tried again: on its own after a passing error, or when a person asks (thread.retry).
 * 34: a cloud computer says when its disk is still full after it freed what it could (disk).
 * 35: memory in layers: memory.update edits name topics, replacements, archive reasons and confirmed
 *     lines; tidy runs lay a memory file out again (memory.tidy).
 */
export const PROTOCOL_VERSION = 35
/** Runners from this version on say when their disk is still full (disk). */
export const DISK_PROTOCOL = 34
/** Runners from this version on try a failed turn again when a person asks (thread.retry). */
export const RETRY_PROTOCOL = 33
/** Runners from this version on remove a deleted thread's folders (thread.deleted). */
export const DELETE_PROTOCOL = 32
/** Runners from this version on bring a thread's tab to the front (browser.focus). */
export const FOCUS_PROTOCOL = 30
/** Runners from this version on take thread.note. */
export const NOTE_PROTOCOL = 27
/** Runners from this version on hand a thread's folders over to another computer, and take one in (moved). */
export const MOVE_PROTOCOL = 25
/** Runners from this version on write a project's brief from its website (project.describe). */
export const DESCRIBE_PROTOCOL = 24
/** Runners from this version on accept a connector kind they do not know, such as an MCP App's. */
export const MCP_PROTOCOL = 23
/** Runners from this version on continue turns and messages a restart lost (welcome's resume, requeue). */
export const RESUME_PROTOCOL = 16
/**
 * Runners from this version on say they are still there every 30 s: the API forgets one it has
 * not heard from in 90 s, whose connection died without closing (a cloud computer stopped, a
 * laptop asleep). Older ones stay until their connection closes.
 */
export const HEARTBEAT_PROTOCOL = 19
/** Runners from this version on keep restricted folders from teammates without access. */
export const LIBRARY_VIEWS_PROTOCOL = 13
/** The API rejects runners below this protocol version. */
export const MIN_PROTOCOL_VERSION = 1
