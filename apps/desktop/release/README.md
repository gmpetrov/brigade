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

| File                                                               | For                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `Brigade.dmg`                                                      | Installing on macOS: the dashboard links to it (`apps/web/lib/mac-app.ts`).                           |
| `Brigade-<version>-universal-mac.zip`, `latest-mac.yml`            | Updates on macOS.                                                                                     |
| `Brigade-Setup.exe`, `latest.yml`                                  | Installing and updating on Windows (signed once Azure is set up).                                     |
| `Brigade-amd64.deb`, `Brigade-x86_64.AppImage`, `latest-linux.yml` | Installing and updating on Linux: the dashboard links to the first two (`apps/web/lib/linux-app.ts`). |
| `Brigade.app.tar.gz`, `latest.json`                                | The Tauri Brigade.app (0.3.x) updating to this one.                                                   |

Installed apps check the latest release at launch and every six hours, download a newer version
and offer "Restart to update" (`src/updates.ts`).

## Signing on Windows

The Windows installer and app are signed with Azure Artifact Signing (Microsoft's managed
code-signing service, about $10 a month on its Basic plan) once the release has its account:

1. An Artifact Signing account on a paid Azure subscription, in a supported region, with the
   company's **Public** identity validation completed and a **Public Trust** certificate profile.
   Individuals can only validate in the US or Canada, so a company validates (the EU is eligible).
2. An app registration (Microsoft Entra) with a client secret, given the _Artifact Signing
   Certificate Profile Signer_ role on the account.
3. In the repository's Actions settings, the secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET` and the variables `AZURE_SIGNING_ENDPOINT` (e.g.
   `https://weu.codesigning.azure.net` for West Europe), `AZURE_SIGNING_ACCOUNT`,
   `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER` (the certificate's CN, the validated
   company name).

Without `AZURE_SIGNING_ENDPOINT` the installer is built unsigned. Apps installed unsigned update to
a signed one; from then on, each update's installer must be signed by `AZURE_SIGNING_PUBLISHER`,
so changing that name (a new company validation) needs care. Signing removes "Unknown publisher",
but SmartScreen may still warn until downloads build the app's reputation.

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
