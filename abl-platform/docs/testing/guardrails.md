# Feature Test Guide: Guardrails

**Feature**: Guardrails -- multi-tier content safety pipeline for agent inputs, outputs, tool calls, and handoffs
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/guardrails.md](../features/guardrails.md)
**First tested**: 2026-03-09
**Last updated**: 2026-03-27
**Overall status**: PARTIAL -- strong unit and integration coverage; significant E2E gaps in provider-kind matrix, multi-tier cascade, and streaming with real providers

---

## Current State (as of 2026-03-27)

Guardrails has comprehensive unit test coverage for each individual component (pipeline factory, policy resolver, cache, cost tracker, streaming evaluator, webhook delivery, trace events, port adapters). Integration-level tests cover policy inheritance, tool guardrails, output guardrails, handoff rails, policy-define rules, and CRUD routes. Compiler-level tests cover all 3 tier evaluators, pipeline orchestration, action executors, circuit breaker, validators, and provider implementations. The primary gaps are runtime-level E2E: the provider-kind matrix via HTTP API, multi-tier cascade through full middleware chain, and streaming with real model providers.

### Quick Health Dashboard

| Area                               | Status     | Last Verified | Notes                                                                    |
| ---------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------ |
| Pipeline factory creation          | PASS       | 2026-03-22    | Tenant-scoped registries, provider loading, fingerprint change detection |
| Pipeline factory LLM eval          | PASS       | 2026-03-22    | Tier 3 LLM adapter with validation/response_gen fallback                 |
| Pipeline factory ports             | PASS       | 2026-03-22    | Cache + cost checker auto-wiring via port adapters                       |
| Pipeline factory policy resolution | PASS       | 2026-03-22    | DB policy loading, toPipelinePolicy conversion                           |
| Policy resolver 4-layer merge      | PASS       | 2026-03-22    | Platform defaults, tenant, project, agent DSL override chain             |
| Policy define rules                | PASS       | 2026-03-22    | Synthetic guardrail creation from policy rules                           |
| Streaming evaluator                | PASS       | 2026-03-22    | Sentence-boundary + chunk modes, early termination, fail-open            |
| Cache hit/miss/invalidation        | PASS       | 2026-03-22    | Tier-specific TTLs, SCAN+DEL invalidation, tenant-wide invalidation      |
| Cost tracker budgets               | PASS       | 2026-03-22    | Microdollar INCRBY, monthly key TTL, budget check                        |
| Port adapters                      | PASS       | 2026-03-22    | CacheAdapter, CostCheckerAdapter, WebhookAdapter bridging                |
| Webhook HMAC signing + retry       | PASS       | 2026-03-22    | HMAC-SHA256, exponential backoff, SSRF protection                        |
| Trace events (15 types)            | PASS       | 2026-03-22    | Factory functions for all guardrail trace event types                    |
| Output guardrails integration      | PASS       | 2026-03-27    | Real pipeline with CEL, no mocks (rewritten 2026-03-27)                  |
| Tool call/output guardrails        | PASS       | 2026-03-27    | Real pipeline with tool_input/tool_output kinds (rewritten 2026-03-27)   |
| Handoff guardrails                 | PASS       | 2026-03-22    | Handoff blocking with cross-agent policy evaluation                      |
| Session policy inheritance         | PASS       | 2026-03-27    | Real MongoDB via MongoMemoryServer, no mocks (rewritten 2026-03-27)      |
| Policy routes CRUD                 | PASS       | 2026-03-27    | RuntimeApiHarness with real auth + DB (rewritten 2026-03-27)             |
| Provider routes CRUD               | PASS       | 2026-03-27    | RuntimeApiHarness with real auth + DB (rewritten 2026-03-27)             |
| Compiler guardrail validation      | PASS       | 2026-03-22    | Action-kind compatibility checks at compile time                         |
| Compiler CEL guardrail functions   | PASS       | 2026-03-22    | CEL expression compilation for Tier 1 evaluators                         |
| Compiler guardrail IR schema       | PASS       | 2026-03-22    | IR serialization/deserialization of guardrail definitions                |
| Compiler guardrail context         | PASS       | 2026-03-22    | CEL context building per guardrail kind                                  |
| Multi-tier cascade (compiler)      | PASS       | 2026-03-22    | Tier 1->2->3 sequential at compiler pipeline level                       |
| Studio E2E comprehensive           | PASS       | 2026-03-22    | Playwright E2E for policy/provider CRUD in Studio UI                     |
| Studio admin provider route        | PASS       | 2026-03-26    | Admin guardrail provider proxy route unit test                           |
| Flow tool guardrails               | PASS       | 2026-03-27    | Real pipeline with tool kinds, 13 tests (rewritten 2026-03-27)           |
| Reasoning guardrail ordering       | PASS       | 2026-03-26    | Guardrail ordering in reasoning executor                                 |
| Tool guardrail LLM eval            | PASS       | 2026-03-26    | Tool guardrail with LLM evaluation                                       |
| Provider x kind E2E (runtime)      | NOT TESTED | -             | 147/175 provider-kind combinations untested via API                      |
| Multi-tier cascade E2E (runtime)   | NOT TESTED | -             | Tier 1->2->3 sequential via HTTP API                                     |
| Streaming + real model provider    | NOT TESTED | -             | No real provider in streaming evaluation path                            |
| Policy scoping E2E (runtime)       | NOT TESTED | -             | Tenant/project/agent override chain via API                              |
| Reask + escalate actions E2E       | NOT TESTED | -             | Only unit-tested, not exercised through HTTP API                         |

