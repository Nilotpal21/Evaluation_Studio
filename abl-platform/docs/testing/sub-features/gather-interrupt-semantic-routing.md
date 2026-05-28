# Test Specification: Gather Interrupt Semantic Routing

**Feature Spec**: [docs/features/sub-features/gather-interrupt-semantic-routing.md](../../features/sub-features/gather-interrupt-semantic-routing.md)
**HLD**: N/A
**LLD**: N/A
**Status**: IN PROGRESS
**Last Updated**: 2026-04-23

---

## 1. Coverage Matrix

| FR    | Description                                                              | Unit | Integration | E2E | Manual | Status  |
| ----- | ------------------------------------------------------------------------ | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Classifier-first gather interrupt detection                              | NO   | YES         | YES | NO     | PARTIAL |
| FR-2  | Semantic rejection keeps gather ownership unless policy says otherwise   | NO   | YES         | YES | NO     | PARTIAL |
| FR-3  | Deterministic lexical fallback when semantic routing is unavailable      | YES  | YES         | YES | NO     | PARTIAL |
| FR-4  | Gather-only normalized lexical matching without global matcher loosening | YES  | YES         | YES | NO     | PARTIAL |
| FR-5  | Parent-supervisor reroutes still resolve through routing rules           | NO   | YES         | YES | NO     | PARTIAL |
| FR-6  | `LEXICAL_FALLBACK` parser/compiler/runtime contract                      | YES  | YES         | NO  | NO     | PARTIAL |
| FR-7  | Trace payload includes detection mode and lexical match type             | NO   | YES         | YES | NO     | PARTIAL |
| FR-8  | Reroute still works when pipeline model is unavailable                   | NO   | YES         | YES | NO     | PARTIAL |
| FR-9  | Future semantic service-pool ranking for finite candidates               | NO   | NO          | NO  | NO     | PLANNED |
| FR-10 | Future policy for semantic negative vs lexical or LLM rescue             | NO   | NO          | NO  | NO     | PLANNED |
| FR-11 | Tenant/project selection of semantic service profiles                    | NO   | NO          | NO  | NO     | PLANNED |
| FR-12 | Service profiles publish and enforce operational characteristics         | NO   | NO          | NO  | NO     | PLANNED |

### Current Baseline

The repository already contains strong targeted coverage for the immediate gap:

- `packages/compiler/src/platform/constructs/__tests__/detect-intent-word-boundary.test.ts`
  - exact word-boundary behavior remains stable
  - normalized lexical matching is opt-in and gather-scoped
- `packages/core/src/__tests__/parser/intents-section.test.ts`
  - `INTENTS: LEXICAL_FALLBACK` parsing
- `packages/compiler/src/__tests__/extract-intent-categories.test.ts`
  - compiler lowering of `lexical_fallback`
- `apps/runtime/src/__tests__/execution/flow-intents-digressions.test.ts`
  - normalized lexical fallback during a gather-step digression
- `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`
  - parent-supervisor reroute when classification is unavailable
  - semantic rejection preserving child gather ownership
  - supervisor `lexical_fallback: never`
- `apps/runtime/src/__tests__/execution/gather-interrupt.e2e.test.ts`
  - public chat reroute through normalized lexical fallback
  - semantic rejection keeps the child gather active
- `apps/runtime/src/__tests__/execution/gather-interrupt-sdk.e2e.test.ts`
  - SDK chat preserves the same reroute contract
  - resumed child-gather state cannot be reused by another SDK user
- `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`
  - `voice_vxml` ingress preserves the same gather reroute contract through a deployment-bound public voice surface
  - channel-scoped sessions cannot bypass the parent-supervisor return trace contract

Verified on 2026-04-23:

- runtime targeted suites: `34/34` passing
- compiler targeted suites: `22/22` passing
- core parser targeted suites: `11/11` passing
- runtime build: passing
- runtime config route regression lane: `25/25` passing
- runtime config resolver integration lane: `1/1` passing
- gather-interrupt public chat + SDK E2E lanes: `3/3` passing
- voice ingress E2E lane: `10/10` passing, including the gather-interrupt VXML parity scenario

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must run through public runtime surfaces with real servers, real middleware, and real routing state. No module mocks. Use test doubles only for external services such as sidecar HTTP endpoints or model providers.

### E2E-1: Child gather flow returns to the parent supervisor during a public chat turn

