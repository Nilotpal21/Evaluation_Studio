# ============================================================
# Runtime Server — Multi-stage Docker build
# ============================================================
# Build:  docker build -t agent-platform-runtime -f apps/runtime/Dockerfile .
# Run:    docker run -p 3112:3112 --env-file .env agent-platform-runtime
# ============================================================

# --------------- Stage 1: Builder ---------------
FROM node:24-slim AS builder

# Build tools for native modules (cpu-features via ssh2)
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 make g++ libssl3; \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.15.0

WORKDIR /app

# Copy workspace root manifests first (layer cache)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.json ./

# Copy all workspace package.json files so pnpm can resolve the dependency graph.
# Packages (libraries)
COPY packages/academy/package.json    packages/academy/package.json
COPY packages/compiler/package.json    packages/compiler/package.json
COPY packages/core/package.json        packages/core/package.json
COPY packages/config/package.json      packages/config/package.json
COPY packages/database/package.json    packages/database/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/shared/package.json      packages/shared/package.json
COPY packages/shared-auth/package.json packages/shared-auth/package.json
COPY packages/shared-auth-profile/package.json packages/shared-auth-profile/package.json
COPY packages/shared-encryption/package.json packages/shared-encryption/package.json
COPY packages/shared-kernel/package.json packages/shared-kernel/package.json
COPY packages/shared-observability/package.json packages/shared-observability/package.json
COPY packages/observatory/package.json packages/observatory/package.json
COPY packages/analyzer/package.json    packages/analyzer/package.json
COPY packages/circuit-breaker/package.json packages/circuit-breaker/package.json
COPY packages/execution/package.json   packages/execution/package.json
COPY packages/eventstore/package.json packages/eventstore/package.json
COPY packages/kore-platform-cli/package.json packages/kore-platform-cli/package.json
COPY packages/language-service/package.json packages/language-service/package.json
COPY packages/llm/package.json         packages/llm/package.json
COPY packages/project-io/package.json  packages/project-io/package.json
COPY packages/redis/package.json                packages/redis/package.json
COPY packages/openapi/package.json     packages/openapi/package.json
COPY packages/i18n/package.json       packages/i18n/package.json
COPY packages/a2a/package.json        packages/a2a/package.json
COPY packages/arch-ai/package.json packages/arch-ai/package.json
COPY packages/search-ai-sdk/package.json packages/search-ai-sdk/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/connectors/piece-shopify/package.json packages/connectors/piece-shopify/package.json
COPY packages/connectors/piece-azure-document-intelligence/package.json packages/connectors/piece-azure-document-intelligence/package.json
COPY packages/connectors/piece-claude/package.json packages/connectors/piece-claude/package.json
COPY packages/connectors/piece-openai/package.json packages/connectors/piece-openai/package.json
COPY packages/connectors/piece-jira-cloud/package.json packages/connectors/piece-jira-cloud/package.json
COPY packages/connectors/piece-google-drive/package.json packages/connectors/piece-google-drive/package.json
COPY packages/crawler/package.json    packages/crawler/package.json
COPY packages/pipeline-engine/package.json packages/pipeline-engine/package.json
COPY packages/agent-transfer/package.json packages/agent-transfer/package.json
COPY packages/abl-lsp-server/package.json packages/abl-lsp-server/package.json
COPY packages/abl-vscode/package.json packages/abl-vscode/package.json
COPY packages/admin-ui/package.json    packages/admin-ui/package.json
COPY packages/auth-enterprise/package.json packages/auth-enterprise/package.json
COPY packages/connectors/base/package.json packages/connectors/base/package.json
COPY packages/connectors/sharepoint/package.json packages/connectors/sharepoint/package.json
COPY packages/editor/package.json      packages/editor/package.json
COPY packages/mcp-debug/package.json   packages/mcp-debug/package.json
COPY packages/mcp-openai-reviewer/package.json packages/mcp-openai-reviewer/package.json
COPY packages/nl-parser/package.json   packages/nl-parser/package.json
COPY packages/search-ai-internal/package.json packages/search-ai-internal/package.json
COPY packages/sizing-calculator/package.json packages/sizing-calculator/package.json
COPY packages/tailwind-config/package.json packages/tailwind-config/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/web-sdk/package.json     packages/web-sdk/package.json

