// What a teammate is told about answering a mailbox's email, the same whatever its provider
// (Brigade's addresses, Gmail): it replies on its own when the answer is clear, and leaves a
// person what needs their judgment. Whether what it sends waits for approval is its mailbox's
// setting (Connection.sendPolicy), which Brigade applies itself: the teammate need not know it.

/** When to reply and when to leave it to a person; `noReply` is the provider's tool for that. */
export const whenToReply = (noReply: string) =>
  'Reply on your own when the answer is clear and yours to give. When it needs a person’s judgment ' +
  '(money or a refund, a promise or a deadline, a complaint, anything you are not sure of), do not reply: ' +
  `say why with ${noReply}, which puts it in a person’s To do with your line.`
