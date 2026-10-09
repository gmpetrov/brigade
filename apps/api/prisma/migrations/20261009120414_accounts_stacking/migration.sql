-- CreateEnum
CREATE TYPE "AccountSource" AS ENUM ('machine', 'brigade');

-- AlterEnum
ALTER TYPE "AccountStatus" ADD VALUE 'signing_in';

-- AlterEnum
ALTER TYPE "TicketType" ADD VALUE 'usage_limit';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "email" TEXT,
ADD COLUMN     "exhaustedUntil" TIMESTAMP(3),
ADD COLUMN     "plan" TEXT,
ADD COLUMN     "source" "AccountSource" NOT NULL DEFAULT 'machine';
