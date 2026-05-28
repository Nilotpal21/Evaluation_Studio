# Test-Spec Oracle Decisions

**Date**: 2026-04-27
**Feature**: workflow-first-class-memory-and-context
**Oracle**: product-oracle (Opus 4.6)

## Context Consulted

- `docs/features/sub-features/workflow-first-class-memory-and-context.md` (FR-1..FR-23, section 4a, section 9, section 17)
- `docs/specs/workflow-first-class-memory-and-context.hld.md` (architecture, 4 internal HTTP routes, requireServiceAuth tenantId cross-check, isolated-vm pattern, 12 concerns)
- `docs/testing/sub-features/workflow-first-class-memory-and-context.md` (stale test spec covering FR-1..FR-17 only)
- `CLAUDE.md` (Test Architecture, E2E Test Standards, Test Integrity sections)
- `apps/workflow-engine/src/__tests__/function-executor.test.ts` (existing pure-function unit tests, uses `executeFunctionStep` directly)
- `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` (existing unit tests for `resolveExpression`/`resolveExpressionTyped`)
- `apps/workflow-engine/src/__tests__/workflow-integration.test.ts` (integration tests using `runWorkflow` with mocked persistence/publisher)
- `apps/workflow-engine/src/__tests__/e2e-medium.test.ts` (medium E2E using `runWorkflow` with mocked deps)
- `apps/workflow-engine/src/__tests__/route-integration.test.ts` (Express route tests with supertest)
- `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` (MongoMemoryServer helper pattern)
- `apps/runtime/src/__tests__/mongodb-fact-store.test.ts` (InMemoryFactStore tests, TTL coverage)
- `apps/runtime/src/__tests__/mongodb-fact-store-scope.test.ts` (scope isolation tests using vi.mock of database models)
- `apps/runtime/src/__tests__/execution/contexts/contact/cascade-delete-contact.test.ts` (cascade delete unit tests)
- `apps/runtime/src/middleware/internal-service-auth.ts` (requireServiceAuth implementation, line 59-73 projectId cross-check)
- `apps/studio/e2e/workflows/agents.md` (E2E test organization, tiers, helpers)
- `apps/studio/e2e/workflows/helpers.ts` (Playwright helpers: loginAndSetup, createWorkflowViaUI, runWorkflow, etc.)
- `apps/studio/e2e/workflows/workflow-function-node.spec.ts` (existing function node E2E pattern)
- `packages/shared-auth/src/middleware/jwt-verify.ts` (`createServiceToken` export)
- `tools/test-capture.ts` (tier system: `test:fast` and `test`)

---

## Answers

### T1: Which FRs are highest risk and should receive E2E coverage?

**Classification**: DECIDED
**Answer**: Rank by risk: (1) FR-10 workflow-scope `wf:<workflowId>:<key>` isolation -- novel key-prefix mechanism, cross-surface namespace, highest isolation risk; (2) FR-11 `memory.user` end-user resolution per section 4a matrix -- complex identity dispatch, compliance-critical; (3) FR-2/3 agentSession/agentContext materialization -- new push-at-invoke data flow across two services; (4) FR-19 no template re-interpolation -- security-critical injection guard; (5) FR-20 per-write quotas + reserved-prefix guard -- enforcement boundary, two-layer guard; (6) FR-23 right-to-erasure cascade -- compliance-critical but extends existing CascadeDeleteContact; (7) FR-22 audit log emission -- important but lower structural risk. E2E coverage: FR-2/3, FR-10, FR-11 (combined in cross-trigger + agent-triggered scenarios). FR-19, FR-20, FR-22, FR-23 are integration-appropriate because they test internal enforcement boundaries rather than user journeys.
**Source**: Feature spec section 17 scenarios, HLD Concern #1 (tenant isolation), Concern #4 (security surface), section 7 (compliance/GDPR)
**Confidence**: HIGH

### T2: Known edge cases requiring test coverage?

