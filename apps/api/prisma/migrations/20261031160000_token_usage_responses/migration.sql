-- AlterTable
ALTER TABLE "TokenUsage" ADD COLUMN     "replaced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "responseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TokenUsage_workspaceId_responseId_key" ON "TokenUsage"("workspaceId", "responseId");

-- CreateIndex
CREATE INDEX "TokenUsage_sessionId_teammateId_at_idx" ON "TokenUsage"("sessionId", "teammateId", "at");
