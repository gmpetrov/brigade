# syntax=docker/dockerfile:1.7
# Brigade's images for a server with Docker (deploy/vps): the API, the dashboard and
# collab, built from the repository root:
#   docker buildx bake -f deploy/vps/docker-bake.hcl
ARG NODE=node:22.22.0-bookworm-slim

FROM ${NODE} AS deps
RUN npm install --global pnpm@8.7.5
WORKDIR /repo
# Packages first, from the lockfile alone: this layer stays cached until it changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY patches patches
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM deps AS api-build
# prisma.config.ts needs a URL, which generating never connects to.
RUN pnpm --filter "@brigade/api^..." build && \
    DATABASE_URL=postgresql://localhost/unused pnpm --filter @brigade/api build
RUN pnpm --filter @brigade/runner bundle
RUN pnpm --filter @brigade/api deploy --prod /out/api

FROM deps AS web-build
# Inlined into the dashboard's code, so each environment has its own image.
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" && \
    pnpm --filter "@brigade/web^..." build && \
    NEXT_STANDALONE=1 NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL pnpm --filter @brigade/web build

FROM deps AS collab-build
# The same Worker as on Cloudflare, bundled by wrangler, and workerd to run it.
RUN pnpm --filter @brigade/collab exec wrangler deploy --dry-run --outdir /out/collab && \
    cd apps/collab && cp "$(node -p "require('module').createRequire(require.resolve('wrangler/package.json'))('workerd').default")" /out/workerd

FROM ${NODE} AS api
# Prisma's schema engine (migrations) needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api-build /out/api ./
COPY --from=api-build /repo/apps/runner/bundle/brigade-runner.tgz runner/brigade-runner.tgz
ENV NODE_ENV=production PORT=3001 RUNNER_BUNDLE_PATH=/app/runner/brigade-runner.tgz
EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM ${NODE} AS web
WORKDIR /app
COPY --from=web-build /repo/apps/web/.next/standalone ./
COPY --from=web-build /repo/apps/web/.next/static apps/web/.next/static
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM debian:bookworm-slim AS collab
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=collab-build /out/workerd /usr/local/bin/workerd
COPY --from=collab-build /out/collab/index.js /app/index.js
COPY deploy/vps/collab.capnp /app/collab.capnp
# The rooms' storage: a volume in compose.yml.
RUN mkdir /data
VOLUME /data
EXPOSE 8787
CMD ["workerd", "serve", "/app/collab.capnp"]
