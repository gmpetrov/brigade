-- One bucket object per save of a library file (LibraryObject): the file's row and its versions
-- point to theirs. Additive: a null objectKey means the legacy key, still used by files not saved since.
-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "objectKey" TEXT;

-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN     "objectKey" TEXT;

-- CreateTable
CREATE TABLE "LibraryObject" (
    "key" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreferencedAt" TIMESTAMP(3),

    CONSTRAINT "LibraryObject_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "LibraryObject_createdAt_idx" ON "LibraryObject"("createdAt");

-- CreateIndex
CREATE INDEX "LibraryObject_unreferencedAt_idx" ON "LibraryObject"("unreferencedAt");

-- CreateIndex
CREATE INDEX "LibraryObject_workspaceId_idx" ON "LibraryObject"("workspaceId");

-- CreateIndex
CREATE INDEX "Document_objectKey_idx" ON "Document"("objectKey");

-- CreateIndex
CREATE INDEX "DocumentVersion_objectKey_idx" ON "DocumentVersion"("objectKey");


-- An API from before this change writes a file's bytes to its legacy key and changes its sha256 without
-- knowing objectKey: the row then points back to the legacy key, which holds them. Same for a version it
-- folds a save into. Whoever sets objectKey changes it in the same update, so its saves are left as they are.
CREATE FUNCTION "library_object_key_follows_sha"() RETURNS trigger AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256" AND NEW."objectKey" IS NOT DISTINCT FROM OLD."objectKey" THEN
    NEW."objectKey" := NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Document_objectKey_follows_sha" BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "library_object_key_follows_sha"();

CREATE TRIGGER "DocumentVersion_objectKey_follows_sha" BEFORE UPDATE ON "DocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION "library_object_key_follows_sha"();