---

## Coverage Matrix

| FR    | Description                                | Unit | Integration | E2E  | Manual | Status             |
| ----- | ------------------------------------------ | ---- | ----------- | ---- | ------ | ------------------ |
| FR-1  | Pipeline evaluation with early termination | PASS | PASS        | PASS | N/A    | Covered            |
| FR-2  | 3 evaluation tiers (local, model, LLM)     | PASS | PASS        | PASS | N/A    | Covered            |
| FR-3  | 4-level policy inheritance                 | PASS | PASS        | GAP  | N/A    | E2E gap            |
| FR-4  | 5 evaluation kinds                         | PASS | PASS        | GAP  | N/A    | E2E gap            |
| FR-5  | Redis cache with tier TTLs                 | PASS | N/A         | GAP  | N/A    | E2E gap            |
| FR-6  | Cost tracking with budgets                 | PASS | N/A         | GAP  | N/A    | E2E gap            |
| FR-7  | Streaming evaluation                       | PASS | PASS        | GAP  | N/A    | E2E gap            |
| FR-8  | Webhook delivery with HMAC                 | PASS | N/A         | GAP  | N/A    | E2E gap            |
| FR-9  | 7 violation actions                        | PASS | PARTIAL     | GAP  | N/A    | reask/escalate gap |
| FR-10 | 15 trace event types                       | PASS | N/A         | GAP  | N/A    | E2E gap            |
| FR-11 | Circuit breaker per provider               | PASS | N/A         | GAP  | N/A    | E2E gap            |
| FR-12 | Fail-open/closed modes                     | PASS | PASS        | GAP  | N/A    | E2E gap            |
| FR-13 | DSL GUARDRAILS compilation to IR           | PASS | PASS        | PASS | N/A    | Covered            |
| FR-14 | CRUD routes for policies and providers     | N/A  | PASS        | PASS | N/A    | Covered            |

---

## Provider x Kind Coverage Matrix

### Implemented Providers x 5 Kinds

| Provider            | input | output | tool_input | tool_output | handoff | Notes                         |
| ------------------- | ----- | ------ | ---------- | ----------- | ------- | ----------------------------- |
| `builtin_pii`       | Unit  | Unit   | Unit       | Unit        | N/A     | E2E via API: NOT TESTED       |
| `openai_moderation` | Unit  | Unit   | N/A        | N/A         | N/A     | E2E via API: NOT TESTED       |
| `custom_http`       | Unit  | Unit   | N/A        | N/A         | N/A     | SSRF tests comprehensive      |
| `openai_compatible` | Unit  | Unit   | N/A        | N/A         | N/A     | E2E via API: NOT TESTED       |
| `llm` (Tier 3)      | Unit  | Unit   | Unit       | Unit        | Unit    | Injection tested, no real LLM |

### Coverage Status

- Unit: 5 providers x 2 kinds average = ~10 tested combinations
- E2E via runtime HTTP API: 0 tested combinations
- Target: All 4 implemented providers x 5 kinds = 20 E2E combinations

---

## E2E Test Scenarios (Mandatory -- Minimum 5)

### E2E-1: Builtin PII Provider Blocks Input Containing SSN

**Preconditions**: Runtime server running on random port. Tenant and project seeded. `builtin_pii` auto-registered. Active guardrail policy with `input` kind rule using `builtin_pii` provider, action `block`.

**Steps**:

1. POST `/api/projects/:projectId/guardrail-policies` -- create policy with builtin_pii input rule, action=block, status=active
2. POST `/api/sessions` -- create a session for the project
3. POST `/api/sessions/:sessionId/messages` -- send message containing "My SSN is 123-45-6789"
4. GET response -- should be blocked with guardrail violation

**Expected Result**: Message is blocked. Response includes guardrail violation with `guardrail_violation` trace event, action=block, provider=builtin_pii.

**Auth Context**: Tenant A, Project P1, User U1
**Isolation Check**: Same policy should NOT apply to Tenant B's projects (returns 404 on cross-tenant access)

### E2E-2: Multi-Tier Cascade -- Tier 1 Block Skips Tier 2 and 3

**Preconditions**: Runtime server running. Policy with Tier 1 local rule (CEL check: `len(input) > 5000`) + Tier 2 model rule (openai_moderation) + Tier 3 LLM rule. Agent compiled with all three guardrails.

**Steps**:

1. POST policy with 3 guardrails at different tiers
2. POST message with 6000-character input (triggers Tier 1 block)
3. Assert response blocked by Tier 1
4. Assert no Tier 2 or Tier 3 evaluation occurred (check trace events)

**Expected Result**: Tier 1 blocks. `guardrail_check` trace event shows tier=local, passed=false. No `guardrail_check` events for tier=model or tier=llm (early termination).

**Auth Context**: Tenant A, Project P1, User U1
**Isolation Check**: Tier 1 check should use tenant-scoped cache key

### E2E-3: Policy Scoping -- Agent Override Takes Precedence Over Project Policy

**Preconditions**: Runtime server running. Tenant with project P1 and agent A1.

**Steps**:

1. POST tenant-scoped policy: `content_safety` rule with threshold=0.5, action=warn
2. POST project-scoped policy: `content_safety` rule with threshold=0.7, action=block
3. Compile agent A1 with DSL GUARDRAILS overriding `content_safety` threshold=0.9, action=warn
4. POST message to agent A1 with content scoring 0.8
5. Assert response is NOT blocked (agent DSL override uses threshold 0.9, score 0.8 < 0.9)

