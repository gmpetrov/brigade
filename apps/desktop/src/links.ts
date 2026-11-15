// brigade:// links. brigade://link?code=…&api=…[&dashboard=…][&workspace=…], from "Open in
// Brigade" in the dashboard: connects this computer, after asking. A workspace not linked here
// yet gets a home of its own, beside the others. brigade://sign-in?code=…, from the dashboard's
// page that signs the app's windows in.
import * as capture from './capture.js'
import { ctx } from './context.js'
import { alert, confirm } from './dialogs.js'
import { runnerSupported } from './runner.js'
import * as setup from './setup.js'
import { parseLink } from './link.js'
import { updateSettings } from './settings.js'

export async function openLink(raw: string) {
  const link = parseLink(raw)
  if (!link) return
  if (link.kind === 'signIn') return capture.signedIn(link.code)
  if (!runnerSupported())
    return alert(
      "Teammates can't run on this computer yet",
      'Brigade runs teammates on macOS and Linux. Connect a Mac or a Linux machine, or use Brigade Cloud.',
      'warning',
    )
  const host = new URL(link.api).host
  // A link alone never connects this computer: its teammates would run commands here.
  const confirmed = await confirm({
    title: 'Connect this computer to Brigade?',
    message: `AI teammates of the workspace at ${host} will run on this computer: they read and change files, run commands and can use your apps when you allow it.\n\nOnly connect a workspace you trust.`,
    ok: 'Connect',
    type: 'warning',
  })
  if (!confirmed) return
  const error = await ctx.supervisor.connect(link.api, link.code, link.workspace)
  if (error) return alert('Could not connect', error, 'error')
  if (link.dashboard)
    updateSettings((settings) => {
      settings.dashboardUrl = link.dashboard
    })
  // What's left to set up, the workspace now checked.
  setup.show()
}
