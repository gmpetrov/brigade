-- Memory in layers: each memory line's date, source and, once it leaves the
-- file, why (the archive); and when a tidy run last laid a memory file out.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "memoryTidiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MemoryLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "topic" TEXT,
    "createdByType" "ActorType",
    "createdById" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "archivedByType" "ActorType",
    "archivedById" TEXT,
    "archivedSessionId" TEXT,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,

    CONSTRAINT "MemoryLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryLine_documentId_key_key" ON "MemoryLine"("documentId", "key");

-- CreateIndex
CREATE INDEX "MemoryLine_documentId_archivedAt_idx" ON "MemoryLine"("documentId", "archivedAt");

-- CreateIndex
CREATE INDEX "MemoryLine_search_idx" ON "MemoryLine" USING GIN ("search");

-- AddForeignKey
ALTER TABLE "MemoryLine" ADD CONSTRAINT "MemoryLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
