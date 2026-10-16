-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'mcp';

-- AlterTable
ALTER TABLE "App" ADD COLUMN "mcp" JSONB;
