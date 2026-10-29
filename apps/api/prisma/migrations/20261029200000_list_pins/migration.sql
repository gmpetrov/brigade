-- Lists a member pinned in their sidebar, under Pinned with their pinned threads.
-- CreateTable
CREATE TABLE "ListPin" (
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ListPin_pkey" PRIMARY KEY ("memberId","documentId")
);

-- CreateIndex
CREATE INDEX "ListPin_documentId_idx" ON "ListPin"("documentId");

-- AddForeignKey
ALTER TABLE "ListPin" ADD CONSTRAINT "ListPin_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListPin" ADD CONSTRAINT "ListPin_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListPin" ADD CONSTRAINT "ListPin_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
