// Codex keeps a thread's tools, instructions and skills from its thread/start: thread/resume
// takes none. When they changed since (an App granted from a ticket, a skill approved, the
// teammate's instructions edited), Codex's harness would start a new thread, which has none of
// the conversation: a GPT-6.2 turn answering a ticket that granted Neon came back as a new
// thread told only "they answered your open_ticket call", and redid work long finished instead of
// the investigation it was asked for (Nov 17). Brigade's patch on the harness refuses that
// restart before anything is sent; the runner then starts a new session told the thread so far,
// as when a harness lost its conversation (HarnessThread.startAnew).

/** The harness's refusal to start a Codex thread over (patches/@ai-sdk__harness-codex). */
export const codexRestartRefused = (message: string) => /CODEX_THREAD_RESTART/.test(message)

/** What the new session is told of why it is one. */
export const CODEX_RESTART_WHY =
  'This conversation continues in a new session because your tools, skills or instructions changed (an App was granted or removed, say), and Codex gives a conversation only those it started with.'

/** Why a lost conversation's new session is one, when the harness's error says (else the default). */
export const lostWhy = (message: string) =>
  codexRestartRefused(message) ? CODEX_RESTART_WHY : undefined
