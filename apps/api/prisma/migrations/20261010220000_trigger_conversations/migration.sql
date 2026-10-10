-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "conversationKey" TEXT;

-- CreateIndex
CREATE INDEX "Session_triggerId_conversationKey_idx" ON "Session"("triggerId", "conversationKey");
