-- Project becomes a GitHub repository's settings for teammates. It was never used, so its rows are none.
DROP INDEX "Project_workspaceId_idx";

ALTER TABLE "Project" DROP COLUMN "name",
DROP COLUMN "repoUrl",
ADD COLUMN     "repository" TEXT NOT NULL,
ADD COLUMN     "notes" TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX "Project_workspaceId_repository_key" ON "Project"("workspaceId", "repository");
