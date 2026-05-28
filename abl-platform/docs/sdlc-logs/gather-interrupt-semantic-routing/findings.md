# Findings — Gather Interrupt Semantic Routing

## wiring-gap

- [CRITICAL] ~~Classifier-first gather interrupt path not wired into flow-step-executor gather escape detection~~
  - flow-step-executor.ts implements gather escape detection (FlowEscapeMatch / detectParentSupervisorRoute) using lexical and LLM-based paths but does not invoke the pipeline classifier (classifier.ts) as a first-pass authority before falling back to lexical matching. The classifier is available via the pipeline context in the executor but the gather interrupt branch does not call classifyIntent() on the interrupt candidate. This means semantic rejection by the classifier never has a chance to keep the user in the gather step when the pipeline is active, violating FR-1 and FR-2 of the feature spec.
  - Files: apps/runtime/src/services/execution/flow-step-executor.ts, apps/runtime/src/services/pipeline/classifier.ts
  - Fixed in: c4e11dac94958e190e6a7e8eadf2a0b957963681
- [CRITICAL] ~~routing-resolver.ts does not receive or forward LEXICAL_FALLBACK policy to gather interrupt branch~~
  - routing-resolver.ts resolves routing candidates for supervisor reroutes but does not thread the lexical_fallback policy field (compiled from INTENTS: LEXICAL_FALLBACK) into the resolution result. flow-step-executor.ts therefore has no structured way to consult the policy when deciding whether to allow lexical rescue after a semantic rejection. The policy must be present in the ResolvedRoute or passed as a separate argument to the escape path for FR-6 to hold.
  - Files: apps/runtime/src/services/pipeline/routing-resolver.ts, apps/runtime/src/services/execution/flow-step-executor.ts
  - Fixed in: 4b09b7c2721d309fa3b3f38ed76fcd976cb6417f
- [MEDIUM] ~~classifier.ts gather-specific candidate surface not scoped — full intent corpus used for interrupt classification~~
  - The classifier in classifier.ts classifies against the full agent intent corpus rather than a gather-scoped finite candidate surface (the digression targets and sub-intent definitions active for the current gather step). The feature spec notes this as a planned improvement but it also affects correctness now: the classifier may return a match against a non-escape intent and the gather interrupt branch has no way to filter that result to only valid escape candidates without the routing-resolver providing a scoped candidate list.
  - Files: apps/runtime/src/services/pipeline/classifier.ts, apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: 4b09b7c2721d309fa3b3f38ed76fcd976cb6417f

## missing-test

- [HIGH] ~~No E2E test for semantic rejection preserving child gather ownership (E2E-2 from test spec)~~
  - The test spec mandates E2E-2: a controlled pipeline classifier that returns a semantic negative must keep the user inside the child gather step rather than triggering return_to_parent. The existing integration test in reasoning-pipeline-contract.test.ts covers the unit-level behavior but no E2E test runs through the public /api/v1/chat/agent route with a real server, real middleware chain, and a stubbed classifier endpoint. FR-2 is marked PARTIAL and E2E coverage is NO in the coverage matrix.
  - Files: apps/runtime/src/**tests**/execution/reasoning-pipeline-contract.test.ts
  - Fixed in: b238097f4e93a69b3c5647412abe349403ed6a1f
- [HIGH] ~~No E2E test for child gather flow returning to parent supervisor via normalized lexical fallback (E2E-1)~~
  - E2E-1 in the test spec requires a full end-to-end run through the public chat route where the pipeline classifier is disabled and the normalized lexical fallback rescues the gather interrupt, routing to the correct sibling. This scenario is only covered at the integration level in flow-intents-digressions.test.ts and reasoning-pipeline-contract.test.ts. A server-level E2E with real request routing and tenant isolation assertions is absent.
  - Files: apps/runtime/src/**tests**/execution/flow-intents-digressions.test.ts
  - Fixed in: b238097f4e93a69b3c5647412abe349403ed6a1f