**Expected Result**: Content passes because agent-level threshold (0.9) is higher than content score (0.8). Project-level block at 0.7 is overridden.

**Auth Context**: Tenant A, Project P1, Agent A1, User U1
**Isolation Check**: Policy for Project P2 should not affect P1's agent

### E2E-4: Output Guardrail with Reask Action Triggers LLM Retry

**Preconditions**: Runtime server running. Active policy with `output` kind guardrail, action=reask, maxReasks=2. LLM configured for agent.

**Steps**:

1. POST policy with output guardrail, action=reask, maxReasks=2
2. POST message that triggers the agent to generate unsafe output
3. Assert `guardrail_reask` trace event is emitted
4. Assert LLM was called again (second attempt)
5. Assert final response is either the safe retry output or blocked after maxReasks

**Expected Result**: First LLM output fails guardrail. Reask triggers second LLM call. If second attempt passes, user gets safe response. If both fail, response is blocked.

**Auth Context**: Tenant A, Project P1, User U1
**Isolation Check**: N/A (reask is within-session behavior)

### E2E-5: Tool Call Guardrail Blocks Dangerous Tool Invocation

**Preconditions**: Runtime server running. Agent with a tool configured. Active policy with `tool_input` kind guardrail using CEL check to block certain tool parameters.

**Steps**:

1. POST policy with `tool_input` guardrail: CEL check `tool_parameters.url.contains("internal")`
2. POST message that triggers agent to call tool with `url: "https://internal.corp.com/api"`
3. Assert tool call is blocked before execution
4. Assert `guardrail_tool_blocked` trace event emitted

**Expected Result**: Tool call blocked by guardrail. Agent receives blocked notification and must respond without tool result.

**Auth Context**: Tenant A, Project P1, User U1
**Isolation Check**: Tool guardrail policy scoped to project

### E2E-6: Streaming Output Evaluation with Early Termination

**Preconditions**: Runtime server running with streaming mode. Active policy with output guardrail (model-tier provider) on streaming content.

**Steps**:

1. POST policy with output guardrail, streaming enabled, earlyTermination=true
2. POST message requesting a long response, via SSE/streaming endpoint
3. Partway through streaming, content triggers guardrail violation
4. Assert stream terminates early with `terminate` event
5. Assert `guardrail_violation` trace event emitted

**Expected Result**: Stream terminates at the violation point. Client receives partial content up to the violation, then a termination event.

**Auth Context**: Tenant A, Project P1, User U1

### E2E-7: Provider CRUD with Cross-Tenant Isolation

**Preconditions**: Runtime server running. Two tenants (A and B) with valid auth tokens.

**Steps**:

1. POST `/api/tenants/:tenantAId/guardrail-providers` -- create provider for Tenant A
2. GET `/api/tenants/:tenantAId/guardrail-providers` with Tenant A auth -- should return provider
3. GET `/api/tenants/:tenantAId/guardrail-providers` with Tenant B auth -- should return 404
4. GET `/api/tenants/:tenantAId/guardrail-providers/:id` with Tenant B auth -- should return 404
5. DELETE provider with Tenant B auth -- should return 404

**Expected Result**: Tenant B cannot see or modify Tenant A's providers. All cross-tenant access returns 404 (not 403).

**Auth Context**: Tenant A + Tenant B
**Isolation Check**: This IS the isolation test

### E2E-8: Circuit Breaker Opens After Provider Failures

**Preconditions**: Runtime server running. Custom HTTP provider configured with circuitBreaker.failureThreshold=3, resetTimeoutMs=5000.

**Steps**:

1. POST provider with custom_http adapter pointing to a failing endpoint
2. POST 3 messages that trigger Tier 2 evaluation (all fail)
3. Assert circuit breaker opens (provider returns fail-open/fail-closed)
4. Assert `guardrail_circuit_breaker` trace event emitted with state=OPEN
5. Wait for resetTimeoutMs, POST another message
6. Assert circuit breaker enters HALF_OPEN state

**Expected Result**: After 3 failures, circuit opens. Subsequent requests skip the provider. After timeout, HALF_OPEN allows one probe.

---

## Integration Test Scenarios (Mandatory -- Minimum 5)

### INT-1: Pipeline Factory Loads Providers from DB with Fingerprint Caching

**Boundary**: Pipeline factory <-> MongoDB (provider configs)
**Setup**: MongoDB with tenant_guardrail_provider_configs seeded. Redis available.

**Steps**:

1. Call `ensureTenantProvidersLoaded(tenantId)`
2. Assert providers registered in pipeline's provider registry
3. Call again within 5-minute TTL -- assert no DB query
4. Modify provider config in DB
5. Call after TTL expires -- assert provider reloaded

**Expected Result**: First call loads from DB. Subsequent calls use cache. TTL expiry triggers reload.

**Failure Mode**: DB unavailable -- factory should work with cached providers until TTL expires.

### INT-2: Policy Resolver Merges 4-Layer Hierarchy

**Boundary**: Policy resolver <-> Policy data from DB
**Setup**: Policy data at tenant, project, and agent scope levels.

**Steps**:

1. Create tenant policy: content_safety threshold=0.5, action=warn
2. Create project policy: content_safety threshold=0.7, action=block
3. Create agent DSL guardrail: content_safety threshold=0.9
4. Call `resolver.resolve(input)` with all three scopes
5. Assert final guardrail uses threshold=0.9 (agent DSL wins)
6. Assert settings.failMode comes from project policy (last explicit)

**Expected Result**: Agent DSL guardrails are highest priority. Project overrides tenant. Platform defaults fill gaps.

