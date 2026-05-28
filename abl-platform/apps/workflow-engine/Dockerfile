FROM node:22-slim AS base
RUN corepack enable pnpm

FROM base AS builder

# Build tools for native modules (cpu-features via ssh2, isolated-vm)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY packages/ packages/
COPY apps/workflow-engine/ apps/workflow-engine/
COPY scripts/ scripts/
COPY patches/ patches/
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@agent-platform/workflow-engine
RUN pnpm deploy --filter=@agent-platform/workflow-engine --prod /app/deploy

FROM gcr.io/distroless/nodejs22-debian13 AS production

ARG GIT_SHA
ARG DEPLOY_ID
ARG DEPLOYMENT_ENVIRONMENT

WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /app/deploy ./
COPY --from=builder --chown=nonroot:nonroot /app/apps/workflow-engine/dist ./dist
ENV NODE_ENV=production
# Phase 4 (workflow-first-class memory): function-node isolate scripts call
# host async memory ops via ivm.Reference.applySyncPromise. Each blocking call
# parks an isolate worker thread waiting on the host fetch promise. Doubling
# the libuv pool from the default 4 keeps room for worker concurrency under
# load (see D-9 prototype findings in src/executors/function-executor.ts).
ENV UV_THREADPOOL_SIZE=8
ENV GIT_SHA=${GIT_SHA}
ENV DEPLOY_ID=${DEPLOY_ID}
ENV DEPLOYMENT_ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}
USER nonroot
EXPOSE 9080

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:9080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["dist/index.js"]
