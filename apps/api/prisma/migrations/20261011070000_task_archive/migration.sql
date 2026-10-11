-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Task_workspaceId_archivedAt_idx" ON "Task"("workspaceId", "archivedAt");