- [MEDIUM] ~~No E2E test for voice surface gather interrupt contract parity (E2E-3 remainder)~~
  - E2E-3 is now satisfied across both non-voice and voice public surfaces. `gather-interrupt-sdk.e2e.test.ts` covers the SDK HTTP path on `/api/v1/chat/agent`, and `channels-voice-ingress.e2e.test.ts` now binds a real deployment to `voice_vxml` ingress and asserts the same `digression` + `return_to_parent` trace contract through the public telephony route.
  - Any future LiveKit/WebSocket-specific parity expansion belongs to the broader voice runtime semantics work, not as an open blocker for this gather-interrupt sub-feature.
  - Files: apps/runtime/src/**tests**/execution/gather-interrupt-sdk.e2e.test.ts, apps/runtime/src/**tests**/channels/channels-voice-ingress.e2e.test.ts
  - Resolved in: workspace follow-up verification on 2026-04-23
- [MEDIUM] ~~LEXICAL_FALLBACK parser/compiler/runtime round-trip test does not cover 'when_unavailable' variant at runtime~~
  - The compiler test (extract-intent-categories.test.ts) and core parser test (intents-section.test.ts) cover parsing and lowering of all three LEXICAL_FALLBACK values. However the runtime integration test in reasoning-pipeline-contract.test.ts only covers 'never' and implicit default behavior. The 'when_unavailable' variant — which should enable lexical rescue only during model outages — has no dedicated runtime integration test verifying the policy is respected when the pipeline transitions from available to unavailable mid-session.
  - Files: apps/runtime/src/**tests**/execution/reasoning-pipeline-contract.test.ts
  - Fixed in: 3fbf79811e99728f06430473e8606cf5a01ef86b
- [HIGH] ~~No negative auth/tenant isolation E2E tests for gather interrupt route~~
  - Per memory conventions, every ID-based route needs an authz triad: correct permission 200, cross-tenant 404, missing auth 401. The gather interrupt path resolves supervisor routes and sibling targets based on agent registry entries, but no E2E test asserts that a cross-tenant agentId in the session context returns 404 (not 403, not leaking existence), that a missing Authorization header returns 401, or that a valid token from a different tenant cannot resolve a parent supervisor route in the target tenant. This is a direct Core Invariant 1 gap and compounds with finding d41df5a1. (supported by Testing Oracle)
  - Files: apps/runtime/src/**tests**/execution/reasoning-pipeline-contract.test.ts, apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: b238097f4e93a69b3c5647412abe349403ed6a1f
- [HIGH] ~~No test verifies the classifier is actually invoked on the gather interrupt path~~
  - Given wiring gap d57bd3de, existing tests that stub the classifier prove nothing about integration — they pass whether or not classifyIntent() is reached. A call-site assertion test is needed: a spy on classifier.classifyIntent() that asserts the function is called at least once during gather interrupt detection, with the correct candidate surface and tenant scope. Without this, the feature's entire semantic-first promise (FR-1) is unverifiable and any future regression that bypasses the classifier will be silent. (supported by Testing Oracle)
  - Files: apps/runtime/src/**tests**/execution/reasoning-pipeline-contract.test.ts, apps/runtime/src/services/execution/flow-step-executor.ts, apps/runtime/src/services/pipeline/classifier.ts
  - Fixed in: 3fbf79811e99728f06430473e8606cf5a01ef86b
- [HIGH] ~~Reasoning-pipeline-contract test over-mocks — mocks classifier, routing-resolver, and session store simultaneously~~
  - The existing integration test at reasoning-pipeline-contract.test.ts appears to stub the classifier, mock the routing-resolver output, and stub session state. When three dependencies are mocked, the test verifies only the glue code between mocks, not that the real classifier, real resolver, and real session store interoperate. This is false-confidence tested behavior. At least one integration test must use the real classifier (with a deterministic local model or seeded fixtures) and the real resolver against a test DB to catch wiring regressions like d57bd3de and 061ac739. Platform components (classifier, resolver) must not be mocked per feedback_fix_code_not_test.md. (supported by Testing Oracle)
  - Files: apps/runtime/src/**tests**/execution/reasoning-pipeline-contract.test.ts
  - Fixed in: 3fbf79811e99728f06430473e8606cf5a01ef86b
