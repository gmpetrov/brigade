# Releasing Brigade.app

`.github/workflows/desktop-release.yml` builds Brigade.app for macOS (universal, signed with the
Developer ID and notarized), Windows and Linux from a `desktop-v*` tag, and publishes one GitHub
Release with all of them. It needs the repository secrets listed at the top of the workflow.

```bash
git tag desktop-v0.4.0 && git push origin desktop-v0.4.0
```

Push a tag only when a person asks for a release: each one updates every installed Brigade.app.
Release the app only when its own code changed. A GitHub Release that isn't the app's stops every
installed app from updating: they all read the latest release.

What a release holds:

| File                                                                         | For                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Brigade.dmg`                                                                | Installing on macOS: the dashboard links to it (`apps/web/lib/mac-app.ts`). |
| `Brigade-<version>-universal-mac.zip`, `latest-mac.yml`                      | Updates on macOS.                                                           |
| `Brigade-Setup.exe`, `latest.yml`                                            | Installing and updating on Windows (not code-signed yet).                   |
| `Brigade-x86_64.AppImage`, `brigade_<version>_amd64.deb`, `latest-linux.yml` | Installing and updating on Linux.                                           |
| `Brigade.app.tar.gz`, `latest.json`                                          | The Tauri Brigade.app (0.3.x) updating to this one.                         |

Installed apps check the latest release at launch and every six hours, download a newer version
and offer "Restart to update" (`src/updates.ts`).

## From the Tauri app

Brigade.app was a Tauri app up to 0.3.11. Those apps check `latest.json`, which points them at
`Brigade.app.tar.gz`: this Electron app, signed with the Tauri update key
(`TAURI_SIGNING_PRIVATE_KEY`), which their updater puts in place of the old bundle. Its version
must be above theirs (0.4.0 or more). The new app keeps what they set up:

- the bundle id (`ai.brigade.desktop`) and the executable's name, `Contents/MacOS/brigade-desktop`,
  which their login item (`~/Library/LaunchAgents/Brigade.plist`) starts;
- `~/.brigade/desktop.json` (dashboard, shortcuts, Keep screen awake), the runner homes and
  `~/.brigade/captures`;
- Brigade Computer Use.app, with its own signature, so its Screen Recording and Accessibility stay.

Keep publishing `latest.json` and the archive while Macs may still run a Tauri version, and keep
the Tauri update key.
