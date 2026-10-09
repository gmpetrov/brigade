-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('active', 'needs_reauth');

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "externalAccount" TEXT,
ADD COLUMN     "status" "ConnectionStatus" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "ConnectionCall" ADD COLUMN     "ticketId" TEXT;
