# Cloud computer backups and replacement

A cloud computer's disk is a cache. What lives only there is backed up to Brigade, so that a VM
that no longer starts costs minutes of work, and **Replace cloud computer** (Computers, owners and
admins) moves the workspace onto a new VM with everything it had.

## What is backed up, where, and when

| What | Where | When |
| --- | --- | --- |
| Each thread folder, per teammate: checkouts with `.git`, untracked and ignored files (`.env`), files outside any repository. Not folders git ignores (`node_modules`, `dist`…), nor git's lock files | Bucket, `thread-files/<thread>/backups/<teammate>.bin`, encrypted by the runner; one row per folder (`FolderBackup`) with what ran in the background then | Every 10 minutes for folders used since their last backup |
| Each teammate's crontab and systemd user services (`~/.config/systemd/user`, Brigade's own units left out) | Bucket, `teammate-backups/<teammate>/tasks.bin`, encrypted (`TeammateBackup`) | Every 10 minutes when changed |
| Each teammate's Chrome sign-ins (`Local State`, `Preferences`, cookies, saved logins, `Web Data`, Local Storage, IndexedDB; never the cache) | Bucket, `teammate-backups/<teammate>/browser.bin`, encrypted | When changed, only while Chrome is closed |
| Account logins (`.oauth-token`, `.credentials.json`, Codex's `auth.json`) | Postgres (`AccountLoginBackup`), sealed with the vault's key, never in the bucket | On each change (a watch on the accounts folder, and each minute) |

Everything is also backed up when the API asks (`computer.backup`): before each idle stop (the API
waits for the answer, up to 20 minutes, before stopping the VM; Chrome is closed first) and at the
start of a replacement.

The runner encrypts bucket backups with AES-256-GCM, with a key the API derives per workspace from
`VAULT_KEY` (`GET /runner/computer/backup-key`). Uploads go straight to R2 through signed URLs; the
API checks the size and the header, never reads the bytes. Deleting a thread deletes its folder
backups (they are in its files folder, late uploads included through `BucketCleanup`).

## Replacing

`POST /api/computers/:id/replace` (`src/cloud-replace.ts`), steps kept on `ComputerReplacement`:

1. **backing_up**: the old VM backs up if it answers, then is stopped. It is never destroyed: its
   reference stays on the replacement row, to read its data at the provider.
2. **creating**: the computer gets a new VM and runner (the same `Computer` row: threads, accounts and
   queued commands stay). The old runner token goes. Every thread of the computer "moves" to the new
   VM (`Session.moved`): its next turn takes its folder from its latest backup and its conversation
   from its events; a thread that was at work gets a nudge to carry on.
3. **restoring**: the new runner's welcome carries `restore`; before any turn or browser starts, it
   puts back account logins, then each teammate's crontab, user services and browser profile.
4. **done**, with what did not come back (shown on Computers, and told to each teammate at its next
   turn). A thread's teammate is also told which background commands stopped with the old VM.

Not covered yet: Docker images and volumes, previews, teammates' tool caches (all made again).
