-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('upload', 'connector', 'teammate');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('ready', 'blocked');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL DEFAULT '',
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ready',
    "note" TEXT,
    "source" "AttachmentSource" NOT NULL,
    "uploadedByMemberId" TEXT,
    "connectionId" TEXT,
    "externalRef" TEXT,
    "sessionId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_workspaceId_createdAt_idx" ON "Attachment"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_connectionId_externalRef_key" ON "Attachment"("connectionId", "externalRef");

-- CreateIndex
CREATE INDEX "ThreadAttachment_attachmentId_idx" ON "ThreadAttachment"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadAttachment_sessionId_path_key" ON "ThreadAttachment"("sessionId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadAttachment_sessionId_attachmentId_key" ON "ThreadAttachment"("sessionId", "attachmentId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadAttachment" ADD CONSTRAINT "ThreadAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadAttachment" ADD CONSTRAINT "ThreadAttachment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadAttachment" ADD CONSTRAINT "ThreadAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

