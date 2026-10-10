-- CreateTable
CREATE TABLE "ThreadTeammate" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTurnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadTeammate_pkey" PRIMARY KEY ("sessionId","teammateId")
);

-- CreateIndex
CREATE INDEX "ThreadTeammate_teammateId_idx" ON "ThreadTeammate"("teammateId");

-- AddForeignKey
ALTER TABLE "ThreadTeammate" ADD CONSTRAINT "ThreadTeammate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadTeammate" ADD CONSTRAINT "ThreadTeammate_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadTeammate" ADD CONSTRAINT "ThreadTeammate_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every thread so far has its starting teammate.
INSERT INTO "ThreadTeammate" ("organizationId", "workspaceId", "sessionId", "teammateId", "joinedAt", "lastTurnAt")
SELECT "organizationId", "workspaceId", "id", "teammateId", "createdAt", "updatedAt" FROM "Session";
