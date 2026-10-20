-- AlterEnum
ALTER TYPE "WakeupKind" ADD VALUE 'reply';

-- AlterTable
ALTER TABLE "Wakeup" ADD COLUMN "sourceId" TEXT;

-- CreateTable
CREATE TABLE "ReplyWatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wakeup_sessionId_sourceId_key" ON "Wakeup"("sessionId", "sourceId");

-- CreateIndex
CREATE INDEX "ReplyWatch_connectionId_conversationKey_idx" ON "ReplyWatch"("connectionId", "conversationKey");

-- CreateIndex
CREATE INDEX "ReplyWatch_workspaceId_idx" ON "ReplyWatch"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyWatch_sessionId_connectionId_conversationKey_key" ON "ReplyWatch"("sessionId", "connectionId", "conversationKey");

-- AddForeignKey
ALTER TABLE "ReplyWatch" ADD CONSTRAINT "ReplyWatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyWatch" ADD CONSTRAINT "ReplyWatch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyWatch" ADD CONSTRAINT "ReplyWatch_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyWatch" ADD CONSTRAINT "ReplyWatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
