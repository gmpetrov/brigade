-- CreateEnum
CREATE TYPE "LoopStatus" AS ENUM ('setup', 'dry_run', 'active', 'paused');

-- CreateEnum
CREATE TYPE "LoopActionLevel" AS ENUM ('ask', 'auto', 'deny');

-- CreateEnum
CREATE TYPE "LoopRunStatus" AS ENUM ('running', 'waiting_person', 'waiting_event', 'done', 'failed');

-- AlterTable
ALTER TABLE "ConnectionCall" ADD COLUMN     "loopActionKey" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "loopInstallationId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "loopRunId" TEXT,
ADD COLUMN     "surfacedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SkillPack" ADD COLUMN     "loopInstallationId" TEXT;

-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "loopInstallationId" TEXT;

-- CreateTable
CREATE TABLE "LoopInstallation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "loopKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'brigade',
    "manifest" JSONB NOT NULL,
    "teammateId" TEXT NOT NULL,
    "ownerMemberId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "LoopStatus" NOT NULL DEFAULT 'setup',
    "createdByMemberId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "activatedByMemberId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoopInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopAction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "level" "LoopActionLevel" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "levelChangedAt" TIMESTAMP(3),
    "levelChangedByMemberId" TEXT,

    CONSTRAINT "LoopAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "rootSessionId" TEXT,
    "conversationKey" TEXT,
    "case" TEXT,
    "status" "LoopRunStatus" NOT NULL DEFAULT 'running',
    "outcome" TEXT,
    "interventions" INTEGER NOT NULL DEFAULT 0,
    "firstResponseAt" TIMESTAMP(3),
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "LoopRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoopInstallation_workspaceId_idx" ON "LoopInstallation"("workspaceId");

-- CreateIndex
CREATE INDEX "LoopInstallation_projectId_idx" ON "LoopInstallation"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "LoopAction_installationId_key_key" ON "LoopAction"("installationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "LoopRun_rootSessionId_key" ON "LoopRun"("rootSessionId");

-- CreateIndex
CREATE INDEX "LoopRun_installationId_startedAt_idx" ON "LoopRun"("installationId", "startedAt");

-- CreateIndex
CREATE INDEX "LoopRun_installationId_conversationKey_idx" ON "LoopRun"("installationId", "conversationKey");

-- CreateIndex
CREATE INDEX "Session_loopRunId_idx" ON "Session"("loopRunId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_loopInstallationId_fkey" FOREIGN KEY ("loopInstallationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_loopInstallationId_fkey" FOREIGN KEY ("loopInstallationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillPack" ADD CONSTRAINT "SkillPack_loopInstallationId_fkey" FOREIGN KEY ("loopInstallationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopInstallation" ADD CONSTRAINT "LoopInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopInstallation" ADD CONSTRAINT "LoopInstallation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopInstallation" ADD CONSTRAINT "LoopInstallation_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopInstallation" ADD CONSTRAINT "LoopInstallation_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopAction" ADD CONSTRAINT "LoopAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopAction" ADD CONSTRAINT "LoopAction_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopRun" ADD CONSTRAINT "LoopRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopRun" ADD CONSTRAINT "LoopRun_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "LoopInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopRun" ADD CONSTRAINT "LoopRun_rootSessionId_fkey" FOREIGN KEY ("rootSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
