-- CreateEnum
CREATE TYPE "LibraryAccess" AS ENUM ('read', 'read_write');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('library', 'workspace_memory', 'teammate_memory', 'thread_summary');

-- DropIndex
DROP INDEX "Document_workspaceId_path_key";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "indexed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "DocumentKind" NOT NULL DEFAULT 'library',
ADD COLUMN     "search" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', translate("path", '/._-', '    ')), 'A') ||
  setweight(to_tsvector('english', "text"), 'B')
) STORED,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "sha256" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "teammateId" TEXT;

-- AlterTable
ALTER TABLE "Teammate" ADD COLUMN     "libraryAccess" "LibraryAccess" NOT NULL DEFAULT 'read';

-- CreateIndex
CREATE INDEX "Document_search_idx" ON "Document" USING GIN ("search");

-- CreateIndex
CREATE UNIQUE INDEX "Document_workspaceId_kind_path_key" ON "Document"("workspaceId", "kind", "path");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