- [MEDIUM] ~~No timeout/latency fallback test for classifier — model hang is untested~~
  - The feature depends on classifier responsiveness. If classifyIntent() hangs, what happens? Is there a timeout? Does the gather step stall, or does it fall back to lexical (and if so, is LEXICAL_FALLBACK=never still respected)? No test covers a classifier that resolves after a deadline exceeds. This is a production failure mode that must be exercised — without it, a slow NLU sidecar would cause gather steps to hang indefinitely in prod. (supported by Testing Oracle)
  - Files: apps/nlu-sidecar/src, apps/runtime/src/services/pipeline/classifier.ts
  - Fixed in: b8f8947e0ea9cb6b61d58a572c04479d0a484203
- [MEDIUM] ~~No contract test for nlu-sidecar ↔ runtime classifier interface~~
  - apps/nlu-sidecar is called remotely from apps/runtime classifier.ts. There is no shared contract test that pins the request/response schema, error envelope, or streaming behavior. A schema drift on either side (e.g., sidecar renames a field) would only be caught in production. A contract test in packages/shared-kernel or a dedicated contract suite should lock both sides to the same JSON schema with a generated fixture replayed by both services. (supported by Testing Oracle)
  - Files: apps/nlu-sidecar/src, apps/runtime/src/services/pipeline/classifier.ts, packages/shared-kernel
  - Fixed in: b8f8947e0ea9cb6b61d58a572c04479d0a484203
- [MEDIUM] ~~No schema-validation test for gather interrupt trace payload shape~~
  - FR-7 mandates detectionMode and lexicalMatchType on traces, and finding 2afdc841 notes these are emitted inconsistently across paths. A single trace-schema assertion test should run each of the three interrupt paths (digression, sub-intent, parent-reroute) and validate the emitted trace payloads against a canonical JSON schema. Without this, downstream observability consumers will silently miss events. This also prevents regression of the 2afdc841 fix. (supported by Testing Oracle)
  - Files: apps/runtime/src/**tests**/execution/flow-intents-digressions.test.ts, apps/runtime/src/services/execution/flow-step-executor.ts
  - Fixed in: 3fbf79811e99728f06430473e8606cf5a01ef86b

## inconsistency

- [HIGH] ~~detectionMode and lexicalMatchType trace fields emitted inconsistently across digression vs sub-intent vs parent-reroute paths~~
  - FR-7 requires trace payloads to include detectionMode (classifier | lexical | llm_fallback) and lexicalMatchType (normalized | exact) on all gather interrupt traces. Based on the gathered evidence, flow-step-executor.ts emits these fields only on the digression path. The sub-intent path and parent-supervisor reroute path do not carry the same structured trace payload, making it impossible for consumers to distinguish how an interrupt was detected in those branches.
  - Files: apps/runtime/src/services/execution/flow-step-executor.ts
  - Fixed in: c4e11dac94958e190e6a7e8eadf2a0b957963681
- [HIGH] ~~routing-resolver.ts parent-supervisor reroute resolution does not validate tenantId/projectId scope on resolved route~~
  - When a child flow triggers a parent-supervisor reroute, routing-resolver.ts resolves the target route but the gathered evidence does not show an explicit tenantId + projectId ownership check on the resolved supervisor agent registration before handing the route back to flow-step-executor.ts. This risks cross-scope route leakage if an agent registry entry is accessible across tenant boundaries (violates Core Invariant 1 — Resource Isolation).
  - Files: apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: 4b09b7c2721d309fa3b3f38ed76fcd976cb6417f
- [HIGH] ~~LEXICAL_FALLBACK policy evaluation is decentralized across flow-step-executor branches~~
  - The lexical_fallback policy (always | when_unavailable | never) must be consulted at three distinct points in the gather interrupt path: (a) after a classifier negative, (b) when the pipeline model is unavailable, and (c) during post-classification rescue for sub-intent paths. With the policy not threaded through ResolvedRoute (see 061ac739), each branch re-derives or ignores the policy independently, creating the exact regression described in fba76473. Architecturally the policy should be evaluated by a single gate function (e.g. shouldAllowLexicalFallback(policy, reason)) in routing-resolver or a dedicated policy module, and every branch should delegate to it. Centralizing this also makes the 'when_unavailable' variant trivially testable. (supported by Architecture Oracle)
  - Files: apps/runtime/src/services/execution/flow-step-executor.ts, apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: c4e11dac94958e190e6a7e8eadf2a0b957963681
