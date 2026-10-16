-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'cloudflare';

-- CreateTable
CREATE TABLE "McpClient" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpClient_issuer_redirectUri_key" ON "McpClient"("issuer", "redirectUri");

-- AlterTable
ALTER TABLE "SkillPack" ADD COLUMN "appId" TEXT;

-- AddForeignKey
ALTER TABLE "SkillPack" ADD CONSTRAINT "SkillPack_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE SET NULL ON UPDATE CASCADE;
