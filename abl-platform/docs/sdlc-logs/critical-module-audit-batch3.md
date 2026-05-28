# Critical Module Cross-Phase Audit -- Batch 3

**Date**: 2026-03-25
**Auditor**: Phase Auditor (claude-opus-4-6)
**Modules**: pii-detection, tool-invocations, agent-anatomy
**Scope**: Cross-phase consistency, spec correctness, testing issues, LLD gaps

---

## Module: pii-detection

### Status: BETA (feature spec) / Implemented BETA (HLD/LLD)

### Spec Issues

#### HIGH: E2E test misclassification in test inventory

The test spec lists `builtin-pii-e2e.test.ts` under **E2E Tests** section header but it is a guardrail-pipeline-level integration test located at `packages/compiler/src/__tests__/guardrails/providers/builtin-pii-e2e.test.ts`. It does NOT exercise the HTTP API, does NOT start a real server, and imports compiler internals directly. This inflates the apparent E2E coverage. The only genuine E2E test is `attachment-pii.e2e.test.ts` (which properly uses real Express servers, real MongoDB, real auth middleware).

- **Location**: `docs/testing/pii-detection.md` line 65-68
- **Fix**: Reclassify `builtin-pii-e2e.test.ts` as "integration" (pipeline-level), not "E2E". Update the E2E count to 1 genuine E2E test file (attachment-pii-e2e).

#### HIGH: 6 of 7 E2E scenarios have status GAP -- no real-server E2E exists for the PII pattern CRUD API

The test spec defines 7 E2E scenarios (E2E-1 through E2E-7). Six have status GAP or PARTIAL. Only E2E-5 has PARTIAL status (covered by pii-integration.test.ts which is actually an integration test, not a real HTTP E2E). There are no E2E tests exercising the 6 PII pattern CRUD API endpoints (`/api/projects/:projectId/pii-patterns`) through real HTTP with full auth middleware.

- **Location**: `docs/testing/pii-detection.md` E2E-1 through E2E-7
- **Fix**: The test spec correctly documents these as GAPs (TG-01 through TG-04). This is honest documentation but represents a significant coverage hole for a BETA feature with API routes in production.

#### MEDIUM: Feature spec and HLD list slightly different module groupings