**Failure Mode**: Missing scope data should gracefully skip that layer, not error.

### INT-3: Streaming Evaluator with Pipeline Policy

**Boundary**: StreamingGuardrailEvaluator <-> GuardrailPipelineImpl
**Setup**: In-memory pipeline with builtin-pii provider. Policy with fail-open.

**Steps**:

1. Create evaluator with output guardrails and streaming config (sentence mode)
2. Feed chunks: "Hello", " there", ". My SSN", " is 123", "-45-6789", "."
3. Assert evaluation triggers at sentence boundary after "."
4. Assert `evaluateChunk` returns violation event when PII detected
5. Assert `evaluateFinal()` aggregates results

**Expected Result**: PII detected at sentence boundary. Violation event returned with action and message.

**Failure Mode**: Pipeline error -> fail-open, pass event returned.

### INT-4: Cost Tracker Budget Enforcement

**Boundary**: GuardrailCostTracker <-> Redis
**Setup**: Redis mock. Budget set to 1.00 USD (1,000,000 microdollars).

**Steps**:

1. Track 10 evaluations at $0.08 each (800,000 microdollars total)
2. Check budget -- should NOT be exceeded
3. Track 3 more evaluations at $0.08 each (1,040,000 microdollars total)
4. Check budget -- should BE exceeded
5. Assert `exceeded: true`, `action: 'downgrade'` returned

**Expected Result**: Budget exceeded after 13th evaluation. CostCheckResult indicates exceeded with correct action.

**Failure Mode**: Redis error -> return 0 spend, no budget enforcement (fail-open).

### INT-5: Webhook Delivery with HMAC Signing and Retry

**Boundary**: GuardrailWebhookDelivery <-> HTTP endpoint
**Setup**: Mock HTTP server. Webhook config with secret for HMAC.

**Steps**:

1. Deliver violation event to mock server
2. Assert request has `X-Signature-256` header with HMAC-SHA256
3. Mock server returns 500
4. Assert retry attempt (1s delay)
5. Mock server returns 200 on retry
6. Assert `success: true`, `attempts: 2`

**Expected Result**: HMAC signature present and verifiable. Retry on 5xx. Success on second attempt.

**Failure Mode**: 4xx (not 429) -> no retry. Timeout -> retry.

### INT-6: Route CRUD with Auth and Feature Gate

**Boundary**: Express routes <-> MongoDB <-> Auth middleware
**Setup**: Supertest with mocked auth. Feature gate enabled.

**Steps**:

1. POST policy without auth -- assert 401
2. POST policy with auth, missing required fields -- assert 400
3. POST policy with auth, valid body -- assert 201
4. GET policy list -- assert contains created policy
5. PUT policy update -- assert 200
6. POST activate -- assert policy status=active
7. DELETE policy -- assert 204

**Expected Result**: Full CRUD lifecycle with proper auth enforcement.

**Failure Mode**: Feature gate disabled -> 403 on all routes.

### INT-7: Output Guardrail Integration in Reasoning Executor

**Boundary**: Reasoning executor <-> GuardrailPipelineImpl
**Setup**: Agent with output guardrails configured. Mocked LLM returning unsafe content.

**Steps**:

1. Execute reasoning loop with guardrails enabled
2. LLM returns content that violates output guardrail
3. Assert guardrail pipeline is called with output kind
4. Assert violation triggers block action
5. Assert agent response is replaced with safety message

**Expected Result**: Unsafe LLM output caught by output guardrail. User receives safe fallback message.

---

## Security & Isolation Tests

- [x] Cross-tenant provider access returns 404 (tested in `provider-routes.test.ts`)
- [x] Cross-tenant policy access returns 404 (tested in `policy-routes.test.ts`)
- [x] Missing auth returns 401 (tested in route tests)
- [x] Feature gate enforced (`requireFeature('guardrails')`)
- [x] SSRF protection on webhook URLs (tested in `custom-http-ssrf.test.ts` and `webhook.test.ts`)
- [x] HMAC-SHA256 signing on webhook payloads (tested in `webhook.test.ts`)
- [ ] Cross-project policy access returns 404 -- E2E NOT TESTED via full HTTP API
- [ ] Provider API key never returned in plaintext -- NOT VERIFIED in E2E

---

## Test Inventory

### Unit Tests

