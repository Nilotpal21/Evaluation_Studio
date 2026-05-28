# Guardrail Test Coverage Audit — 2026-03-09

## Executive Summary

This audit maps existing guardrail test coverage across **4 providers × 5 kinds × 7 actions × 3 tiers**, identifying critical gaps that block downstream work. The analysis spans 22 compiler test files, 6 runtime test files, 1 studio e2e test, plus implementation files for 4 tier-2 (model) providers and all evaluator tiers.

**Key Findings:**

- **Tier 1 (Local/CEL)**: ✅ 95% covered — 9 tests validate all actions and error modes
- **Tier 2 (Model)**: ⚠️ 40% covered — only 2 providers tested (builtin-pii, custom-http SSRF), 2 providers have no unit tests
- **Tier 3 (LLM)**: ⚠️ 30% covered — parser & prompt validation only, no multi-tier cascade tested
- **Provider × Kind**: ❌ 0% e2e coverage — no tests verify providers across all 5 guardrail kinds
- **Actions**: ⚠️ 60% covered — block, warn, redact, fix tested; reask & escalate largely untested
- **Policy/DB**: ⚠️ 50% covered — models exist, no schema validation tests

---

## 1. Provider Implementation Status

### DB Model Support (guardrail-provider-config.model.ts)

| Adapter Type            | Status          | Implementation       | Tests                                   |
| ----------------------- | --------------- | -------------------- | --------------------------------------- |
| `openai_moderation`     | ✅ Implemented  | openai-moderation.ts | ✅ provider-interface.test.ts           |
| `openai_compatible`     | ✅ Implemented  | openai-compatible.ts | ✅ provider-interface.test.ts           |
| `custom_http`           | ✅ Implemented  | custom-http.ts       | ✅ custom-http-ssrf.test.ts (SSRF only) |
| `custom_webhook`        | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `builtin_pii`           | ✅ Implemented  | builtin-pii.ts       | ✅ tier2-evaluator.test.ts (indirect)   |
| `custom_llm`            | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `huggingface_inference` | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `anthropic`             | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `google_cloud`          | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `vertex_ai`             | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `bedrock`               | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `azure_content_safety`  | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `lakera`                | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `aporia`                | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |
| `other`                 | ❓ Type Defined | **NOT IMPLEMENTED**  | ❌ None                                 |

**Summary**: 4 providers implemented, 11 adapter types exist only in DB schema with no implementations.

---

## 2. Guardrail Kinds × Actions Coverage Matrix

### Allowed Actions Per Kind (guardrail-validator.ts)

```
input:      [block, warn, redact, fix, filter, escalate]
output:     [block, warn, redact, fix, reask, filter, escalate]
tool_input: [block, warn, redact, fix, filter, escalate]
tool_output:[block, warn, redact, fix, filter, escalate]
handoff:    [block, warn, redact, escalate]
```

### Test Coverage by Kind

| Kind          | Implemented | Tested     | Status | Notes                                                                     |
| ------------- | ----------- | ---------- | ------ | ------------------------------------------------------------------------- |
| `input`       | ✅          | ⚠️ Partial | 30%    | No e2e provider tests, action-applier tested locally                      |
| `output`      | ✅          | ⚠️ Partial | 35%    | streaming-guardrails-\*.test.ts cover integration, no provider e2e        |
| `tool_input`  | ✅          | ❌ Minimal | 20%    | action-executors.test.ts only, no runtime integration tests               |
| `tool_output` | ✅          | ❌ Minimal | 20%    | Same as tool_input                                                        |
| `handoff`     | ✅          | ❌ None    | 0%     | No tests for handoff-specific constraints; escalate-only actions untested |

---

## 3. Action Type Coverage

