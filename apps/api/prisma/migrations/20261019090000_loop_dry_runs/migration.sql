-- AlterTable
ALTER TABLE "ConnectionCall" ADD COLUMN     "input" JSONB;

-- AlterTable
ALTER TABLE "LoopRun" ADD COLUMN     "dryRunId" TEXT,
ADD COLUMN     "replay" JSONB,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "LoopDryRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "sessionId" TEXT,
    "teammateId" TEXT NOT NULL,
    "startedByMemberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "firstEventAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "LoopDryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoopRun_dryRunId_idx" ON "LoopRun"("dryRunId");

-- CreateIndex
CREATE INDEX "LoopDryRun_installationId_startedAt_idx" ON "LoopDryRun"("installationId", "startedAt");

-- CreateIndex
CREATE INDEX "LoopDryRun_status_idx" ON "LoopDryRun"("status");

-- AddForeignKey
ALTER TABLE "LoopRun" ADD CONSTRAINT "LoopRun_dryRunId_fkey" FOREIGN KEY ("dryRunId") REFERENCES "LoopDryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopDryRun" ADD CONSTRAINT "LoopDryRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopDryRun" ADD CONSTRAINT "LoopDryRun_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopDryRun" ADD CONSTRAINT "LoopDryRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