| Test File                                                                                | Suites | Status | Key Scenarios                                                              |
| ---------------------------------------------------------------------------------------- | ------ | ------ | -------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/guardrails/pipeline-factory.test.ts`                         | ~6     | PASS   | Factory creation, tenant-scoped registries, provider loading, LRU eviction |
| `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-llmeval.test.ts`        | ~4     | PASS   | LLM eval adapter, validation/response_gen fallback                         |
| `apps/runtime/src/services/guardrails/__tests__/pipeline-factory-ports.test.ts`          | ~4     | PASS   | Cache + cost checker port auto-wiring                                      |
| `apps/runtime/src/__tests__/guardrails/pipeline-factory-policy.test.ts`                  | ~5     | PASS   | DB policy loading, toPipelinePolicy conversion                             |
| `apps/runtime/src/__tests__/guardrails/policy-resolver.test.ts`                          | ~8     | PASS   | 4-layer merge, settings merge, disable/threshold/action overrides          |
| `apps/runtime/src/services/guardrails/__tests__/policy-resolver.test.ts`                 | ~5     | PASS   | Define-mode synthetic guardrails, DSL priority                             |
| `apps/runtime/src/__tests__/guardrails/policy-define-rules.test.ts`                      | ~4     | PASS   | Synthetic guardrail creation from define rules                             |
| `apps/runtime/src/__tests__/guardrails/streaming-evaluator.test.ts`                      | ~6     | PASS   | Sentence boundary, chunk mode, early termination, fail-open                |
| `apps/runtime/src/__tests__/guardrails/cache.test.ts`                                    | ~6     | PASS   | Key building, tier TTLs, Tier 3 skip, fail-open, SCAN+DEL                  |
| `apps/runtime/src/services/guardrails/__tests__/cache-invalidation.test.ts`              | ~4     | PASS   | Per-guardrail invalidation, tenant-wide invalidation                       |
| `apps/runtime/src/__tests__/guardrails/cost-tracker.test.ts`                             | ~5     | PASS   | Microdollar conversion, INCRBY, monthly key TTL, budget check              |
| `apps/runtime/src/services/guardrails/__tests__/port-adapters.test.ts`                   | ~4     | PASS   | CacheAdapter, CostCheckerAdapter, WebhookAdapter bridging                  |
| `apps/runtime/src/__tests__/guardrails/webhook.test.ts`                                  | ~6     | PASS   | HMAC signing, event filter, retry on 5xx/429, no retry on 4xx, SSRF        |
| `apps/runtime/src/__tests__/guardrails/trace-events.test.ts`                             | ~4     | PASS   | All 15 trace event factory functions                                       |
| `packages/compiler/src/__tests__/guardrails/tier1-evaluator.test.ts`                     | ~6     | PASS   | CEL evaluation, fail modes, priority sorting, parallel execution           |
| `packages/compiler/src/__tests__/guardrails/tier2-evaluator.test.ts`                     | ~8     | PASS   | Provider dispatch, threshold, severity mapping, parallel evaluation        |
| `packages/compiler/src/__tests__/guardrails/tier3-evaluator.test.ts`                     | ~6     | PASS   | LLM injection, prompt building, response parsing, score clamping           |
| `packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts`                 | ~6     | PASS   | Action-kind compatibility matrix                                           |
| `packages/compiler/src/__tests__/guardrails/circuit-breaker.test.ts`                     | ~4     | PASS   | CLOSED/OPEN/HALF_OPEN state transitions                                    |
| `packages/compiler/src/__tests__/guardrails/action-executors.test.ts`                    | ~5     | PASS   | Fix strategies, redaction, filtering                                       |
| `packages/compiler/src/__tests__/guardrails/action-applier.test.ts`                      | ~4     | PASS   | Action application logic                                                   |
| `packages/compiler/src/__tests__/guardrails/result-aggregator.test.ts`                   | ~3     | PASS   | Multi-tier result aggregation                                              |
| `packages/compiler/src/__tests__/guardrails/provider-interface.test.ts`                  | ~3     | PASS   | Provider interface compliance                                              |
| `packages/compiler/src/__tests__/guardrails/provider-registry.test.ts`                   | ~4     | PASS   | Registry register/get/unregister/list                                      |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`               | ~3     | PASS   | PII detection scoring                                                      |
| `packages/compiler/src/__tests__/guardrails/providers/openai-moderation.test.ts`         | ~3     | PASS   | OpenAI Moderation API response mapping                                     |
| `packages/compiler/src/__tests__/guardrails/providers/openai-compatible.test.ts`         | ~3     | PASS   | Generic OpenAI-compatible provider                                         |
| `packages/compiler/src/__tests__/guardrails/providers/custom-http.test.ts`               | ~3     | PASS   | Custom HTTP provider with response mapping                                 |
| `packages/compiler/src/__tests__/guardrails/custom-http-ssrf.test.ts`                    | ~15    | PASS   | SSRF URL validation (15 test cases)                                        |
| `packages/compiler/src/platform/guardrails/providers/__tests__/custom-http-ssrf.test.ts` | ~5     | PASS   | Additional SSRF tests at provider level                                    |
| `packages/compiler/src/__tests__/guardrails/guardrail-action.test.ts`                    | ~4     | PASS   | Action type definitions, severity levels                                   |
| `packages/compiler/src/__tests__/guardrails/guardrail-ir-schema.test.ts`                 | ~3     | PASS   | IR serialization/deserialization                                           |
| `packages/compiler/src/__tests__/guardrails/guardrail-compilation.test.ts`               | ~4     | PASS   | DSL GUARDRAILS section to IR compilation                                   |
| `packages/compiler/src/__tests__/guardrails/guardrail-messages.test.ts`                  | ~3     | PASS   | Default violation messages and i18n                                        |
| `packages/compiler/src/__tests__/guardrails/guardrail-context.test.ts`                   | ~5     | PASS   | CEL context per kind                                                       |
| `packages/compiler/src/__tests__/guardrails/cel-guardrail-functions.test.ts`             | ~4     | PASS   | CEL expression compilation                                                 |
| `packages/compiler/src/__tests__/guardrails/pipeline-policy-validation.test.ts`          | ~3     | PASS   | Policy validation rules                                                    |
| `packages/compiler/src/__tests__/guardrails/pipeline-types.test.ts`                      | ~3     | PASS   | Pipeline type definitions                                                  |
| `packages/compiler/src/__tests__/guardrails/pipeline-ports.test.ts`                      | ~3     | PASS   | Port interface definitions                                                 |
| `packages/compiler/src/__tests__/guardrails/fail-mode.test.ts`                           | ~3     | PASS   | Fail-open vs fail-closed behavior                                          |
| `packages/compiler/src/__tests__/guardrails/builtin-templates.test.ts`                   | ~3     | PASS   | Built-in guardrail template definitions                                    |