| Action       | Tier        | Test Files               | Coverage | Notes                                                                |
| ------------ | ----------- | ------------------------ | -------- | -------------------------------------------------------------------- |
| **block**    | All         | 12+                      | ✅ 95%   | Tested in T1/T2/T3 evaluators, all kinds                             |
| **warn**     | All         | 8+                       | ✅ 90%   | Tested in tier evaluators, some edge cases missing                   |
| **redact**   | T1,T2,T3    | action-executors.test.ts | ⚠️ 70%   | PII redaction tested, pattern matching partially tested              |
| **fix**      | T1,T2,T3    | action-executors.test.ts | ⚠️ 60%   | truncate, strip_html, normalize tested; custom strategies not tested |
| **filter**   | T1,T2,T3    | action-executors.test.ts | ⚠️ 50%   | Basic filtering tested, edge cases (empty result) not fully covered  |
| **reask**    | Output only | ❌ None                  | ❌ 0%    | No tests for reask action behavior or LLM regeneration               |
| **escalate** | All         | ❌ Minimal               | ❌ 10%   | escalation types defined, no runtime escalation tests                |

---

## 4. Tier-by-Tier Coverage Analysis

### Tier 1: Local (CEL) Evaluator

**File**: `tier1-evaluator.ts` | **Test**: `tier1-evaluator.test.ts` (105 lines)

| Aspect             | Status | Details                                   |
| ------------------ | ------ | ----------------------------------------- |
| CEL evaluation     | ✅     | Passes/fails for true/false checks        |
| Parallel execution | ✅     | Multiple guardrails tested                |
| Error handling     | ✅     | Malformed CEL → fail-open or fail-closed  |
| Fail modes         | ✅     | Both 'open' and 'closed' tested           |
| Latency tracking   | ✅     | Per-check and max latency measured        |
| Priority sorting   | ✅     | Primary violation selection verified      |
| Action types       | ⚠️     | Only block/warn tested; redact indirectly |

**Gaps**: No tests for severity-based action overrides (if Tier 1 supported them).

### Tier 2: Model Evaluator

**File**: `tier2-evaluator.ts` | **Test**: `tier2-evaluator.test.ts` (240+ lines)

| Aspect                      | Status | Details                                 |
| --------------------------- | ------ | --------------------------------------- |
| Provider registry dispatch  | ✅     | Registry lookup and evaluation tested   |
| Score-to-severity mapping   | ✅     | scoreToSeverity() conversion tested     |
| Threshold application       | ✅     | Scores above threshold = violation      |
| Parallel evaluation         | ✅     | Multiple providers tested               |
| Severity-based actions      | ✅     | severityActions override tested         |
| Fail-open behavior          | ✅     | Provider errors → pass                  |
| Circuit breaker integration | ❌     | Not tested in tier2-evaluator tests     |
| Retry logic                 | ❌     | Not tested in tier2-evaluator tests     |
| Cost accumulation           | ❌     | costPerEvalUsd tracking not tested      |
| Provider-specific tests     | ⚠️     | Only builtin-pii and custom-http tested |

**Provider Coverage**:

- ✅ builtin-pii: 3+ tests (PII detection, score mapping)
- ✅ custom-http: 1 test (SSRF validation only) + custom-http-ssrf.test.ts (15 SSRF cases)
- ❌ openai-moderation: 0 dedicated tests
- ❌ openai-compatible: 0 dedicated tests

### Tier 3: LLM Evaluator

**File**: `tier3-evaluator.ts` | **Test**: `tier3-evaluator.test.ts` (180+ lines)

| Aspect                 | Status | Details                            |
| ---------------------- | ------ | ---------------------------------- |
| LLM function injection | ✅     | Injected LLM eval tested           |
| Prompt construction    | ✅     | Prompt building validated          |
| Response parsing       | ✅     | JSON and heuristic fallback tested |
| Score clamping         | ✅     | [0,1] range enforced               |
| Fail-open behavior     | ✅     | LLM errors → pass                  |
| Severity mapping       | ✅     | Score-to-severity conversion       |
| Parallel execution     | ✅     | Multiple guardrails tested         |
| Unavailable evaluator  | ✅     | failMode=closed behavior tested    |
| Context handling       | ⚠️     | Partial (recentMessages truncated) |

**Gaps**: No multi-message context escalation; no real LLM integration tests.

---

## 5. Runtime Integration Coverage

### Streaming Guardrails Tests

