# Feature Test Guide: NLU / Intent Classification & Entity Extraction

**Feature**: NLU — intent classification, entity extraction, multi-intent handling, NL-to-ABL
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/nlu.md](../features/nlu.md)
**Related Child Feature Docs**: [docs/features/entity-extraction.md](../features/entity-extraction.md), [docs/features/sub-features/gather-interrupt-semantic-routing.md](../features/sub-features/gather-interrupt-semantic-routing.md)
**First tested**: 2026-03-22
**Last updated**: 2026-04-21
**Overall status**: BETA — extensive unit coverage, moderate integration coverage, limited HTTP E2E coverage

---

## Current State (as of 2026-04-15)

**Implementation status: BETA**

The NLU umbrella feature still has comprehensive coverage across classifier/orchestrator/circuit-breaker/config/tool-filter/sidecar/multi-intent/extraction/flow/nl-parser modules and moderate integration coverage around multi-intent dispatch and sidecar wiring. As of 2026-04-15 it still has one real HTTP E2E slice: `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts` configures pipeline settings through `PUT /api/projects/:projectId/runtime-config`, sends a live `/api/v1/chat/agent` request, and asserts classifier, guided multi-intent planning, shared parallel execution, and merge traces. Detailed parser/compiler/runtime observation coverage for semantic entities now lives in [docs/testing/entity-extraction.md](./entity-extraction.md), while gather-step interrupt routing and future semantic-sidecar routing ownership now lives in [docs/testing/sub-features/gather-interrupt-semantic-routing.md](./sub-features/gather-interrupt-semantic-routing.md). This guide remains the routing-focused umbrella.

### Quick Health Dashboard

| Area                                  | Status          | Last Verified | Notes                                                                                      |
| ------------------------------------- | --------------- | ------------- | ------------------------------------------------------------------------------------------ |
| Pipeline classifier prompt/parse      | PASS            | 2026-03-26    | Prompt building, JSON parsing, markdown fence stripping                                    |
| Pipeline orchestrator                 | PASS            | 2026-03-26    | Parallel/sequential modes, short-circuit, fan-out                                          |
| Pipeline config resolution            | PASS            | 2026-04-01    | Live PUT-to-execution path now covered; pipeline block mapping fixed                       |
| Pipeline circuit breaker (per-tenant) | PASS            | 2026-03-26    | LRU eviction, threshold, reset, half-open                                                  |
| Pipeline tool filter                  | PASS            | 2026-03-26    | LLM-based tool selection                                                                   |
| NLU sidecar client extract/correction | PASS            | 2026-03-26    | HTTP calls, JSON parsing, timeout handling                                                 |
| Sidecar circuit breaker               | PASS            | 2026-03-26    | Threshold transitions, probe behavior, reset                                               |
| Half-open probe                       | PASS            | 2026-03-26    | Dedicated test file for probe edge cases                                                   |
| Per-session sidecar creation          | PASS            | 2026-03-26    | Config-driven client instantiation                                                         |
| Sidecar wiring in executor            | PASS            | 2026-03-26    | Runtime executor creates sidecar from project config                                       |
| NLU provider gating (Enterprise)      | PASS            | 2026-03-26    | Plan enforcement at route level                                                            |
| Tenant config NLU flags               | PASS            | 2026-03-26    | advancedNlu per plan tier                                                                  |
| Project runtime config NLU route      | PASS            | 2026-04-01    | GET/PUT path now participates in a live execution regression                               |
| Multi-intent strategy                 | PASS            | 2026-03-26    | Strategy resolution by agent type and relationship                                         |
| Intent queue operations               | PASS            | 2026-03-26    | Enqueue, dequeue, dedup, expire, max size                                                  |
| Multi-intent integration              | PASS            | 2026-04-01    | Dispatch flow with routing executor plus guided HTTP path                                  |
| Entity extraction / semantic entities | SEE CHILD GUIDE | 2026-04-15    | Canonical parser/compiler/runtime observation coverage now lives in `entity-extraction.md` |
| Extraction strategy selection         | PASS            | 2026-03-26    | Auto, LLM, regex, sidecar paths                                                            |
| Post-extraction conversion            | PASS            | 2026-03-26    | Currency/unit conversion                                                                   |
| Post-extraction inference             | PASS            | 2026-03-26    | Field inference from extracted data                                                        |
| Post-extraction lookup                | PASS            | 2026-03-26    | Lookup table matching                                                                      |
| Currency rate client                  | PASS            | 2026-03-26    | Live fetch, cache, static fallback                                                         |
| nl-parser ABL generation              | PASS            | 2026-03-26    | Agent and supervisor ABL generation                                                        |
| Flow intent detection                 | PASS            | 2026-03-26    | Constraints, digressions, queued intents                                                   |
| Pinned intent enforcement             | PASS            | 2026-03-26    | Pinned intent validation                                                                   |
| On-input multi-intent invariant       | PASS            | 2026-03-26    | Multi-intent invariant at input boundary                                                   |
| Delegation intent isolation           | PASS            | 2026-03-26    | Intent isolation across delegations                                                        |
| Extraction tool call                  | PASS            | 2026-03-26    | Tool-call-based entity extraction                                                          |
| Extraction decision traces            | PASS            | 2026-03-26    | TraceEvent emission for extraction decisions                                               |
| JS extraction (email/currency)        | PASS            | 2026-03-26    | Regex-based email and currency extraction                                                  |
| Pipeline intent bridge                | PASS            | 2026-04-01    | Target-aware bridge exercised in live guided multi-intent flow                             |
| Pipeline tiered resolver              | PASS            | 2026-03-26    | Tiered NLU resolution (306 lines)                                                          |
| Pipeline comparison                   | PASS            | 2026-03-26    | Pipeline result comparison/ranking (866 lines)                                             |
| Pipeline filler                       | PASS            | 2026-03-26    | Pipeline slot filling                                                                      |
| Reasoning pipeline bridge             | PASS            | 2026-04-01    | Guided planning + merge exercised in live HTTP flow                                        |
| Handoff resume intent                 | PASS            | 2026-03-26    | Intent handling on handoff resume (336 lines)                                              |
| DB NLU provider config                | PASS            | 2026-03-26    | Prisma project runtime config NLU provider test                                            |
| Pipeline config E2E (pseudo)          | PASS            | 2026-03-26    | Config E2E-style test, no real HTTP (1,055 lines)                                          |
| E2E: full pipeline via HTTP           | PARTIAL         | 2026-04-01    | Guided multi-intent via `/api/v1/chat/agent`; other scenario families pending              |
| E2E: sidecar with real ML service     | NOT IMPL        | -             | Tests mock fetch, no real sidecar                                                          |

