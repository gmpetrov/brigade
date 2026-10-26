-- AlterTable
ALTER TABLE "DocumentAsset" ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL DEFAULT '',
    "status" "AttachmentStatus" NOT NULL DEFAULT 'pending',
    "memberId" TEXT,
    "computerId" TEXT,
    "sessionId" TEXT,
    "teammateId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "checked" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Upload_workspaceId_createdAt_idx" ON "Upload"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Upload_createdAt_idx" ON "Upload"("createdAt");
