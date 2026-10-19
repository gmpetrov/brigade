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
   Otherwise, start a child thread (`start_child`) in the playbook's repository with that description. The child
   opens a pull request with the fix and a test, and reports back.
4. When the fix is merged, tell the customer it is fixed, in the same Gmail thread.