**Classification**: ANSWERED
**Answer**: Yes, three explicit edge cases from the spec. (1) Section 4a says cookie-reset starts a new `endUserId` and prior `memory.user.*` is unreachable -- test spec needs an explicit scenario confirming `memory.user` isolation across `anonymousId` rotation. (2) Section 6 anti-pattern: `memory.workflow.*` is workflow-global (not per-invoker) so two different end users writing/reading the same key see each other's data -- test spec scenario 7 already covers this but should be labeled as a privacy regression test. (3) HLD Concern #4 (c.2): `tool-memory-bridge.ts` must NOT be able to forge `wf:` keys -- this is scenario 21's cross-surface namespace test. All three need explicit test coverage.
**Source**: Feature spec section 4a (cookie-reset paragraph), section 6 (anti-pattern note), HLD Concern #4 (c.2 MongoDBFactStore `wf:` prefix guard)
**Confidence**: HIGH

### T3: Current test coverage baseline and extend vs new?

**Classification**: ANSWERED
**Answer**: Current baseline: (a) `expression-resolver.test.ts` tests `resolveExpression`/`resolveExpressionTyped` against `trigger`, `workflow`, `tenant`, `steps`, `vars` -- extend with new test cases for `memory`, `agentSession`, `agentContext` top-level keys. (b) `function-executor.test.ts` tests `executeFunctionStep` with `context` proxy, read-only enforcement -- extend with new test cases for direct globals and memory ops. (c) `workflow-integration.test.ts` tests `runWorkflow` with mocked persistence/publisher -- extend for agent-triggered vs non-agent trigger scenarios. (d) `mongodb-fact-store.test.ts` uses `InMemoryFactStore` (not real Mongo); `mongodb-fact-store-scope.test.ts` uses `vi.mock` of `@agent-platform/database/models` (violates CLAUDE.md no-mock rule -- NOT a good pattern to follow). (e) Net-new files needed: `runtime-memory-client.test.ts`, `fact-store-workflow-adapter.test.ts`, `workflow-memory.integration.test.ts`, `internal-memory-route.integration.test.ts`, `workflow-first-class-memory.spec.ts` (Studio E2E).
**Source**: `apps/workflow-engine/src/__tests__/expression-resolver.test.ts`, `function-executor.test.ts`, `workflow-integration.test.ts`, `apps/runtime/src/__tests__/mongodb-fact-store*.test.ts`
**Confidence**: HIGH

### T4: External deps -- mocking vs real integration?

**Classification**: DECIDED
**Answer**: Per CLAUDE.md Test Architecture and the HLD Concern #12: (a) Real Mongo via MongoMemoryServer -- established pattern in `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`. (b) Real isolated-vm -- existing `function-executor.test.ts` already uses the real isolate. (c) Real internal HTTP routes -- mount Express app with the new `/api/internal/memory` routes using supertest. (d) For `requireServiceAuth` JWT: use a real JWT signed with a test secret via `createServiceToken` from `@agent-platform/shared-auth` (already exported, already used in `apps/workflow-engine/src/index.ts:751`). Do NOT stub the middleware -- the tenantId cross-check is a prerequisite infrastructure change being landed with this feature and must be tested through the real middleware. (e) No external third-party services need mocking -- the entire stack is internal (Mongo, isolated-vm, HTTP routes).
**Source**: CLAUDE.md "Test Architecture" and "E2E Test Standards"; `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`; `packages/shared-auth/src/middleware/jwt-verify.ts:163` (`createServiceToken`); HLD Concern #12
**Confidence**: HIGH

### T5: Test environment setup and organization?

**Classification**: ANSWERED
**Answer**: (a) Workflow-engine integration tests do NOT bring up runtime as a separate process; they call `runWorkflow()` directly with injected deps (persistence, publisher are mocked interfaces). For the new memory feature, tests that exercise the workflow-engine --> runtime HTTP seam must mount the runtime memory route into a local Express app via supertest -- same pattern as `route-integration.test.ts`. (b) Studio E2E tests (Playwright) exercise real running services (Studio, Runtime, Workflow Engine, Restate, MongoDB, Redis) -- per `workflow-function-node.spec.ts` header comment. (c) Existing tests are organized: unit tests call pure functions directly; integration tests use `runWorkflow` or supertest against mounted routes; E2E tests use Playwright against real services. (d) CI tiers per `tools/test-capture.ts`: `test:fast` (default, pure unit) and `test` (full including integration). New unit/integration tests belong in `test` tier; Studio E2E tests run as a separate Playwright CI job.
**Source**: `apps/workflow-engine/src/__tests__/workflow-integration.test.ts` (runWorkflow pattern), `route-integration.test.ts` (supertest pattern), `workflow-function-node.spec.ts` (real services comment), `tools/test-capture.ts` (tier flags)
**Confidence**: HIGH

