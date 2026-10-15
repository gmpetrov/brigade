# Releasing Brigade.app

`.github/workflows/desktop-release.yml` builds, signs, notarizes and publishes Brigade.app
from a `desktop-v*` tag. It needs the repository secrets listed at the top of the workflow.

```bash
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

Installed apps check `releases/latest/download/latest.json` every six hours and offer
"Restart to update". The dashboard links to `releases/latest/download/Brigade.dmg`.