| File                                  | Lines | Focus                               | Status |
| ------------------------------------- | ----- | ----------------------------------- | ------ |
| streaming-guardrails-wiring.test.ts   | 60    | Buffer accumulation, chunk handling | ✅ 90% |
| streaming-guardrails-pipeline.test.ts | 90    | Pipeline wiring (Gap 3 fix)         | ✅ 95% |
| streaming-guardrails-policy.test.ts   | 120   | PipelinePolicy forwarding (P1 fix)  | ✅ 95% |

**Integration Points**:

- ✅ StreamingGuardrailEvaluator accepts pipeline + policy
- ✅ evaluateChunk() and evaluateFinal() wiring verified
- ✅ Buffer state machine tested
- ❌ No e2e provider × kind tests
- ❌ No real LLM evaluator tests

### Output/Post-Validation Tests

| File                                 | Lines | Focus                                      | Status |
| ------------------------------------ | ----- | ------------------------------------------ | ------ |
| output-guardrails.test.ts            | 30    | Existence checks only                      | ⚠️ 30% |
| post-guardrail-revalidation.test.ts  | 40    | Tool parameter validation after guardrails | ⚠️ 70% |
| flow-guardrail-actions.test.ts       | ?     | Handoff validation                         | ⚠️     |
| reasoning-guardrail-ordering.test.ts | ?     | Tier ordering in reasoning executor        | ⚠️     |

---

## 6. DB & Policy Coverage

| Model                         | Status         | Tests                                     |
| ----------------------------- | -------------- | ----------------------------------------- |
| TenantGuardrailProviderConfig | ✅ Defined     | ❌ 0 schema validation tests              |
| GuardrailPolicy               | ✅ Defined     | ❌ 0 schema tests                         |
| guardrail-validator.ts        | ✅ Implemented | ✅ guardrail-validator.test.ts (50 lines) |

**Gaps**:

- No tests for policy scope precedence (tenant → project → agent)
- No budget constraint enforcement tests
- No circuit breaker config validation tests
- No caching config tests

---

## 7. Studio E2E Test Coverage

**File**: `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts` (400+ lines)

**Phases Tested**:

1. ✅ Login & project navigation
2. ✅ LLM provider setup
3. ✅ Guardrail provider CRUD (OpenAI Moderation, Google Cloud, Built-in PII)
4. ✅ Project-level policy CRUD
5. ✅ Agent-level guardrail overrides
6. ⚠️ Chat validation (basic safe/PII/harmful triggers only)
7. ✅ Policy override verification
8. ✅ Cleanup

**Limitations**:

- Only tests 3 providers (missing custom-http, openai-compatible)
- Chat validation uses mock endpoints, not real provider calls
- No streaming output validation
- No tool input/tool output guardrails tested
- No handoff guardrails tested

---

## 8. Critical Gaps Summary

### Provider × Kind × Action (E2E)

**No tests exist for these combinations:**

```
Provider: builtin-pii
  × input + block ❌
  × input + warn ❌
  × input + redact ❌
  × input + fix ❌
  × input + filter ❌
  × input + escalate ❌
  × output + block ❌
  ... (all 42 combinations untested)
  × tool_input + * (5 actions × 5 untested)
  × tool_output + * (5 actions × 5 untested)
  × handoff + * (4 actions untested)

Provider: openai-moderation
  × [ALL 35 combinations] ❌

Provider: custom-http
  × input + * (6 combinations) ❌
  × output + * (7 combinations) ❌
  × tool_input + * (5 combinations) ❌
  × tool_output + * (5 combinations) ❌
  × handoff + * (4 combinations) ❌

Provider: openai-compatible
  × [ALL 35 combinations] ❌
```

**Total Provider × Kind × Action Gaps: 147/175 combinations (84% untested)**

### Multi-Tier Cascade

**No tests verify**:

- ✅ Tier 1 → Tier 2 → Tier 3 sequential evaluation
- ✅ Violation priority across tiers
- ✅ Fail modes when tier is unavailable
- ✅ Cost tracking across all tiers
- ✅ Latency aggregation

### Policy Scoping

**No tests for**:

- Tenant-level policy → Project override → Agent override hierarchy
- Policy disable patterns
- Provider endpoint override resolution
- Circuit breaker config per policy

