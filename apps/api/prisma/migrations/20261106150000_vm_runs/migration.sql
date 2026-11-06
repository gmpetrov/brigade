-- What a workspace's VMs cost (docs/vm-costs.md). Only adds: a table of each VM's runs.
CREATE TYPE "VmKind" AS ENUM ('computer', 'machine');
CREATE TYPE "VmStart" AS ENUM ('create', 'resume', 'found');
CREATE TYPE "VmRunStatus" AS ENUM ('pending', 'open', 'closed', 'void');

CREATE TABLE "VmRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "VmKind" NOT NULL,
    "computerId" TEXT,
    "machineId" TEXT,
    "sessionId" TEXT,
    "sandboxId" TEXT,
    "size" TEXT NOT NULL,
    "start" "VmStart" NOT NULL,
    "status" "VmRunStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "stoppedBy" TEXT,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VmRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VmRun_workspaceId_startedAt_idx" ON "VmRun"("workspaceId", "startedAt");
CREATE INDEX "VmRun_status_idx" ON "VmRun"("status");
CREATE INDEX "VmRun_sandboxId_idx" ON "VmRun"("sandboxId");
-- One run at a time per VM that runs or may run: a start asked twice (a retry, a crash and a
-- restart) is the same run, counted once.
CREATE UNIQUE INDEX "VmRun_one_live_per_sandbox" ON "VmRun"("sandboxId") WHERE "status" IN ('pending', 'open');

ALTER TABLE "VmRun" ADD CONSTRAINT "VmRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
