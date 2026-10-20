-- The review loop goes: a review is a child thread of the thread that opened the pull request
-- (src/reviews.ts), and what the loop's status kept of a merge a person asked for moves to
-- mergeStatus. Only additions: the API deployed before this one keeps the loop's columns
-- (reviewStatus, autoMerge, reviewerTeammateId, reviewedSha) for the minutes it still runs
-- while the new one starts; a later migration drops them.

-- Tickets the loop opened for a pull request it stopped on no longer wait on anyone. A merge a
-- person asked for (Resolve conflicts) has its method set; the loop's never had.
UPDATE "Ticket"
SET "status" = 'resolved', "resolvedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'open'
  AND ("payload"->>'pullRequestId') IN (
    SELECT "id" FROM "PullRequest"
    WHERE "reviewStatus" IN ('reviewing', 'fixing', 'approved', 'changes_requested')
       OR ("reviewStatus" = 'stuck' AND "mergeMethod" IS NULL)
  );

-- The loop stops: the old API, still running for a few minutes, moves none of them on.
UPDATE "PullRequest"
SET "reviewStatus" = 'none', "autoMerge" = false, "note" = NULL, "round" = 0
WHERE "reviewStatus" IN ('reviewing', 'fixing', 'approved', 'changes_requested')
   OR ("reviewStatus" = 'stuck' AND "mergeMethod" IS NULL);

-- CreateEnum
CREATE TYPE "MergeStatus" AS ENUM ('none', 'stuck', 'resolving', 'merging');

-- CreateEnum
CREATE TYPE "ReviewPolicy" AS ENUM ('teammate', 'manual');

-- DropForeignKey: nothing joins on the loop's reviewer any more.
ALTER TABLE "PullRequest" DROP CONSTRAINT "PullRequest_reviewerTeammateId_fkey";

-- DropIndex
DROP INDEX "PullRequest_reviewStatus_autoMerge_idx";

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "mergeStatus" "MergeStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "resolveFromSha" TEXT,
ADD COLUMN "noReviewReason" TEXT,
ADD COLUMN "reviewClaimedAt" TIMESTAMP(3),
ADD COLUMN "reviewSessionId" TEXT;

-- A merge under way (Resolve conflicts) goes on where it was.
UPDATE "PullRequest"
SET "mergeStatus" = "reviewStatus"::text::"MergeStatus", "resolveFromSha" = "reviewedSha"
WHERE "reviewStatus" IN ('stuck', 'resolving', 'merging');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "reviewPolicy" "ReviewPolicy" NOT NULL DEFAULT 'teammate';

-- CreateIndex
CREATE INDEX "PullRequest_reviewSessionId_idx" ON "PullRequest"("reviewSessionId");

-- CreateIndex
CREATE INDEX "PullRequest_mergeStatus_idx" ON "PullRequest"("mergeStatus");

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_reviewSessionId_fkey" FOREIGN KEY ("reviewSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