# Apps
COPY apps/admin/package.json           apps/admin/package.json
COPY apps/crawler-go-worker/package.json apps/crawler-go-worker/package.json
COPY apps/crawler-mcp-server/package.json apps/crawler-mcp-server/package.json
COPY apps/docs-internal/package.json   apps/docs-internal/package.json
COPY apps/multimodal-service/package.json apps/multimodal-service/package.json
COPY apps/observatory-cli/package.json apps/observatory-cli/package.json
COPY apps/runtime/package.json         apps/runtime/package.json
COPY apps/search-ai/package.json       apps/search-ai/package.json
COPY apps/search-ai-runtime/package.json apps/search-ai-runtime/package.json
COPY apps/studio/package.json          apps/studio/package.json
COPY apps/academy/package.json       apps/academy/package.json
COPY apps/template-store/package.json apps/template-store/package.json
COPY apps/workflow-engine/package.json apps/workflow-engine/package.json

# Install all dependencies (frozen lockfile for reproducibility)
# MONGOMS_DISABLE_POSTINSTALL prevents mongodb-memory-server from downloading
# MongoDB binaries during postinstall — not needed in production images.
COPY patches/ patches/
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile

# Copy full source for the runtime and its workspace dependencies
COPY scripts/ scripts/
COPY packages/ packages/
COPY apps/runtime/ apps/runtime/

# Build the runtime and all its workspace dependencies (turbo resolves build order)
RUN pnpm turbo build --filter=@agent-platform/runtime

# Prune dev dependencies for a leaner production image
RUN pnpm --filter @agent-platform/runtime deploy --prod /app/pruned

# Prune for seed image — pnpm deploy accepts only one --filter at a time, so
# we run twice and overlay. Database brings mongoose + @clickhouse/client +
# @agent-platform/shared-encryption (needed by seed-mongo.ts). Eventstore brings
# kafkajs + @agent-platform/config (needed by packages/eventstore/seed-kafka.ts).
# `cp -rn` overlays without clobbering, so shared deps keep their first copy.
RUN pnpm --filter @agent-platform/database deploy --prod /app/seed-pruned \
    && pnpm --filter @abl/eventstore deploy --prod /tmp/eventstore-pruned \
    && cp -rn /tmp/eventstore-pruned/node_modules/. /app/seed-pruned/node_modules/ \
    && rm -rf /tmp/eventstore-pruned

# --------------- Stage 2: Production ---------------
FROM gcr.io/distroless/nodejs24-debian13 AS production

ARG GIT_SHA
ARG DEPLOY_ID
ARG DEPLOYMENT_ENVIRONMENT

ENV NODE_ENV=production
ENV PORT=3112
ENV GIT_SHA=${GIT_SHA}
ENV DEPLOY_ID=${DEPLOY_ID}
ENV DEPLOYMENT_ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}

WORKDIR /app

# Copy built artefacts and production node_modules from builder
COPY --from=builder --chown=nonroot:nonroot /app/pruned/dist    ./dist
COPY --from=builder --chown=nonroot:nonroot /app/pruned/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/pruned/package.json ./package.json

USER nonroot

EXPOSE 3112

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:3112/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["dist/index.js"]

# --------------- Stage 3: Debug ---------------
FROM gcr.io/distroless/nodejs24-debian13:debug AS debug

ARG GIT_SHA
ARG DEPLOY_ID
ARG DEPLOYMENT_ENVIRONMENT

ENV NODE_ENV=production
ENV PORT=3112
ENV GIT_SHA=${GIT_SHA}
ENV DEPLOY_ID=${DEPLOY_ID}
ENV DEPLOYMENT_ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}

WORKDIR /app

COPY --from=builder --chown=nonroot:nonroot /app/pruned/dist    ./dist
COPY --from=builder --chown=nonroot:nonroot /app/pruned/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/pruned/package.json ./package.json

USER nonroot

EXPOSE 3112

CMD ["dist/index.js"]

# --------------- Stage 4: Migrate ---------------
# Lean image for running MongoDB migrations as a K8s Job / init-container.
# Runs: acquire distributed lock → apply pending migrations → release lock.
FROM node:24-slim AS migrate

RUN npm install -g tsx

WORKDIR /app

# Pruned database package with only prod node_modules (mongoose)
COPY --from=builder /app/seed-pruned/ ./

# Migration source files (tsx runs .ts directly)
COPY --from=builder /app/packages/database/src/ ./src/

USER node