---

## Audit Scope

This guide covers:

- Pipeline classifier (LLM intent classification, short-circuit routing)
- Pipeline orchestrator (parallel/sequential modes, fan-out detection)
- Pipeline infrastructure (config resolution, circuit breaker, tool filter, merge)
- NLU sidecar client (entity extraction, correction detection, circuit breaker)
- Multi-intent system (strategy resolution, intent queue, dispatch)
- Entity extraction pipeline (tiered strategy, post-extraction processing)
- Currency conversion client
- nl-parser (NL-to-ABL extraction and generation)

---

## Coverage Matrix

> Canonical split (2026-04-15): use [docs/testing/entity-extraction.md](./entity-extraction.md) for `ENTITIES`, `ENTITY_REF`, runtime observations, intrinsic validation, and semantic entity trace coverage.

| FR    | Description                                                       | Unit | Integration | E2E     | Manual | Status  |
| ----- | ----------------------------------------------------------------- | ---- | ----------- | ------- | ------ | ------- |
| FR-1  | Pipeline classifier classifies intents via fast LLM call          | YES  | NO          | PARTIAL | NO     | PARTIAL |
| FR-2  | Short-circuit routing (single intent, high confidence, no veto)   | YES  | NO          | NO      | NO     | PARTIAL |
| FR-3  | Multi-intent fan-out short-circuit                                | YES  | YES         | NO      | NO     | PARTIAL |
| FR-4  | Multi-intent strategy handling (queue/sequential/parallel/disamb) | YES  | YES         | PARTIAL | NO     | PARTIAL |
| FR-5  | Sidecar entity extraction and correction detection                | YES  | NO          | NO      | NO     | PARTIAL |
| FR-6  | Sidecar circuit breaker state transitions                         | YES  | NO          | NO      | NO     | PARTIAL |
| FR-7  | Enterprise plan gating for advanced NLU                           | YES  | NO          | NO      | NO     | PARTIAL |
| FR-8  | Pipeline per-tenant circuit breaker                               | YES  | NO          | NO      | NO     | PARTIAL |
| FR-9  | Intent queue operations (enqueue, dequeue, prune, max size)       | YES  | NO          | NO      | NO     | PARTIAL |
| FR-10 | nl-parser agent/supervisor extraction and ABL generation          | YES  | NO          | NO      | NO     | PARTIAL |
| FR-11 | Pipeline config resolution cascade                                | YES  | NO          | PARTIAL | NO     | PARTIAL |
| FR-12 | Pipeline merge module for fan-out response synthesis              | YES  | NO          | PARTIAL | NO     | PARTIAL |

---

## E2E Test Scenarios (MANDATORY) — guided multi-intent HTTP slice partially implemented

> **Status**: `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts` now provides a real HTTP regression for the guided multi-intent path. It does not replace the full matrix below: single-intent short-circuit, sidecar extraction, keyword veto, classifier-failure fallback, and circuit-breaker flows still do not have real HTTP E2E coverage. `pipeline-config.e2e.test.ts` remains a useful in-process config test, but it is not a substitute for the public-API regressions below.

### E2E-1: Single-intent short-circuit routing via WebSocket

**Preconditions**: Runtime running on random port. Project with pipeline enabled (`pipeline.enabled=true`), supervisor agent with two sub-agents (billing, support), pipeline model configured. Project runtime config created in DB with `tenantId + projectId`.

**Steps**:

