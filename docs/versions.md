# Versions

Brigade deploys each merge to main, so a version names a week of work for people to talk about
(the changelog, support, self-hosters); it never holds a deploy back. The build, the commit a
server runs, says exactly what is deployed.

## The product's version

- One version for the dashboard, the API and the runner: `version` in the root `package.json`.
- It stays below 1.0 for now (0.x: anything may still change).
- **Each weekly release raises the minor** (0.4.0, then 0.5.0…), in the same pull request as its
  changelog entry (`apps/web/lib/changelog.ts`). An urgent fix shipped between two releases raises
  the patch (0.4.1) and gets an entry of its own. `apps/web/test/changelog.test.ts` checks that the
  newest entry carries `package.json`'s version and that versions only go up.
- Releases before v0.4.0 (October 14 to November 1, 2026) keep their date and have no number.
- A git tag `v0.4.0` may mark a release's commit, pushed only when a person asks. **Never a GitHub
  Release**: Brigade.app updates from the latest GitHub Release's `latest.json`
  (`apps/desktop/src-tauri/tauri.conf.json`), so a release that isn't the app's would stop every
  installed app from updating.

## Where it shows

- **Preferences, at the foot of the page**: `Brigade v0.4.0 · build 67724a7`, a click copies
  `Brigade v0.4.0 (67724a7)` for a support message (`apps/web/components/build-info.tsx`).
- **`/version`** answers `{"build": "67724a7", "version": "0.4.0"}`. The New version pill compares
  only the build (`apps/web/components/update-pill.tsx`).
- **The changelog**: each release from v0.4.0 shows its version beside its date, in its page's
  title and in the RSS feed.

Mid-week, the build is newer than the version: `v0.4.0 · build 67724a7` reads "release 0.4.0 and
what was merged since". The build is what support goes by.

## Brigade.app

The Mac app keeps its own version (`desktop-v0.3.11` and on): it is the only part people install,
its updater compares versions, and it ships more often than once a week (eight releases from
November 2 to 5). It ships **only when its own code changed** (`apps/desktop`,
`apps/computer-use-macos`), never because the rest of Brigade moved on, from a `desktop-v*` tag a
person asks for (`.github/workflows/desktop-release.yml`). A week it shipped, the changelog's
release names its versions in a Brigade.app section.

Runners show their own version, the start of their bundle's SHA-256, on Settings › Computers.