- **Preconditions**: Runtime server on a random port. Supervisor with at least two child agents. One child agent is in `GATHER` waiting for a required field. Pipeline classifier is disabled or unavailable so lexical fallback is the active rescue lane.
- **Steps**:
  1. Start a public chat session through `/api/v1/chat/agent`.
  2. Route into the child gather flow and wait for the required-field prompt.
  3. Send a user message that expresses a different routed intent using a form that requires normalized lexical handling instead of exact matching.
  4. Assert the runtime emits `digression` and `return_to_parent` traces and the final action routes to the correct sibling target.
- **Expected Result**: The turn exits the child gather flow, returns to the parent supervisor, and lands on the correct target without re-prompting for the original field.
- **Isolation Check**: The same sequence from another tenant or project returns 404 for protected resources rather than leaking route availability.

### E2E-2: Semantic rejection keeps the user in the child gather flow

- **Preconditions**: Runtime server on a random port. Pipeline classifier enabled with a deterministic test model or controlled provider that returns no matching category for the interrupt attempt.
- **Steps**:
  1. Start the same public chat flow and enter the child `GATHER` step.
  2. Send a message that lexically resembles an interrupt candidate but is intentionally classified as non-routing input by the semantic path.
  3. Assert there is no `return_to_parent` action and the child gather step either stores the field or re-prompts according to the flow definition.
- **Expected Result**: Semantic negative results are authoritative unless the configured policy explicitly allows lexical rescue.
- **Isolation Check**: Cross-project execution still returns 404 and does not expose classifier behavior details.

### E2E-3: Voice or SDK surface preserves the same gather interrupt contract

- **Preconditions**: SDK or voice surface configured for the same project. Child flow and supervisor routing identical to the chat path. Current shipped coverage uses SDK HTTP chat plus deployment-bound `voice_vxml` ingress.
- **Steps**:
  1. Enter the child gather flow through the chosen channel.
  2. Interrupt the gather step with a routed request that should return to the parent supervisor.
  3. Assert the same trace sequence and final target appear as in chat.
- **Expected Result**: Channel transport does not change the gather interrupt contract.
- **Isolation Check**: Another session or channel connection cannot reuse the routed state.

### E2E-4: Future semantic service-pool ranking handles gather interrupts when the pipeline LLM is unavailable

- **Preconditions**: Future phase only. Runtime configured with semantic service-pool routing enabled and pipeline classifier disabled or unavailable. The selected service profile returns a ranked candidate above threshold.
- **Steps**:
  1. Start a public chat session and enter a child gather flow.
  2. Send an interrupt message that is not an exact lexical match but is a semantic match against the finite candidate set.
  3. Assert the sidecar route wins, traces record semantic provider and score, and lexical fallback is not required.
- **Expected Result**: Finite-candidate semantic routing succeeds without the main pipeline LLM.
- **Isolation Check**: Semantic service selection remains scoped to the owning project and tenant.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Exact and normalized lexical matching remain intentionally separate

- **Boundary**: `packages/compiler/src/platform/constructs/utils.ts`
- **Setup**: Use exact lexical callers and gather-scoped normalized callers against the same candidate set.
- **Steps**: Verify exact word-boundary behavior rejects inflectional variants while `allowNormalized: true` accepts them for approved gather surfaces.
- **Expected Result**: Global lexical callers stay precise; gather callers gain normalization without global behavior drift.

### INT-2: `detectFlowEscapeMatch()` uses semantic-first resolution and fail-closed rejection

- **Boundary**: `apps/runtime/src/services/execution/flow-step-executor.ts`
- **Setup**: Run with pipeline available and then with pipeline unavailable.
- **Steps**: Assert classifier-first routing when a model exists, `null` on semantic rejection, and lexical fallback only when the semantic path is unavailable or skipped.
- **Expected Result**: Flow-escape routing honors semantic authority and only uses lexical fallback in the intended lanes.

### INT-3: `detectParentSupervisorRoute()` honors lexical fallback policy

- **Boundary**: Parent-supervisor reroute logic plus compiled supervisor IR
- **Setup**: Use supervisors with `LEXICAL_FALLBACK: never`, `when_unavailable`, and `always`.
- **Steps**: Exercise reroute attempts with classifier unavailable and classifier negative results.
- **Expected Result**: Policy controls whether lexical rescue is allowed, and final targets still resolve through routing rules.

### INT-4: Supervisor routing resolution stays deterministic after lexical or semantic category match

