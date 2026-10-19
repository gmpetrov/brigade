-- CreateTable
CREATE TABLE "ThreadLater" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "laterAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadLater_pkey" PRIMARY KEY ("memberId","sessionId")
);

-- CreateIndex
CREATE INDEX "ThreadLater_sessionId_idx" ON "ThreadLater"("sessionId");

-- CreateIndex
CREATE INDEX "ThreadLater_workspaceId_idx" ON "ThreadLater"("workspaceId");

-- AddForeignKey
ALTER TABLE "ThreadLater" ADD CONSTRAINT "ThreadLater_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadLater" ADD CONSTRAINT "ThreadLater_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadLater" ADD CONSTRAINT "ThreadLater_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
