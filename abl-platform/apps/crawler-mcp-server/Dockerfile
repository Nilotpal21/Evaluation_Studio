# Multi-stage Dockerfile for MCP Crawler Server

FROM node:24-bookworm-slim AS base

# Upgrade OS packages to pick up security patches (libc, libcap2, etc.)
# then install Playwright dependencies
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    libappindicator3-1 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable pnpm

WORKDIR /app

# ============================================================================
# Dependencies Stage
# ============================================================================
FROM base AS deps

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN pnpm install --no-frozen-lockfile

# Install Playwright browsers
RUN pnpm exec playwright install chromium

# ============================================================================
# Builder Stage
# ============================================================================
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build TypeScript
RUN pnpm build

# ============================================================================
# Production Dependencies Stage
# ============================================================================
FROM base AS prod-deps

COPY package.json ./
RUN pnpm install --no-frozen-lockfile --prod

# ============================================================================
# Runner Stage
# ============================================================================
FROM base AS runner

ENV NODE_ENV=production
ENV HEADLESS=true

# Copy built application and production-only dependencies
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy Playwright browsers from deps stage
COPY --from=deps /ms-playwright /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Remove npm/yarn shipped with base image (not needed at runtime, eliminates CVEs)
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-v*

# Create non-root user
RUN groupadd -r crawler && useradd -r -g crawler crawler
RUN chown -R crawler:crawler /app
USER crawler

EXPOSE 3100

CMD ["node", "dist/index.js"]
