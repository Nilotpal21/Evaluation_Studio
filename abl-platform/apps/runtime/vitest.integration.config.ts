/**
 * Vitest INTEGRATION tier — tests requiring real services or heavy isolation.
 *
 * These tests are excluded from the default `vitest run` and the FAST tier.
 * They require MongoDB (via MongoMemoryServer), Redis, or create real HTTP
 * servers that are sensitive to resource pressure during concurrent runs.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts
 *   pnpm test:integration
 *
 * The `test:flaky` alias reuses this config with explicit file filters.
 *
 * Intended for: CI merge gate (not every push).
 */
import { defineConfig } from 'vitest/config';
import { resolveVitestPathSelection } from './vitest.path-filters';

const defaultInclude = [
  // MongoDB-dependent (MongoMemoryServer)
  'src/__tests__/env-vars-namespace-pagination.test.ts',
  'src/__tests__/sessions/stores.test.ts',
  'src/__tests__/mongo-message-store-scrub.test.ts',
  'src/__tests__/sessions/repos-session.test.ts',
  'src/__tests__/sessions/repos-data.test.ts',
  'src/__tests__/sessions/repos-project.test.ts',
  'src/__tests__/cascade-delete.test.ts',
  'src/__tests__/execution/guardrails/session-policy-inheritance.test.ts',
  'src/__tests__/cold-store-field-parity.integration.test.ts',

  // Redis-dependent
  'src/__tests__/sessions/session-redis.e2e.test.ts',
  'src/__tests__/redis-field-parity.integration.test.ts',

  // Full E2E (multi-service)
  'src/__tests__/integrated.e2e.test.ts',
  'src/__tests__/platform.e2e.test.ts',
  'src/__tests__/agent-search.integration.test.ts',
  'src/__tests__/airlines-search.integration.test.ts',
  'src/__tests__/searchai-kb-agent.integration.test.ts',
  'src/__tests__/escalation-integration.test.ts',
  'src/__tests__/reported-runtime-control-plane.test.ts',
  'src/__tests__/integration/auth-jit-rich-content.test.ts',
  'src/__tests__/integration/observatory-api.integration.test.ts',
  'src/__tests__/auth/auth-profile-tool-executor-integration.test.ts',
  'src/__tests__/auth/kms-per-tenant-integration.test.ts',
  'src/__tests__/channels/email-channel.integration.test.ts',
  'src/__tests__/channels/voice-config-integration.test.ts',
  'src/__tests__/channels/voice-filler-integration.test.ts',
  'src/__tests__/execution/contexts/identity/delivery-integration.test.ts',
  'src/__tests__/execution/contexts/identity/identity-concurrency-integration.test.ts',
  'src/__tests__/execution/contexts/identity/identity-redis-integration.test.ts',
  'src/__tests__/execution/event-bus/integration.test.ts',
  'src/__tests__/execution/execution-model-integration.test.ts',
  'src/__tests__/execution/executor-integration.test.ts',
  'src/__tests__/execution/flow-step-thoughts-integration.test.ts',
  'src/__tests__/execution/guardrails/runtime-integration.test.ts',
  'src/__tests__/execution/ablp-930-supervisor-tool-call-routing.integration.test.ts',
  'src/__tests__/execution/thread-resume-integration.test.ts',
  'src/__tests__/project-runtime-config-resolver.integration.test.ts',
  'src/__tests__/routing/supervisor-tool-call-routing.integration.test.ts',

  'src/__tests__/stress/runtime-e2e-persistence.test.ts',

  // Auth JIT multichannel E2E (MongoMemoryServer)
  'src/__tests__/integration/auth-jit-multichannel.test.ts',

  // Observatory API E2E (MongoMemoryServer + RuntimeApiHarness)
  'src/__tests__/integration/observatory-api-e2e.test.ts',

  // Omnichannel integration (MongoMemoryServer)
  'src/__tests__/channels/omnichannel-identity-linking.integration.test.ts',
  'src/__tests__/channels/omnichannel-recall-service.integration.test.ts',

  // ABLP-1229: LLM error classification cross-component composition (no Mongo/Redis)
  'src/__tests__/llm-error-classification.integration.test.ts',

  // ABLP-674: AWS Bedrock provider (nock HTTP interception; no MongoDB required)
  'src/__tests__/bedrock-integration.test.ts',

  // ABLP-674: AWS Bedrock E2E (RuntimeApiHarness + nock)
  'src/__tests__/bedrock-e2e.test.ts',

  // Governance contract tests (RuntimeApiHarness + MongoMemoryServer)
  'src/__tests__/contracts/governance-policies.contract.test.ts',

  // Governance E2E tests (RuntimeApiHarness + real local ClickHouse at localhost:8124)
  'src/__tests__/governance-e2e.test.ts',

  // Agentic compat callback worker (real HTTP sink, no Mongo)
  'src/__tests__/integration/agent-assist-callback-worker.int.test.ts',
  'src/__tests__/integration/agent-assist-binding-repo.int.test.ts',

  // Covered by the dedicated isolated lane to avoid duplicate merge-gate work.
  // See `pnpm test:flaky` / `pnpm run test:regression:isolated`.
];
const selection = resolveVitestPathSelection(defaultInclude);

export default defineConfig({
  test: {
    exclude: selection.exclude,
    include: selection.include,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
