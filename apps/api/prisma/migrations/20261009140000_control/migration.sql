-- CreateEnum
CREATE TYPE "SessionOrigin" AS ENUM ('member', 'webhook');

-- CreateEnum
CREATE TYPE "WebhookVerification" AS ENUM ('stripe', 'hmac', 'none');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "origin" "SessionOrigin" NOT NULL DEFAULT 'member',
ADD COLUMN     "webhookId" TEXT;

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "label" TEXT NOT NULL,
ADD COLUMN     "pathToken" TEXT NOT NULL,
ADD COLUMN     "verification" "WebhookVerification" NOT NULL;

-- CreateIndex
CREATE INDEX "ConnectionCall_teammateId_connectionId_createdAt_idx" ON "ConnectionCall"("teammateId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_sessionId_idx" ON "Ticket"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_pathToken_key" ON "Webhook"("pathToken");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