### Integration Tests

#### Execution-Level Integration (Guardrail Pipeline wired into Execution)

| Test File                              | Suites | Status | Key Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output-guardrails.test.ts`            | ~7     | PASS   | Output validation via `checkOutputGuardrails`: empty input passthrough, missing guardrails passthrough, input-kind guardrails skipped for output eval, clean response passes with real CEL PII check, PII violation returns guardrailName/action/message, policy disables guardrail (PII passes), pipelineResult populated with metrics. Uses **real `GuardrailPipelineImpl`**, no mocks.                                                                                                                             |
| `tool-rails.test.ts`                   | ~9     | PASS   | **Tool Input (6 tests):** PII in tool input triggers block + `guardrail_tool_blocked` trace, clean input passes, no guardrails defined skips pipeline, fail-open on pipeline error, system tool `__complete__` bypasses guardrails, `guardrail_check` trace events emitted. **Tool Output (3 tests):** SSN in tool result blocked + `guardrail_tool_output_blocked` trace, clean output passes, fail-open on pipeline crash + `guardrail_pipeline_error` trace. Uses **real `RuntimeExecutor`** with mock LLM client. |
| `handoff-rails.test.ts`                | ~3     | PASS   | PII in handoff context (SSN, customer name) blocks handoff + `guardrail_handoff_blocked` trace + session stays on Supervisor; clean context allows handoff + session moves to ChildAgent; pipeline crash fail-opens + handoff proceeds + `guardrail_pipeline_error` trace. Uses **real `RuntimeExecutor`** with mock LLM client.                                                                                                                                                                                      |
| `session-policy-inheritance.test.ts`   | ~4     | PASS   | `getSessionPolicy` resolves policy from real MongoDB; resolved policy cached on session (delete from DB, second call returns cached value); null cached when no policies found (seed after first call, still returns undefined); agent with DSL guardrails still triggers resolve. Uses **real MongoDB** (MongoMemoryServer), no mocks.                                                                                                                                                                               |
| `runtime-integration.test.ts`          | ~11    | PASS   | **Real pipeline, no mocks.** SSN blocked by `abl.contains_pii`; clean input passes; email blocked; long output triggers warn (still passes); short output no warn; kind filtering (only output-kind fires for output eval); runtime context (`agentGoal`) propagated to CEL; 3 guardrails aggregated (PII fails, others pass, totalChecks=3); empty guardrails passes with zero metrics; pipeline reuse across 3 evals with no state leakage; latency metrics populated (tier1LatencyMs >= 0).                        |
| `flow-tool-guardrails.test.ts`         | ~13    | PASS   | Tool guardrail pipeline integration: tool_input pass/block with CEL PII check, tool_output pass/block, kind filtering (tool_input doesn't fire for tool_output and vice versa), no cross-fire between tool and non-tool kinds, empty guardrails no-op, context propagation (tool_name, content length), multiple guardrails with priority ordering, pipeline reuse across tool_input and tool_output (no state leakage), latency metrics populated. Uses **real `GuardrailPipelineImpl`**, no mocks.                  |
| `reasoning-guardrail-ordering.test.ts` | ~3     | PASS   | Guardrail evaluation ordering: Tier 1 local runs before Tier 2 model, terminal violation in lower tier skips higher tiers (early termination)                                                                                                                                                                                                                                                                                                                                                                         |
| `tool-guardrail-llmeval.test.ts`       | ~3     | PASS   | LLM-based guardrail on tool calls: Tier 3 LLM evaluator injected into pipeline, tool call content evaluated by LLM prompt, violation triggers block action                                                                                                                                                                                                                                                                                                                                                            |
| `post-guardrail-revalidation.test.ts`  | ~5     | PASS   | Re-validation of tool params after guardrail modification: valid params pass; guardrail nullifies required field → throws "missing required parameter"; guardrail removes required field → same error; guardrail sets enum to `[REDACTED]` → throws "not in allowed values"; guardrail changes number to string → throws "expected type 'number'". Uses **real `validateToolInputs`**, no mocks.                                                                                                                      |

All execution-level integration tests now use real components: `runtime-integration.test.ts`, `output-guardrails.test.ts`, and `flow-tool-guardrails.test.ts` use the **real `GuardrailPipelineImpl`** with CEL expressions; `session-policy-inheritance.test.ts` uses **real MongoDB** (MongoMemoryServer); `tool-rails.test.ts` and `handoff-rails.test.ts` use **real `RuntimeExecutor`** with mock LLM client (LLM mocking is acceptable as an external service).

#### Streaming Integration

| Test File                                 | Suites | Status | Key Scenarios                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streaming-guardrails-wiring.test.ts`     | ~6     | PASS   | Chunks pass through when no guardrails; buffer accumulates across chunks; `isTerminated()` false initially; `getViolationCount()` zero initially; 6 sequential chunks processed correctly; `evaluateFinal()` returns passed=true. Uses **real evaluator, no mocks.**                                          |
| `streaming-guardrails-pipeline.test.ts`   | ~5     | PASS   | Injected pipeline used instead of bare default; falls back to `GuardrailPipelineImpl` when no pipeline provided; buffer accumulates across chunks and evaluates at sentence boundary; `evaluateFinal()` uses provided pipeline; mock pipeline returning violation triggers terminate + `isTerminated()=true`. |
| `streaming-guardrails-policy.test.ts`     | ~3     | PASS   | Streaming with policy forwarding: policy settings (failMode, streaming config) forwarded to streaming evaluator, fail-open on evaluation errors                                                                                                                                                               |
| `streaming-guardrails-model-tier.test.ts` | ~3     | PASS   | Streaming with model-tier evaluators: Tier 2 provider dispatched for buffered chunks, provider score compared against threshold, violation on above-threshold score                                                                                                                                           |

