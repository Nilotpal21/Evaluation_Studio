/**
 * Vitest FAST tier — pure unit tests only.
 *
 * Uses `pool: 'threads'` to share the V8 module cache across test files,
 * eliminating the ~127s import overhead that `pool: 'forks'` incurs with 270 files.
 *
 * Excludes tests that need fork-level isolation:
 *   - Integration / e2e / stress (real DB, Redis, HTTP servers)
 *   - Authz tests (complex Express middleware + supertest)
 *   - Route tests (supertest, Express app lifecycle)
 *   - WebSocket handler tests (ws lifecycle)
 *   - Context domain tests (mixed complexity)
 *   - Deployment tests (complex mock chains)
 *
 * Run with:
 *   npx vitest run --config vitest.fast.config.ts
 *   pnpm test:fast       # PR / pre-push unit lane
 *   pnpm test:fast:all   # unit lane + serialized hotspots shard
 *
 * Target: <30s wall-clock (vs ~155s for the full forks-based suite).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { coverageHotspotSuites } from './vitest.coverage.suites';

const FAST_CONFIG_DIR = new URL('.', import.meta.url);
const FAST_INFRA_EXCLUDE_MARKERS = [
  /from ['"]supertest['"]/,
  /require\(['"]supertest['"]\)/,
  /from ['"]express['"]/,
  /require\(['"]express['"]\)/,
  /\bsetupTestMongo\b/,
  /\bteardownTestMongo\b/,
  /\bclearCollections\b/,
  /mongodb-memory-server/,
  /\bmongoose\b/,
  /from ['"]ws['"]/,
  /new WebSocket\b/,
  /\bWebSocketServer\b/,
  /server\.listen\(/,
  /\bcreateServer\(/,
  /from ['"]http['"]/,
  /from ['"]node:http['"]/,
];

function collectTestFiles(directoryUrl: URL): string[] {
  const directoryPath = directoryUrl.pathname;
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryUrl = new URL(entry.name, directoryUrl);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(new URL(`${entry.name}/`, directoryUrl)));
      continue;
    }

    if (entry.isFile() && /\.(test)\.tsx?$/.test(entry.name)) {
      files.push(entryUrl.pathname);
    }
  }

  return files;
}

function toPosixRelativePath(filePath: string): string {
  return relative(new URL('.', FAST_CONFIG_DIR).pathname, filePath).replaceAll('\\', '/');
}

const fastInfraDependentSuites = collectTestFiles(new URL('./src/', import.meta.url))
  .filter((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    return FAST_INFRA_EXCLUDE_MARKERS.some((pattern) => pattern.test(source));
  })
  .map(toPosixRelativePath);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [
      'dist/**',
      'node_modules/**',
      'src/**/*.repro.test.ts',
      'src/**/*.repro.test.tsx',

      // ── Integration / E2E / Stress (convention-based) ──────────────────
      'src/__tests__/stress/**',
      'src/__tests__/*e2e*',
      'src/__tests__/**/*e2e*',
      'src/__tests__/**/*.integration.test.ts',
      'src/__tests__/integration/**',
      'src/__tests__/integrated.e2e.test.ts',
      'src/__tests__/platform.e2e.test.ts',
      'src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts',
      'src/__tests__/env-vars.integration.test.ts',
      'src/__tests__/channels/email-channel.integration.test.ts',

      // ── MongoDB / Redis dependent ─────────────────────────────────────
      'src/__tests__/sessions/stores.test.ts',
      'src/__tests__/mongo-message-store-scrub.test.ts',
      'src/__tests__/sessions/repos-*.test.ts',
      'src/__tests__/cascade-delete.test.ts',
      'src/__tests__/sessions/session-redis.e2e.test.ts',
      'src/__tests__/agent-search.integration.test.ts',
      'src/__tests__/airlines-search.integration.test.ts',
      'src/__tests__/searchai-kb-agent.integration.test.ts',
      'src/__tests__/tools-deployment/module-preview.integration.test.ts',
      'src/__tests__/channels/livekit-voice.integration.test.ts',

      // ── Flaky under resource pressure ─────────────────────────────────
      'src/__tests__/sessions/session-service.test.ts',
      'src/__tests__/sessions/session-ttl-dynamic.test.ts',
      'src/__tests__/sessions/chat-routes.test.ts',
      'src/__tests__/sessions/session-routes.test.ts',
      'src/__tests__/auth/user-isolation.integration.test.ts',
      'src/__tests__/llm-queue-distributed.test.ts',
      'src/__tests__/redis-connection-cleanup.test.ts',

      // ── Authz tests (Express middleware chains + supertest) ────────────
      'src/__tests__/*-authz*.test.ts',
      'src/__tests__/**/*-authz*.test.ts',

      // ── Route / HTTP handler tests (supertest, Express app) ───────────
      'src/__tests__/*-routes*.test.ts',
      'src/__tests__/**/*-routes*.test.ts',
      'src/__tests__/*-route.test.ts',
      'src/__tests__/**/*-route.test.ts',
      'src/__tests__/agent-transfer-webhook*.test.ts',
      'src/__tests__/platform-admin-*.test.ts',
      'src/__tests__/slack-*.test.ts',
      'src/__tests__/callback-*.test.ts',
      'src/__tests__/kms-admin-*.test.ts',
      'src/__tests__/auth/kms-admin-*.test.ts',
      'src/__tests__/channels/email/feedback-endpoint.test.ts',
      'src/routes/__tests__/**', // co-located route tests (supertest)

      // ── WebSocket tests (ws lifecycle, handler state) ─────────────────
      'src/__tests__/ws-*.test.ts',
      'src/__tests__/channels/ws-*.test.ts',
      'src/__tests__/websocket-*.test.ts',
      'src/__tests__/channels/websocket-*.test.ts',

      // ── Context domain tests (mixed complexity, fork isolation) ───────
      'src/__tests__/execution/contexts/**',

      // ── Heavy integration / wiring (deep cross-module mock chains) ────
      'src/__tests__/wiring.test.ts',
      'src/__tests__/llm-wiring.test.ts',
      'src/__tests__/model-resolution-comprehensive.test.ts',
      'src/__tests__/debug_llm.test.ts',
      'src/__tests__/debug_llm2.test.ts',
      'src/__tests__/agent-transfer-boot.test.ts',

      // ── Queue / worker tests (BullMQ singleton mocking) ───────────────
      'src/__tests__/inbound-worker*.test.ts',
      'src/__tests__/message-persistence-queue-full.test.ts',

      // ── LLM provider integration tests ────────────────────────────────
      'src/__tests__/llm-integration.test.ts',
      'src/__tests__/llm-services.test.ts',

      // ── Session lifecycle tests (complex state management) ────────────
      'src/__tests__/sessions/session-rehydration.test.ts',

      // ── Livekit (30s timeout test dominates wall-clock) ────────────────
      'src/__tests__/channels/livekit-llm-adapter.test.ts',

      // ── Email / channel infrastructure ────────────────────────────────
      'src/__tests__/channels/email-smtp-server.test.ts',

      // ── Deployment tests (complex mock chains) ────────────────────────
      'src/__tests__/tools-deployment/deployment-*.test.ts',

      // ── Benchmark / comparison tests (require real API keys + services) ─
      'src/__tests__/pipeline-comparison.test.ts',

      // ── KMS reencryption queue (flaky timeout under thread pool) ──────
      'src/services/kms/__tests__/reencryption-queue.test.ts',

      // ── Dedicated fast-tier hotspots shard (serialized forks pool) ────
      ...coverageHotspotSuites,

      // ── External-agent registry lane ──────────────────────────────────
      // Keep the pure contract suite in its own lane and keep the HTTP/Mongo
      // integration suite out of the broad threads unit lane.
      'src/__tests__/external-agent-registry-resolution.test.ts',
      'src/__tests__/external-agents-integration.test.ts',

      // ── Infra-backed tests (HTTP/WS/Mongo harnesses) ───────────────────
      // Keep push-time fast tests focused on pure unit logic. These suites
      // still run in the dedicated runtime regression lane.
      ...fastInfraDependentSuites,
    ],

    // Threads pool: share module cache across files — fast startup.
    // Timeouts are generous to handle resource contention when all packages
    // run in parallel under the pre-push Turbo pipeline (import phase can
    // inflate to 900 s under load vs ~300 s in isolation).
    pool: 'threads',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 2,
  },
});