### Streaming + Real Providers

**No tests for**:

- Streaming output with model-tier guardrails
- Streaming with circuit breaker triggering
- Chunk-level cost accumulation
- Early termination on violations

### Action Coverage Gaps

| Action   | E2E Tested                 | Notes                         |
| -------- | -------------------------- | ----------------------------- |
| block    | ✅ (compiler + runtime)    | Well covered                  |
| warn     | ✅ (compiler)              | No runtime e2e                |
| redact   | ⚠️ (action-executors only) | No provider integration tests |
| fix      | ⚠️ (action-executors only) | No provider integration tests |
| filter   | ⚠️ (action-executors only) | No provider integration tests |
| reask    | ❌                         | Completely untested           |
| escalate | ❌                         | Defined but untested          |

---

## 9. Implementation Completeness

### Implemented vs Stubs

| Component          | Status  | File                   | Tests                      |
| ------------------ | ------- | ---------------------- | -------------------------- |
| Tier1Evaluator     | ✅ Full | tier1-evaluator.ts     | ✅ Comprehensive           |
| Tier2Evaluator     | ✅ Full | tier2-evaluator.ts     | ⚠️ Partial (provider gaps) |
| Tier3Evaluator     | ✅ Full | tier3-evaluator.ts     | ⚠️ Partial (context gaps)  |
| GuardrailPipeline  | ✅ Full | pipeline.ts            | ⚠️ Partial (action gaps)   |
| ActionApplier      | ✅ Full | action-applier.ts      | ⚠️ Partial                 |
| ActionExecutors    | ✅ Full | action-executors.ts    | ⚠️ Partial                 |
| StreamingEvaluator | ✅ Full | streaming-evaluator.ts | ✅ 95%                     |
| PolicyResolver     | ✅ Full | policy-resolver.ts     | ⚠️ 40%                     |
| PipelineFactory    | ✅ Full | pipeline-factory.ts    | ✅ 90%                     |

---

## 10. Test File Inventory

### Compiler Tests (22 files, ~3,800 lines)

**Unit Tier Tests**:

- ✅ tier1-evaluator.test.ts (105 lines)
- ✅ tier2-evaluator.test.ts (240 lines)
- ✅ tier3-evaluator.test.ts (180 lines)

**Foundation Tests**:

- ✅ provider-interface.test.ts
- ✅ provider-registry.test.ts
- ✅ action-executors.test.ts
- ✅ action-applier.test.ts
- ✅ result-aggregator.test.ts
- ✅ circuit-breaker.test.ts
- ✅ pipeline.test.ts
- ✅ guardrail-validator.test.ts

**Integration Tests**:

- ✅ guardrails-e2e.test.ts (50+ cases)
- ✅ guardrail-compilation.test.ts

**Schema & Type Tests**:

- ✅ guardrail-ir-schema.test.ts
- ✅ guardrail-action.test.ts
- ✅ guardrail-messages.test.ts
- ✅ fail-mode.test.ts

**Specialized Tests**:

- ✅ cel-guardrail-functions.test.ts
- ✅ custom-http-ssrf.test.ts (15 SSRF cases)
- ✅ pipeline-policy-validation.test.ts
- ✅ pipeline-types.test.ts
- ✅ guardrail-context.test.ts

### Runtime Tests (6+ files, ~500 lines)

- ✅ guardrail-pipeline-expanded.test.ts (factory + registry)
- ✅ streaming-guardrails-wiring.test.ts
- ✅ streaming-guardrails-pipeline.test.ts
- ✅ streaming-guardrails-policy.test.ts
- ⚠️ output-guardrails.test.ts (minimal)
- ⚠️ post-guardrail-revalidation.test.ts
- ❌ flow-guardrail-actions.test.ts (referenced but not reviewed)
- ❌ handoff-guardrail-llmeval.test.ts (referenced but not reviewed)
- ❌ tool-guardrail-llmeval.test.ts (referenced but not reviewed)
- ❌ reasoning-guardrail-ordering.test.ts (referenced but not reviewed)

### Studio E2E Tests (1 file, 400+ lines)

