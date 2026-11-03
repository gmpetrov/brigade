-- A pull request's repository by its GitHub id, which a rename keeps (only adds).
ALTER TABLE "PullRequest" ADD COLUMN "repositoryId" TEXT;

CREATE INDEX "PullRequest_workspaceId_repositoryId_idx" ON "PullRequest"("workspaceId", "repositoryId");
