/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: MongoDB (real or MongoMemoryServer), Redis/BullMQ,
 * OpenSearch, Neo4j, ClickHouse, HTTP supertest, or external APIs.
 * Also excludes tests that use vi.doMock with vi.resetModules() in beforeEach,
 * which requires module-cache isolation (forks pool) to avoid cross-file leakage.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── E2E tests (MongoMemoryServer + HTTP server) ───────────────────────
      'src/__tests__/e2e/**',
      'src/__tests__/search-ai.integration.test.ts',

      // ── Integration tests (real Neo4j, MongoDB, or external services) ─────
      'src/__tests__/integration/**',
      'src/__tests__/pipeline-timing-integration.test.ts', // MongoMemoryServer + forks pool
      'src/__tests__/per-index-config-integration.test.ts',
      'src/__tests__/text-extraction-integration.test.ts',
      'src/__tests__/phase2-integration.test.ts',
      'src/__tests__/visual-enrichment-integration.test.ts',
      'src/__tests__/kg-enrichment-integration.test.ts',
      'src/__tests__/structured-data/structured-data-integration.test.ts',
      'src/__tests__/structured-data/clickhouse-client.integration.test.ts',

      // ── Route tests (supertest / HTTP) ────────────────────────────────────
      // supertest creates real TCP servers — must run in forks pool, not threads
      'src/__tests__/routes/connectors-delta-sync.test.ts',
      'src/__tests__/document-permissions-api.test.ts',
      'src/__tests__/llm-config-api.test.ts',
      'src/__tests__/structured-data/ingest-api.test.ts',
      'src/__tests__/routes/crawl-batch.test.ts',
      'src/routes/__tests__/bull-board.test.ts',
      'src/routes/__tests__/crawl-dashboard.test.ts',
      'src/routes/__tests__/crawl-history.test.ts',
      'src/routes/__tests__/crawl-security.test.ts',
      'src/routes/__tests__/crawl-url-expansion.test.ts',
      'src/routes/__tests__/errors.test.ts',
      'src/routes/__tests__/metrics.test.ts',
      'src/routes/__tests__/queue-monitoring.test.ts',
      'src/routes/__tests__/kg-taxonomy-generate-profile.test.ts',
      'src/routes/__tests__/health-summary.test.ts',
      'src/routes/__tests__/query-history.test.ts',
      'src/routes/__tests__/activity-feed.test.ts',

      // ── BullMQ worker tests (vi.doMock requires forks isolation) ─────────
      'src/__tests__/search-ai-workers.test.ts',
      'src/__tests__/connector-permission-crawl-worker.test.ts',
      'src/__tests__/connector-sync-worker.test.ts',
      'src/__tests__/permission-recrawl-worker.test.ts',
      'src/__tests__/permission-recrawl-scheduler.test.ts',
      'src/__tests__/search-ai-services.test.ts', // vi.resetModules() + vi.doMock in beforeEach
      'src/__tests__/rate-limit-middleware.test.ts', // vi.resetModules() in beforeEach (module-level reset)

      // ── Auth middleware tests (vi.doMock + vi.resetModules in beforeEach) ─
      // These reset module cache per-test and need process isolation (forks).
      'src/__tests__/search-ai-middleware.test.ts',
      'src/__tests__/routes/connectors-auth.test.ts',
      'src/__tests__/routes/connectors-sync.test.ts',

      // ── Connector route tests (vi.doMock requires forks isolation) ──────
      'src/__tests__/routes/connector-monitoring.test.ts',
      'src/__tests__/routes/connector-notifications.test.ts',
      'src/__tests__/routes/connector-error-recovery.test.ts',
      'src/__tests__/routes/connector-utilities.test.ts',
      'src/__tests__/routes/connector-security.test.ts',
      'src/__tests__/routes/connector-content-purge.test.ts',
      'src/__tests__/routes/connector-presence.test.ts',
    ],

    // Keep startup fast with threads, but run files serially. The monorepo
    // turbo test run already parallelizes across packages, and this package's
    // remaining route-level HTTP tests become flaky when multiple workers
    // execute them concurrently.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
