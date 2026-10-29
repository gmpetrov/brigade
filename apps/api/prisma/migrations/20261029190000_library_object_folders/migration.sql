-- Workspaces that have had library objects, kept for good: the listing sweep goes over their folders.
-- CreateTable
CREATE TABLE "LibraryObjectFolder" (
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryObjectFolder_pkey" PRIMARY KEY ("workspaceId")
);

