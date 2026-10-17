-- CreateEnum
CREATE TYPE "WakeupKind" AS ENUM ('wakeup', 'report');

-- AlterEnum
ALTER TYPE "SessionOrigin" ADD VALUE 'child';

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "parentSessionId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "awaitUntil" TIMESTAMP(3),
ADD COLUMN     "awaited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "parentTeammateId" TEXT,
ADD COLUMN     "report" JSONB,
ADD COLUMN     "reportDeliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Wakeup" ADD COLUMN     "kind" "WakeupKind" NOT NULL DEFAULT 'wakeup';

-- CreateIndex
CREATE INDEX "Session_parentId_createdAt_idx" ON "Session"("parentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
