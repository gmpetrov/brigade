-- Previews on a machine of their own (docs/previews.md, the preview_machines feature). Only adds:
-- a member's preference, off by default, and a table of the machines.
ALTER TABLE "Member" ADD COLUMN "previewMachines" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "PreviewMachineStatus" AS ENUM ('creating', 'running', 'stopping', 'stopped', 'destroying');

CREATE TABLE "PreviewMachine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "PreviewMachineStatus" NOT NULL DEFAULT 'creating',
    "providerRef" JSONB,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "claimedUntil" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keptAliveAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreviewMachine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewMachine_sessionId_key" ON "PreviewMachine"("sessionId");
CREATE INDEX "PreviewMachine_workspaceId_status_idx" ON "PreviewMachine"("workspaceId", "status");
CREATE INDEX "PreviewMachine_status_idx" ON "PreviewMachine"("status");