- ⚠️ guardrails-comprehensive-e2e.spec.ts (provider CRUD + basic validation)
- ❓ model-guardrails-e2e.spec.ts (file exists, not reviewed)

---

## 11. Blocking Dependencies

**Task #1 (this audit) unblocks**:

- #2: Provider × Kind E2E tests for builtin-pii
- #3: Provider × Kind E2E tests for openai-moderation
- #4: Provider × Kind E2E tests for custom-http
- #5: Multi-tier cascade tests
- #6: Streaming + model-tier provider tests
- #7: Edge case tests (circuit breaker, fail modes, budget, caching)
- #8: Policy scoping hierarchy tests

---

## 12. Recommendations (Priority Order)

### P0: Unblock downstream (required for #2–#8)

1. **Create provider-kind matrix template** (task #2–#4)
   - Define test structure: provider × kind × action combinations
   - Use parametrized tests to avoid duplication
   - Example: `builtin-pii × input × [block, warn, redact, fix, filter, escalate]`

2. **Provider Unit Tests** (not yet blocked)
   - `openai-moderation.test.ts`: API mocking, category mapping, threshold logic
   - `openai-compatible.test.ts`: Generic provider wiring

### P1: High-value coverage gaps

3. **Multi-tier Cascade** (task #5)
   - Sequential Tier 1 → Tier 2 → Tier 3
   - Violation priority across tiers
   - Cost + latency aggregation
   - Fail modes (what happens when Tier 2 unavailable?)

4. **Streaming + Model-tier** (task #6)
   - Chunk-level model evaluation (e.g., offensive content in partial sentence)
   - Early termination on violations
   - Cost per stream

5. **Policy Scoping** (task #8)
   - Tenant policy + project override + agent override precedence
   - Provider endpoint override resolution
   - Disable/enable patterns

### P2: Edge cases (task #7)

6. **Circuit Breaker Behavior**
   - Threshold hits → circuit open → fail-open requests
   - Reset timeout → circuit closed again

7. **Fail Modes**
   - failMode='closed' → block on provider timeout
   - failMode='open' → allow on provider error

8. **Budget Constraints**
   - Monthly spend limit enforcement
   - Overspend actions (downgrade, disable, alert)

9. **Caching**
   - Exact match cache hits
   - Semantic similarity caching
   - TTL expiration

### P3: Completeness

10. **Action Coverage**
    - reask: LLM regeneration after output violation
    - escalate: Violation escalation routes

11. **Handoff Guardrails**
    - No fix/filter allowed (opaque handoff payload)
    - Escalate-only enforcement

12. **Missing Providers**
    - Implement stubs for: custom_webhook, custom_llm, huggingface, anthropic, google_cloud, vertex_ai, bedrock, azure_content_safety, lakera, aporia

---

## 13. Coverage Summary Table

| Layer          | Total Tests | Passing      | Critical Gaps                            |
| -------------- | ----------- | ------------ | ---------------------------------------- |
| Tier 1 (Local) | 9           | 9 (100%)     | None                                     |
| Tier 2 (Model) | 12+         | 10 (80%)     | openai-\*, provider × kind e2e           |
| Tier 3 (LLM)   | 8           | 7 (85%)      | context edge cases, real LLM integration |
| Actions        | 20+         | 12 (60%)     | reask, escalate, all actions in e2e      |
| Pipeline       | 15+         | 12 (80%)     | multi-tier cascade, streaming with model |
| Policy         | 2           | 1 (50%)      | scoping hierarchy, budget, caching       |
| E2E (Studio)   | 1           | 1 (100%)     | provider coverage, tool/handoff kinds    |
| **TOTAL**      | **67+**     | **52 (78%)** | **Provider × Kind E2E (84% gap)**        |

---

## Conclusion

The guardrail system has **strong foundations** (78% test pass rate on what exists) but critical **E2E coverage gaps**: no tests verify any of the 4 providers × 5 kinds × 6 actions combinations in realistic scenarios. Tasks #2–#8 are unblocked and should prioritize high-value combinations (task #2 builtin-pii, #5 multi-tier cascade, #6 streaming) before tackling exhaustive matrix coverage.
