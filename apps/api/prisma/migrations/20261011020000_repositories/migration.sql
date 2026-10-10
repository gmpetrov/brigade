-- Project is renamed Repository: each row is one GitHub repository's settings for teammates.
ALTER TABLE "Project" RENAME TO "Repository";
ALTER TABLE "Repository" RENAME CONSTRAINT "Project_pkey" TO "Repository_pkey";
ALTER TABLE "Repository" RENAME CONSTRAINT "Project_workspaceId_fkey" TO "Repository_workspaceId_fkey";
ALTER INDEX "Project_workspaceId_repository_key" RENAME TO "Repository_workspaceId_repository_key";