- [MEDIUM] ~~classifier.ts has no typed seam distinguishing gather-scoped vs global classification modes~~
  - classifyIntent() is a single polymorphic entry point used by both the global pipeline routing path and the gather interrupt path. This couples two distinct use cases (open-domain classification over the full agent intent corpus vs. constrained classification over a finite gather-escape candidate set) into one function with no type-level distinction. The right seam is either (a) a second method classifyGatherInterrupt(candidates, utterance) with its own return contract, or (b) a required CandidateSurface parameter on classifyIntent. Without this seam, finding 242c39eb cannot be cleanly resolved, and future contributors will continue to conflate the two modes. (supported by Architecture Oracle)
  - Files: apps/runtime/src/services/pipeline/classifier.ts, apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: 4d42711a27a1645eb3daa8472c4e57066772aefa

## bug

- [HIGH] ~~Lexical fallback policy 'never' is not enforced when pipeline model is unavailable (FR-8 regression risk)~~
  - When the pipeline model is unavailable, flow-step-executor.ts falls through to lexical matching as a rescue lane. If the supervisor has configured LEXICAL_FALLBACK: never, the fallback should be suppressed entirely and the gather step should retain ownership (or return a safe non-routing result). The gathered code does not gate the unavailability fallback against the lexical_fallback policy, meaning a 'never' policy is silently violated during outages.
  - Files: apps/runtime/src/services/execution/flow-step-executor.ts, apps/runtime/src/services/pipeline/routing-resolver.ts
  - Fixed in: c4e11dac94958e190e6a7e8eadf2a0b957963681

## missing-doc

- [LOW] ~~No inline contract comment on classifier.ts gather-interrupt entry point distinguishing gather-scoped vs global classification~~
  - classifier.ts exposes a single classify entry point used by both the normal pipeline routing path and the gather interrupt path. An inline contract comment now documents that this exported seam intentionally preserves gather-scoped routing semantics so tests can observe the real classifier lane without bypassing prompt construction or finite-candidate filtering.
  - Files: apps/runtime/src/services/pipeline/classifier.ts
  - Fixed in: fe32a4d16dc427083e689a66759bd80afc91e49b
- [MEDIUM] ~~No typed GatherInterruptTrace contract in shared-kernel for cross-surface parity~~
  - Trace payload fields (detectionMode, lexicalMatchType, policyApplied, classifierConfidence, candidateSurface) are emitted ad-hoc by flow-step-executor with no shared type. Channel adapters (chat, voice, SDK) and downstream consumers (audit, eval harness, observability) have no contract to code against, which is the root cause of the inconsistency in 2afdc841 and will recur when E2E-3 (voice/SDK parity) is implemented. A typed GatherInterruptTrace interface should live in packages/shared-kernel and be the only emit shape permitted in the executor. (supported by Architecture Oracle)
  - Files: apps/runtime/src/services/execution/flow-step-executor.ts, packages/shared-kernel/src/
  - Fixed in: 4d42711a27a1645eb3daa8472c4e57066772aefa

## stale-dependency

- [LOW] ~~Prior Deep Scan finding (network/DNS failure) remains unresolved in findings.md~~
  - The earlier Deep Scan blockage was superseded by later recovered HELIX runs. The final audit session (`0f8f7064`) completed successfully on April 23, 2026, and the remaining transport/DNS noise was traced to HELIX executor handling rather than a persistent machine-wide connectivity fault. This historical finding is now explicitly closed in the audit record.
  - Files: docs/sdlc-logs/gather-interrupt-semantic-routing/findings.md
  - Resolved in: session 0f8f7064 doc-sync closure on 2026-04-23

## isolation

- [MEDIUM] ~~Classifier sidecar calls lack explicit tenantId/projectId scoping in the request envelope~~
  - apps/nlu-sidecar is in scope for this feature but the gathered evidence does not confirm that classifier invocations carry tenantId + projectId in the request envelope for per-tenant model routing, rate limiting, and audit attribution. Without this, the sidecar cannot enforce per-tenant classifier configuration (e.g., tenant-specific thresholds or models) and logs/metrics cannot be attributed to the correct scope. Confirm request envelope includes tenantId/projectId/agentId and that the sidecar rejects requests missing them. (supported by Architecture Oracle)
  - Files: apps/nlu-sidecar/, apps/runtime/src/services/pipeline/classifier.ts
  - Fixed in: 4d42711a27a1645eb3daa8472c4e57066772aefa
