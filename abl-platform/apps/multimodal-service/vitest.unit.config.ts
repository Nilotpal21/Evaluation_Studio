/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: Express app lifecycle / supertest HTTP server.
 * All other tests mock their dependencies (DB, ClamAV, Tika, ffmpeg, BullMQ)
 * and run safely without any infra running.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── HTTP server / supertest ───────────────────────────────────────
      'src/__tests__/attachment-routes.test.ts',
      'src/__tests__/attachment-rate-limit.test.ts',

      // ── Real MongoDB + detectPII pipeline integration ────────────────
      'src/__tests__/pii-pipeline-integration.test.ts',
    ],
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
