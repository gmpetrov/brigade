
-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "createdByType" "ActorType",
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletedByType" "ActorType",
ADD COLUMN     "updatedById" TEXT,
ADD COLUMN     "updatedByType" "ActorType",
ADD COLUMN     "updatedInSessionId" TEXT;

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" TEXT,
    "restoredFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFolder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "createdByType" "ActorType",
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFolderGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "access" "LibraryAccess" NOT NULL,

    CONSTRAINT "LibraryFolderGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_createdAt_idx" ON "DocumentVersion"("documentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFolder_workspaceId_path_key" ON "LibraryFolder"("workspaceId", "path");

-- CreateIndex
CREATE INDEX "LibraryFolderGrant_teammateId_idx" ON "LibraryFolderGrant"("teammateId");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFolderGrant_folderId_teammateId_key" ON "LibraryFolderGrant"("folderId", "teammateId");

-- CreateIndex
CREATE INDEX "Document_workspaceId_deletedAt_idx" ON "Document"("workspaceId", "deletedAt");

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolderGrant" ADD CONSTRAINT "LibraryFolderGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolderGrant" ADD CONSTRAINT "LibraryFolderGrant_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "LibraryFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFolderGrant" ADD CONSTRAINT "LibraryFolderGrant_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Who added and last changed each library file, from the audit log.
UPDATE "Document" d SET "createdByType" = a."actorType", "createdById" = a."actorId"
FROM (
  SELECT DISTINCT ON ("targetId") "targetId", "actorType", "actorId"
  FROM "AuditEntry"
  WHERE "targetType" = 'document' AND action = 'library.file_added'
  ORDER BY "targetId", at ASC
) a
WHERE d.id = a."targetId" AND d.kind = 'library';

UPDATE "Document" d SET "updatedByType" = a."actorType", "updatedById" = a."actorId",
  "updatedInSessionId" = a."sessionId"
FROM (
  SELECT DISTINCT ON ("targetId") "targetId", "actorType", "actorId", data->>'sessionId' AS "sessionId"
  FROM "AuditEntry"
  WHERE "targetType" = 'document' AND action IN ('library.file_added', 'library.file_replaced')
  ORDER BY "targetId", at DESC
) a
WHERE d.id = a."targetId" AND d.kind = 'library';
