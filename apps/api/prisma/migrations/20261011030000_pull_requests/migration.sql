-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('none', 'reviewing', 'fixing', 'approved', 'changes_requested', 'stuck');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('approve', 'request_changes');

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "headRef" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "sessionId" TEXT,
    "authorTeammateId" TEXT,
    "reviewerTeammateId" TEXT,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'none',
    "autoMerge" BOOLEAN NOT NULL DEFAULT false,
    "requestedByMemberId" TEXT,
    "round" INTEGER NOT NULL DEFAULT 0,
    "reviewedSha" TEXT,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "teammateId" TEXT,
    "sessionId" TEXT,
    "verdict" "ReviewVerdict" NOT NULL,
    "body" TEXT NOT NULL,
    "comments" JSONB NOT NULL DEFAULT '[]',
    "sha" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequestReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PullRequest_sessionId_idx" ON "PullRequest"("sessionId");

-- CreateIndex
CREATE INDEX "PullRequest_reviewStatus_autoMerge_idx" ON "PullRequest"("reviewStatus", "autoMerge");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_workspaceId_repository_number_key" ON "PullRequest"("workspaceId", "repository", "number");

-- CreateIndex
CREATE INDEX "PullRequestReview_pullRequestId_createdAt_idx" ON "PullRequestReview"("pullRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_authorTeammateId_fkey" FOREIGN KEY ("authorTeammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_reviewerTeammateId_fkey" FOREIGN KEY ("reviewerTeammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReview" ADD CONSTRAINT "PullRequestReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReview" ADD CONSTRAINT "PullRequestReview_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReview" ADD CONSTRAINT "PullRequestReview_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