The feature spec (section 10) lists `packages/eventstore` as a package but the HLD does not reference eventstore integration in the component diagram or key integration points table. The feature spec mentions `event-retention-service.ts` integration with `piiRetentionDays`, but this is treated as config-only in the HLD (concern #11 Compliance, mentions "EventStore has separate PII retention policy" as a config reference, not a code dependency).

- **Location**: Feature spec header vs HLD section 4
- **Fix**: Minor. Either add EventStore as a key integration point in the HLD or clarify in the feature spec header that EventStore is config-only (not code dependency).

#### LOW: LLD acceptance criteria checkboxes all unchecked

The LLD has historical implementation phases with all tasks marked "Done" but the E2E gaps section at the bottom (section 5) lists 4 E2E gaps with no timeline. The wiring checklist (section 4) shows all verified but phase 3 includes Studio UI verification which was not independently tested.

- **Location**: `docs/plans/pii-detection.lld.md` sections 5, 3
- **Fix**: Cosmetic. Add estimated timelines to the E2E gaps section since the feature is at BETA status and E2E coverage is required for STABLE promotion.

### Testing Issues

#### HIGH: No real-server E2E tests for the PII pattern CRUD API

The feature has 6 REST API endpoints registered at `apps/runtime/src/routes/pii-patterns.ts` (verified file exists). The test spec acknowledges this gap (TG-01, TG-02, TG-03, TG-04). For a BETA feature, having zero E2E tests for the primary API surface is a significant gap -- the routes, auth middleware, tenant isolation, and validation are all untested through real HTTP.

- **Location**: `docs/testing/pii-detection.md` gaps section
- **Impact**: Routes may have auth, validation, or isolation bugs that unit tests (which mock middleware) would never catch.
- **Fix**: Implement E2E-1 (Pattern CRUD), E2E-3 (Cross-Tenant Isolation), and E2E-4 (Invalid Pattern Rejection) as minimum before STABLE promotion.

#### MEDIUM: Integration tests use mocks for codebase components

`pii-pattern-loader.test.ts` uses `vi.mock` for `pii-pattern-repo.js` and `@abl/compiler/platform` (lines 13, 28). `output-pii-filter.test.ts` uses `vi.mock` for `@abl/compiler/platform` (line 14). While these are classified as "unit" tests (not E2E), they are listed in the integration test inventory of the test spec. The test spec should not classify mock-heavy tests as integration tests.

- **Location**: `docs/testing/pii-detection.md` Integration Test inventory
- **Fix**: `pii-pattern-loader.test.ts` and `output-pii-filter.test.ts` should be classified as unit tests. `pii-integration.test.ts` and `session-pii-vault.test.ts` (which do not use vi.mock) are the genuine integration tests.

#### LOW: No browser E2E tests for Studio PIIProtectionTab/PIIPatternFormDialog

The feature spec claims Studio UI integration (`PIIProtectionTab.tsx`, `PIIPatternFormDialog.tsx` -- both files verified to exist). No browser-level E2E tests exist for these components. The test spec lists this as TG-07 (low priority) but given that the CRUD UI is the primary user-facing surface for pattern management, this gap should be upgraded.

- **Location**: `docs/testing/pii-detection.md` TG-07
- **Fix**: Add at least 1 browser E2E test covering create-pattern-via-dialog flow before STABLE.

### LLD Gaps

#### LOW: LLD references all files accurately

All file paths in the LLD (`docs/plans/pii-detection.lld.md`) were verified against the codebase:

- `packages/compiler/src/platform/security/pii-detector.ts` -- EXISTS
- `packages/compiler/src/platform/security/pii-vault.ts` -- EXISTS
- `packages/compiler/src/platform/security/pii-recognizer-registry.ts` -- EXISTS
- `packages/compiler/src/platform/security/pii-audit.ts` -- EXISTS
- `packages/compiler/src/platform/security/streaming-pii-buffer.ts` -- EXISTS
- `packages/compiler/src/platform/security/encrypted-vault.ts` -- EXISTS
- `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts` -- EXISTS
- `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` -- EXISTS
- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` -- EXISTS
- `apps/runtime/src/routes/pii-patterns.ts` -- EXISTS
- `apps/studio/src/components/settings/PIIProtectionTab.tsx` -- EXISTS
- `apps/studio/src/components/settings/PIIPatternFormDialog.tsx` -- EXISTS

No file path inaccuracies found. LLD implementation phases are well-documented with exit criteria.

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: PASS. All FRs (FR-1 through FR-15) trace from feature spec through test spec coverage matrix, HLD data model, and LLD file map. No orphan requirements.
- **XP-2 Forward compatibility**: PASS. Feature spec enables test spec (FR mapping complete), HLD enables LLD (architectural decisions documented in LLD decision log).
- **XP-3 Scope lock**: PASS. No scope drift detected between phases. HLD and LLD do not introduce requirements absent from the feature spec.
- **XP-4 Terminology consistency**: PASS. "PIIVault", "recognizer registry", "consumer rendering", "selective redaction" used consistently across all 4 artifacts.
- **XP-5 Status consistency**: MINOR ISSUE. Feature spec says "BETA", HLD says "Implemented (BETA)", LLD says "Implemented (BETA)". Consistent in meaning but not in format. Recommend standardizing to `BETA` across all docs.

---

## Module: tool-invocations

### Status: STABLE (all docs consistent)

### Spec Issues

#### HIGH: Test files labeled "E2E" in agent-anatomy tests actually use heavy mocking

The tool-invocations test spec references agent anatomy tests (`project-agents-authz.test.ts`, `versions-authz.test.ts`, `version-routes.test.ts`) via the agent-anatomy test spec for cross-feature integration. While these are not tool-invocations tests, the classification pattern is relevant: these files use extensive `vi.mock()` (10+ mocks each for auth, rate limiter, shared packages, OpenAPI, compiler, repos, version service) -- making them **unit tests with mocked dependencies**, not integration or E2E tests.

This is not a tool-invocations-specific issue but worth noting because the tool-invocations HLD section 12 (Test Strategy) claims "19-scenario API E2E suite" -- which IS genuine: `tool-invocations-api.e2e.test.ts` starts real servers. The single mock in that E2E file (`vi.mock('server-only', () => ({}))`) is mocking a Next.js build-time module, not a codebase component, so it does not violate E2E standards.

- **Location**: `docs/testing/tool-invocations.md` E2E section
- **Fix**: No fix needed for tool-invocations -- the E2E suite is genuine. This is a cross-module observation.

#### HIGH: E2E-13 (Cross-Tenant Tool Isolation) is still PLANNED -- blocking STABLE completeness

The test spec lists E2E-13 as PLANNED. The HLD (section 12) states "Primary gap: cross-tenant isolation E2E." The LLD Phase 1 plans to close this gap with `tool-invocations-isolation.e2e.test.ts`. However, the file does not exist (`apps/studio/src/__tests__/e2e/tool-invocations-isolation.e2e.test.ts` -- verified NOT present in repo). This means the LLD Phase 1 has not been executed.

- **Location**: `docs/plans/2026-03-22-tool-invocations-impl-plan.md` Phase 1
- **Fix**: Execute LLD Phase 1 to create the isolation E2E test. Until then, the STABLE status is aspirational for the gap-closure phases (the existing feature is correctly STABLE; the improvement plan is PLANNED).

#### MEDIUM: LLD Phase 3 (Lambda Executor) references a file that does not exist

The LLD Phase 3 plans to create `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts`. This file does not exist in the repo (verified). The feature spec acknowledges lambda and async_webhook as "partial" in the non-goals section. The IR schema (`schema.ts`) declares `tool_type: 'lambda'` but no executor exists.

- **Location**: `docs/plans/2026-03-22-tool-invocations-impl-plan.md` Phase 3
- **Fix**: This is correctly documented as future work. The LLD accurately flags this as a gap and provides an implementation plan. No correction needed -- but this should be tracked as a backlog item.

#### LOW: Feature spec lists `connector`, `workflow`, `searchai` in toolType enum but data model shows only `['http', 'mcp', 'sandbox', 'searchai']`

The feature spec section 9 (Data Model, `project_tools.toolType`) lists: `enum ['http', 'mcp', 'sandbox', 'searchai']`. But the IR schema and feature spec summary reference 7 tool types including `connector`, `workflow`, and `async_webhook`. The data model enum is narrower because connector/workflow/async_webhook tools are not stored as `project_tools` records -- they are inferred at runtime.

- **Location**: `docs/features/tool-invocations.md` section 9 vs section 4 FR-1
- **Fix**: Add a clarifying note to the data model section explaining that `connector`, `workflow`, and `async_webhook` are runtime-resolved tool types not stored in `project_tools`.

### Testing Issues

#### HIGH: No E2E test for cross-tenant/project tool isolation (GAP-001/GAP-007)

Both the test spec and HLD identify this as the primary gap. The isolation guarantee is currently proven only at the unit level (via `tool-secrets-authz.test.ts` which uses mocks). The LLD plans an isolation E2E test but it has not been created.

- **Location**: `docs/testing/tool-invocations.md` GAP-001, GAP-007
- **Impact**: Tenant isolation is a CRITICAL platform invariant. Without real-server E2E tests, isolation bugs could go undetected.
- **Fix**: Create `tool-invocations-isolation.e2e.test.ts` per LLD Phase 1 specification.

#### MEDIUM: FR-5 (Resilience controls) has no E2E coverage

The coverage matrix shows FR-5 as "PARTIAL" with unit-only coverage. Circuit breaker lifecycle, rate limiter enforcement, and timeout behavior are tested at the unit level but not through the full API. The LLD Phase 2 plans `tool-invocations-resilience.e2e.test.ts` but the file does not exist.

- **Location**: `docs/testing/tool-invocations.md` FR-5 row, GAP-007
- **Fix**: Implement LLD Phase 2 resilience E2E test.

#### MEDIUM: FR-8 (Studio UI) and FR-9 (SSRF) have no E2E coverage

Both show "N" for E2E in the coverage matrix. FR-8 has Manual testing. FR-9 is tested at the unit level in `http-tool-executor.test.ts` and `ssrf-validator.test.ts`. For a STABLE feature, SSRF protection should have at least one integration-level test that exercises the real executor + validator chain.

- **Location**: `docs/testing/tool-invocations.md` FR-8, FR-9 rows
- **Fix**: SSRF is tested in `shared-kernel` unit tests which is acceptable since SSRF validator is a pure function. Studio UI E2E is acceptable as manual for now. No urgent fix needed.

#### LOW: FR-12 (Tool result compaction) has no E2E or integration coverage

Unit coverage exists for all compaction strategies. The full pipeline (LLM -> tool -> compact -> history) is not tested end-to-end. This is correctly flagged in the test spec.

### LLD Gaps

#### LOW: LLD accurately documents existing system

All files referenced in the LLD's "Existing Files" table (section 2) were verified:

- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- EXISTS
- `apps/runtime/src/routes/tool-secrets.ts` -- EXISTS
- All Studio API routes verified via glob -- EXISTS

The LLD's improvement phases (1-4) are well-structured with exit criteria, file lists, and rollback plans. Wiring checklist has accurate checkmarks for existing wiring and unchecked boxes for future phases.

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: PASS. All 12 FRs traced through coverage matrix, HLD concerns, and LLD phases.
- **XP-2 Forward compatibility**: PASS. Feature spec -> test spec -> HLD -> LLD chain is complete.
- **XP-3 Scope lock**: PASS. No scope drift. LLD improvement phases (lambda executor, resilience E2E) are explicitly scoped as future work, not new requirements.
- **XP-4 Terminology consistency**: PASS. "ToolBindingExecutor", "middleware chain", "SSRF validator", "confirmation gate", "auth profile" used consistently across all 4 artifacts.
- **XP-5 Status consistency**: PASS. All 4 documents consistently use "STABLE".

---

## Module: agent-anatomy

### Status: STABLE (all docs consistent)

### Spec Issues

#### HIGH: Test files classified as "integration" actually use extensive mocking

The test spec and feature spec list these test files:

- `project-agents-authz.test.ts` -- classified as "integration" in test spec, but uses **10 `vi.mock()` calls** (auth, rate limiter, shared, OpenAPI, compiler, repos, version service, audit helpers)
- `agent-model-config-authz.test.ts` -- classified as "integration", uses **7 `vi.mock()` calls**
- `versions-authz.test.ts` -- classified as "integration", uses **9 `vi.mock()` calls**
- `version-routes.test.ts` -- classified as "integration", uses **12+ `vi.mock()` calls** including DB, repos, middleware, RBAC, shared, version service, compiler

These are **unit tests with mocked dependencies**, not integration tests. They mock the auth middleware, rate limiter, repository layer, version service, and compiler -- essentially everything beyond the Express route handler itself. A true integration test would start a real server with real middleware (like `attachment-pii.e2e.test.ts` does for pii-detection).

Only `execution-model-integration.test.ts` and `behavior-profile.e2e.test.ts` appear to be genuine integration/E2E tests (they do NOT use `vi.mock`).

- **Location**: `docs/testing/agent-anatomy.md` Coverage Matrix FR-3/FR-4/FR-5 "Integration" column; Test File Mapping table
- **Fix**: Reclassify `project-agents-authz.test.ts`, `agent-model-config-authz.test.ts`, `versions-authz.test.ts`, and `version-routes.test.ts` as unit tests. Update the coverage matrix accordingly -- this means FR-3, FR-4, and FR-5 lose their "Integration: Yes" marks and should show "Integration: No" or "Integration: Unit-with-mocks".

#### HIGH: No genuine E2E tests for the agent CRUD API

The test spec defines 7 E2E scenarios (E2E-1 through E2E-7). Each lists a "Test File" reference. But the referenced files are the mock-heavy tests identified above. There are NO test files that exercise the agent API through real HTTP with real auth middleware, real rate limiter, and real database access.

`behavior-profile.e2e.test.ts` (no vi.mock) is the closest to a genuine E2E test but covers only FR-8 (behavior profiles), not the core CRUD/version/model-config API surface.

- **Location**: `docs/testing/agent-anatomy.md` E2E scenarios E2E-1 through E2E-7
- **Impact**: The STABLE status is based on test coverage that is actually unit-level with mocked middleware. Auth bypass, tenant isolation, rate limiting, and real DB query behavior are untested through real HTTP.
- **Fix**: Write at least 3 genuine E2E tests (no vi.mock, real Express on random port, real MongoDB via MongoMemoryServer): (1) Agent CRUD with tenant isolation, (2) Version creation and promotion lifecycle, (3) Model config override with cross-project isolation.

#### HIGH: GAP-008 (console.error in agents.ts) still unfixed

The HLD (section 4, concern #8 Observability) identifies GAP-008: `agents.ts` uses `console.error` instead of `createLogger`. The LLD Phase 1 is dedicated to fixing this. Verification against the codebase confirms the issue **still exists**: `apps/runtime/src/routes/agents.ts` lines 91 and 143 contain `console.error`. This is a code standards violation per CLAUDE.md ("Never `console.log` in server code").

- **Location**: `apps/runtime/src/routes/agents.ts` lines 91, 143
- **Fix**: Replace `console.error` with `createLogger('agents-route')` as specified in LLD Phase 1.

#### MEDIUM: GAP-004 (no tenantId on agent_versions) documented but not tracked

The HLD section 4 (concern #1) and LLD Phase 3 both document that `agent_versions` lacks `tenantId`, meaning tenant isolation depends on a join through `project_agents`. This is a known architectural debt. The LLD Phase 3 has a full implementation plan but no timeline.

- **Location**: `docs/specs/agent-anatomy.hld.md` section 4 concern #1; `docs/plans/2026-03-22-agent-anatomy-impl-plan.md` Phase 3
- **Fix**: No immediate fix needed (by design). Track in backlog with priority.

#### MEDIUM: Coverage matrix shows 6 of 10 FRs as PARTIAL

FR-5 through FR-10 all show PARTIAL status in the coverage matrix. For a STABLE feature, having 60% of FRs at PARTIAL coverage is unusual. The gaps are:

- FR-5 (source hashes/tool snapshots): No E2E
- FR-6 (cross-agent validation): Unit only
- FR-7 (static graph extraction): Unit only
- FR-8 (behavior profiles): Integration only via `behavior-profile.e2e.test.ts`
- FR-9 (config variable resolution): Unit only
- FR-10 (compilation timeout): Unit only

The LLD Phase 2 plans to close these gaps but has not been executed.

- **Location**: `docs/testing/agent-anatomy.md` Coverage Matrix
- **Fix**: Execute LLD Phase 2 to add integration tests for FR-5 through FR-10.

### Testing Issues

#### CRITICAL: Tests labeled as E2E/integration violate CLAUDE.md E2E standards

Per CLAUDE.md: "E2E tests must NOT mock codebase components (`vi.mock`, `jest.mock`), must NOT access the DB directly (Mongoose models), and must only interact via HTTP API."

The agent-anatomy test files classified as "integration" in the test spec ALL use `vi.mock` extensively:

| Test File                        | vi.mock count | Mocks auth? | Mocks DB/repo? | Mocks service? |
| -------------------------------- | ------------- | ----------- | -------------- | -------------- |
| project-agents-authz.test.ts     | 10            | YES         | YES            | YES            |
| agent-model-config-authz.test.ts | 7             | YES         | YES            | NO             |
| versions-authz.test.ts           | 9             | YES         | YES            | YES            |
| version-routes.test.ts           | 12+           | YES         | YES            | YES            |

These tests would NOT catch: auth middleware bugs, rate limiter bugs, tenant isolation query bugs, real MongoDB query behavior, or middleware chain ordering issues.

- **Impact**: The STABLE status rests on mock-heavy tests that could pass while real auth or isolation is broken (the exact scenario described in CLAUDE.md's "A2A tests passed 55/55 while auth was missing" example).
- **Fix**: These tests are fine as **unit tests** (rename/reclassify). Write separate genuine E2E tests per the E2E scenarios in the test spec, using the pattern from `attachment-pii.e2e.test.ts` or `channels-sdk-runtime.e2e.test.ts`.

#### MEDIUM: No browser E2E tests for Studio agent UI

The feature spec lists 5 Studio UI components (`AgentDetailPage.tsx`, `AgentListPage.tsx`, `AgentModelTab.tsx`, `VersionListTab.tsx`, `AgentMiniTopology.tsx`). The test spec notes "Browser topology/version UX: PARTIAL". Only `agent-detail-page.test.tsx` exists (verified) and it is a unit/UI test, not a browser E2E.

- **Location**: `docs/testing/agent-anatomy.md` Quick Health Dashboard
- **Fix**: Acceptable for STABLE status if API-level E2E is solid, but browser E2E should be planned.

### LLD Gaps

#### LOW: LLD Phase 1 (GAP-008 fix) not executed

The LLD Phase 1 is a single-task fix (replace `console.error` with `createLogger` in `agents.ts`). This has not been done despite being labeled "Immediate" priority.

- **Location**: `docs/plans/2026-03-22-agent-anatomy-impl-plan.md` Phase 1
- **Fix**: Execute the fix -- it is a 2-line change.

#### LOW: LLD accurately references existing files

All existing files in the LLD were verified:

- `packages/compiler/src/platform/ir/schema.ts` -- EXISTS
- `packages/database/src/models/project-agent.model.ts` -- EXISTS
- `packages/database/src/models/agent-version.model.ts` -- EXISTS
- `packages/database/src/models/agent-model-config.model.ts` -- EXISTS
- `apps/runtime/src/routes/project-agents.ts` -- EXISTS
- `apps/runtime/src/routes/agents.ts` -- EXISTS
- `apps/runtime/src/routes/agent-model-config.ts` -- EXISTS
- `apps/runtime/src/routes/versions.ts` -- EXISTS
- `apps/runtime/src/services/version-service.ts` -- EXISTS
- `apps/runtime/src/repos/project-repo.ts` -- EXISTS

No file path inaccuracies found.

### Cross-Phase Inconsistencies

- **XP-1 Backward traceability**: PASS. All 10 FRs traced through coverage matrix, HLD, and LLD.
- **XP-2 Forward compatibility**: PASS. Artifact chain is complete.
- **XP-3 Scope lock**: PASS. No scope drift detected.
- **XP-4 Terminology consistency**: PASS. "AgentIR", "compilation output", "version promotion", "model layering" used consistently.
- **XP-5 Status consistency**: PASS. All 4 documents consistently use "STABLE".

---

## Summary of Findings

### CRITICAL (must fix)

| Module        | ID    | Finding                                                                                                                                                 |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-anatomy | AA-T1 | Tests labeled "integration/E2E" use 7-12 `vi.mock` calls each, violating CLAUDE.md E2E standards. Reclassify as unit tests and write genuine E2E tests. |

### HIGH (should fix)

| Module           | ID     | Finding                                                                                                              |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| pii-detection    | PII-S1 | `builtin-pii-e2e.test.ts` misclassified as E2E -- it is a pipeline integration test. Only 1 genuine E2E file exists. |
| pii-detection    | PII-T1 | Zero real-server E2E tests for the 6-endpoint PII pattern CRUD API.                                                  |
| tool-invocations | TI-T1  | E2E-13 (cross-tenant isolation) PLANNED but not created. LLD Phase 1 not executed.                                   |
| tool-invocations | TI-T2  | FR-5 (resilience) has no E2E coverage; LLD Phase 2 not executed.                                                     |
| agent-anatomy    | AA-S1  | No genuine E2E tests for agent CRUD, version lifecycle, or model config API.                                         |
| agent-anatomy    | AA-S2  | GAP-008 (`console.error` in `agents.ts`) unfixed despite LLD Phase 1 being "Immediate".                              |
| agent-anatomy    | AA-S3  | 6 of 10 FRs at PARTIAL coverage for a STABLE feature.                                                                |

### MEDIUM (recommended)

| Module           | ID     | Finding                                                                                    |
| ---------------- | ------ | ------------------------------------------------------------------------------------------ |
| pii-detection    | PII-S2 | EventStore reference inconsistency between feature spec header and HLD.                    |
| pii-detection    | PII-T2 | `pii-pattern-loader.test.ts` uses vi.mock but listed in integration test inventory.        |
| tool-invocations | TI-S1  | Lambda executor (LLD Phase 3) does not exist in repo. Correctly documented as future work. |
| tool-invocations | TI-S2  | Data model toolType enum narrower than FR-1 tool type list. Needs clarifying note.         |
| agent-anatomy    | AA-S4  | GAP-004 (no tenantId on agent_versions) documented but no timeline for fix.                |

### LOW (informational)

| Module           | ID     | Finding                                                                                            |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------- |
| pii-detection    | PII-L1 | Status format inconsistency ("BETA" vs "Implemented (BETA)") across docs.                          |
| pii-detection    | PII-L2 | No browser E2E for Studio PIIProtectionTab.                                                        |
| pii-detection    | PII-L3 | LLD file paths all verified accurate. No file reference errors.                                    |
| tool-invocations | TI-L1  | All file paths verified accurate. Studio API routes, runtime routes, and executor files all exist. |
| tool-invocations | TI-L2  | FR-12 (compaction) has no E2E coverage. Unit coverage is comprehensive.                            |
| agent-anatomy    | AA-L1  | LLD Phase 1 (2-line `console.error` fix) still pending despite "Immediate" priority.               |
| agent-anatomy    | AA-L2  | All LLD file paths verified accurate.                                                              |
| agent-anatomy    | AA-L3  | No browser E2E for Studio agent management UI.                                                     |

---

## Cross-Module Patterns

### Recurring Pattern: Mock-Heavy Tests Classified as Integration/E2E

This is the most significant finding across all three modules. Tests that use 5-12+ `vi.mock()` calls are classified as "integration" or referenced as E2E scenario implementations when they are effectively unit tests with mocked dependencies. This pattern was previously flagged in the A2A audit referenced in CLAUDE.md ("A2A tests passed 55/55 while auth was missing").

**Affected modules**: agent-anatomy (most severe -- 4 test files), pii-detection (2 files), tool-invocations (1 genuine E2E exists so impact is lower)

**Recommendation**: Establish a project-wide classification rule:

- **Unit**: May use `vi.mock` freely
- **Integration**: Real service boundaries (e.g., compiler + MongoDB), but may mock external services
- **E2E**: ZERO `vi.mock` of codebase components (only mock `server-only` or external third-party). Real Express server, real auth middleware, real MongoDB.

### Recurring Pattern: LLD Improvement Phases Not Executed

All three modules have LLD improvement phases that are documented but not executed:

- pii-detection: E2E gaps documented, no timeline
- tool-invocations: Phase 1 (isolation E2E), Phase 2 (resilience E2E) not started
- agent-anatomy: Phase 1 (console.error fix -- 2 lines), Phase 2 (test coverage) not started

**Recommendation**: Either execute the immediate/low-effort phases (agent-anatomy Phase 1 is literally 2 lines) or add explicit "PLANNED -- deferred to sprint X" annotations to LLD phases.

### Positive Patterns

1. **File path accuracy**: All three LLDs reference files that exist in the repo. Zero fabricated paths.
2. **Cross-phase terminology consistency**: All three modules use consistent naming across feature spec, test spec, HLD, and LLD.
3. **Scope discipline**: No scope drift detected in any module. LLD improvement phases are correctly scoped as incremental, not new requirements.
4. **HLD architectural concerns**: All three HLDs address the 12 architectural concerns with specific, verifiable details.
5. **Gap documentation honesty**: All three modules honestly document their testing gaps rather than inflating coverage claims.
