-- Product analytics (src/analytics.ts). Add-only.

-- Where a person came from when they signed up: set once, never changed.
ALTER TABLE "User" ADD COLUMN "attribution" JSONB;

-- The analytics events a person has sent once already.
CREATE TABLE "AnalyticsFirst" (
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsFirst_pkey" PRIMARY KEY ("userId","event")
);

ALTER TABLE "AnalyticsFirst" ADD CONSTRAINT "AnalyticsFirst_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- People who were here before analytics are past their first time: none of their next events
-- counts as a first (the list is FIRST_EVENTS in src/analytics-events.ts).
INSERT INTO "AnalyticsFirst" ("userId", "event")
SELECT u."id", e."event"
FROM "User" u
CROSS JOIN (VALUES
    ('workspace_created'),
    ('computer_chosen'),
    ('ai_account_connected'),
    ('runner_connected'),
    ('teammate_created'),
    ('thread_started'),
    ('message_sent'),
    ('turn_completed'),
    ('pull_request_opened'),
    ('preview_started'),
    ('ticket_answered'),
    ('checkout_started'),
    ('subscription_started')
) AS e("event")
ON CONFLICT DO NOTHING;
