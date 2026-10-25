-- CreateTable
CREATE TABLE "DocumentPin" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPin_pkey" PRIMARY KEY ("memberId","documentId")
);

-- CreateIndex
CREATE INDEX "DocumentPin_documentId_idx" ON "DocumentPin"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentPin" ADD CONSTRAINT "DocumentPin_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPin" ADD CONSTRAINT "DocumentPin_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPin" ADD CONSTRAINT "DocumentPin_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
