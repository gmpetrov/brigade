-- A thread spec's large parts, by SHA-256 (src/spec-parts.ts). Only adds.

-- CreateTable
CREATE TABLE "SpecPart" (
    "workspaceId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpecPart_pkey" PRIMARY KEY ("workspaceId","sha256")
);

-- CreateIndex
CREATE INDEX "SpecPart_usedAt_idx" ON "SpecPart"("usedAt");

-- AddForeignKey
ALTER TABLE "SpecPart" ADD CONSTRAINT "SpecPart_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

