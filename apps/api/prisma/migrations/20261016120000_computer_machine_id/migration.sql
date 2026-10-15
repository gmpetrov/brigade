-- AlterTable
ALTER TABLE "Computer" ADD COLUMN     "machineId" TEXT;

-- CreateIndex
CREATE INDEX "Computer_workspaceId_memberId_machineId_idx" ON "Computer"("workspaceId", "memberId", "machineId");