### E1: Critical user journeys for E2E?

**Classification**: DECIDED
**Answer**: Minimum E2E set (5 scenarios, matching the stale spec's 4 + adding erasure): (a) Agent-triggered run reads agentSession/agentContext + writes/reads memory -- combines FR-2/3 with FR-9. (b) Cross-trigger memory continuity: function-node write from one trigger type, expression read from another. (c) Non-agent trigger surfaces undefined for agentSession/agentContext gracefully. (d) `memory.user.*` erasure cascade end-to-end via the existing GDPR delete route -- this must be E2E because it validates the full cascade pipeline, not just a single service boundary. (e) Workflow-as-tool nesting: nested workflow run sees outermost agent's agentSession/agentContext and its own `memory.workflow.*` keyed on the inner workflowId. This is E2E because it requires two real workflow executions chained through the agent tool invocation path. The stale test spec already has (a)-(d) as E2E-1 through E2E-4; add (e) as E2E-5.
**Source**: Feature spec section 8 (workflow-as-tool nesting paragraph), section 17 scenario 19 (nesting), HLD section 3.3
**Confidence**: HIGH

### E2: Auth/permission combinations for E2E?

**Classification**: DECIDED
**Answer**: The `requireServiceAuth` tenantId cross-check is a prerequisite infrastructure change (HLD section 8.1). Auth combination E2E coverage should include: (a) valid service JWT with matching tenantId+projectId (happy path, covered implicitly by all E2E memory scenarios); (b) tampered tenantId (body tenantId differs from JWT tenantId) returns 403 -- this is the NEW cross-check being added. (c) expired service token returns 401. These belong as integration tests against the mounted route (supertest), not full Studio Playwright E2E, because they test middleware enforcement not user journeys. Cross-tenant token reuse is architecturally identical to (b). Tampered projectId is already covered by existing `requireServiceAuth` (line 59-73 of `internal-service-auth.ts`). Add (b) and (c) to the integration test suite for the new `/api/internal/memory` route.
**Source**: HLD section 8.1 (prerequisite change), `apps/runtime/src/middleware/internal-service-auth.ts:59-73`
**Confidence**: HIGH

### E3: Cross-feature interactions for E2E?

**Classification**: DECIDED
**Answer**: Two cross-feature interactions need coverage: (1) `tool-memory-bridge.ts` writing `memory.project.foo` and a workflow run reading the same key -- this validates the cross-surface fact namespace (scenario 21). Integration-level is sufficient because it only requires verifying the fact-store key matches, not a full user journey. (2) Workflow-as-tool nesting does need a real two-workflow chain in E2E (E2E-5 above) because the agentSession/agentContext propagation through the agent --> outer-workflow --> agent-tool --> inner-workflow path cannot be meaningfully tested without the full invocation chain. The `wf:` prefix guard blocking `tool-memory-bridge.ts` from forging workflow-scoped keys (HLD Concern #4 c.2) is integration-appropriate.
**Source**: Feature spec section 9 (cross-surface fact trust model), HLD Concern #4 (c.2), section 17 scenario 19 and 21
**Confidence**: HIGH

### E4: Data seeding for E2E?

**Classification**: INFERRED
**Answer**: Based on existing Studio E2E patterns in `helpers.ts` and `workflow-function-node.spec.ts`: (a) Workflow fixtures created via UI (`createWorkflowViaUI`) + function node configured via Zustand store (`configureFunctionNode` pattern from `workflow-function-node.spec.ts`). (b) Agent-tool binding requires an agent with the workflow registered as a tool -- seed via runtime API (POST). (c) End-user contact fixture for erasure tests: seed via the contacts API. (d) Prior-run memory state: seed by running the workflow once with a memory write before the assertion run -- no direct DB seeding (per CLAUDE.md E2E rules). (e) For the nesting E2E: two workflows must be created -- outer with agent-tool binding to inner. The existing `loginAndSetup` helper provides auth tokens and project context.
**Source**: `apps/studio/e2e/workflows/helpers.ts` (loginAndSetup, createWorkflowViaUI, runWorkflow), `workflow-function-node.spec.ts:34-60` (configureFunctionNode pattern)
**Confidence**: MEDIUM

### E5: Performance/load scenarios?

**Classification**: DECIDED
**Answer**: The FR-20 cap (100 writes/run) and HLD Concern #9 budget (5s worst-case) are enforcement assertions, not load tests. The correct test is an integration test: (a) assert that the 100th write succeeds and the 101st throws `QUOTA_WRITE_COUNT`; (b) assert that a single memory op completes within a reasonable time bound (< 200ms, not the 50ms p95 target -- that's operational). Load testing (k6, multi-concurrent-run throughput) is deferred to post-implementation performance validation. The test spec should include the quota enforcement scenario (scenario 11) as integration, not as a load test.
**Source**: Feature spec FR-20, HLD Concern #9 (performance budget), CLAUDE.md (no load test infrastructure in unit/integration suites)
**Confidence**: HIGH

### I1: Service boundaries for integration tests?

**Classification**: ANSWERED
**Answer**: The full list of integration boundaries: (a) workflow-engine --> runtime via `/api/internal/memory/*` (4 routes: projection, get, set, delete) -- test via supertest against mounted Express app. (b) Runtime memory route --> MongoDBFactStore (via FactStoreWorkflowAdapter) -- real MongoMemoryServer. (c) FactStoreWorkflowAdapter `wf:<workflowId>:<key>` prefix translation -- pure function test for key mapping + integration test that the translated key round-trips through Mongo. (d) CascadeDeleteContact --> fact-erasure step (new) -- extend existing cascade delete test pattern. (e) function-executor --> `ivm.Reference.applySyncPromise` --> runtime-memory-client --> HTTP -- this is the most novel pattern per HLD section 8.1; needs an integration test that runs a real isolated-vm function node with a memory write that hits the mounted runtime route. (f) `requireServiceAuth` tenantId cross-check (prerequisite) -- supertest against the middleware.
**Source**: HLD section 3 (architecture diagram), section 6.1 (4 routes), Concern #12 (test strategy), HLD section 8.1 (prerequisite)
**Confidence**: HIGH

### I2: Webhook/event-driven flows for integration?

**Classification**: DECIDED
**Answer**: Testing memory.workflow.\* directly (writing from a function node, reading from an expression in a subsequent run) is sufficient for webhook/cron/event triggers. The trigger pipeline itself (webhook receipt, cron scheduling, event dispatch) is already tested in existing trigger tests (`trigger-engine.test.ts`, `trigger-scheduler-lifecycle.test.ts`). The memory feature does not modify the trigger pipeline -- it only consumes the execution context that triggers produce. Spawning the full trigger pipeline in memory integration tests would add complexity without additional memory-specific coverage.
**Source**: Feature spec section 3.3a (non-agent triggers), existing `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`
**Confidence**: HIGH

### I3: Tenant/project isolation scenarios?

**Classification**: ANSWERED
**Answer**: Confirmed -- all four scenarios need integration tests: (a) Cross-tenant read: memory write with tenantId A, read attempt with tenantId B returns undefined/error. Enforced by MongoDBFactStore query filters and requireServiceAuth JWT cross-check. (b) Cross-project read: same as (a) but projectId. (c) `wf:<workflowId>:<key>` doesn't leak across workflows in same project: write `memory.workflow.foo` from workflow A, read from workflow B returns undefined -- the `wf:` prefix includes workflowId. (d) `memory.user.*` with different `anonymousId` values returns different data -- tests the user-scope isolation per section 4a. All four are integration-level (supertest + real Mongo).
**Source**: Feature spec FR-10, FR-11, FR-16, section 4a, HLD Concern #1
**Confidence**: HIGH

### I4: Race conditions / concurrency scenarios?

**Classification**: DECIDED
**Answer**: A single-process simulated test with two parallel async writes is sufficient for v1. The spec (section 17 scenario 17) explicitly states v1 is last-write-wins with no CAS/atomic guarantees. The test should: (a) fire two `memory.workflow.set('key', valueA)` and `memory.workflow.set('key', valueB)` concurrently via `Promise.all`; (b) assert the final read returns one of valueA or valueB (not a merge or error). A real two-process test is overkill given the v1 contract explicitly disclaims cross-run consistency. MongoDB upsert is inherently last-write-wins.
**Source**: Feature spec section 12 (concurrency paragraph), section 17 scenario 17, HLD Concern #7 (idempotency)
**Confidence**: HIGH

### I5: Error/failure paths for integration?

**Classification**: DECIDED
**Answer**: Five integration-level failure scenarios: (a) HTTP timeout from runtime-memory-client: configure a test route with artificial delay beyond the client timeout, assert the function node throws `WorkflowMemoryError` with code `STORAGE_UNAVAILABLE`. (b) 503 from runtime: mock the route handler to return 503, assert the client surfaces the error. (c) Network partition simulation is not needed -- (a) covers the observable behavior. (d) MongoDB unavailable: stop MongoMemoryServer mid-test (or use a connection-drop mock), assert the memory route returns 503 and the client throws. (e) Tombstone visibility post-soft-delete: `memory.delete` a key, then `memory.get` the same key returns undefined; but the underlying Mongo document has `isDeleted: true` and `deletedAt` set (verify via a separate fact-store read that includes tombstones -- this is an internal assertion, not an E2E test). Error codes to test: `QUOTA_KEY_LENGTH`, `QUOTA_VALUE_SIZE`, `QUOTA_WRITE_COUNT`, `RESERVED_PREFIX`, `TTL_INVALID`, `STORAGE_UNAVAILABLE`, `UNAVAILABLE_SCOPE`.
**Source**: HLD Concern #5 (error model), Concern #6 (failure modes), section 3.4 (failure path diagram), feature spec FR-21
**Confidence**: HIGH

### S1: Testcontainer pattern for Mongo in workflow-engine?

**Classification**: ANSWERED
**Answer**: Yes, documented pattern exists at `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts`. Uses `MongoMemoryServer` (not Docker testcontainers). Provides `setupTestMongo()`, `teardownTestMongo()`, `clearCollections()`, and a `requireMongo(skip)` guard for graceful skip when MongoMemoryServer is unavailable. Already used by system tests (`system-persistence.test.ts`, `system-handler.test.ts`, etc.). New integration tests should import from this helper.
**Source**: `apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts` (full file read)
**Confidence**: HIGH

### S2: Studio E2E helper for "create workflow with function node and run it"?

**Classification**: ANSWERED
**Answer**: Yes. `apps/studio/e2e/workflows/helpers.ts` exports: `loginAndSetup`, `navigateToWorkflows`, `createWorkflowViaUI`, `waitForCanvasReady`, `addNodeViaHandleMenu`, `selectNodeByName`, `saveWorkflow`, `runWorkflow`, `waitForDebugPanel`, `deleteWorkflowFromList`. The `workflow-function-node.spec.ts` demonstrates the full pattern: create workflow via UI, configure function node via Zustand store (`configureFunctionNode`), save, run, verify debug output. New E2E tests should follow this pattern exactly.
**Source**: `apps/studio/e2e/workflows/helpers.ts:1-80`, `workflow-function-node.spec.ts:1-60`
**Confidence**: HIGH

### S3: CI tier classifications?

**Classification**: ANSWERED
**Answer**: Two tiers per `tools/test-capture.ts`: (a) `test:fast` (default) -- pure unit tests, no I/O dependencies. (b) `test` -- full tier including integration tests with MongoMemoryServer and isolated-vm. New workflow-memory unit tests (expression resolver, key-prefix translation, TTL clamping) go in `test:fast`. New integration tests (memory route, fact-store adapter, function-executor with memory, cascade delete) go in `test`. Studio E2E (Playwright) tests run in a separate CI job (not via test-capture) per existing infrastructure. Each package's `package.json` declares which script name maps to which tier.
**Source**: `tools/test-capture.ts:9-10` (tier documentation), `tools/test-capture.ts:28` (type definition: `'test:fast' | 'test'`)
**Confidence**: HIGH

---

## Decisions Made

| #   | Decision                                                                                          | Rationale                                                                                                                                                  | Risk |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D-1 | FR-10, FR-11, FR-2/3 ranked as top E2E risks; FR-19/20/22/23 as integration-level                 | FR-10/11 involve novel isolation mechanisms spanning two services; FR-19/20/22/23 test enforcement at a single service boundary                            | Low  |
| D-2 | Use real JWT via `createServiceToken` with test secret for requireServiceAuth                     | Pattern already used in `apps/workflow-engine/src/index.ts:751`; stubbing the middleware would hide the tenantId cross-check being added as a prerequisite | Low  |
| D-3 | Auth combination tests (tampered tenantId, expired token) as integration, not Playwright E2E      | These test middleware enforcement, not user journeys; supertest is faster and more precise                                                                 | Low  |
| D-4 | Cross-feature `tool-memory-bridge` namespace test as integration; workflow-as-tool nesting as E2E | Namespace is a key-matching concern (single boundary); nesting requires multi-service invocation chain                                                     | Low  |
| D-5 | Concurrency test uses single-process `Promise.all`, not multi-process                             | v1 explicitly disclaims cross-run consistency; MongoDB upsert is inherently last-write-wins                                                                | Low  |
| D-6 | Performance quotas tested as integration assertions, not load tests                               | FR-20 defines enforcement thresholds, not throughput targets; load testing is post-impl                                                                    | Low  |
| D-7 | Cookie-reset `anonymousId` isolation needs an explicit test                                       | Feature spec section 4a calls it out as a consequence authors must understand; regression test prevents future scope confusion                             | Low  |

## Escalations

None -- all questions were answerable from the codebase, feature spec, HLD, and existing test patterns.

---

## Audit Log

### Round 1 — phase-auditor (NEEDS_REVISION)

- **CRITICAL**: 0
- **HIGH**: 2
  - HIGH-1: INT-14 omitted the `event` trigger row from the §4a User Identity Resolution Matrix (only 5 of 6 rows mounted).
  - HIGH-2: `memory.workflow.*` workflow-global privacy regression had no dedicated scenario testing two distinct end users.
- **MEDIUM**: 2 (resolved alongside HIGH fixes)
- **LOW**: 0

Resolutions:

1. INT-14 setup expanded to 7 mounted scenarios including event-with-userId and event-without-userId; expected results enumerate the conditional branch; coverage line updated.
2. New INT-16 added — alice + bob on same workflow, alice writes, bob reads alice's value, fact-store inspection confirms `userId === '__project__'` sentinel.
3. Test File Mapping updated — event coverage rolled into existing end-user-identity-matrix file; new `workflow-scope-global-regression.integration.test.ts` mapped for INT-16.
4. Security checklist item 13 updated to reference INT-16 explicitly with both contact identities named.

### Round 2 — phase-auditor (APPROVED)

- **CRITICAL**: 0
- **HIGH**: 0
- **MEDIUM**: 0
- **LOW**: 0
- Cosmetic note: "INT-1..INT-15" prose in CI config — fixed to "INT-1..INT-16" post-audit.

Both round-1 HIGH findings verified resolved. All XP-1..XP-5 cross-phase consistency checks PASS. All test-spec quality gates (TS-1..TS-10) PASS.

## Final Counts

- E2E scenarios: 5 (E2E-1..E2E-5) — exceeds minimum of 5
- Integration scenarios: 16 (INT-1..INT-16) — exceeds minimum of 5
- Unit scenarios: 7 (UT-1..UT-7)
- FR coverage: 23 of 23 (FR-1..FR-23)
- Test files mapped: 17 (3 extending existing, 14 new)
