-- CreateEnum
CREATE TYPE "WakeupStatus" AS ENUM ('pending', 'fired', 'cancelled', 'missed');

-- CreateTable
CREATE TABLE "Wakeup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "wakeAt" TIMESTAMP(3) NOT NULL,
    "status" "WakeupStatus" NOT NULL DEFAULT 'pending',
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wakeup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Wakeup_status_wakeAt_idx" ON "Wakeup"("status", "wakeAt");

-- CreateIndex
CREATE INDEX "Wakeup_sessionId_status_idx" ON "Wakeup"("sessionId", "status");

-- AddForeignKey
ALTER TABLE "Wakeup" ADD CONSTRAINT "Wakeup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wakeup" ADD CONSTRAINT "Wakeup_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wakeup" ADD CONSTRAINT "Wakeup_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

