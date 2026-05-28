# NLU / Intent Classification & Entity Extraction — Low-Level Design + Implementation Plan

**Feature**: NLU
**Date**: 2026-03-22
**Last Updated**: 2026-03-26
**Feature Spec**: [docs/features/nlu.md](../features/nlu.md)
**HLD**: [docs/specs/nlu.hld.md](../specs/nlu.hld.md)
**Test Spec**: [docs/testing/nlu.md](../testing/nlu.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                                 | Rationale                                                                                 | Alternatives Rejected                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pipeline classifier uses separate fast model (qwen3-30b) | Sub-second classification; primary LLM is too slow for routing                            | Using primary LLM (too slow); using embeddings (lower accuracy for routing)                            |
| Keyword veto uses word-boundary regex                    | Simple, predictable, low latency                                                          | NLP-based detection (too heavy for a veto check); no veto (risks premature routing)                    |
| Sidecar circuit breaker is per-client instance           | Each session gets its own client from config; no cross-session state leakage              | Global circuit breaker (cross-tenant interference); Redis-based CB (over-engineered for current scale) |
| Pipeline circuit breaker is per-tenant in-memory         | Tenant isolation, LRU eviction prevents memory growth                                     | Global CB (cross-tenant interference); per-project CB (too many entries)                               |
| Intent queue is session-serialized (no separate store)   | Simple, no cross-pod coordination needed, survives session persistence                    | Redis queue (adds dependency); separate MongoDB collection (over-engineered)                           |
| Multi-intent parallel restricted to supervisors          | Only supervisors can fan out to sub-agents; scripted/reasoning agents are single-threaded | Allowing parallel for all types (not architecturally possible)                                         |
| Merge module uses pipeline model (qwen3-30b)             | Fast synthesis, much cheaper than primary model                                           | Using primary model (too slow/expensive); no merge (poor UX)                                           |
| nl-parser uses Anthropic API directly                    | Best extraction quality; used only in Studio Arch context                                 | Provider-neutral (adds complexity with unclear benefit for this use case)                              |

### Key Interfaces & Types

All interfaces are already implemented. Key types from `apps/runtime/src/services/pipeline/types.ts`:

```typescript
interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  model: string;
  shortCircuit: { enabled: boolean; confidenceThreshold: number };
  toolFilter: { enabled: boolean; maxTools: number };
  keywordVeto: { enabled: boolean; keywords: string[] };
}

interface ClassifierResult {
  intents: ClassifiedIntent[];
  shouldExecuteInAgent: boolean;
  matchedTools: string[];
}

interface PipelineResult {
  shortCircuit: boolean;
  handoffInput?: { target: string; message: string; context?: Record<string, unknown> };
  fanOutTargets?: Array<{ target: string; intent: string; context?: Record<string, unknown> }>;
  filteredTools?: ToolDefinition[];
  classifierResult?: ClassifierResult;
  toolFilterResult?: ToolFilterResult;
}
```

From `apps/runtime/src/services/nlu/sidecar-client.ts`:

```typescript
interface SidecarConfig {
  url: string;
  timeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}
```

From `apps/runtime/src/services/execution/intent-queue.ts`:

```typescript
interface PendingIntentEntry {
  intent: string;
  confidence: number;
  original_message: string;
  detected_at: string;
}

interface IntentQueue {
  pending: PendingIntentEntry[];
}
```

### Module Boundaries

| Module                                      | Responsibility                                                         | Dependencies                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pipeline/classifier.ts`                    | LLM intent classification, prompt building, JSON parsing, keyword veto | `ai` (Vercel AI SDK), `pipeline/types.ts`                                |
| `pipeline/index.ts`                         | Pipeline orchestration, target extraction, short-circuit/fan-out logic | `pipeline/classifier.ts`, `pipeline/tool-filter.ts`, `pipeline/types.ts` |
| `pipeline/config.ts`                        | Config resolution cascade (agent IR -> project -> defaults)            | `@abl/compiler` IR types, `pipeline/types.ts`                            |
| `pipeline/circuit-breaker.ts`               | Per-tenant pipeline circuit breaker with LRU eviction                  | None (self-contained)                                                    |
| `pipeline/merge.ts`                         | Fan-out response synthesis (streaming + non-streaming)                 | `ai` (Vercel AI SDK)                                                     |
| `pipeline/tool-filter.ts`                   | LLM-based tool set reduction                                           | `ai` (Vercel AI SDK)                                                     |
| `nlu/sidecar-client.ts`                     | HTTP client for NLU sidecar with circuit breaker                       | None (uses native fetch)                                                 |
| `nlu/currency-rate-client.ts`               | Exchange rate fetching with cache + static fallback                    | None (uses native fetch)                                                 |
| `execution/multi-intent-strategy.ts`        | Strategy resolution (auto/parallel/sequential/disambiguate)            | `@abl/compiler` IR types                                                 |
| `execution/intent-queue.ts`                 | Pure functional intent queue operations                                | None (self-contained)                                                    |
| `config/project-runtime-config-resolver.ts` | MongoDB config loading + IR mapping                                    | `@agent-platform/database`                                               |
| `nl-parser/extractor.ts`                    | NL-to-structured extraction via Anthropic                              | `@anthropic-ai/sdk`                                                      |
| `nl-parser/generator.ts`                    | Structured extraction to ABL DSL                                       | None                                                                     |
| `nl-parser/types.ts`                        | Zod schemas for extraction types                                       | `zod`                                                                    |

---

## 2. File-Level Change Map

### Existing Files (All Implemented — No New Files Needed)

The NLU feature is fully implemented. All files listed below exist and have passing unit tests. The remaining work is E2E test coverage, documentation correctness, and wiring the NLU sidecar server ML models.

**Core Implementation Files:**

| File                                                                  | Purpose                           | Status                   |
| --------------------------------------------------------------------- | --------------------------------- | ------------------------ |
| `apps/runtime/src/services/pipeline/classifier.ts`                    | Pipeline intent classifier        | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/index.ts`                         | Pipeline orchestrator             | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/config.ts`                        | Config resolution cascade         | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/types.ts`                         | Type definitions + defaults       | Implemented              |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`                 | Classifier → session state bridge | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`               | Tier 1/2/3 action resolver        | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/tool-filter.ts`                   | LLM tool filtering                | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/circuit-breaker.ts`               | Per-tenant pipeline CB            | Implemented, unit tested |
| `apps/runtime/src/services/pipeline/merge.ts`                         | Fan-out response synthesis        | Implemented              |
| `apps/runtime/src/services/nlu/sidecar-client.ts`                     | NLU sidecar HTTP + CB             | Implemented, unit tested |
| `apps/runtime/src/services/nlu/currency-rate-client.ts`               | Exchange rate client              | Implemented, unit tested |
| `apps/runtime/src/services/execution/multi-intent-strategy.ts`        | Strategy resolution               | Implemented, unit tested |
| `apps/runtime/src/services/execution/intent-queue.ts`                 | Intent queue operations           | Implemented, unit tested |
| `apps/runtime/src/services/config/project-runtime-config-resolver.ts` | DB config loader                  | Implemented              |
| `apps/runtime/src/routes/project-runtime-config.ts`                   | Config REST API                   | Implemented, unit tested |
| `apps/runtime/src/routes/pipeline-config.ts`                          | Pipeline config endpoints         | Implemented              |
| `apps/nlu-sidecar/app.py`                                             | NLU sidecar server (Python)       | STUB (returns empty)     |
| `packages/nl-parser/src/extractor.ts`                                 | NL-to-structured extraction       | Implemented              |
| `packages/nl-parser/src/generator.ts`                                 | ABL DSL generation                | Implemented, unit tested |
| `packages/nl-parser/src/types.ts`                                     | Zod schemas                       | Implemented              |
| `packages/nl-parser/src/prompts/agent.ts`                             | Agent extraction prompt           | Implemented              |
| `packages/nl-parser/src/prompts/supervisor.ts`                        | Supervisor extraction prompt      | Implemented              |

**Planned New Files (E2E Tests):**

| File                                                              | Purpose                                           | LOC Estimate |
| ----------------------------------------------------------------- | ------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/e2e/nlu-pipeline-e2e.test.ts`         | E2E: pipeline short-circuit routing via WebSocket | ~150         |
| `apps/runtime/src/__tests__/e2e/nlu-multi-intent-e2e.test.ts`     | E2E: multi-intent fan-out                         | ~150         |
| `apps/runtime/src/__tests__/e2e/nlu-sidecar-e2e.test.ts`          | E2E: sidecar extraction in gather mode            | ~150         |
| `apps/runtime/src/__tests__/e2e/nlu-fallback-e2e.test.ts`         | E2E: classifier fallback + keyword veto           | ~100         |
| `apps/runtime/src/__tests__/e2e/nlu-circuit-breaker-e2e.test.ts`  | E2E: circuit breaker opens on failures            | ~100         |
| `apps/runtime/src/__tests__/e2e/nlu-tenant-isolation-e2e.test.ts` | E2E: project runtime config tenant isolation      | ~100         |
| `apps/runtime/src/__tests__/e2e/nlu-plan-gating-e2e.test.ts`      | E2E: Enterprise plan gating for advanced NLU      | ~80          |

---

## 3. Implementation Phases

### Phase 1: E2E Test Infrastructure

**Goal**: Set up the test infrastructure needed for NLU E2E tests (test server startup, sidecar test double, auth helpers).

**Tasks**:
1.1. Create a minimal HTTP sidecar test double that serves `/extract`, `/detect-correction`, and `/health` endpoints with configurable responses.
1.2. Create test helper for starting the runtime on a random port with pipeline-enabled agent configuration.
1.3. Create test helper for seeding project runtime config with NLU settings via the REST API.
1.4. Create test helper for WebSocket connection with valid auth tokens.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/helpers/sidecar-test-double.ts` — New: minimal HTTP server for sidecar
- `apps/runtime/src/__tests__/e2e/helpers/nlu-test-helpers.ts` — New: runtime startup + config seeding

**Exit Criteria**:

- [ ] Sidecar test double starts on random port and responds to `/extract` with configurable JSON
- [ ] Runtime starts on random port with pipeline-enabled agent configuration
- [ ] WebSocket connection established with valid auth context
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: N/A (infrastructure code)
- Integration: Test double responds correctly to all 3 endpoints

**Rollback**: Delete the new helper files.

---

### Phase 2: Core Pipeline E2E Tests

**Goal**: Add E2E tests for the pipeline classifier short-circuit, fan-out, fallback, and keyword veto paths.

**Tasks**:
2.1. E2E-1: Single-intent short-circuit routing — send message via WebSocket, verify routing to target agent, verify trace events.
2.2. E2E-2: Multi-intent fan-out — send compound message, verify both sub-agents produce responses, verify merge.
2.3. E2E-4: Classifier fallback — configure non-existent pipeline model, verify graceful fallback to reasoning loop.
2.4. E2E-5: Keyword veto — send message with tool-keyword, verify veto trace event and no short-circuit.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/nlu-pipeline-e2e.test.ts` — New: E2E-1 (short-circuit)
- `apps/runtime/src/__tests__/e2e/nlu-multi-intent-e2e.test.ts` — New: E2E-2 (fan-out)
- `apps/runtime/src/__tests__/e2e/nlu-fallback-e2e.test.ts` — New: E2E-4, E2E-5 (fallback + veto)

**Exit Criteria**:

- [ ] E2E-1 test sends message via WebSocket and verifies short-circuit to correct target agent
- [ ] E2E-2 test sends compound message and verifies multi-intent fan-out with response merge
- [ ] E2E-4 test verifies graceful fallback when classifier LLM fails
- [ ] E2E-5 test verifies keyword veto prevents short-circuit
- [ ] All 4 tests pass with `pnpm test --filter=runtime`

**Test Strategy**:

- E2E: Real runtime, real WebSocket, real middleware chain
- No mocking of codebase components

**Rollback**: Delete the new E2E test files.

---

### Phase 3: Sidecar & Circuit Breaker E2E Tests

**Goal**: Add E2E tests for sidecar entity extraction, circuit breaker behavior, and plan gating.

**Tasks**:
3.1. E2E-3: Sidecar extraction — configure advanced NLU with sidecar test double, send gather-mode message, verify extraction.
3.2. E2E-6: Circuit breaker — configure sidecar to return 500s, verify circuit opens after threshold failures, verify fallback.
3.3. E2E-7: Tenant isolation — verify cross-tenant access to project runtime config returns 404.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/nlu-sidecar-e2e.test.ts` — New: E2E-3 (extraction)
- `apps/runtime/src/__tests__/e2e/nlu-circuit-breaker-e2e.test.ts` — New: E2E-6 (CB)
- `apps/runtime/src/__tests__/e2e/nlu-tenant-isolation-e2e.test.ts` — New: E2E-7 (isolation)
- `apps/runtime/src/__tests__/e2e/nlu-plan-gating-e2e.test.ts` — New: Enterprise plan gating

**Exit Criteria**:

- [ ] E2E-3 test verifies sidecar test double receives extraction request and gather fields are populated
- [ ] E2E-6 test verifies circuit breaker opens after consecutive failures and sidecar calls are skipped
- [ ] E2E-7 test verifies cross-tenant access returns 404 for both GET and PUT
- [ ] Plan gating test verifies 403 for non-Enterprise tenants setting advanced NLU
- [ ] All tests pass with `pnpm test --filter=runtime`

**Test Strategy**:

- E2E: Real runtime, real HTTP, sidecar test double
- No mocking of codebase components

**Rollback**: Delete the new E2E test files.

---

### Phase 4: Documentation Sync

**Goal**: Ensure all NLU documentation artifacts are consistent with actual codebase state.

**Tasks**:
4.1. Update feature spec test matrix (section 17) with E2E test status after implementation.
4.2. Update test spec coverage matrix with E2E coverage after implementation.
4.3. Update HLD test strategy (concern 12) with actual E2E count.
4.4. Verify all file paths in docs match actual codebase paths.

**Files Touched**:

- `docs/features/nlu.md` — Update section 17
- `docs/testing/nlu.md` — Update coverage matrix and health dashboard
- `docs/specs/nlu.hld.md` — Update test strategy

**Exit Criteria**:

- [ ] Feature spec section 17 reflects actual test status (all E2E rows updated)
- [ ] Test spec coverage matrix shows E2E = YES for tested FRs
- [ ] HLD test strategy shows correct E2E count
- [ ] All file paths in docs verified against actual codebase

**Test Strategy**:

- Manual: Review all docs for accuracy
- No code tests needed for this phase

**Rollback**: Revert doc changes.

---

## 4. Wiring Checklist

Since the NLU feature is fully implemented, this checklist verifies existing wiring:

- [x] Pipeline orchestrator called from runtime executor before reasoning loop
- [x] Pipeline config resolved from agent IR + project config + defaults
- [x] Pipeline circuit breaker checked before running pipeline
- [x] Intent bridge maps classifier output to session state (intent-bridge.ts)
- [x] Tiered resolver determines Tier 1/2/3 actions from pipeline result (tiered-resolver.ts)
- [x] `PipelineConfig.intentBridge` field exists in types.ts (line 45) with `IntentBridgeConfig`
- [x] `IIntentBridgeConfig` interface exists in DB model (`project-runtime-config.model.ts`)
- [x] Sidecar client created per-session from project runtime config
- [x] Multi-intent strategy resolution called from routing executor
- [x] Intent queue operations called from flow step executor
- [x] Project runtime config routes registered in runtime router
- [x] Pipeline config routes registered in runtime router
- [x] nl-parser exported from package index
- [x] nl-parser used in Studio Arch assistant (`apps/studio/src/app/api/arch/`)

**For E2E tests (new wiring needed):**

- [ ] Sidecar test double registered in E2E test setup
- [ ] E2E test files discoverable by vitest configuration
- [ ] E2E helpers importable from test files

---

## 5. Cross-Phase Concerns

### Database Migrations

None needed. NLU uses existing `project_runtime_configs` collection schema.

### Feature Flags

Pipeline is disabled by default (`pipeline.enabled = false`). No new feature flags needed.

### Configuration Changes

No new environment variables or config keys. All NLU configuration already exists in:

- Agent IR (`execution.pipeline`)
- Project runtime config (MongoDB)
- Default constants in `types.ts`

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 35+ unit tests pass
- [ ] All 3+ integration tests pass
- [ ] 7 E2E tests pass (after Phase 2-3 implementation)
- [ ] No regressions in existing runtime tests
- [ ] Feature spec updated with implementation details (after Phase 4)
- [ ] Test spec coverage matrix updated with actual coverage (after Phase 4)
- [ ] All documentation file paths verified against actual codebase
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors

---

## 7. Open Questions

1. Should the E2E sidecar test double be a shared utility or inline per test file?
   - **DECIDED**: Shared utility in `e2e/helpers/`. Reusable across all sidecar E2E tests.

2. Should E2E tests use a real LLM for the pipeline classifier or a deterministic mock?
   - **DECIDED**: Use the real pipeline model for E2E (tests real classification) but allow skipping via env var `SKIP_LLM_E2E=true` for CI without LLM access.

3. How to verify trace events in E2E tests?
   - **DECIDED**: The runtime should expose a test-only endpoint (`/api/debug/traces`) or the E2E test should capture trace events via a test trace store injected at startup.

4. Should E2E tests run in CI or only locally?
   - **DECIDED**: E2E tests that require an LLM should be tagged and skippable in CI. Sidecar and isolation tests (which use test doubles) should run in CI.
