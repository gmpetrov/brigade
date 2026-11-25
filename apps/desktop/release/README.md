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
code-signing service, Basic plan) under the publisher name **CHAINDESK**, the company Microsoft
validated. Everything lives in the Azure subscription "Brigade signing" of georgesm.petrov@gmail.com,
resource group `brigade-signing`:

| What                                              | Value                                                          |
| ------------------------------------------------- | -------------------------------------------------------------- |
| Artifact Signing account (North Europe)           | `brigadesigning`, endpoint `https://neu.codesigning.azure.net` |
| Certificate profile (Public Trust)                | `brigade`, subject `CN=CHAINDESK, O=CHAINDESK, L=Paris, C=FR`  |
| Identity validation (organization, until 02/2029) | `64136cc0-9bcd-4e3f-bd9c-0e80caed1e7e`                         |
| Managed identity that signs                       | `brigade-release-signer` (Certificate Profile Signer role)     |

The release's windows job runs in the `desktop-release` GitHub environment and signs in to Azure
with GitHub's OIDC token: the managed identity trusts only
`repo:gmpetrov/brigade:environment:desktop-release`, so no secret is stored. That subject names the
environment, not the ref, so the environment itself is locked down in the repository's
settings, or any workflow on any branch could declare it and sign as CHAINDESK:

- Settings → Environments → `desktop-release` → Deployment branches and tags: **Selected branches
  and tags**, with only the tag rule `desktop-v*`.
- Settings → Rules → Rulesets: the tag ruleset "release tags" on `desktop-v*` restricts creating,
  updating and deleting those tags; only repository admins and the Brigade Production app (which
  pushes a release tag when a person asks for one) may bypass it.

The values are in `desktop-release.yml`; without `AZURE_SIGNING_ENDPOINT` the installer would be
built unsigned.

Apps installed unsigned update to a signed one; from then on, each update's installer must be
signed by CHAINDESK, so a new company validation needs care. Renew the identity validation before
it expires, or signing stops. Signing removes "Unknown publisher", but SmartScreen may still warn
until downloads build the app's reputation.

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
