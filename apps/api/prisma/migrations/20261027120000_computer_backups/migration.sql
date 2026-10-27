-- A cloud computer's backups and its replacement onto a new VM (src/cloud-replace.ts, routes/runner-folders.ts,
-- routes/runner-backups.ts). Only adds.

-- CreateTable
CREATE TABLE "FolderBackup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "background" JSONB NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FolderBackup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeammateBackup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teammateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeammateBackup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLoginBackup" (
    "accountId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLoginBackup_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "ComputerReplacement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'backing_up',
    "oldProviderRef" JSONB,
    "backup" TEXT,
    "problems" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ComputerReplacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderBackup_workspaceId_idx" ON "FolderBackup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderBackup_sessionId_teammateId_key" ON "FolderBackup"("sessionId", "teammateId");

-- CreateIndex
CREATE INDEX "TeammateBackup_workspaceId_idx" ON "TeammateBackup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TeammateBackup_teammateId_kind_key" ON "TeammateBackup"("teammateId", "kind");

-- CreateIndex
CREATE INDEX "AccountLoginBackup_workspaceId_idx" ON "AccountLoginBackup"("workspaceId");

-- CreateIndex
CREATE INDEX "ComputerReplacement_computerId_phase_idx" ON "ComputerReplacement"("computerId", "phase");

-- AddForeignKey
ALTER TABLE "FolderBackup" ADD CONSTRAINT "FolderBackup_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeammateBackup" ADD CONSTRAINT "TeammateBackup_teammateId_fkey" FOREIGN KEY ("teammateId") REFERENCES "Teammate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLoginBackup" ADD CONSTRAINT "AccountLoginBackup_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputerReplacement" ADD CONSTRAINT "ComputerReplacement_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

