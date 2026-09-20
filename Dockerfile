# Milvance API and indexer.
#
# One image, two commands: the HTTP API and the event indexer run as separate
# processes from the same build. They are not combined, because a slow backfill
# must never stall HTTP and scaling the API must never start a second indexer.
#
# Nothing in this image is a financial authority. It holds no key, signs no
# transaction, and rebuilds its entire database from Stellar if it is lost.

FROM node:20.19-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

# Manifests first, so a dependency layer survives a source-only change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/anchor/package.json packages/anchor/
COPY packages/shared/package.json packages/shared/
COPY packages/stellar/package.json packages/stellar/
COPY packages/contract-bindings/package.json packages/contract-bindings/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm --filter @milvance/api db:generate \
 && pnpm --filter @milvance/shared... --filter @milvance/api build

FROM node:20.19-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY --from=build /app /app

# Never root: a compromised process should not own the filesystem it runs on.
USER node
EXPOSE 3001

# The API. The indexer runs the same image with:
#   node apps/api/dist/indexer/indexer.main.js watch
CMD ["node", "apps/api/dist/main.js"]