- **Boundary**: `resolveRouting()` plus gather reroute caller
- **Setup**: Multiple routing rules with priorities and `WHEN` clauses.
- **Steps**: Feed both lexical-origin and classifier-origin category matches into the resolver.
- **Expected Result**: The same category resolves to the same target and rule ordering regardless of how the category was detected.

### INT-5: Future semantic service-pool ranking integrates with runtime fallback order

- **Boundary**: Semantic service client + `flow-step-executor.ts`
- **Setup**: Future phase only. Service-pool ranking endpoint, circuit breaker, threshold config.
- **Steps**: Verify semantic ranking wins above threshold, lexical fallback wins when the selected service pool is unavailable, and semantic negatives remain authoritative when policy requires fail-closed behavior.
- **Expected Result**: Semantic service-pool ranking slots into the interrupt detector without breaking current deterministic behavior.

### INT-6: Tenant policy and project override resolve a semantic service profile deterministically

- **Boundary**: Tenant config + project runtime config + runtime profile resolution
- **Setup**: Tenant policy defines a default semantic service profile plus an allowlist of profile ids. Project A inherits the default, Project B selects an allowed override, and Project C attempts a disallowed override.
- **Steps**: Resolve runtime semantic routing config for each project.
- **Expected Result**: Inheritance, allowed override, and deny cases are deterministic and do not require raw endpoint URLs in project config.

### INT-7: Service profile compatibility validation blocks invalid hardware or capacity choices

- **Boundary**: Semantic service profile registry + runtime config validation
- **Setup**: Register multiple profiles with different hardware classes, memory requirements, throughput targets, concurrency envelopes, and language coverage.
- **Steps**: Attempt to bind projects to incompatible profiles, such as GPU-only profiles on CPU-only entitlements or English-only profiles for multilingual-required projects.
- **Expected Result**: Validation fails before runtime dispatch when the selected profile cannot satisfy policy or project requirements.

### INT-8: Shared service-profile resolution remains type-safe across `semantic-router` and `memory-compactor`

- **Boundary**: Shared service profile registry + runtime config validation
- **Setup**: Register profiles for both `semantic-router` and `memory-compactor`.
- **Steps**: Attempt to bind a `memory-compactor` profile where `semantic-router` is required, and vice versa.
- **Expected Result**: Cross-type binding is rejected before runtime dispatch, proving that the shared control plane does not collapse distinct runtime contracts into one generic endpoint type.

### INT-9: Unknown or disallowed service profiles are rejected before project publish

- **Boundary**: Tenant policy + project runtime config validation
- **Setup**: Project A references a profile id missing from the registry. Project B references a profile id that exists globally but is not allowlisted for the tenant.
- **Steps**: Attempt to save or publish runtime config for both projects.
- **Expected Result**: Validation fails before runtime dispatch, and the error surface explains that the selected logical profile is unavailable for the current tenant or service type.

### INT-10: Runtime degrades explicitly when a valid profile has no healthy pool

- **Boundary**: Service discovery + runtime execution fallback
- **Setup**: Register a valid `semantic-router` profile and a valid `memory-compactor` profile, but simulate zero healthy pools for each at runtime.
- **Steps**: Trigger a gather interrupt that would normally use semantic ranking, then trigger a compaction request that would normally use the selected compactor profile.
- **Expected Result**: Gather routing falls back to deterministic exact/normalized matching, compaction follows its configured fallback policy, and traces or health surfaces mark the project as degraded instead of silently hanging or swapping models.

### INT-11: In-use service profiles cannot be removed without an explicit lifecycle decision

- **Boundary**: Service profile registry + project reference validation + operator workflow
- **Setup**: One or more projects actively reference a profile that an operator attempts to deprecate and then remove.
- **Steps**: Attempt normal removal, then attempt force removal through an operator-only path.
- **Expected Result**: Normal removal is blocked while active references remain. Force removal is auditable, leaves affected projects in a degraded state, and does not silently substitute a different profile unless tenant policy explicitly defines a fallback chain.

---

## 4. Unit Test Scenarios

### UT-1: `detectIntent()` remains exact

- **Module**: `utils.ts`
- **Input**: Exact keywords, substrings, multi-word phrases, regex metacharacter keywords
- **Expected Output**: Only word-boundary exact matches succeed

### UT-2: `detectIntentLexically()` normalized mode is opt-in