1. POST `/api/projects/:projectId/runtime-config` to configure pipeline enabled with `shortCircuit.enabled=true`, `confidenceThreshold=0.85`.
2. Open WebSocket connection to runtime with valid auth token for the tenant/project.
3. Send user message: "I need help with my billing invoice" (clear single-intent message targeting the billing agent).
4. Receive WebSocket response and verify:
   - The response came from the billing sub-agent (not the supervisor's reasoning loop).
   - `pipeline_classify` trace event was emitted with latencyMs < 10000.
   - `pipeline_short_circuit` trace event was emitted with `target: "billing"` and `confidence >= 0.85`.

**Expected Result**: Message routed directly to billing agent without entering supervisor reasoning loop. Response time significantly faster than non-pipeline path.

**Auth Context**: Tenant T1, Project P1, User U1 with `agent:execute` permission.

**Isolation Check**: Sending the same message with Tenant T2 credentials returns 404 for the project.

---

### E2E-2: Multi-intent fan-out via supervisor

> **Status (2026-04-15)**: Implemented via a public HTTP chat variant in `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`. The current regression verifies the guided multi-intent path (`pipeline_classify` -> `pipeline_tiered_action` -> `pipeline_multi_intent` -> `pipeline_merge`) through `/api/v1/chat/agent`. Direct pipeline multi-intent short-circuit over WebSocket remains unimplemented.

**Preconditions**: Same as E2E-1, but supervisor has three sub-agents (billing, shipping, support). Pipeline enabled.

**Steps**:

1. Open WebSocket connection to runtime with valid auth.
2. Send compound message: "Check my billing status and give me my shipping tracking number".
3. Receive WebSocket response and verify:
   - `pipeline_multi_intent_short_circuit` trace event emitted with `targets: ["billing", "shipping"]`.
   - Both sub-agents produced responses.
   - The final response is a merged synthesis (from `pipeline_merge`) combining billing and shipping information.

**Expected Result**: Both sub-agents receive their respective sub-requests. Responses are merged into a single coherent reply.

**Auth Context**: Tenant T1, Project P1, User U1.

**Isolation Check**: Different project under same tenant cannot access this supervisor agent configuration.

---

### E2E-3: NLU sidecar entity extraction in gather mode

**Preconditions**: Runtime on random port. Project runtime config with `nlu_provider: "advanced"`, `advanced_sidecar_url` pointing to a running NLU sidecar instance (or test double serving the `/extract` endpoint). Tenant plan is ENTERPRISE. Agent in gather mode collecting `{name, email, date_of_birth}`.

**Steps**:

1. PUT `/api/projects/:projectId/runtime-config` with `extraction.nlu_provider: "advanced"`, `extraction.advanced_sidecar_url: "http://localhost:<sidecar_port>"`.
2. Open WebSocket connection and send message: "My name is John Smith, email john@example.com, born on March 15 1990".
3. Verify that the sidecar `/extract` endpoint was called (via test double request log or trace events).
4. Verify extracted entities populate the gather fields: `name: "John Smith"`, `email: "john@example.com"`, `date_of_birth: "1990-03-15"`.

**Expected Result**: Sidecar called for entity extraction. Gather fields populated with structured extracted values.

**Auth Context**: Tenant T1 (Enterprise plan), Project P1, User U1.

**Isolation Check**: Tenant T2 (BUSINESS plan) attempting the same config PUT gets 403 for `nlu_provider: "advanced"`.

---

### E2E-4: Pipeline classifier fallback on LLM error

**Preconditions**: Runtime on random port. Pipeline enabled but configured with a non-existent model name (to force LLM call failure). Supervisor agent with sub-agents.

**Steps**:

1. Configure project pipeline with `model: "nonexistent-model-xxx"` (or similar that will cause the `generateText` call to fail).
2. Open WebSocket connection and send message: "I need billing help".
3. Verify:
   - The classifier LLM call failed (pipeline-classifier WARN log emitted).
   - The system fell through to the full reasoning loop (no short-circuit occurred).
   - The supervisor agent processed the message via its normal reasoning path and produced a valid response.

**Expected Result**: Pipeline failure is graceful. System falls through to reasoning loop. User receives a response (possibly slower, but correct).

**Auth Context**: Tenant T1, Project P1, User U1.

**Isolation Check**: N/A (failure path testing).

---

### E2E-5: Keyword veto prevents short-circuit

**Preconditions**: Runtime on random port. Pipeline enabled. Supervisor agent with `billing` sub-agent and in-agent tool `process_refund`. Pipeline `keywordVeto.enabled: true`.

**Steps**:

1. Open WebSocket connection and send message: "I need a refund for my billing issue" (contains "refund" which matches tool name `process_refund`).
2. Verify:
   - `pipeline_keyword_veto` trace event emitted with `matchedKeywords: ["refund"]` and `vetoedTarget: "billing"`.
   - Message was NOT short-circuited to billing agent.
   - Message was processed through the supervisor's reasoning loop instead.

**Expected Result**: Keyword veto prevents premature routing. The supervisor's reasoning loop handles the request, allowing it to decide whether to route or use the in-agent refund tool.

**Auth Context**: Tenant T1, Project P1, User U1.

**Isolation Check**: N/A (behavioral testing).

---

### E2E-6: Sidecar circuit breaker opens after consecutive failures

**Preconditions**: Runtime on random port. Project runtime config with `nlu_provider: "advanced"`, sidecar URL pointing to a test double that returns 500 errors. Agent in gather mode.

**Steps**:

1. Configure sidecar circuit breaker threshold to 3 (for faster test).
2. Send 3 consecutive gather-mode messages. Each triggers a sidecar `/extract` call that returns 500.
3. Verify sidecar client circuit breaker transitions to OPEN (WARN log emitted).
4. Send a 4th gather-mode message.
5. Verify the sidecar is NOT called (circuit is open, request skipped at DEBUG log level).
6. Verify entity extraction falls back to LLM-based extraction (the gather still works, just without sidecar).

**Expected Result**: After 3 failures, circuit opens. Subsequent requests skip sidecar and use LLM fallback. System remains functional.

**Auth Context**: Tenant T1 (Enterprise), Project P1, User U1.

**Isolation Check**: N/A (resilience testing).

---

### E2E-7: Project runtime config CRUD with tenant isolation

**Preconditions**: Runtime on random port. Two tenants (T1, T2) each with their own project.

**Steps**:

1. PUT `/api/projects/:projectIdT1/runtime-config` as Tenant T1 with NLU config `{ extraction: { nlu_provider: "standard" }, multi_intent: { strategy: "sequential" } }`.
2. GET `/api/projects/:projectIdT1/runtime-config` as Tenant T1. Verify the saved config is returned.
3. GET `/api/projects/:projectIdT1/runtime-config` as Tenant T2. Verify 404 (cross-tenant isolation).
4. PUT `/api/projects/:projectIdT1/runtime-config` as Tenant T2. Verify 404 (cannot modify other tenant's config).
5. PUT `/api/projects/:projectIdT2/runtime-config` as Tenant T2 with different NLU config. Verify success.
6. GET `/api/projects/:projectIdT2/runtime-config` as Tenant T2. Verify T2's config is independent from T1's.

**Expected Result**: Each tenant can only read/write their own project's runtime config. Cross-tenant access returns 404.

**Auth Context**: Tenant T1 User U1 and Tenant T2 User U2, both with `project:write` permission.

**Isolation Check**: This IS the isolation test.

---

## Integration Test Scenarios (MANDATORY)

### INT-1: Pipeline config resolution cascade

**Boundary**: `config.ts` + IR types + project runtime config resolver

**Setup**: Agent IR with partial pipeline config. Project runtime config with partial overrides. Default config.

**Steps**:

1. Create agent IR with `execution.pipeline = { enabled: true, model: 'gpt-4.1-mini' }` (partial — no shortCircuit, no toolFilter).
2. Create project pipeline config with `{ shortCircuit: { confidenceThreshold: 0.9 } }` (partial — no enabled, no model).
3. Call `resolvePipelineConfig(agentExecution, projectPipeline)`.
4. Verify resolved config:
   - `enabled: true` (from agent IR)
   - `model: 'gpt-4.1-mini'` (from agent IR)
   - `shortCircuit.confidenceThreshold: 0.9` (from project override)
   - `shortCircuit.enabled: true` (from defaults)
   - `toolFilter.enabled: true` (from defaults)
   - `keywordVeto.enabled: true` (from defaults)

**Expected Result**: Three-level cascade resolves correctly. Agent IR takes precedence over project, project takes precedence over defaults.

**Failure Mode**: Missing config at one level should fall through to next level, never error.

---

### INT-2: Sidecar client circuit breaker full lifecycle

**Boundary**: `NLUSidecarClient` + HTTP server test double

**Setup**: Start a minimal HTTP server as sidecar test double. Create `NLUSidecarClient` with `circuitBreakerThreshold: 2`, `circuitBreakerResetMs: 500`.

**Steps**:

1. Configure test double to return 200 with valid extraction JSON. Call `client.extract()`. Verify success. Circuit state: CLOSED.
2. Configure test double to return 500. Call `client.extract()` twice. Verify both return null. Circuit state: OPEN.
3. Immediately call `client.extract()`. Verify null returned without HTTP call (circuit is open, request short-circuited).
4. Wait 600ms (> resetMs). Call `client.extract()`. Verify HTTP call is made (circuit in HALF_OPEN). Test double still returns 500. Verify null returned. Circuit state: OPEN again.
5. Wait 600ms again. Configure test double to return 200. Call `client.extract()`. Verify success. Circuit state: CLOSED.

**Expected Result**: Full CLOSED -> OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED lifecycle.

**Failure Mode**: If test double is unreachable, circuit opens. When recovered, half-open probe re-closes.

---

### INT-3: Multi-intent strategy resolution with routing executor

**Boundary**: `multi-intent-strategy.ts` + `routing-executor.ts`

**Setup**: Supervisor agent IR with two sub-agents. ClassifierResult with 2 intents (independent relationship).

**Steps**:

1. Create supervisor agent context with `multiIntent.strategy: 'auto'`.
2. Build ClassifierResult with 2 intents: `[{target: "billing", confidence: 0.95}, {target: "shipping", confidence: 0.9}]`.
3. Resolve strategy via `resolveStrategy('auto', 'supervisor', 'independent')`. Verify result: `'parallel'`.
4. Same test with `agentType: 'scripted'`. Verify result: `'sequential'` (downgraded).
5. Same test with `declared: 'parallel'` and `agentType: 'reasoning'`. Verify result: `'sequential'` (downgraded).

**Expected Result**: Strategy resolution respects agent type constraints. Supervisors get parallel, non-supervisors get sequential.

**Failure Mode**: N/A (pure function, no failure modes).

---

### INT-4: Intent queue operations with session serialization

**Boundary**: `intent-queue.ts` + session state serialization

**Setup**: Create intent queue, perform operations, serialize to JSON, deserialize, verify state preserved.

**Steps**:

1. `createIntentQueue()` -> empty queue.
2. `enqueueIntents(queue, [{intent: "billing", confidence: 0.9, original_message: "billing help"}, {intent: "shipping", confidence: 0.7, original_message: "shipping help"}])`.
3. Verify `queue.pending.length === 2`. Verify sorted by confidence descending (billing first).
4. `JSON.stringify(queue)` -> serialize. `JSON.parse(serialized)` -> deserialize.
5. Verify deserialized queue has same entries.
6. `enqueueIntents(deserializedQueue, [{intent: "billing", confidence: 0.95, original_message: "updated billing"}])`.
7. Verify deduplication: still 2 entries, billing confidence updated to 0.95.
8. `dequeueNext(queue)` -> verify returns billing (highest confidence).
9. `pruneExpired(queue, 0)` -> verify removes all remaining entries (maxAge=0 means everything is expired).

**Expected Result**: Queue operations are correct and survive JSON serialization round-trip.

**Failure Mode**: N/A (pure functions).

---

### INT-5: Pipeline per-tenant circuit breaker isolation

**Boundary**: `circuit-breaker.ts`

**Setup**: Two different tenantIds.

**Steps**:

1. Record 3 pipeline failures for tenant T1 via `recordPipelineFailure('T1')`.
2. Verify `isPipelineCircuitOpen('T1')` returns `true` (circuit open for T1).
3. Verify `isPipelineCircuitOpen('T2')` returns `false` (circuit closed for T2, independent).
4. Record 1 failure for T2. Verify `isPipelineCircuitOpen('T2')` returns `false` (below threshold).
5. Record `recordPipelineSuccess('T1')` — this shouldn't affect T2.
6. Wait 60s (or mock time). Verify T1 circuit transitions to half-open.

**Expected Result**: Circuit breaker state is fully isolated per tenant. One tenant's failures do not affect another.

**Failure Mode**: If LRU eviction occurs (> 500 tenants), oldest tenant's breaker state is lost (acceptable — resets to closed).

---

### INT-6: NLU provider plan gating enforcement

**Boundary**: Runtime route + tenant config + project runtime config

**Setup**: Two tenants — T1 on ENTERPRISE plan, T2 on BUSINESS plan.

**Steps**:

1. PUT `/api/projects/:projectId/runtime-config` as T1 with `nlu_provider: "advanced"`. Verify 200 OK.
2. PUT `/api/projects/:projectId/runtime-config` as T2 with `nlu_provider: "advanced"`. Verify 403 (BUSINESS plan does not allow advanced NLU).
3. PUT `/api/projects/:projectId/runtime-config` as T2 with `nlu_provider: "standard"`. Verify 200 OK (standard is allowed for all plans).

**Expected Result**: Enterprise plan gates are enforced at the API level.

**Failure Mode**: Non-Enterprise tenant attempting to set advanced NLU provider gets 403.

---

### INT-7: nl-parser extraction with Zod validation

**Boundary**: `extractor.ts` + `types.ts` Zod schemas

**Setup**: Mock Anthropic API response with valid agent extraction JSON.

**Steps**:

1. Create mock Anthropic response with agent extraction JSON matching `AgentExtractionSchema`.
2. Call `extractor.extractAgent(sopText)` with the mock.
3. Verify the returned `AgentExtraction` passes Zod validation.
4. Verify steps have correct `action_type` enum values.
5. Call `generator.generateAgentABL(extraction)`. Verify valid ABL DSL string is produced.
6. Test with malformed response (missing required fields). Verify Zod validation throws.

**Expected Result**: Extraction + validation + generation pipeline produces correct ABL from NL input.

**Failure Mode**: Malformed API response causes Zod validation error (caught by caller).

---

## Unit Test Scenarios

### Unit and integration tests — 44 test files, ~14,600 lines

| Module                         | Test File(s)                                                                                | Type        | Lines | Key Scenarios                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ----------- | ----- | ----------------------------------------------------------------- |
| Pipeline classifier            | `pipeline-classifier.test.ts`                                                               | unit        | 167   | Prompt building, JSON parsing, markdown stripping, fallback       |
| Pipeline orchestrator          | `pipeline-executor.test.ts`                                                                 | unit        | 244   | Parallel/sequential modes, short-circuit, fan-out, tool filtering |
| Pipeline config                | `pipeline-config.test.ts`                                                                   | unit        | 188   | Cascade resolution, defaults, partial overrides                   |
| Pipeline config (pseudo-E2E)   | `pipeline-config.e2e.test.ts`                                                               | e2e-style   | 1,055 | Config resolution end-to-end (in-process, no HTTP)                |
| Pipeline circuit breaker       | `pipeline-circuit-breaker.test.ts`                                                          | unit        | 124   | Per-tenant isolation, LRU eviction, threshold, reset              |
| Pipeline tool filter           | `pipeline-tool-filter.test.ts`                                                              | unit        | 62    | Tool selection, fallback, max tools                               |
| Pipeline intent bridge         | `pipeline-intent-bridge.test.ts`                                                            | unit        | 345   | Pipeline-to-intent system bridge                                  |
| Pipeline tiered resolver       | `pipeline-tiered-resolver.test.ts`                                                          | unit        | 306   | Tiered NLU provider resolution                                    |
| Pipeline comparison            | `pipeline-comparison.test.ts`                                                               | unit        | 866   | Pipeline result comparison and ranking                            |
| Pipeline filler                | `pipeline-filler.test.ts`                                                                   | unit        | 99    | Pipeline slot filling                                             |
| Sidecar client                 | `nlu-sidecar-client.test.ts`                                                                | unit        | 339   | Extract, correction, circuit breaker, timeout                     |
| Sidecar half-open              | `nlu-sidecar-half-open-probe.test.ts`                                                       | unit        | 243   | Probe success/failure, single probe concurrency                   |
| Sidecar per-session            | `nlu-sidecar-per-session.test.ts`                                                           | unit        | 70    | Config-driven creation, standard skip, missing URL skip           |
| Sidecar wiring                 | `nlu-sidecar-wiring.test.ts`                                                                | unit        | 47    | Runtime executor sidecar creation from session IR                 |
| Provider gating                | `nlu-provider-gating.test.ts`                                                               | unit        | 119   | Enterprise required, non-Enterprise rejected                      |
| Tenant config NLU              | `tenant-config-advanced-nlu.test.ts`                                                        | unit        | 23    | advancedNlu flag per plan tier                                    |
| Runtime config route           | `project-runtime-config-route-nlu.test.ts`                                                  | unit        | 83    | CRUD, validation, defaults                                        |
| Multi-intent strategy          | `multi-intent-strategy.test.ts`                                                             | unit        | 42    | Auto/parallel/sequential/disambiguate, agent type constraints     |
| Intent queue                   | `intent-queue.test.ts`, `intent-queue-expanded.test.ts`, `intent-queue-max-intents.test.ts` | unit        | 475   | Enqueue, dequeue, dedup, expire, max size, edge cases             |
| Routing + multi-intent         | `routing-executor-multi-intent.test.ts`                                                     | unit        | 998   | Multi-intent dispatch via routing executor                        |
| Extraction pipeline            | `extraction-pipeline.test.ts`                                                               | unit        | 529   | Tiered extraction flow                                            |
| Extraction strategy            | `extraction-strategy.test.ts`                                                               | unit        | 338   | Auto-selection                                                    |
| Extraction tool call           | `extraction-tool-call.test.ts`                                                              | unit        | 325   | Tool-call-based extraction                                        |
| Extraction decision traces     | `extraction-decision-traces.test.ts`                                                        | unit        | 523   | Decision trace events                                             |
| Post-extraction conversion     | `post-extraction-conversion.test.ts`                                                        | unit        | 146   | Currency/unit conversion                                          |
| Post-extraction inference      | `post-extraction-inference.test.ts`                                                         | unit        | 296   | Field inference from extracted data                               |
| Post-extraction lookup         | `post-extraction-lookup.test.ts`                                                            | unit        | 199   | Lookup table matching                                             |
| JS extraction (email/currency) | `js-extraction-email-currency.test.ts`                                                      | unit        | 247   | Regex-based email and currency extraction                         |
| Currency client                | `currency-rate-client.test.ts`                                                              | unit        | 136   | Live fetch, cache TTL, static fallback                            |
| nl-parser generation           | `packages/nl-parser/src/__tests__/generator.test.ts`                                        | unit        | 562   | Agent ABL, supervisor ABL, legacy exports                         |
| DB NLU provider config         | `packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts`               | unit        | 129   | Prisma project runtime config NLU provider                        |
| Flow intent constraints        | `flow-detect-intent-constraints.test.ts`                                                    | unit        | 684   | Flow intent detection, constraints                                |
| Flow intents digressions       | `flow-intents-digressions.test.ts`                                                          | unit        | 364   | Intent digressions in flow execution                              |
| Flow queued intents            | `flow-queued-intents.test.ts`                                                               | unit        | 626   | Queued intent handling within flows                               |
| Pinned intent enforcement      | `pinned-intent-enforcement.test.ts`                                                         | unit        | 144   | Pinned intent validation and enforcement                          |
| On-input multi-intent          | `on-input-multi-intent-invariant.test.ts`                                                   | unit        | 59    | Multi-intent invariant at input boundary                          |
| Delegation intent isolation    | `delegation-intent-isolation.test.ts`                                                       | unit        | 62    | Intent isolation across delegations                               |
| Reasoning pipeline bridge      | `reasoning-pipeline-bridge.test.ts`                                                         | unit        | 724   | Bridge between reasoning engine and NLU pipeline                  |
| Handoff resume intent          | `handoff-resume-intent.test.ts`                                                             | unit        | 336   | Intent handling on handoff resume                                 |
| Multi-intent integration       | `multi-intent-integration.test.ts`                                                          | integration | 676   | Dispatch flow with routing executor                               |
| Multi-intent executor integ.   | `multi-intent-executor-integration.test.ts`                                                 | integration | 733   | Executor-level multi-intent dispatch                              |
| Multi-intent dispatch wiring   | `multi-intent-dispatch-wiring.test.ts`                                                      | integration | 78    | Dispatch wiring verification                                      |
| Sidecar config wiring          | `sidecar-config-wiring.test.ts`                                                             | integration | 243   | Runtime sidecar creation from project config                      |

---

## Security & Isolation Tests

- [x] Cross-tenant access to project runtime config returns 404 (E2E-7)
- [x] Enterprise plan gating returns 403 for non-Enterprise tenants (E2E-3, INT-6)
- [ ] Cross-project access to NLU config returns 404 (scenario defined but not implemented)
- [ ] Missing auth returns 401 for runtime config endpoints (scenario defined but not implemented)
- [x] Pipeline circuit breaker isolation per tenant (INT-5)
- [ ] Input validation rejects malformed pipeline config (unit tests exist)

---

## Performance & Load Tests

Not currently implemented. Recommended scenarios:

1. Pipeline classifier latency under load (100 concurrent classifications)
2. Sidecar circuit breaker behavior under sustained failure (50 requests/sec with sidecar down)
3. Intent queue max size enforcement with rapid concurrent enqueue operations

---

## Test Infrastructure

### Required Services

- Runtime (Express on random port)
- MongoDB (for project runtime config persistence)
- NLU sidecar test double (minimal HTTP server returning mock responses)
- No external LLM required for unit tests (mocked via Vercel AI SDK)

### Data Seeding

- Tenant records with appropriate plan tiers (FREE, ENTERPRISE)
- Project records with `tenantId + projectId` scope
- Agent IR with pipeline configuration
- Project runtime config documents

### Environment Variables

| Variable                | Required For       | Notes                           |
| ----------------------- | ------------------ | ------------------------------- |
| `ENCRYPTION_MASTER_KEY` | Runtime startup    | Required for session encryption |
| `ANTHROPIC_API_KEY`     | nl-parser E2E only | Only for real extraction tests  |
| `NLU_SIDECAR_URL`       | Sidecar E2E only   | Sidecar test double URL         |

---

## Test File Mapping

| Test File                                                                     | Type        | Lines | Covers                                         |
| ----------------------------------------------------------------------------- | ----------- | ----- | ---------------------------------------------- |
| `apps/runtime/src/__tests__/pipeline-classifier.test.ts`                      | unit        | 167   | FR-1, FR-2                                     |
| `apps/runtime/src/__tests__/pipeline-executor.test.ts`                        | unit        | 244   | FR-1, FR-2, FR-3                               |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`                          | unit        | 188   | FR-11                                          |
| `apps/runtime/src/__tests__/pipeline-config.e2e.test.ts`                      | e2e-style   | 1,055 | FR-11                                          |
| `apps/runtime/src/__tests__/pipeline-circuit-breaker.test.ts`                 | unit        | 124   | FR-8                                           |
| `apps/runtime/src/__tests__/pipeline-tool-filter.test.ts`                     | unit        | 62    | FR-1 (tool filter)                             |
| `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`                   | unit        | 345   | FR-1, FR-2                                     |
| `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`                 | unit        | 306   | FR-11                                          |
| `apps/runtime/src/__tests__/pipeline-comparison.test.ts`                      | unit        | 866   | FR-1, FR-3                                     |
| `apps/runtime/src/__tests__/pipeline-filler.test.ts`                          | unit        | 99    | FR-5                                           |
| `apps/runtime/src/__tests__/nlu-sidecar-client.test.ts`                       | unit        | 339   | FR-5, FR-6                                     |
| `apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts`              | unit        | 243   | FR-6                                           |
| `apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts`                  | unit        | 70    | FR-5                                           |
| `apps/runtime/src/__tests__/nlu-sidecar-wiring.test.ts`                       | unit        | 47    | FR-5                                           |
| `apps/runtime/src/__tests__/nlu-provider-gating.test.ts`                      | unit        | 119   | FR-7                                           |
| `apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`               | unit        | 23    | FR-7                                           |
| `apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`         | unit        | 83    | FR-7, FR-11                                    |
| `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`          | unit        | 308   | FR-11                                          |
| `apps/runtime/src/__tests__/multi-intent-strategy.test.ts`                    | unit        | 42    | FR-4                                           |
| `apps/runtime/src/__tests__/intent-queue.test.ts`                             | unit        | 76    | FR-9                                           |
| `apps/runtime/src/__tests__/intent-queue-expanded.test.ts`                    | unit        | 336   | FR-9                                           |
| `apps/runtime/src/__tests__/intent-queue-max-intents.test.ts`                 | unit        | 63    | FR-9                                           |
| `apps/runtime/src/__tests__/routing-executor-multi-intent.test.ts`            | unit        | 998   | FR-3, FR-4                                     |
| `apps/runtime/src/__tests__/extraction-pipeline.test.ts`                      | unit        | 529   | FR-5                                           |
| `apps/runtime/src/__tests__/extraction-strategy.test.ts`                      | unit        | 338   | FR-5                                           |
| `apps/runtime/src/__tests__/extraction-tool-call.test.ts`                     | unit        | 325   | FR-5                                           |
| `apps/runtime/src/__tests__/extraction-decision-traces.test.ts`               | unit        | 523   | FR-5                                           |
| `apps/runtime/src/__tests__/post-extraction-conversion.test.ts`               | unit        | 146   | FR-5                                           |
| `apps/runtime/src/__tests__/post-extraction-inference.test.ts`                | unit        | 296   | FR-5                                           |
| `apps/runtime/src/__tests__/post-extraction-lookup.test.ts`                   | unit        | 199   | FR-5                                           |
| `apps/runtime/src/__tests__/js-extraction-email-currency.test.ts`             | unit        | 247   | FR-5                                           |
| `apps/runtime/src/__tests__/currency-rate-client.test.ts`                     | unit        | 136   | FR-5                                           |
| `apps/runtime/src/__tests__/flow-detect-intent-constraints.test.ts`           | unit        | 684   | FR-1, FR-2                                     |
| `apps/runtime/src/__tests__/flow-intents-digressions.test.ts`                 | unit        | 364   | FR-1                                           |
| `apps/runtime/src/__tests__/flow-queued-intents.test.ts`                      | unit        | 626   | FR-9                                           |
| `apps/runtime/src/__tests__/pinned-intent-enforcement.test.ts`                | unit        | 144   | FR-1                                           |
| `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`          | unit        | 59    | FR-3, FR-4                                     |
| `apps/runtime/src/__tests__/delegation-intent-isolation.test.ts`              | unit        | 62    | FR-1                                           |
| `apps/runtime/src/__tests__/reasoning-pipeline-bridge.test.ts`                | unit        | 724   | FR-1, FR-12                                    |
| `apps/runtime/src/__tests__/handoff-resume-intent.test.ts`                    | unit        | 336   | FR-1                                           |
| `packages/nl-parser/src/__tests__/generator.test.ts`                          | unit        | 562   | FR-10                                          |
| `packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts` | unit        | 129   | FR-7, FR-11                                    |
| `apps/runtime/src/__tests__/multi-intent-integration.test.ts`                 | integration | 676   | FR-3, FR-4                                     |
| `apps/runtime/src/__tests__/multi-intent-executor-integration.test.ts`        | integration | 733   | FR-3, FR-4                                     |
| `apps/runtime/src/__tests__/multi-intent-dispatch-wiring.test.ts`             | integration | 78    | FR-3, FR-4                                     |
| `apps/runtime/src/__tests__/sidecar-config-wiring.test.ts`                    | integration | 243   | FR-5, FR-7                                     |
| `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`                   | e2e         | 647   | FR-1, FR-4, FR-11, FR-12                       |
| Remaining planned E2E scenarios                                               | planned     | 0     | FR-1 through FR-12 — **PARTIALLY IMPLEMENTED** |

---

## Coverage Gaps

> **Summary (2026-04-15 audit)**: Unit coverage remains extensive and integration coverage remains moderate. E2E coverage is now limited, not zero: one deterministic HTTP E2E file covers the guided multi-intent classifier/bridge/merge path plus live runtime-config-to-execution wiring. Most planned scenario families are still unimplemented, and sidecar / short-circuit / failure-mode HTTP coverage is still absent.

| Gap                                                          | Severity | Notes                                                                                                                       |
| ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Most planned E2E scenarios are still missing**             | **High** | One guided multi-intent HTTP slice exists, but the rest of E2E-1 through E2E-7 remain absent or only partially covered      |
| Only one HTTP E2E path exercises the NLU pipeline            | High     | Guided multi-intent via `/api/v1/chat/agent` is covered; single-intent, sidecar, veto, and fallback paths are still missing |
| No test with real NLU sidecar service                        | High     | All sidecar tests mock fetch                                                                                                |
| No test for classifier with real LLM call                    | Medium   | Classifier tests mock generateText                                                                                          |
| No HTTP E2E for queue/sequential/disambiguate multi-intent   | Medium   | The live regression covers guided `parallel` only                                                                           |
| No test for correction detection with real sidecar           | Medium   | detectCorrection mocks the HTTP response                                                                                    |
| No test for pipeline merge with real LLM                     | Medium   | Merge module tests mock generateText/streamText                                                                             |
| No test for nl-parser extractAgent with real Anthropic API   | Low      | Requires API key, not suitable for CI                                                                                       |
| No test for concurrent sidecar requests with circuit breaker | Low      | Circuit breaker tested serially only                                                                                        |

---

## Open Testing Questions

1. Should E2E tests use a real NLU sidecar (Docker container) or a minimal HTTP test double?
2. Should classifier E2E tests use a real LLM (adds cost/flakiness) or a deterministic test double?
3. Should pipeline merge tests validate response quality (subjective) or just verify the merge call completes?

---

## How to Run

```bash
# All NLU-related tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "nlu\|sidecar\|intent\|classifier\|extraction\|pipeline"

# Pipeline tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/pipeline-classifier.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/pipeline-executor.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/pipeline-config.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/pipeline-circuit-breaker.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/pipeline-tool-filter.test.ts

# NLU sidecar tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/nlu-sidecar-client.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts

# Multi-intent tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/multi-intent-strategy.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/intent-queue.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/multi-intent-integration.test.ts

# Extraction tests
pnpm test --filter=runtime -- apps/runtime/src/__tests__/extraction-pipeline.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/extraction-strategy.test.ts

# nl-parser tests
pnpm build --filter=nl-parser && pnpm test --filter=nl-parser
```
