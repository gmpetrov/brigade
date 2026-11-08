-- CreateTable
CREATE TABLE "LibraryShare" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibraryShare_documentId_key" ON "LibraryShare"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryShare_token_key" ON "LibraryShare"("token");

-- CreateIndex
CREATE INDEX "LibraryShare_workspaceId_idx" ON "LibraryShare"("workspaceId");

-- AddForeignKey
ALTER TABLE "LibraryShare" ADD CONSTRAINT "LibraryShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryShare" ADD CONSTRAINT "LibraryShare_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