- **Module**: `utils.ts`
- **Input**: Same lexical candidates with `allowNormalized` on and off
- **Expected Output**: Normalized matching is available only when explicitly enabled

### UT-3: `LEXICAL_FALLBACK` parser validation

- **Module**: `agent-based-parser.ts`
- **Input**: Valid, invalid, and duplicate `LEXICAL_FALLBACK` entries
- **Expected Output**: Valid modes parse, invalid modes warn, duplicates keep the last configured value

### UT-4: Compiler lowering preserves lexical fallback policy

- **Module**: IR compiler extraction of intent categories
- **Input**: Supervisor docs with explicit intent config
- **Expected Output**: `routing.intent_classification.lexical_fallback` reflects the authored value

### UT-5: Trace payload records lexical match type

- **Module**: `flow-step-executor.ts`
- **Input**: Gather interrupt routed through normalized lexical fallback
- **Expected Output**: `digression` or `return_to_parent` trace contains `detectionMode: lexical` and `lexicalMatchType: normalized`

---

## 5. Performance, Capacity, and Hardware Validation

These checks are part of model and service-profile selection, not just post-hoc benchmarking.

### PERF-1: Per-profile latency benchmark on finite-candidate interrupt routing

- **Goal**: Measure p50 and p95 latency for each candidate semantic service profile at representative candidate-set sizes.
- **Why It Matters**: Gather interrupts are on the hot path of an interactive turn and must stay within a bounded latency budget.

### PERF-2: Throughput and max concurrent request envelope per replica

- **Goal**: Measure sustained QPS and the safe max in-flight requests before p95 latency or error rate degrades.
- **Why It Matters**: Service-pool selection is only meaningful if each profile advertises safe concurrency and throughput numbers for autoscaling and admission control.

### PERF-3: CPU vs GPU profile comparison for the same routing workload

- **Goal**: Compare latency, throughput, and cost envelope for CPU-capable and GPU-backed profiles on the same labeled interrupt corpus.
- **Why It Matters**: Some projects may prefer cheaper CPU pools, while others may need GPU-backed multilingual or high-recall profiles.

### PERF-4: Memory footprint and cold-start behavior

- **Goal**: Measure resident memory, model load time, and warmup behavior per profile.
- **Why It Matters**: Memory and startup behavior determine whether a profile is viable for shared container pools, burst scaling, or small-node deployment.

### PERF-5: Multilingual routing quality under load

- **Goal**: Validate interrupt-routing recall and precision for supported languages while the service profile is under representative concurrency.
- **Why It Matters**: A multilingual profile that performs well offline but collapses under load is not a valid project-selectable option.

### PERF-6: Shared service-pool benchmarks cover compaction-oriented profiles

- **Goal**: Validate that the shared profile registry can also benchmark `memory-compactor` profiles for latency, concurrency, token-budget adherence, and fidelity.
- **Why It Matters**: The same control plane is expected to serve more than routing, so profile metadata must stay truthful across adjacent service types.

---

## 6. Current Gaps Blocking BETA

| Gap                                             | Why It Blocks BETA                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| No semantic service-pool ranking implementation | The future-ready architecture is still planned rather than shipped                                               |
| No semantic score traces                        | Observability is better than before, but not yet rich enough for semantic service-pool rollout                   |
| No tenant/project service-profile contract      | Projects still depend on raw URL wiring rather than logical semantic service selection                           |
| No profile benchmark suite                      | Model selection cannot be made responsibly without latency, throughput, concurrency, and memory data             |
| No shared multi-service profile contract        | The platform has not yet proven that `semantic-router` and `memory-compactor` can share one control plane safely |
| No profile lifecycle coverage                   | The repo does not yet prove reject, degrade, deprecate, and force-remove behavior for in-use service profiles    |

---

## 7. Notes

- This guide intentionally separates the shipped deterministic mitigation from the planned semantic-sidecar phase.
- This guide also separates the shipped deterministic mitigation from the later semantic service-pool phase.
- The NLU umbrella guide in [docs/testing/nlu.md](../nlu.md) remains the canonical parent for classifier and sidecar testing. This guide narrows the focus to gather-step interrupts and parent-supervisor reroutes.
- Current runtime config is URL-based for advanced NLU. Future validation in this guide assumes logical service-profile selection backed by a pool of semantic service containers.
- `memory-compactor` shares the future control plane described here, but compaction correctness itself should eventually live in a dedicated memory-management or compaction test guide rather than in this routing-focused guide.
