# Releasing Brigade.app

`desktop-release.yml` is the GitHub Actions workflow that builds, signs, notarizes and
publishes Brigade.app from a `desktop-v*` tag. It lives here because Brigade's GitHub App
cannot push files under `.github/workflows` (that needs GitHub's "Workflows" permission).
To enable it, a maintainer moves it into place and applies the patch that keeps Mac app
changes from redeploying the VPS:

```bash
git mv apps/desktop/release/desktop-release.yml .github/workflows/desktop-release.yml
git apply apps/desktop/release/vps-exclude-desktop.patch
```

Then add the repository secrets listed at the top of the workflow, and release with
`git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`.
