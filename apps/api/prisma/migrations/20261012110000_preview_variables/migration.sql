-- CreateEnum
CREATE TYPE "PreviewVariableKind" AS ENUM ('setting', 'secret', 'generated');

-- CreateTable
CREATE TABLE "PreviewVariable" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PreviewVariableKind" NOT NULL,
    "value" TEXT,
    "vaultSecretId" TEXT,
    "description" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreviewVariable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewVariable_vaultSecretId_key" ON "PreviewVariable"("vaultSecretId");

-- CreateIndex
CREATE INDEX "PreviewVariable_workspaceId_idx" ON "PreviewVariable"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PreviewVariable_workspaceId_repository_name_key" ON "PreviewVariable"("workspaceId", "repository", "name");

-- AddForeignKey
ALTER TABLE "PreviewVariable" ADD CONSTRAINT "PreviewVariable_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreviewVariable" ADD CONSTRAINT "PreviewVariable_vaultSecretId_fkey" FOREIGN KEY ("vaultSecretId") REFERENCES "VaultSecret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

