// What Chrome said when it failed, from the log the teammate helper keeps in the
// teammate's home (~/.browser.log). Read by the runner, and by the browser relay
// as the teammate when the browser it waits for does not come up.

/** The log's path in a teammate's home. */
export const chromeLog = (home: string) => `${home}/.browser.log`

/** The last errors in a tail of Chrome's log, joined; empty when none. */
export function chromeLogErrors(text: string) {
  // [pid:tid:time:ERROR:file.cc:123] message
  const errors = text
    .split('\n')
    .filter((line) => /^\[[^\]]*:(ERROR|FATAL):[^\]]*\]/.test(line))
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
  // Chrome often repeats an error inside a later one ("Unable to show message box: …").
  return errors
    .filter((error, i) => !errors.slice(0, i).some((earlier) => error.includes(earlier)))
    .slice(-2)
    .join(' / ')
}
