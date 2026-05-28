/**
 * Vitest FORKS tier — tests that need process isolation but no external services.
 *
 * These tests are excluded from the threads-pool unit config because they use
 * `vi.doMock`, `vi.resetModules()`, or `supertest` HTTP servers — patterns that
 * require per-process module-cache isolation (pool: 'forks').
 *
 * Does NOT include tests requiring real MongoDB, Redis, OpenSearch, Neo4j, or
 * ClickHouse (those remain in the full `vitest.config.ts` suite).
 *
 * Run with:
 *   npx vitest run --config vitest.forks.config.ts
 *   pnpm test:forks
 *
 * Target: moderate wall-clock time vs. full suite.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      // ── Route tests (supertest / HTTP — real TCP server, no external DB) ──
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
      'src/routes/__tests__/knowledge-bases.test.ts',
      'src/routes/__tests__/health-summary.test.ts',
      'src/routes/__tests__/documents-status.test.ts',
      'src/routes/__tests__/query-history.test.ts',
      'src/routes/__tests__/activity-feed.test.ts',
      'src/__tests__/routes/connector-audit.test.ts',
      'src/__tests__/routes/connector-config-versions.test.ts',
      'src/__tests__/routes/connector-proposal.test.ts',
      'src/__tests__/routes/connectors-name-check.test.ts',

      // ── BullMQ worker tests (vi.doMock requires forks isolation) ──────────
      'src/__tests__/search-ai-workers.test.ts',
      'src/__tests__/connector-permission-crawl-worker.test.ts',
      'src/__tests__/connector-sync-worker.test.ts',
      'src/__tests__/permission-recrawl-worker.test.ts',
      'src/__tests__/permission-recrawl-scheduler.test.ts',
      'src/__tests__/search-ai-services.test.ts',
      'src/__tests__/rate-limit-middleware.test.ts',

      // ── Auth middleware tests (vi.doMock + vi.resetModules in beforeEach) ─
      'src/__tests__/search-ai-middleware.test.ts',
      'src/__tests__/routes/connectors-auth.test.ts',
      'src/__tests__/routes/connectors-sync.test.ts',

      // ── E2E tests (MongoMemoryServer + supertest — no external services) ──
      'src/__tests__/e2e/connector-discovery-sync.e2e.test.ts',

      // ── Connector route tests (vi.doMock — service-level mocks) ─────────
      'src/__tests__/routes/connector-monitoring.test.ts',
      'src/__tests__/routes/connector-notifications.test.ts',
      'src/__tests__/routes/connector-error-recovery.test.ts',
      'src/__tests__/routes/connector-utilities.test.ts',
      'src/__tests__/routes/connector-security.test.ts',
      'src/__tests__/routes/connector-content-purge.test.ts',
      'src/__tests__/routes/connector-presence.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],

    // Forks pool: process-level isolation — required for vi.doMock/vi.resetModules
    // and supertest HTTP server lifecycle.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
