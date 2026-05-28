/**
 * Vitest E2E tier — RuntimeApiHarness-based tests that spin up MongoMemoryServer.
 *
 * These tests are excluded from the default `vitest run` because running 30+
 * MongoMemoryServer instances in parallel causes resource contention and
 * timeout failures.  This config runs them sequentially (`maxWorkers: 1`)
 * with generous timeouts.
 *
 * Run with:
 *   npx vitest run --config vitest.e2e.config.ts
 *   pnpm test:e2e
 *
 * Specialty aliases (`test:sdk-auth`, `test:connector-e2e`, `test:afg-e2e`)
 * also reuse this config with explicit file filters.
 */
import { defineConfig } from 'vitest/config';
import { resolveVitestPathSelection } from './vitest.path-filters';

const defaultInclude = [
  // Attachment E2E
  'src/__tests__/tools-deployment/attachment-advanced.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-config.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-pii.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-tools.e2e.test.ts',

  // Channel E2E
  'src/__tests__/channels/channels-control-plane.e2e.test.ts',
  'src/__tests__/channels/channels-sdk-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-slack-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-telegram-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-twilio-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-voice-ingress.e2e.test.ts',
  'src/__tests__/channels/channels-web-debug-runtime.e2e.test.ts',
  'src/__tests__/channels/http-async-identity-continuity.e2e.test.ts',
  'src/__tests__/channels/slack-attachment-webhook.e2e.test.ts',
  'src/__tests__/channels/ws-sdk-interaction-context.e2e.test.ts',
  'src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts',
  'src/__tests__/channels/teams-interaction-context.e2e.test.ts',
  'src/__tests__/channels/webhooks/channel-webhooks-route.test.ts',

  // Omnichannel E2E
  'src/__tests__/channels/omnichannel-cross-channel.e2e.test.ts',
  'src/__tests__/channels/omnichannel-identity-verification.e2e.test.ts',
  'src/__tests__/channels/omnichannel-live-session.e2e.test.ts',
  'src/__tests__/channels/omnichannel-privacy-gates.e2e.test.ts',
  'src/__tests__/channels/omnichannel-recall.e2e.test.ts',

  // Pipeline / deployment E2E
  'src/__tests__/pipeline-config.e2e.test.ts',
  'src/__tests__/tools-deployment/deployment-pipeline.e2e.test.ts',

  // Execution E2E
  'src/__tests__/escalation.e2e.test.ts',
  // RuntimeApiHarness-backed session/guardrail route suites that time out
  // under the default concurrent unit-tier run.
  'src/__tests__/on-start-session-idempotency.e2e.test.ts',
  'src/__tests__/thoughts-status-ws.e2e.test.ts',
  'src/__tests__/concurrent-execution.e2e.test.ts',
  'src/__tests__/traveldesk.e2e.test.ts',
  'src/__tests__/hotel-booking.e2e.test.ts',
  'src/__tests__/multi-agent-orchestration.e2e.test.ts',
  'src/__tests__/execution/gather-interrupt.e2e.test.ts',
  'src/__tests__/execution/gather-interrupt-authz.e2e.test.ts',
  'src/__tests__/execution/gather-interrupt-sdk.e2e.test.ts',
  'src/__tests__/e2e/ablp-930-acceptance.e2e.test.ts',
  'src/__tests__/e2e/child-routing-authority.e2e.test.ts',
  'src/__tests__/e2e/lookup-data-crud.e2e.test.ts',
  'src/__tests__/e2e/localized-interaction-context-chat.e2e.test.ts',
  'src/__tests__/e2e/routing-phase5.e2e.test.ts',
  'src/__tests__/new-features.e2e.test.ts',
  'src/__tests__/action-handlers.e2e.test.ts',
  'src/__tests__/agent-on-error.e2e.test.ts',
  'src/__tests__/guardrail-edge-cases.e2e.test.ts',
  'src/__tests__/hooks-lifecycle.e2e.test.ts',
  'src/__tests__/behavior-profile.e2e.test.ts',
  'src/__tests__/behavior-profiles.e2e.test.ts',
  'src/__tests__/import-idempotent.e2e.test.ts',
  'src/__tests__/tools-crud.e2e.test.ts',
  'src/__tests__/execution/guardrails/policy-routes.test.ts',
  'src/__tests__/execution/guardrails/provider-routes.test.ts',
  'src/__tests__/execution/contexts/integration/identity.e2e.test.ts',

  // Module E2E
  'src/__tests__/tools-deployment/module-concurrency.e2e.test.ts',
  'src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts',
  'src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts',
  'src/__tests__/tools-deployment/module-preview.e2e.test.ts',
  'src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts',
  'src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts',
  'src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts',

  // Model Hub E2E
  'src/__tests__/model-hub-provisioning.e2e.test.ts',
  'src/__tests__/model-hub-isolation.e2e.test.ts',
  'src/__tests__/model-hub-overrides.e2e.test.ts',

  // Voice E2E (non-LiveKit)
  'src/__tests__/channels/korevg-grok-handoff.e2e.test.ts',
  'src/__tests__/channels/voice-e2e-caller-audio-route.test.ts',
  'src/__tests__/channels/voice-ir-resolution.e2e.test.ts',

  // SDK integration
  'src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts',
  'src/__tests__/auth/sdk-verified-continuity.integration.test.ts',

  // Attachment config validation (MongoMemoryServer)
  'src/__tests__/tools-deployment/attachment-config-validation.test.ts',

  // Process API E2E (MongoMemoryServer + fake workflow-engine)
  'src/__tests__/process-api.e2e.test.ts',
  'src/__tests__/process-api-auth.e2e.test.ts',

  // Workflows Execute API E2E (MongoMemoryServer + fake workflow-engine)
  'src/__tests__/workflows-execute.e2e.test.ts',

  // Billing / session / auth-profile / voice-pipeline integration suites —
  // MongoMemoryServer-backed, moved here from the default tier because they
  // hit hook timeouts under concurrent monorepo test runs.
  'src/__tests__/billing-session-assessment-service.integration.test.ts',
  'src/__tests__/billing-usage-materialization-scheduler-service.integration.test.ts',
  'src/__tests__/session-runtime-timeouts.integration.test.ts',
  'src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts',
  'src/__tests__/integration/auth-profile-route-validation.test.ts',
  'src/__tests__/session-terminalization.e2e.test.ts',
  'src/__tests__/agent-transfer-session-terminalization.e2e.test.ts',

  // Workflow E2E (MongoMemoryServer + RuntimeApiHarness)
  'src/__tests__/e2e/workflows/workflow-crud.e2e.test.ts',
  'src/__tests__/e2e/workflows/workflow-human-task-resolve.e2e.test.ts',
  'src/__tests__/e2e/workflows/workflow-proxy-admin.e2e.test.ts',
  'src/__tests__/e2e/workflows/workflow-proxy-execution.e2e.test.ts',
  'src/__tests__/e2e/workflows/workflow-proxy-triggers.e2e.test.ts',

  // LLM error classification E2E (ABLP-1229)
  'src/__tests__/e2e/llm-error-classification.e2e.test.ts',

  // PII vault boundary contract E2E (ABLP-535)
  'src/__tests__/e2e/pii-vault-boundary.e2e.test.ts',

  // PII detection tiered recognizers (ABLP-921)
  'src/__tests__/e2e/pii-config-validation.e2e.test.ts',
  'src/__tests__/e2e/pii-cross-project-isolation.e2e.test.ts',
  'src/__tests__/e2e/pii-pack-eu.e2e.test.ts',
  'src/__tests__/e2e/pii-confidence-threshold.e2e.test.ts',
  'src/__tests__/e2e/pii-tier-mid-session.e2e.test.ts',
  'src/__tests__/e2e/pii-pack-and-custom-pattern-coexist.e2e.test.ts',
  'src/__tests__/e2e/pii-custom-pattern-survives-pack-disable.e2e.test.ts',

  // Guardrails Sensitive Data Block E2E (ABLP-723)
  'src/__tests__/e2e/sensitive-data-block.e2e.test.ts',

  // Guardrails Sensitive Data Block integration (ABLP-723)
  'src/__tests__/integration/guardrails/failmode-default.test.ts',
  'src/__tests__/integration/guardrails/auto-deactivation-race.test.ts',
  'src/__tests__/integration/guardrails/entity-filter.test.ts',
  'src/__tests__/integration/guardrails/action-message-sanitization.test.ts',

  // PII entity catalog integration (INT-3 + INT-5)
  'src/__tests__/integration/guardrails/pii-entities-catalog.test.ts',

  // Sensitive Data Block entity catalog E2E (E2E-5, E2E-6, E2E-15)
  'src/__tests__/e2e/sensitive-data-block-catalog.e2e.test.ts',

  // Sensitive Data Block tenant-scope + API-bypass E2E (E2E-9, E2E-11, E2E-12)
  'src/__tests__/e2e/sensitive-data-block-tenant-scope.e2e.test.ts',
  'src/__tests__/e2e/sensitive-data-block-api-bypass.e2e.test.ts',
];
const selection = resolveVitestPathSelection(defaultInclude);

export default defineConfig({
  test: {
    exclude: selection.exclude,
    include: selection.include,
    pool: 'forks',
    // Sequential execution — only 1 file at a time to avoid MongoMemoryServer
    // resource contention that causes timeout failures.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
