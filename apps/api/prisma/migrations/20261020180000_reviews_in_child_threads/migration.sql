-- The review loop goes: a review is a child thread of the thread that opened the pull request
-- (src/reviews.ts), and what was the loop's status only tracks a merge a person asked for.

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

UPDATE "PullRequest"
SET "reviewStatus" = 'none', "note" = NULL, "round" = 0
WHERE "reviewStatus" IN ('reviewing', 'fixing', 'approved', 'changes_requested')
   OR ("reviewStatus" = 'stuck' AND "mergeMethod" IS NULL);

-- CreateEnum
CREATE TYPE "MergeStatus" AS ENUM ('none', 'stuck', 'resolving', 'merging');

-- CreateEnum
CREATE TYPE "ReviewPolicy" AS ENUM ('teammate', 'manual');

-- DropForeignKey
ALTER TABLE "PullRequest" DROP CONSTRAINT "PullRequest_reviewerTeammateId_fkey";

-- DropIndex
DROP INDEX "PullRequest_reviewStatus_autoMerge_idx";

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "mergeStatus" "MergeStatus" NOT NULL DEFAULT 'none';
UPDATE "PullRequest" SET "mergeStatus" = "reviewStatus"::text::"MergeStatus";
ALTER TABLE "PullRequest" DROP COLUMN "reviewStatus",
DROP COLUMN "autoMerge",
DROP COLUMN "reviewerTeammateId",
ADD COLUMN "noReviewReason" TEXT,
ADD COLUMN "reviewClaimedAt" TIMESTAMP(3),
ADD COLUMN "reviewSessionId" TEXT;
ALTER TABLE "PullRequest" RENAME COLUMN "reviewedSha" TO "resolveFromSha";
-- Only a merge under way keeps it: the rest is what a review looked at.
UPDATE "PullRequest" SET "resolveFromSha" = NULL WHERE "mergeStatus" = 'none';

-- DropEnum
DROP TYPE "ReviewStatus";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "reviewPolicy" "ReviewPolicy" NOT NULL DEFAULT 'teammate';

-- CreateIndex
CREATE INDEX "PullRequest_reviewSessionId_idx" ON "PullRequest"("reviewSessionId");

-- CreateIndex
CREATE INDEX "PullRequest_mergeStatus_idx" ON "PullRequest"("mergeStatus");

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_reviewSessionId_fkey" FOREIGN KEY ("reviewSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
