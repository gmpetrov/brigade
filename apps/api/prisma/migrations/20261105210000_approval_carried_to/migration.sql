-- A head that resolving a pull request's conflicts pushed while leaving its own changes as its
-- latest approval read them (src/pull-requests.ts, resolverDone): that approval holds for it.
ALTER TABLE "PullRequest" ADD COLUMN "approvalCarriedTo" TEXT;