CMD ["tsx", "src/migrations/cli.ts", "migrate"]

# --------------- Stage 5: Seed ---------------
# Lean image for ArgoCD PreSync hook.
# Runs: Mongo seed + Kafka topic seed.
FROM node:24-slim AS seed

RUN npm install -g tsx

WORKDIR /app

# Pruned node_modules with only database (mongoose, @clickhouse/client) and
# eventstore (kafkajs, @agent-platform/config) prod deps.
COPY --from=builder /app/seed-pruned/ ./

# Source files in repo-matching layout (for import resolution)
COPY --from=builder /app/packages/database/src/ ./packages/database/src/
COPY --from=builder /app/packages/database/seed-mongo.ts ./packages/database/seed-mongo.ts
COPY --from=builder /app/packages/database/seed-examples.ts ./packages/database/seed-examples.ts
COPY --from=builder /app/packages/database/seed-inline-tools.ts ./packages/database/seed-inline-tools.ts
COPY --from=builder /app/packages/database/seed-prompt-templates.ts ./packages/database/seed-prompt-templates.ts
COPY --from=builder /app/packages/database/seed-pipelines.ts ./packages/database/seed-pipelines.ts
COPY --from=builder /app/packages/shared/src/prompts/ ./packages/shared/src/prompts/
COPY --from=builder /app/packages/pipeline-engine/ ./packages/pipeline-engine/
COPY --from=builder /app/packages/eventstore/seed-kafka.ts ./packages/eventstore/seed-kafka.ts
COPY scripts/fixtures/ ./scripts/fixtures/

USER node

CMD ["sh", "-c", "echo '=== Step 1: Seed MongoDB ===' && tsx packages/database/seed-mongo.ts && echo '=== Step 2: Seed Kafka Topics ===' && tsx packages/eventstore/seed-kafka.ts"]

# --------------- Stage 6: Init ---------------
# Combined init-container: runs migrations → seed → RBAC alignment.
# All steps are idempotent — safe to re-run on every deploy.
# Use as a K8s init-container or ArgoCD PreSync hook.
#
# Layout mirrors repo paths so relative imports resolve correctly:
#   /app/packages/database/src/       — models + migrations
#   /app/packages/database/seed-mongo.ts
#   /app/scripts/rbac-tool-permissions.ts — uses raw MongoDB collections
#   /app/packages/database/seed-examples.ts — only used for explicit dev seeding
FROM node:24-slim AS init

RUN npm install -g tsx

WORKDIR /app

# Pruned node_modules with only database (mongoose, @clickhouse/client) and
# eventstore (kafkajs, @agent-platform/config) prod deps.
COPY --from=builder /app/seed-pruned/ ./

# Source files in repo-matching layout (for import resolution)
COPY --from=builder /app/packages/database/src/ ./packages/database/src/
COPY --from=builder /app/packages/database/seed-mongo.ts ./packages/database/seed-mongo.ts
COPY --from=builder /app/packages/database/seed-examples.ts ./packages/database/seed-examples.ts
COPY --from=builder /app/packages/database/seed-inline-tools.ts ./packages/database/seed-inline-tools.ts
COPY --from=builder /app/packages/database/seed-prompt-templates.ts ./packages/database/seed-prompt-templates.ts
COPY --from=builder /app/packages/database/seed-pipelines.ts ./packages/database/seed-pipelines.ts
COPY --from=builder /app/packages/eventstore/seed-kafka.ts ./packages/eventstore/seed-kafka.ts

# Seed support scripts
COPY scripts/rbac-tool-permissions.ts ./scripts/rbac-tool-permissions.ts
COPY scripts/fixtures/ ./scripts/fixtures/

# Prompt catalog (for seed-prompt-templates.ts → PromptCatalog)
COPY --from=builder /app/packages/shared/src/prompts/ ./packages/shared/src/prompts/

# Pipeline engine package (for seed-pipelines.ts → seedPipelines())
COPY --from=builder /app/packages/pipeline-engine/ ./packages/pipeline-engine/

USER node

CMD ["sh", "-c", "echo '=== Step 1: Seed MongoDB ===' && tsx packages/database/seed-mongo.ts && echo '=== Step 2: Seed Kafka Topics ===' && tsx packages/eventstore/seed-kafka.ts && echo '=== Step 3: RBAC Alignment ===' && tsx scripts/rbac-tool-permissions.ts"]
