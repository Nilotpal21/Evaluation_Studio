export const runtimeVitestInclude = ['src/**/*.test.ts', 'src/**/*.test.tsx'];

export const runtimeDefaultTestExcludes = [
  'dist/**',
  'node_modules/**',
  // Reproduction suites document known failures and run only in test:repro.
  'src/**/*.repro.test.ts',
  'src/**/*.repro.test.tsx',
  // Cluster-mode integration suites — require docker-compose.cluster.yml
  // up. Run via `pnpm test:cluster` or `pnpm test:smart` (which auto-detects).
  'src/__tests__/**/*.cluster.test.ts',
  'src/__tests__/stress/runtime-channel-stress.test.ts',
  // Generic full-regression tiers that run via dedicated lane configs.
  'src/__tests__/**/*e2e*.test.ts',
  'src/__tests__/**/*.integration.test.ts',
  'src/__tests__/**/*-integration.test.ts',
  'src/__tests__/**/integration.test.ts',
  'src/__tests__/integration/**',
  // MongoDB integration / e2e tests — require MongoMemoryServer binary.
  // Run separately with: npx vitest run --config vitest.integration.config.ts
  'src/__tests__/env-vars-namespace-pagination.test.ts',
  'src/__tests__/integrated.e2e.test.ts',
  'src/__tests__/platform.e2e.test.ts',
  'src/__tests__/sessions/stores.test.ts',
  'src/__tests__/agent-search.integration.test.ts',
  'src/__tests__/airlines-search.integration.test.ts',
  'src/__tests__/searchai-kb-agent.integration.test.ts',
  'src/__tests__/stress/runtime-e2e-persistence.test.ts',
  'src/__tests__/sessions/repos-session.test.ts',
  'src/__tests__/sessions/repos-data.test.ts',
  'src/__tests__/sessions/repos-project.test.ts',
  'src/__tests__/cascade-delete.test.ts',
  'src/__tests__/sessions/session-redis.e2e.test.ts',
  // Real LLM e2e test — requires a valid ANTHROPIC_API_KEY making live API calls.
  // Run separately with: npx vitest run src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts
  'src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts',
  // Ordering-dependent flaky tests — pass in isolation but fail under concurrent
  // turbo execution (pnpm turbo test) due to resource exhaustion when the full
  // monorepo test suite spawns hundreds of forked processes simultaneously.
  // The HTTP-server-based route tests (chat-routes, session-routes, user-isolation.integration)
  // are especially sensitive to resource pressure during concurrent runs.
  // Run separately with: pnpm test:flaky
  'src/__tests__/sessions/session-service.test.ts',
  'src/__tests__/sessions/session-ttl-dynamic.test.ts',
  'src/__tests__/sessions/chat-routes.test.ts',
  'src/__tests__/sessions/session-routes.test.ts',
  'src/__tests__/auth/user-isolation.integration.test.ts',
  'src/__tests__/llm-queue-distributed.test.ts',
  'src/__tests__/redis-connection-cleanup.test.ts',
  // Additional isolated-pass suites that become flaky only under the full
  // monorepo concurrent test run. Keep them out of the default gate and
  // cover them via pnpm test:flaky.
  'src/__tests__/agent-transfer-webhooks.test.ts',
  'src/__tests__/platform-admin-deals.test.ts',
  'src/routes/__tests__/platform-admin-models.test.ts',
  'src/__tests__/routes/tenant-usage.openapi-contract.test.ts',
  'src/__tests__/runtime-lifecycle.test.ts',
  'src/__tests__/channels/korevg-router.test.ts',
  // Additional Mongo / harness-backed integration suites — run in dedicated tiers
  'src/__tests__/mongo-message-store-scrub.test.ts',
  'src/__tests__/execution/guardrails/session-policy-inheritance.test.ts',
  'src/__tests__/escalation-integration.test.ts',
  'src/__tests__/reported-runtime-control-plane.test.ts',
  'src/__tests__/integration/auth-jit-rich-content.test.ts',
  'src/__tests__/integration/observatory-api.integration.test.ts',
  'src/__tests__/import-idempotent.e2e.test.ts',
  'src/__tests__/tools-crud.e2e.test.ts',
  'src/__tests__/channels/http-async-identity-continuity.e2e.test.ts',
  'src/__tests__/channels/omnichannel-identity-linking.integration.test.ts',
  'src/__tests__/channels/omnichannel-recall-service.integration.test.ts',
  // LiveKit voice adapter coverage — expensive because it compiles the full
  // TravelDesk graph. Keep it out of the merge gate and run via:
  //   pnpm test:voice:integration
  'src/__tests__/channels/livekit-voice.integration.test.ts',
  // Standalone benchmark script (not a vitest test suite)
  'src/__tests__/pipeline-comparison.test.ts',
  // SearchAI E2E tests — require MongoMemoryServer + SearchAI service infrastructure.
  // Run separately with: npx vitest run src/__tests__/integration/searchai/
  'src/__tests__/integration/searchai/**',
  // Long-running benchmark / load suites — keep them out of the default
  // monorepo gate and run them in the explicit slow lane:
  //   pnpm test:stress
  'src/__tests__/stress/high-throughput-stress.test.ts',
  'src/__tests__/stress/runtime-load.test.ts',
  // AFG Blue Advisory E2E — LLM-dependent, assertions on model output are inherently flaky.
  // Run separately with: pnpm test:afg-e2e
  'src/__tests__/integration/afg-blue-advisory/**',
  // Auth JIT multichannel E2E — requires MongoMemoryServer binary.
  // Run separately with: npx vitest run --config vitest.integration.config.ts
  'src/__tests__/integration/auth-jit-multichannel.test.ts',
  // Five9 E2E tests — require AGENT_TRANSFER_E2E=1 and Redis.
  // Run separately with: AGENT_TRANSFER_E2E=1 npx vitest run src/__tests__/five9-webhook.e2e.test.ts src/__tests__/five9-transfer.e2e.test.ts
  'src/__tests__/five9-webhook.e2e.test.ts',
  'src/__tests__/five9-transfer.e2e.test.ts',
  // Observatory API E2E — requires MongoMemoryServer + RuntimeApiHarness.
  // Run separately with: npx vitest run --config vitest.integration.config.ts
  'src/__tests__/integration/observatory-api-e2e.test.ts',
  // Redis-dependent channel E2E tests — require redis-server or REDIS_URL sidecar.
  // Run separately with: npx vitest run --config vitest.e2e.config.ts
  'src/__tests__/channels/webhooks/channel-webhooks-route.test.ts',
  'src/__tests__/channels/channels-slack-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-telegram-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-twilio-runtime.e2e.test.ts',
  // Connector E2E tests — require MongoMemoryServer + connector infrastructure.
  // Run separately with: pnpm test:connector-e2e
  'src/__tests__/connector-connection-crud.e2e.test.ts',
  'src/__tests__/connector-oauth-flow.e2e.test.ts',
  'src/__tests__/connector-trigger-lifecycle.e2e.test.ts',
  'src/__tests__/connector-tool-execution.e2e.test.ts',
  // RuntimeApiHarness-based E2E tests — MongoMemoryServer resource contention
  // causes timeout failures when 30+ instances run in parallel.
  // Run sequentially with: npx vitest run --config vitest.e2e.config.ts
  'src/__tests__/tools-deployment/attachment-advanced.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-config.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-pii.e2e.test.ts',
  'src/__tests__/tools-deployment/attachment-tools.e2e.test.ts',
  'src/__tests__/channels/channels-control-plane.e2e.test.ts',
  'src/__tests__/channels/channels-sdk-runtime.e2e.test.ts',
  'src/__tests__/channels/channels-voice-ingress.e2e.test.ts',
  'src/__tests__/channels/channels-web-debug-runtime.e2e.test.ts',
  'src/__tests__/channels/omnichannel-cross-channel.e2e.test.ts',
  'src/__tests__/channels/omnichannel-identity-verification.e2e.test.ts',
  'src/__tests__/channels/omnichannel-live-session.e2e.test.ts',
  'src/__tests__/channels/omnichannel-privacy-gates.e2e.test.ts',
  'src/__tests__/channels/omnichannel-recall.e2e.test.ts',
  'src/__tests__/pipeline-config.e2e.test.ts',
  'src/__tests__/tools-deployment/deployment-pipeline.e2e.test.ts',
  'src/__tests__/escalation.e2e.test.ts',
  'src/__tests__/thoughts-status-ws.e2e.test.ts',
  'src/__tests__/concurrent-execution.e2e.test.ts',
  'src/__tests__/traveldesk.e2e.test.ts',
  'src/__tests__/hotel-booking.e2e.test.ts',
  'src/__tests__/multi-agent-orchestration.e2e.test.ts',
  'src/__tests__/e2e/child-routing-authority.e2e.test.ts',
  'src/__tests__/e2e/lookup-data-crud.e2e.test.ts',
  'src/__tests__/e2e/routing-phase5.e2e.test.ts',
  'src/__tests__/new-features.e2e.test.ts',
  'src/__tests__/action-handlers.e2e.test.ts',
  'src/__tests__/agent-on-error.e2e.test.ts',
  'src/__tests__/guardrail-edge-cases.e2e.test.ts',
  'src/__tests__/hooks-lifecycle.e2e.test.ts',
  'src/__tests__/behavior-profile.e2e.test.ts',
  'src/__tests__/behavior-profiles.e2e.test.ts',
  'src/__tests__/tools-deployment/module-concurrency.e2e.test.ts',
  'src/__tests__/tools-deployment/module-cutover-safety.e2e.test.ts',
  'src/__tests__/tools-deployment/module-lifecycle.e2e.test.ts',
  'src/__tests__/tools-deployment/module-preview.e2e.test.ts',
  'src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts',
  'src/__tests__/tools-deployment/module-runtime-provenance.e2e.test.ts',
  'src/__tests__/tools-deployment/module-upgrade-lifecycle.e2e.test.ts',
  'src/__tests__/channels/voice-e2e-caller-audio-route.test.ts',
  'src/__tests__/channels/voice-ir-resolution.e2e.test.ts',
  // Model Hub E2E — MongoMemoryServer-based, run via vitest.e2e.config.ts
  'src/__tests__/model-hub-provisioning.e2e.test.ts',
  'src/__tests__/model-hub-isolation.e2e.test.ts',
  'src/__tests__/model-hub-overrides.e2e.test.ts',
  'src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts',
  'src/__tests__/auth/sdk-verified-continuity.integration.test.ts',
  'src/__tests__/tools-deployment/attachment-config-validation.test.ts',
  // Additional RuntimeApiHarness/MongoMemoryServer suites — stable in the
  // dedicated serialized E2E tier, but prone to hook timeouts under the
  // default concurrent monorepo test pass.
  'src/__tests__/on-start-session-idempotency.e2e.test.ts',
  'src/__tests__/execution/guardrails/policy-routes.test.ts',
  'src/__tests__/execution/guardrails/provider-routes.test.ts',
  'src/__tests__/tools-deployment/attachment-config-validation.test.ts',
  // Live voice E2E — requires real Twilio credentials.
  'src/__tests__/channels/voice-pipeline-twilio.live.e2e.test.ts',
  // Process API E2E — MongoMemoryServer-backed, prone to hook timeouts and
  // connection-pool exhaustion under concurrent monorepo test runs.
  // Run serialized via vitest.e2e.config.ts.
  'src/__tests__/process-api.e2e.test.ts',
  'src/__tests__/process-api-auth.e2e.test.ts',
  // Billing / session / auth-profile / voice-pipeline integration suites —
  // MongoMemoryServer-backed, hit hook timeouts under concurrent load.
  // Pass in isolation. Run serialized via vitest.e2e.config.ts.
  'src/__tests__/billing-session-assessment-service.integration.test.ts',
  'src/__tests__/billing-usage-materialization-scheduler-service.integration.test.ts',
  'src/__tests__/session-runtime-timeouts.integration.test.ts',
  'src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts',
  'src/__tests__/integration/auth-profile-route-validation.test.ts',
  'src/__tests__/session-terminalization.e2e.test.ts',
];
