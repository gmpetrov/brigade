-- Where a workspace's hub runs on Cloudflare (docs/workspace-hubs-plan.md): the Api object, as
-- every workspace's did, until it is moved to a Durable Object of its own.
CREATE TYPE "HubMode" AS ENUM ('api', 'object');

ALTER TABLE "Workspace" ADD COLUMN "hubMode" "HubMode" NOT NULL DEFAULT 'api';
