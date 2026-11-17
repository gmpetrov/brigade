-- Brigade Cloud Starter (docs/billing.md): which Cloud plan a subscription is. Only adds a
-- column with a default: the API before it keeps working, and every row stays "cloud".
-- AlterTable
ALTER TABLE "BillingSubscription" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'cloud';
