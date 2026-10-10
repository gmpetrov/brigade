-- Hand-made webhooks are deleted (their triggers are now chosen from each connector's
-- catalog). Their signing secrets go with them.
DELETE FROM "VaultSecret" WHERE "id" IN (SELECT "verificationSecretId" FROM "Webhook" WHERE "verificationSecretId" IS NOT NULL);

-- CreateEnum
CREATE TYPE "TriggerVerification" AS ENUM ('hmac', 'none');

-- CreateEnum
CREATE TYPE "SubscriptionMode" AS ENUM ('push', 'poll');

-- AlterEnum
ALTER TYPE "SessionOrigin" RENAME VALUE 'webhook' TO 'trigger';

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_webhookId_fkey";

-- DropForeignKey
ALTER TABLE "Webhook" DROP CONSTRAINT "Webhook_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "Webhook" DROP CONSTRAINT "Webhook_teammateId_fkey";

-- DropForeignKey
ALTER TABLE "Webhook" DROP CONSTRAINT "Webhook_workspaceId_fkey";

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "webhookId",
ADD COLUMN     "triggerId" TEXT;

-- DropTable
DROP TABLE "Webhook";

-- DropEnum
DROP TYPE "WebhookSource";

-- DropEnum
DROP TYPE "WebhookVerification";

-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "pathToken" TEXT,
    "verification" "TriggerVerification",
    "verificationSecretId" TEXT,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "mode" "SubscriptionMode" NOT NULL,
    "externalId" TEXT,
    "externalResourceId" TEXT,
    "secretId" TEXT,
    "events" TEXT[],
    "cursor" TEXT,
    "expiresAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Trigger_pathToken_key" ON "Trigger"("pathToken");

-- CreateIndex
CREATE INDEX "Trigger_workspaceId_idx" ON "Trigger"("workspaceId");

-- CreateIndex
CREATE INDEX "Trigger_connectionId_idx" ON "Trigger"("connectionId");

-- CreateIndex
CREATE INDEX "Subscription_workspaceId_idx" ON "Subscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_connectionId_resource_key" ON "Subscription"("connectionId", "resource");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "Trigger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

