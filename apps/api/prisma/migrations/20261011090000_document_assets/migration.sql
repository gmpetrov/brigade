
-- CreateTable
CREATE TABLE "DocumentAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ready',
    "uploadedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentAsset_documentId_idx" ON "DocumentAsset"("documentId");

-- CreateIndex
CREATE INDEX "DocumentAsset_workspaceId_idx" ON "DocumentAsset"("workspaceId");

-- CreateIndex
CREATE INDEX "DocumentAsset_checkedAt_idx" ON "DocumentAsset"("checkedAt");

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

