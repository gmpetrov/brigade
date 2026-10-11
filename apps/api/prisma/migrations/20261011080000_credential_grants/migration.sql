-- CreateEnum
CREATE TYPE "CredentialAccess" AS ENUM ('all', 'selected');

-- AlterTable
ALTER TABLE "Credential" ADD COLUMN     "access" "CredentialAccess" NOT NULL DEFAULT 'all',
ADD COLUMN     "createdByTeammateId" TEXT,
ADD COLUMN     "previousVaultSecretId" TEXT;

-- CreateTable
CREATE TABLE "CredentialGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "withoutAsking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CredentialGrant_teammateId_idx" ON "CredentialGrant"("teammateId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialGrant_credentialId_teammateId_key" ON "CredentialGrant"("credentialId", "teammateId");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_previousVaultSecretId_key" ON "Credential"("previousVaultSecretId");

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_previousVaultSecretId_fkey" FOREIGN KEY ("previousVaultSecretId") REFERENCES "VaultSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_createdByTeammateId_fkey" FOREIGN KEY ("createdByTeammateId") REFERENCES "Teammate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialGrant" ADD CONSTRAINT "CredentialGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialGrant" ADD CONSTRAINT "CredentialGrant_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialGrant" ADD CONSTRAINT "CredentialGrant_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

