-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'mixpanel';

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "mcpUrl" TEXT;
