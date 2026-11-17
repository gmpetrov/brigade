-- Brigade Cloud Starter (docs/billing.md): which Cloud plan a subscription is. Only adds a
-- column with a default: the API before it keeps working, and every row stays "cloud".
-- AlterTable
ALTER TABLE "BillingSubscription" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'cloud';

-- A cloud computer held while its workspace's Starter hours were used up (src/runner-commands.ts giveUp).
ALTER TABLE "Computer" ADD COLUMN "hoursHeldAt" TIMESTAMP(3);
