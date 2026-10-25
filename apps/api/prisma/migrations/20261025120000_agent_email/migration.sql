-- CreateEnum
CREATE TYPE "MailAddressKind" AS ENUM ('agent', 'inbox');

-- CreateEnum
CREATE TYPE "MailDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('pending', 'done', 'failed', 'scheduled', 'sent', 'delivered', 'bounced', 'cancelled');

-- CreateEnum
CREATE TYPE "MailSender" AS ENUM ('member', 'contact', 'unknown', 'brigade');

-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'email';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "quiet" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MailAddress" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MailAddressKind" NOT NULL,
    "teammateId" TEXT,
    "projectId" TEXT,
    "connectionId" TEXT,
    "publicAddress" TEXT,
    "domainId" TEXT,
    "displayName" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailProject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAlias" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT,
    "teammateId" TEXT,
    "purpose" TEXT NOT NULL DEFAULT '',
    "waitUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "projectId" TEXT,
    "box" TEXT NOT NULL,
    "aliasId" TEXT,
    "direction" "MailDirection" NOT NULL,
    "status" "MailStatus" NOT NULL,
    "resendId" TEXT,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT '',
    "to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replyTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "headers" JSONB NOT NULL DEFAULT '{}',
    "authentication" JSONB,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "sender" "MailSender",
    "memberId" TEXT,
    "contactId" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "route" TEXT,
    "routeNote" TEXT,
    "sessionId" TEXT,
    "triggerId" TEXT,
    "teammateId" TEXT,
    "approvedByMemberId" TEXT,
    "sendAt" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resendDomainId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "records" JSONB NOT NULL DEFAULT '[]',
    "createdByMemberId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactHandle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactHandle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailAddress_name_key" ON "MailAddress"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MailAddress_teammateId_key" ON "MailAddress"("teammateId");

-- CreateIndex
CREATE UNIQUE INDEX "MailAddress_connectionId_key" ON "MailAddress"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MailAddress_publicAddress_key" ON "MailAddress"("publicAddress");

-- CreateIndex
CREATE INDEX "MailAddress_workspaceId_idx" ON "MailAddress"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MailProject_projectId_key" ON "MailProject"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "MailProject_workspaceId_slug_key" ON "MailProject"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "MailAlias_local_key" ON "MailAlias"("local");

-- CreateIndex
CREATE INDEX "MailAlias_sessionId_idx" ON "MailAlias"("sessionId");

-- CreateIndex
CREATE INDEX "MailMessage_workspaceId_conversationId_idx" ON "MailMessage"("workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "MailMessage_workspaceId_messageId_idx" ON "MailMessage"("workspaceId", "messageId");

-- CreateIndex
CREATE INDEX "MailMessage_box_receivedAt_idx" ON "MailMessage"("box", "receivedAt");

-- CreateIndex
CREATE INDEX "MailMessage_status_updatedAt_idx" ON "MailMessage"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "MailMessage_sessionId_idx" ON "MailMessage"("sessionId");

-- CreateIndex
CREATE INDEX "MailMessage_expiresAt_idx" ON "MailMessage"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_resendId_box_key" ON "MailMessage"("resendId", "box");

-- CreateIndex
CREATE UNIQUE INDEX "MailDomain_name_key" ON "MailDomain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ContactHandle_workspaceId_kind_value_key" ON "ContactHandle"("workspaceId", "kind", "value");

-- AddForeignKey
ALTER TABLE "MailAddress" ADD CONSTRAINT "MailAddress_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAddress" ADD CONSTRAINT "MailAddress_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "MailDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailProject" ADD CONSTRAINT "MailProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailProject" ADD CONSTRAINT "MailProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAlias" ADD CONSTRAINT "MailAlias_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAlias" ADD CONSTRAINT "MailAlias_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "MailAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAlias" ADD CONSTRAINT "MailAlias_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "MailAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "MailAlias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDomain" ADD CONSTRAINT "MailDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactHandle" ADD CONSTRAINT "ContactHandle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactHandle" ADD CONSTRAINT "ContactHandle_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