All streaming tests use **real `StreamingGuardrailEvaluator`** with in-memory pipeline. No real HTTP or Redis.

#### Route Integration (CRUD via RuntimeApiHarness)

| Test File                 | Suites | Status | Key Scenarios                                                                                                                                                                                                                                        |
| ------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-routes.test.ts`   | ~18    | PASS   | Create policy (201), list policies (200), get by ID (200), update (200), activate (200 + deactivate others), delete (204), missing fields (400), duplicate name (409), non-existent (404), tenant+project isolation verified via cross-tenant insert |
| `provider-routes.test.ts` | ~21    | PASS   | Create provider (201, custom_webhook/openai_moderation), reject invalid adapters (400), list by tenant (200), get by ID (200), update (200), delete (204), test endpoint, cross-tenant 404, feature gate enforcement, tenant isolation verified      |

Route tests use **RuntimeApiHarness** with real MongoMemoryServer, real auth (dev-login JWT via `bootstrapProject()`), real middleware chain (auth, rate-limiter, feature-gate, permissions). No vi.mock() — exercises full request lifecycle.

#### Pipeline-Level Integration

| Test File                             | Suites | Status | Key Scenarios                                                                                                                                                     |
| ------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardrail-pipeline-expanded.test.ts` | ~4     | PASS   | Factory + registry: tenant-scoped provider loading, config fingerprint change detection, LRU eviction at max capacity, port adapter auto-wiring                   |
| `guardrail-policy-hierarchy.test.ts`  | ~3     | PASS   | Policy hierarchy: 4-layer merge (platform→tenant→project→DSL), disable rule removes guardrail, threshold override replaces value, action override replaces action |
| `severity-actions-policy.test.ts`     | ~3     | PASS   | Severity-based action: different actions for different severity levels (low→warn, medium→block, critical→escalate), severity resolved from provider score         |

#### Compiler-Level Integration (E2E at Compiler Boundary)

| Test File                        | Suites | Status | Key Scenarios                                                                                                                                         |
| -------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardrails-e2e.test.ts`         | ~4     | PASS   | Full compiler pipeline: DSL → IR compilation → pipeline execution → result aggregation, validates compile-time warnings and action-kind compatibility |
| `multi-tier-cascade-e2e.test.ts` | ~4     | PASS   | Tier 1→2→3 sequential cascade: Tier 1 CEL passes → Tier 2 model evaluates → Tier 3 LLM evaluates; early termination when lower tier blocks            |
| `builtin-pii-e2e.test.ts`        | ~3     | PASS   | PII provider through guardrail evaluate() interface: SSN/email detection, score mapping, provider metadata in result                                  |
| `openai-moderation-e2e.test.ts`  | ~3     | PASS   | OpenAI Moderation provider E2E: mocked HTTP response, category score mapping, threshold comparison                                                    |
| `custom-http-e2e.test.ts`        | ~3     | PASS   | Custom HTTP provider E2E: request template rendering, response path extraction, SSRF URL validation                                                   |

Compiler tests use **real IR compiler and pipeline** with test DSL inputs. External HTTP mocked via `nock`.

### E2E Tests

#### Studio UI E2E (Playwright)

| Test File                              | Suites | Status | Key Scenarios                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardrails-comprehensive-e2e.spec.ts` | ~8     | PASS   | **Full 7-phase lifecycle:** (1) Login + navigate to project, (2) Navigate to Guardrails Config page → Policies tab, (3) Create guardrail policy via UI form, (4) Providers tab → register provider, (5) Activate policy, (6) Audit tab verification, (7) Policy edit + delete. Uses real Studio dev server + Playwright browser automation.                                                           |
| `model-guardrails-e2e.spec.ts`         | ~4     | PASS   | **Full 7-phase model + guardrails lifecycle:** (1) Login + navigate, (2) Create models for multiple providers (OpenAI, Anthropic, etc.), (3) Wire connections, (4) Chat with agent, (5) Guardrails config — navigate to page, create policy via API, verify on page, chat to trigger guardrail, (6) Error path — invalid API key, (7) Verify sessions and traces. Uses real Studio + runtime servers. |

#### Runtime Pipeline E2E (Vitest with Real Compiler)

| Test File                          | Suites | Status | Key Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guardrail-edge-cases.e2e.test.ts` | ~25    | PASS   | **6 test groups:** (1) **Circuit breaker** — opens after threshold failures, requests short-circuit, fail-closed blocks when open, recovery after reset timeout (half-open→success→closed), policy providerOverrides customize thresholds, half-open probe through registry, fail-closed result when open, independent breakers per provider. (2) **Fail-open** — provider error passes content, unregistered provider passes, Tier 1 CEL error passes, Tier 3 LLM unavailable passes. (3) **Fail-closed** — provider error blocks, unregistered provider blocks, CEL error blocks, LLM unavailable blocks, mixed fail modes comparison. (4) **Budget enforcement** — budget fields in schema, overspendAction enum validation, cost tracking per evaluation, accumulated cost across evaluations. (5) **Caching schema** — caching fields in schema, metrics fields, cache metrics without caching enabled, streaming settings fields. (6) **Circuit breaker state machine** — half-open allows probe, fail-closed with open circuit returns critical score, multiple providers have independent breakers. Uses **real `GuardrailPipelineImpl`**, `GuardrailProviderRegistry`, and `CircuitBreaker` from `@abl/compiler`. No HTTP, no DB. |

---

## How to Run

```bash
# All guardrails-related runtime tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "guardrail"

