-- AlterTable
ALTER TABLE "Member" ADD COLUMN "autoMerge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "autoMergeAt" TIMESTAMP(3);
