# One image, two processes (architecture.md r5): `api` and `keeper` differ only in their command.
# Build from the repository root: docker build -f apps/server/Dockerfile .

FROM node:24.19.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/chain/package.json packages/chain/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @atprice/server...
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm --filter @atprice/server... run build \
 && pnpm --filter @atprice/server deploy --prod /out

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/api/main.js"]
