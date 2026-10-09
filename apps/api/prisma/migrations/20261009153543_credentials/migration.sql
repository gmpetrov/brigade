-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('website', 'database', 'api_key', 'other');

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "name" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "vaultSecretId" TEXT NOT NULL,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Credential_vaultSecretId_key" ON "Credential"("vaultSecretId");

-- CreateIndex
CREATE INDEX "Credential_workspaceId_idx" ON "Credential"("workspaceId");

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_vaultSecretId_fkey" FOREIGN KEY ("vaultSecretId") REFERENCES "VaultSecret"("id") ON DELETE CASCADE ON UPDATE CASCADE;