# Pipeline factory tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/pipeline-factory.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/guardrails/__tests__/pipeline-factory-llmeval.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/guardrails/__tests__/pipeline-factory-ports.test.ts

# Policy resolver
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/policy-resolver.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/guardrails/__tests__/policy-resolver.test.ts

# Streaming
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/streaming-evaluator.test.ts

# Cache + cost
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/cache.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/guardrails/__tests__/cache-invalidation.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/cost-tracker.test.ts

# Webhook + trace + adapters
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/webhook.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/trace-events.test.ts
pnpm test --filter=runtime -- apps/runtime/src/services/guardrails/__tests__/port-adapters.test.ts

# Execution integration
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/output-guardrails.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/tool-rails.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/handoff-rails.test.ts

# Routes
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/policy-routes.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/guardrails/provider-routes.test.ts

# Compiler guardrail tests
pnpm build --filter=compiler && pnpm test --filter=compiler -- --reporter=verbose -t "guardrail"

# Studio E2E (requires running dev server)
pnpm --filter=studio e2e -- guardrails-comprehensive-e2e.spec.ts
```

---

## Coverage Gaps & Recommendations

### Critical Gaps

| ID  | Gap                                                  | Impact                                                                | Recommendation                                                                                 |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| G-1 | Provider x kind matrix: untested E2E via runtime API | Cannot verify providers work across all evaluation kinds via full API | Create parametrized E2E tests: builtin_pii x {input, output, tool_input, tool_output, handoff} |
| G-2 | Multi-tier cascade untested via runtime HTTP API     | Cannot verify early termination works through full middleware chain   | Write E2E with Tier 1 block that proves Tier 2/3 never execute                                 |
| G-3 | Streaming + real model provider untested E2E         | Production streaming path with model evaluation not validated         | Add E2E with mock HTTP provider returning scores in streaming mode                             |
| G-4 | Policy scoping chain untested via full API           | 4-level inheritance not validated through Express routes              | Write E2E seeding policies at each scope, verify merge via agent execution                     |
| G-5 | Reask + escalate actions untested E2E                | Two of seven actions have no HTTP-level coverage                      | Add E2E tests for output+reask and handoff+escalate scenarios                                  |

### Medium Gaps

| ID  | Gap                                                    | Impact                                                   | Recommendation                                      |
| --- | ------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| G-6 | 11 adapter types have no implementation                | DB enum promises more than runtime delivers              | Implement or remove unused types                    |
| G-7 | Circuit breaker state transitions untested integration | CLOSED/OPEN/HALF_OPEN not validated with real HTTP calls | Integration test with failing mock HTTP server      |
| G-8 | Budget enforcement not tested via API                  | Cost downgrade behavior not validated end-to-end         | E2E test with budget limit, verify tier downgrade   |
| G-9 | Cache invalidation on policy mutation not tested E2E   | Cannot verify stale cache is cleared on policy update    | E2E: update policy, verify next eval uses new rules |

### Recommended Priority Order

1. **G-1** builtin_pii x kind -- best E2E template (zero cost, fully local)
2. **G-2** multi-tier cascade -- foundational system understanding
3. **G-4** policy scoping chain -- validates core governance feature
4. **G-3** streaming + model -- production scenario validation
5. **G-5** reask + escalate -- completes action coverage
6. **G-8** budget enforcement -- validates cost control feature

---

## Test Architecture Notes

- **Unit tests** use mocked Redis (`RedisLike` interface) and mocked DB models for isolation.
- **Integration tests** use the real `GuardrailPipelineImpl` from `@abl/compiler` with in-memory providers.
- **Port adapter tests** verify the bridging layer between compiler port interfaces and runtime implementations.
- **Route tests** use Express `supertest` with mocked auth middleware and mocked DB models.
- **Compiler tests** use the real IR compiler and validator with test DSL inputs.
- **Studio E2E** uses Playwright against a running Studio dev server.
- **Runtime E2E** (needed) should start Express on random port with full middleware chain, seed via POST endpoints, and assert via GET responses.

---

## Test Infrastructure Requirements

- **MongoDB**: Required for policy and provider CRUD tests. Use `MongoMemoryServer` or real MongoDB.
- **Redis**: Required for cache and cost tracker tests. Use mocked `RedisLike` interface for unit tests; real Redis for E2E.
- **LLM Provider**: Not required for most tests. Tier 3 tests inject a mock LLM function.
- **External HTTP**: Custom HTTP provider tests use `nock` or mock HTTP servers for SSRF and response mapping.
- **Studio Dev Server**: Required for Playwright E2E tests.
- **Environment Variables**: `GUARDRAILS_ENABLED=true`, `GUARDRAILS_CACHE_ENABLED=true` for E2E tests.

---

## Open Testing Questions

1. Should E2E tests for provider x kind matrix use real external providers (OpenAI) or mock HTTP servers?
   - DECIDED: Use mock HTTP servers for deterministic, cost-free testing. Real provider tests can be separate smoke tests.

2. How should streaming E2E tests verify mid-stream guardrail evaluation?
   - DECIDED: Use SSE client to consume streaming responses and detect terminate events.

3. Should circuit breaker E2E tests introduce real network failures or use controlled mocks?
   - DECIDED: Use a mock HTTP server that returns errors on demand for deterministic testing.
