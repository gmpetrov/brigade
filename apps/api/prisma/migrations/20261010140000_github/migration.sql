-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'github';

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "externalUrl" TEXT;
