-- Playbooks, again (#210 and #211, reverted by 20261019090000_drop_loops), now named "playbook"
-- in code and database. Only adds: tables, columns, enums, indexes and foreign keys.

-- CreateEnum
CREATE TYPE "PlaybookStatus" AS ENUM ('setup', 'dry_run', 'active', 'paused');

-- CreateEnum
CREATE TYPE "PlaybookActionLevel" AS ENUM ('ask', 'auto', 'deny');

-- CreateEnum
CREATE TYPE "PlaybookRunStatus" AS ENUM ('running', 'waiting_person', 'waiting_event', 'done', 'failed');

-- AlterTable
ALTER TABLE "ConnectionCall" ADD COLUMN     "input" JSONB,
ADD COLUMN     "playbookActionKey" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "playbookInstallationId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "playbookRunId" TEXT,
ADD COLUMN     "surfacedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SkillPack" ADD COLUMN     "playbookInstallationId" TEXT;

-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "playbookInstallationId" TEXT;

-- CreateTable
CREATE TABLE "PlaybookInstallation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "playbookKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'brigade',
    "manifest" JSONB NOT NULL,
    "teammateId" TEXT NOT NULL,
    "ownerMemberId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "PlaybookStatus" NOT NULL DEFAULT 'setup',
    "createdByMemberId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "activatedByMemberId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybookInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybookAction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "level" "PlaybookActionLevel" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "levelChangedAt" TIMESTAMP(3),
    "levelChangedByMemberId" TEXT,

    CONSTRAINT "PlaybookAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybookRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "rootSessionId" TEXT,
    "conversationKey" TEXT,
    "case" TEXT,
    "status" "PlaybookRunStatus" NOT NULL DEFAULT 'running',
    "outcome" TEXT,
    "interventions" INTEGER NOT NULL DEFAULT 0,
    "firstResponseAt" TIMESTAMP(3),
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "dryRunId" TEXT,
    "replay" JSONB,
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PlaybookRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybookDryRun" (
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

    CONSTRAINT "PlaybookDryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlaybookInstallation_workspaceId_idx" ON "PlaybookInstallation"("workspaceId");

-- CreateIndex
CREATE INDEX "PlaybookInstallation_projectId_idx" ON "PlaybookInstallation"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybookAction_installationId_key_key" ON "PlaybookAction"("installationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybookRun_rootSessionId_key" ON "PlaybookRun"("rootSessionId");

-- CreateIndex
CREATE INDEX "PlaybookRun_installationId_startedAt_idx" ON "PlaybookRun"("installationId", "startedAt");

-- CreateIndex
CREATE INDEX "PlaybookRun_installationId_conversationKey_idx" ON "PlaybookRun"("installationId", "conversationKey");

-- CreateIndex
CREATE INDEX "PlaybookRun_dryRunId_idx" ON "PlaybookRun"("dryRunId");

-- CreateIndex
CREATE INDEX "PlaybookDryRun_installationId_startedAt_idx" ON "PlaybookDryRun"("installationId", "startedAt");

-- CreateIndex
CREATE INDEX "PlaybookDryRun_status_idx" ON "PlaybookDryRun"("status");

-- CreateIndex
CREATE INDEX "Session_playbookRunId_idx" ON "Session"("playbookRunId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_playbookRunId_fkey" FOREIGN KEY ("playbookRunId") REFERENCES "PlaybookRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_playbookInstallationId_fkey" FOREIGN KEY ("playbookInstallationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_playbookInstallationId_fkey" FOREIGN KEY ("playbookInstallationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillPack" ADD CONSTRAINT "SkillPack_playbookInstallationId_fkey" FOREIGN KEY ("playbookInstallationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookInstallation" ADD CONSTRAINT "PlaybookInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookInstallation" ADD CONSTRAINT "PlaybookInstallation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookInstallation" ADD CONSTRAINT "PlaybookInstallation_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookInstallation" ADD CONSTRAINT "PlaybookInstallation_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookAction" ADD CONSTRAINT "PlaybookAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookAction" ADD CONSTRAINT "PlaybookAction_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookRun" ADD CONSTRAINT "PlaybookRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookRun" ADD CONSTRAINT "PlaybookRun_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookRun" ADD CONSTRAINT "PlaybookRun_rootSessionId_fkey" FOREIGN KEY ("rootSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookRun" ADD CONSTRAINT "PlaybookRun_dryRunId_fkey" FOREIGN KEY ("dryRunId") REFERENCES "PlaybookDryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookDryRun" ADD CONSTRAINT "PlaybookDryRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookDryRun" ADD CONSTRAINT "PlaybookDryRun_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PlaybookInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookDryRun" ADD CONSTRAINT "PlaybookDryRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
