-- Stripe accounts now sign in with Stripe (on its MCP server) instead of a pasted key: those
-- connected with a key ask their owner to reconnect. Their triggers keep running meanwhile, on
-- the webhook endpoint they have.
UPDATE "Connection" SET "status" = 'needs_reauth' WHERE "kind" = 'stripe' AND "status" = 'active';
