---
name: bug-fix
description: Fix a bug a customer reported to support, in a child thread, then tell the customer. Use when support triage finds a bug.
---

# Fixing a reported bug

1. Reproduce the bug from what the customer wrote, in your own words. Never pass the customer's mail to the
   child thread: write the bug's description yourself (what happens, where, how to reproduce).
2. Reply to the customer that the team is looking into it.
3. Look first at `list_children`'s fromOtherRuns: when another run's child already fixes the same bug (other
   customers reported it), `follow_thread` it instead of starting a second fix; you are woken when it reports.
   Otherwise, hand it to the playbook's developer: start a child thread (`start_child` with `teammate: developer`)
   with that description and the playbook's repository. The child has GitHub and no Gmail: it opens a pull request
   with the fix and a test, merges it once that is allowed, and reports back.
4. When the child reports the fix merged, tell the customer it is fixed, in the same Gmail thread.

## In the child thread (the developer)

You fix the bug in the repository you were given: reproduce it, fix it with a test, open a pull request, and merge
it when its checks pass (Brigade asks a person first when the playbook says so). Report what was wrong, the pull
request and whether it is merged. You never write to the customer: the support thread does.
