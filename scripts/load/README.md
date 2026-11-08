# Load test

A disposable copy of the API on Cloudflare, loaded from one machine, to see what breaks first and
when. First run on 2026-11-08, before the launch; its report is in the library
(`Projects/Brigade/investigations/load-test-2026-11.md`).

## What it sets up

- `brigade-api-loadtest` (`wrangler.api.jsonc`) and `brigade-api-front-loadtest`
  (`wrangler.front.jsonc`, on workers.dev): production's Workers under other names, with their
  own Hyperdrive config, queues (`brigade-jobs-loadtest`, `brigade-jobs-loadtest-dlq`) and R2
  bucket (`brigade-loadtest`).
- A throwaway Neon project, sized as production's (`0.25` CU, then more to compare), migrated
  by `deploy.sh`.
- No mail leaves (no `RESEND_API_KEY`: sign-in codes go to the log), no Stripe, no GitHub.

## Steps

1. Make the Neon project, the Hyperdrive config (cache off, to its direct address), the queues
   and the bucket; put their ids in the two configs.
2. Write a `.env` file outside the repository with `CLOUDFLARE_API_TOKEN` (Workers Scripts,
   Queues and Hyperdrive Edit; R2 object access to the bucket only), `CLOUDFLARE_ACCOUNT_ID`,
   `DATABASE_URL` (direct), `BETTER_AUTH_SECRET`, `VAULT_KEY`, `OPS_TOKEN`, `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `API_URL` (the front's workers.dev
   address) and `WEB_URL`.
3. `scripts/deploy/workers.sh build api`, then `SECRETS=<file> scripts/load/deploy.sh api`.
   **Right after**, ask `https://brigade-api-loadtest.<subdomain>.workers.dev/health/db` once:
   the one Api object is made where its first request runs, and this Worker runs next to the
   database. It should say `"colo":"FRA"` and a few milliseconds a query, as production does.
   Made from elsewhere (London once), each query took 18 ms and every number was wrong: delete
   both Workers (remove the queue's consumer first) and deploy again.
4. `SECRETS=<file> scripts/load/deploy.sh front` (add `/api/threads,/api/inbox,...` to try
   STATELESS_ROUTES).
5. Seed workspaces, each a copy of the preview's sample with three members signed in and a
   runner token: `cd apps/api && env $(cat <file>) npx tsx ../../scripts/load/seed.mts 40 ws.json`.
   Then give each its hub object as production's have: `POST /ops/hubs` with
   `{ workspaceId, mode: "object" }` and the OPS_TOKEN.
6. From a machine with `npm i ws`: `node run.mjs http|sockets|files|signups --api <front>
--workspaces ws.json` (options at the top of `run.mjs`).
7. Delete everything after: both Workers, the queues, the Hyperdrive config, the bucket, the Neon
   project and the API token.

## Limits

- Sign-ups through the API allow 3 per 10 seconds from one address (better-auth's rule), so the
  test's accounts are made in the database (`seed.mts`), and `signups` only checks the flow and
  the limit at the rate one address may.
- No real runner, Claude or GitHub: runners are sockets that stream events (`run.mjs`), and the
  git proxy is not loaded.
