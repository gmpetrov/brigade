-- CreateTable
CREATE TABLE "PreviewRecipe" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "recipe" JSONB NOT NULL,
    "savedByTeammateId" TEXT,
    "savedFromSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreviewRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreviewRecipe_workspaceId_idx" ON "PreviewRecipe"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PreviewRecipe_workspaceId_repository_key" ON "PreviewRecipe"("workspaceId", "repository");

-- AddForeignKey
ALTER TABLE "PreviewRecipe" ADD CONSTRAINT "PreviewRecipe_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

