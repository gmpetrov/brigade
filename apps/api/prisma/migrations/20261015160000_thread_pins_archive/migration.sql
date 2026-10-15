-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ThreadPin" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadPin_pkey" PRIMARY KEY ("memberId","sessionId")
);

-- CreateIndex
CREATE INDEX "ThreadPin_sessionId_idx" ON "ThreadPin"("sessionId");

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
