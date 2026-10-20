-- The review loop goes: a review is a child thread of the thread that opened the pull request
-- (src/reviews.ts). Only additions, for the API deployed before this one, which runs a few
-- minutes more while the new one starts: what the loop's status kept of a merge a person asked
-- for (resolving, merging, stuck) stays in its column (reviewStatus, mergeStatus to the new
-- code, with reviewedSha as resolveFromSha), so a merge either API moves on, the other sees.
-- The loop's other columns stay too, and a later migration drops them.

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

-- The loop stops: nothing moves its pull requests on, not even the older API meanwhile.
UPDATE "PullRequest"
SET "reviewStatus" = 'none', "autoMerge" = false, "reviewedSha" = NULL, "note" = NULL, "round" = 0
WHERE "reviewStatus" IN ('reviewing', 'fixing', 'approved', 'changes_requested')
   OR ("reviewStatus" = 'stuck' AND "mergeMethod" IS NULL);
UPDATE "PullRequest" SET "reviewedSha" = NULL WHERE "reviewStatus" = 'none';

-- CreateEnum
CREATE TYPE "ReviewPolicy" AS ENUM ('teammate', 'manual');

-- DropForeignKey: nothing joins on the loop's reviewer any more.
ALTER TABLE "PullRequest" DROP CONSTRAINT "PullRequest_reviewerTeammateId_fkey";

-- DropIndex
DROP INDEX "PullRequest_reviewStatus_autoMerge_idx";

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "noReviewReason" TEXT,
ADD COLUMN "reviewClaimedAt" TIMESTAMP(3),
ADD COLUMN "reviewSessionId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "reviewPolicy" "ReviewPolicy" NOT NULL DEFAULT 'teammate';

-- CreateIndex
CREATE INDEX "PullRequest_reviewSessionId_idx" ON "PullRequest"("reviewSessionId");

-- CreateIndex
CREATE INDEX "PullRequest_reviewStatus_idx" ON "PullRequest"("reviewStatus");

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_reviewSessionId_fkey" FOREIGN KEY ("reviewSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
