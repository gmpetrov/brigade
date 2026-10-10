-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'webhook';

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('http', 'gmail');

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "cursor" TEXT,
ADD COLUMN     "filter" TEXT,
ADD COLUMN     "source" "WebhookSource" NOT NULL DEFAULT 'http',
ALTER COLUMN "pathToken" DROP NOT NULL;
