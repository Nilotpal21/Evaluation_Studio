# Cross-Phase Consistency Audit -- Batch 2

**Modules Audited**: agent-transfer-orchestration, environment-variables, guardrails
**Auditor**: Phase Auditor (Opus 4.6)
**Date**: 2026-03-25
**Scope**: All SDLC artifacts (feature spec, test spec, HLD, LLD) per module, plus codebase verification

---

## Module: agent-transfer-orchestration

### Status: STABLE (feature spec says STABLE)

### Spec Issues

**CRITICAL: No HLD exists**

- The feature spec at `docs/features/agent-transfer-orchestration.md` is a HUB doc that links to four sub-feature docs (multi-agent-orchestration, agent-transfer, multi-agent-session-management, a2a-integration). However, no HLD exists at `docs/specs/agent-transfer-orchestration.hld.md` or similar. The glob search returned zero results. For a feature marked STABLE, the SDLC pipeline requires an HLD to have been produced and audited.
- **Mitigation**: This is a HUB doc (not a MAJOR FEATURE), so it may be that HLDs exist for each sub-feature independently. However, there is no cross-cutting coordination HLD that addresses the 12 architectural concerns for the orchestration family as a whole.

**CRITICAL: No LLD exists for the hub**

- No LLD was found at `docs/plans/` for `agent-transfer-orchestration` specifically. There ARE plans for the `agent-transfer` sub-feature: `2026-03-08-studio-agent-transfer-design.md`, `2026-03-08-studio-agent-transfer-plan.md`, `2026-03-10-agent-transfer-critical-fixes.md`, `2026-03-13-agent-transfer-gap-closure.md`, `2026-03-23-agent-transfer-impl-plan.md`. These cover the transfer sub-feature, not the orchestration hub.
- **Impact**: The hub's delivery plan (Section 13) mentions family-level hardening and cross-feature verification, but there is no phased LLD with exit criteria for this work.

**HIGH: Feature spec status is STABLE but significant test gaps remain**

- The feature spec claims STABLE status, but the test spec's Quick Health Dashboard shows 3 areas as NOT TESTED: cross-tenant A2A live E2E, thread resume, and auth propagation chain. The test coverage map also has extensive unchecked items across fan-out, delegation, escalation, and multi-intent dispatch.
- Section 16 lists 4 open gaps (GAP-001 through GAP-004) including "Several orchestration-family async and return-path cases remain only partially verified."
- A STABLE feature should not have this many open coverage gaps, especially around cross-tenant isolation (GAP-002).

**LOW: API table path mismatch**

- The feature spec lists `GET /api/channel-connections` (Section 8, Studio API table) but this is a runtime endpoint; Studio API routes are typically proxied through `/api/admin/`. Minor — this is a documentation clarity issue.

### Testing Issues

**CRITICAL: E2E test uses mocks (vi.mock) -- FORBIDDEN by CLAUDE.md**

- The `kore-e2e.test.ts` file in `packages/agent-transfer/src/__tests__/e2e/` contains `vi.mock('@abl/compiler/platform', ...)` on line 11. Per CLAUDE.md E2E Test Standards, `vi.mock()` is FORBIDDEN in E2E tests. This test mocks the logger, which means it does not exercise the real logging infrastructure.
- The test also accesses `TransferSessionStore` directly rather than through the HTTP API, and uses `checkRateLimit` and `isVoiceChannel` as direct function imports. This violates the "API-only interaction" rule.
- **Severity**: While the mock is only for the logger (not a critical component), the direct import pattern means this is structurally an integration test labeled as E2E.

**HIGH: Multi-intent dispatch completely uncovered**

- The test coverage map shows all 4 multi-intent dispatch strategies (`primary_queue`, `disambiguate`, `parallel`, `sequential`) as uncovered (not even unit tests). These are listed in the feature spec's orchestration capabilities but have zero test evidence.

**HIGH: Hub test spec delegates all detail to sub-feature test specs**

- The hub test spec is intentionally thin, delegating to 4 sub-feature test specs. This is architecturally reasonable, but it means there are no cross-cutting test scenarios that verify the family works as a whole (e.g., orchestration -> escalation -> transfer -> A2A in a single flow).

### LLD Gaps

**CRITICAL: No LLD exists for the hub feature**

- As noted above, there is no LLD. The feature spec's delivery plan (Section 13) has high-level work items but no phased implementation plan with exit criteria.

### Cross-Phase Inconsistencies

- **[XP-1] Backward traceability**: The feature spec references 4 sub-feature docs, but there is no HLD or LLD to trace requirements to. FR-1 through FR-5 have no design doc backing.
- **[XP-2] Forward compatibility**: The hub format is reasonable as an overview. The sub-features have their own artifacts. But the hub itself is a dead-end — it produces no design artifacts.
- **[XP-3] Scope lock**: No scope creep detected. The hub is deliberately scope-limited to documentation coordination.
- **[XP-4] Terminology consistency**: Consistent use of "coordination family" across feature spec and test spec. Sub-feature names match.

---

## Module: environment-variables

### Status: BETA (feature spec says BETA)

### Spec Issues

**HIGH: Two LLDs exist -- potential confusion and contradiction**

- `docs/plans/2026-03-22-environment-variables-impl-plan.md` (Status: ALPHA, 4 phases)
- `docs/plans/2026-03-23-environment-variables-impl-plan.md` (Status: DONE, 4 phases)
- The 2026-03-22 LLD was the initial plan. The 2026-03-23 LLD supersedes it with different phase structure, different decisions, and different file paths. For example:
  - 2026-03-22 Phase 1 is "Base Fallback in RuntimeSecretsProvider" only. 2026-03-23 Phase 1 is "Critical Bug Fixes" combining all 4 bug fixes (FR-1 through FR-4, FR-8, FR-11).
  - 2026-03-22 Decision D-2 says "Base fallback in secrets-provider level." 2026-03-23 Decision D-2 says "Base fallback in EnvVarStore, not secrets-provider." These are contradictory.
  - 2026-03-22 has test files at `apps/runtime/src/__tests__/e2e/env-vars-e2e.test.ts`. 2026-03-23 has them at `apps/runtime/src/__tests__/env-vars-e2e.test.ts`. The actual file exists at the 2026-03-23 path.
- The test spec references only the 2026-03-23 LLD. The feature spec Section 18 references the 2026-03-22 LLD. This inconsistency could confuse implementers.
- **Fix**: The feature spec's Section 18 should reference `2026-03-23-environment-variables-impl-plan.md` as the canonical LLD. The 2026-03-22 plan should be marked as SUPERSEDED.

**HIGH: Feature spec status is BETA but test spec status is STABLE**

- Feature spec header: `Status: BETA`
- Test spec header: `Status: STABLE`
- HLD header: `Status: IMPLEMENTED`
- LLD (2026-03-23) header: `Status: DONE`
- These should be consistent. If the feature is BETA, the test spec and HLD should not claim STABLE/IMPLEMENTED unless they are referring to their own document completeness (not the feature status). Per SDLC conventions, the feature status should be the canonical source.

**HIGH: Test spec coverage matrix shows FR-9 as DEFERRED but feature spec lists it as a requirement**

- FR-9: "The snapshot service must continue to deduplicate base+override correctly." Test spec shows INT-3 as DEFERRED. This means a CRITICAL requirement (snapshot dedup) has no verified test, yet the test spec status is STABLE. The feature spec's Section 17 row 3 shows it as PASS but the test spec contradicts this.

**MEDIUM: HLD references a 2026-03-13 design doc that is not in the standard artifact chain**

- HLD Section 10 References mentions `docs/specs/2026-03-13-environment-consistency-variable-overrides-design.md` and `docs/plans/2026-03-13-environment-consistency-variable-overrides.md`. These are pre-SDLC pipeline artifacts. Their relationship to the current HLD is not clarified (superseded? supplementary?).

### Testing Issues

**CRITICAL: E2E test file uses extensive vi.mock() -- FORBIDDEN by CLAUDE.md**

- `apps/runtime/src/__tests__/env-vars-e2e.test.ts` (the file labeled as "E2E") contains 14+ `vi.mock()` calls, mocking: security-repo, auth-repo, namespace-membership-repo, namespace-repo, database models, auth middleware, rate-limiter, shared-auth, shared-observability, rbac middleware, openapi registry, project-repo, openapi express, and compiler/platform.
- This is NOT an E2E test. It mocks virtually every dependency. It is an integration test for the route handler logic with mocked repositories.
- The file header itself says "Tests the full env-vars HTTP API using real Express server with **mocked dependencies** (repos, auth, rate-limiter)."
- Per CLAUDE.md: "E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access." This test violates both the spirit and letter of the E2E standard.
- **Impact**: The test spec coverage matrix marks E2E-1 through E2E-14 as PASS based on this file. In reality, zero true E2E scenarios exist.

**CRITICAL: authz test also uses vi.mock()**

- `apps/runtime/src/__tests__/environment-variables-authz.test.ts` uses 10+ `vi.mock()` calls. The feature spec's Section 17 honestly notes this: "The existing `environment-variables-authz.test.ts` uses `vi.mock()` for auth middleware, which means it does NOT exercise the real middleware chain."

**HIGH: Test spec claims PASS for scenarios that use mocks**

- The coverage matrix shows FR-1 as "PASS (E2E + Live)", FR-2 as "PASS (INT-2)", FR-4 as "PASS (INT-9 + E2E-12)". The "E2E" portions all come from the mock-heavy env-vars-e2e.test.ts file. These should be classified as integration tests with mocks, not E2E.

**HIGH: Several integration test files claimed in LLD do not exist**

- `apps/runtime/src/__tests__/snapshot-service-integration.test.ts` -- NOT FOUND (LLD 2026-03-23 Phase 4 Task 4.5)
- `apps/runtime/src/__tests__/deployment-repo-integration.test.ts` -- NOT FOUND (LLD 2026-03-23 Phase 4 Task 4.6)
- `apps/runtime/src/__tests__/env-vars-namespace-pagination.test.ts` -- EXISTS (verified)
- `apps/runtime/src/__tests__/secrets-provider-integration.test.ts` -- EXISTS (verified)
- The LLD claims INT-3, INT-6 (snapshot) and INT-4, INT-7 (deployment repo) test files should exist. They do not. The coverage matrix marks INT-3 as DEFERRED, consistent with missing file, but INT-4 and INT-7 status is unclear.

**MEDIUM: No browser E2E tests for Studio UI changes**

- FR-5 (Studio base value tab) is marked as "CODE DONE (UI only)" with no test. The feature spec describes new Studio UI components (Base tab in EnvironmentsTab.tsx, override indicators), but there are no Playwright or browser E2E tests for them.

### LLD Gaps

**HIGH: LLD (2026-03-23) claims "Status: DONE" but exit criteria are unchecked**

- All exit criteria in every phase still show `- [ ]` (unchecked). The Wiring Checklist (Section 4) also has all items unchecked. If the LLD status is DONE, these checkboxes should reflect actual completion status. This is a recurring finding across features (see audit memory for omnichannel, identity-verification).

**HIGH: LLD (2026-03-22) and LLD (2026-03-23) have conflicting architectural decisions**

- As noted in Spec Issues: D-2 in the older plan says fallback goes in secrets-provider; D-2 in the newer plan says it goes in EnvVarStore. Without marking the older as superseded, an implementer could follow the wrong design.

**MEDIUM: LLD (2026-03-23) references "D-13" in Section 5 ("Per HLD decision D-13") but HLD has no decision D-13**

- The HLD has no numbered decision system. This is a phantom reference.

### Cross-Phase Inconsistencies

- **[XP-1] Backward traceability**: All 11 FRs trace back to the feature spec. The LLD (2026-03-23) has an explicit FR-to-Task traceability table (Section 8). GOOD.
- **[XP-2] Forward compatibility**: HLD enables LLD. Test spec enables implementation verification. Artifacts are well-linked.
- **[XP-3] Scope lock**: No scope creep detected. Both LLDs stay within the feature spec's scope.
- **[XP-4] Terminology consistency**: Consistent use of "base value", "base fallback", "environment: null", "EnvVarStore", "RuntimeSecretsProvider" across all docs.
- **[XP-5] Status inconsistency**: BETA (feature spec) vs STABLE (test spec) vs IMPLEMENTED (HLD) vs DONE (LLD). Must be reconciled.

---

## Module: guardrails

### Status: BETA (feature spec says BETA)

### Spec Issues

**HIGH: 4 additional plan documents create fragmentation risk**

- Beyond the primary LLD at `docs/plans/guardrails.lld.md`, there are:
  - `docs/plans/2026-03-08-guardrails-ui-design.md` -- UI design for provider/policy creation forms
  - `docs/plans/2026-03-08-guardrails-ui-plan.md` -- UI implementation plan (read failed due to size -- implies substantial content)
  - `docs/plans/2026-03-10-guardrails-hardening-plan.md` -- Bug fixes, security hardening, wiring gaps
  - `docs/plans/2026-03-18-dsl-constraints-guardrails-cleanup-plan.md` -- DSL constraint cleanup (overlaps guardrails)
- The primary LLD (guardrails.lld.md) does not reference or acknowledge these additional plans. There is a risk that work tracked in the hardening plan (e.g., "add reask to TERMINAL_ACTIONS", "harden Tier 3 prompt injection") has been done but the LLD's Known Gaps and Wiring Checklist don't reflect it.
- The DSL cleanup plan is a cross-cutting concern that touches the guardrails system (e.g., "Workstream D: IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES extracted to shared constant"). This is documented as completed (Status Update 2026-03-19) but the LLD doesn't mention it.
- **Fix**: The LLD should reference these plans and indicate which items are completed, or they should be consolidated.

**HIGH: LLD GAP-1 (`projectId` hardcoded to 'default') is a production correctness bug**

- The LLD Section 4 Known Gaps lists: "GAP-1: `projectId` hardcoded to `'default'` in pipeline factory auto-wiring" as Medium severity, Status: Open. This is actually HIGH severity because it means all guardrail cache keys and cost tracking keys use the wrong `projectId`, breaking multi-project isolation for these subsystems.
- The feature spec and HLD both promise project-scoped cache keys (`guardrail:{tenantId}:{projectId}:...`), but this hardcoded default undermines that guarantee.

**MEDIUM: Feature spec and HLD are well-aligned on all 14 FRs**

- FR-1 through FR-14 in the feature spec map cleanly to the HLD's 12 concerns and API design. No scope drift detected. This is good.

**MEDIUM: HLD status says "BETA (implemented)" but the feature is still BETA with significant E2E gaps**

- The HLD status is appropriate as a design doc status. The feature spec honestly documents the E2E gaps (GAP-002, GAP-003, GAP-010). Consistency is acceptable here since the HLD describes the design (implemented) while the feature spec tracks operational readiness (BETA).

### Testing Issues

**CRITICAL: The "E2E" edge-cases test is NOT a real E2E test**

- `apps/runtime/src/__tests__/guardrail-edge-cases.e2e.test.ts` is labeled as E2E in the test spec, but it does NOT start a real Express server, does NOT make HTTP requests, and directly imports `GuardrailPipelineImpl`, `GuardrailProviderRegistry`, and `CircuitBreaker` from `@abl/compiler`. This is a compiler-level integration test, not a runtime HTTP API E2E test.
- The test spec lists this file's status as PASS in the E2E section. This inflates the perceived E2E coverage.

**CRITICAL: No runtime-level E2E tests exist at all**

- The glob search for `apps/runtime/src/__tests__/guardrails/e2e/**` returned zero results. The LLD's Phase 1-8 plan describes 8+ E2E test files that should be created, but none exist yet.
- The test spec's Quick Health Dashboard honestly marks all runtime E2E items as NOT TESTED. The test spec's E2E Scenarios section (E2E-1 through E2E-8) are well-designed but entirely unimplemented.

**HIGH: Integration tests use mocks extensively**

- `guardrails/output-guardrails.test.ts` uses `vi.mock('../../services/guardrails/pipeline-factory.js', ...)` -- mocking the pipeline factory.
- `guardrails/policy-routes.test.ts` uses 6 `vi.mock()` calls including database models, auth middleware.
- These are appropriately classified as integration tests (not E2E), so this is less severe than the env-vars case. However, the route tests mock the DB models, meaning CRUD validation through the real Mongoose layer is untested.

**HIGH: 147/175 provider-kind combinations untested via API**

- The test spec's Provider x Kind Coverage Matrix shows 0 E2E combinations tested via the runtime HTTP API. Unit-level coverage exists for ~10 combinations. This is a massive gap for a feature that is BETA.

**MEDIUM: Studio Playwright E2E tests exist and pass**

- `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts` and `apps/studio/e2e/model-guardrails-e2e.spec.ts` exist and are marked PASS. These cover Studio UI policy/provider CRUD. This is positive -- at least the UI surface has real browser E2E coverage.

### LLD Gaps

**HIGH: LLD Phase 1-8 test files do not exist**

- The LLD lists 8 phases of E2E test files that should be created under `apps/runtime/src/__tests__/guardrails/e2e/`. The directory does not exist. None of these files have been created:
  - `guardrail-e2e-helpers.ts`
  - `builtin-pii-input.e2e.ts`
  - `builtin-pii-matrix.e2e.ts`
  - `custom-http-matrix.e2e.ts`
  - `multi-tier-cascade.e2e.ts`
  - `policy-scoping.e2e.ts`
  - `streaming-model-eval.e2e.ts`
  - `action-coverage.e2e.ts`
  - `circuit-breaker.e2e.ts`
  - `budget-enforcement.e2e.ts`
  - `cache-invalidation.e2e.ts`
  - `isolation.e2e.ts`
- The LLD status says "Implemented (BETA)" but these are the primary remaining work items.

**HIGH: Hardening plan task completion unclear**

- The `2026-03-10-guardrails-hardening-plan.md` defines Sprint 1 with tasks like "add reask to TERMINAL_ACTIONS" and "harden Tier 3 LLM eval prompt." These appear to be code-change tasks with specific file/line references. It is unclear which have been completed. The hardening plan has no status tracking or completion checkboxes visible in the read excerpt.

**MEDIUM: LLD Wiring Checklist is fully checked (all [x])**

- Unlike the env-vars LLD where all checkboxes are unchecked, the guardrails LLD wiring checklist has all items checked. This is good and indicates post-implementation verification was done for the compiler-runtime-database-studio wiring.

### Cross-Phase Inconsistencies

- **[XP-1] Backward traceability**: All 14 FRs are traceable from feature spec through HLD's 12 concerns and LLD's module boundaries. The coverage matrix in the test spec maps all FRs. GOOD.
- **[XP-2] Forward compatibility**: The test spec's E2E scenarios are well-designed and actionable. The LLD's phased plan is clear. Both enable implementation.
- **[XP-3] Scope lock**: The DSL constraints cleanup plan introduces scope that touches guardrails but originates from a different feature concern (constraints). This is cross-cutting, not scope creep.
- **[XP-4] Terminology consistency**: Consistent use of "3-tier pipeline", "provider x kind matrix", "policy resolver", "port adapter" across all docs. Good.
- **[XP-5] Plan fragmentation**: 4 additional plans beyond the LLD is the most fragmentation of any feature audited. The plans cover different time periods and concerns, but there is no index or relationship map between them.

---

## Summary of Findings by Severity

### CRITICAL (must fix before STABLE promotion)

| ID  | Module                       | Finding                                                                                         |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| C-1 | agent-transfer-orchestration | No HLD exists for the coordination hub feature                                                  |
| C-2 | agent-transfer-orchestration | No LLD exists for the coordination hub feature                                                  |
| C-3 | agent-transfer-orchestration | kore-e2e.test.ts uses vi.mock() and direct imports -- not a true E2E test                       |
| C-4 | environment-variables        | env-vars-e2e.test.ts uses 14+ vi.mock() calls -- not a true E2E test, zero real E2E tests exist |
| C-5 | environment-variables        | Test spec claims PASS for E2E-1 through E2E-14 based on mock-heavy tests                        |
| C-6 | guardrails                   | guardrail-edge-cases.e2e.test.ts is not a real E2E test (no HTTP, no Express, direct imports)   |
| C-7 | guardrails                   | Zero runtime-level HTTP API E2E tests exist; `e2e/` directory not created                       |

### HIGH (should fix)

| ID   | Module                       | Finding                                                                                              |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| H-1  | agent-transfer-orchestration | STABLE status with 3 NOT TESTED areas and 4 open gaps                                                |
| H-2  | agent-transfer-orchestration | Multi-intent dispatch (4 strategies) completely uncovered                                            |
| H-3  | environment-variables        | Two LLDs with conflicting architectural decisions; older not marked SUPERSEDED                       |
| H-4  | environment-variables        | Feature spec BETA vs test spec STABLE vs HLD IMPLEMENTED -- status inconsistency                     |
| H-5  | environment-variables        | FR-9 (snapshot dedup) marked DEFERRED in test spec but listed as required in feature spec            |
| H-6  | environment-variables        | LLD (2026-03-23) exit criteria all unchecked despite "Status: DONE"                                  |
| H-7  | environment-variables        | snapshot-service-integration.test.ts and deployment-repo-integration.test.ts do not exist            |
| H-8  | guardrails                   | GAP-1 (projectId hardcoded to 'default') is a production correctness bug in cache/cost key isolation |
| H-9  | guardrails                   | LLD Phase 1-8 E2E test files do not exist (12 planned files, 0 created)                              |
| H-10 | guardrails                   | 147/175 provider-kind combinations untested via runtime API                                          |
| H-11 | guardrails                   | 4 additional plan documents beyond LLD create fragmentation with unclear completion status           |

### MEDIUM (recommended)

| ID  | Module                       | Finding                                                                                      |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| M-1 | environment-variables        | Feature spec Section 18 references wrong LLD (2026-03-22 instead of 2026-03-23)              |
| M-2 | environment-variables        | LLD references "HLD decision D-13" which does not exist in the HLD                           |
| M-3 | environment-variables        | No browser E2E tests for Studio UI changes (FR-5 base value tab)                             |
| M-4 | guardrails                   | HLD status "BETA (implemented)" could be clearer about what "implemented" refers to          |
| M-5 | guardrails                   | Hardening plan task completion status unclear                                                |
| M-6 | agent-transfer-orchestration | Hub test spec delegates all detail to sub-features -- no cross-cutting integration scenarios |

---

## Recommendations

### Immediate Actions

1. **Reclassify mock-heavy tests**: All three modules have tests labeled "E2E" that use `vi.mock()`. These should be relabeled as "integration" or "route handler" tests. Coverage matrices should be updated to reflect the absence of true E2E tests.

2. **Create real E2E tests for environment-variables**: The env-vars module has the best-designed E2E scenarios (E2E-1 through E2E-14 in the test spec are detailed and actionable). Implement them with real Express + MongoMemoryServer + real encryption, no mocks.

3. **Create guardrails runtime E2E directory**: The LLD's Phase 1 (E2E infrastructure) should be implemented. Start with `builtin-pii-input.e2e.ts` as it requires zero external providers.

4. **Mark 2026-03-22 env-vars LLD as SUPERSEDED**: Add a header note to the older plan pointing to the 2026-03-23 plan. Update the feature spec's Section 18 reference.

5. **Fix guardrails GAP-1**: The hardcoded `projectId: 'default'` in pipeline factory auto-wiring is a data isolation bug. This should be prioritized before STABLE promotion.

### Before STABLE Promotion

- **agent-transfer-orchestration**: Decide whether the hub format requires its own HLD/LLD or if the sub-feature artifacts are sufficient. If the latter, document this explicitly. Address the 3 NOT TESTED areas.
- **environment-variables**: Reconcile status across all 4 artifact types. Implement real E2E tests. Complete the deferred INT-3 and missing INT-4/INT-7.
- **guardrails**: Implement at least Phase 1-3 of the LLD's E2E plan (infrastructure, provider-kind matrix, multi-tier cascade). Fix GAP-1. Consolidate or index the 4 additional plan documents.

---

## Codebase Verification Summary

| Spec Claim                                   | Verification Result                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| routing-executor.ts exists                   | CONFIRMED at `apps/runtime/src/services/execution/routing-executor.ts` |
| agent-transfer-webhooks.ts route exists      | CONFIRMED at `apps/runtime/src/routes/agent-transfer-webhooks.ts`      |
| SpanTree.tsx / DebugTabs.tsx exist           | CONFIRMED in `apps/studio/src/components/observatory/`                 |
| routing-remote-handoff.test.ts exists        | CONFIRMED                                                              |
| escalation-negative.test.ts exists           | CONFIRMED                                                              |
| kore-e2e.test.ts exists                      | CONFIRMED, but uses vi.mock()                                          |
| task-lifecycle-integration.test.ts exists    | CONFIRMED                                                              |
| environment-variables.ts route exists        | CONFIRMED; diff/export/import endpoints present (lines 450, 557, 636)  |
| env-vars-e2e.test.ts exists                  | CONFIRMED, but uses 14+ vi.mock() calls                                |
| secrets-provider-integration.test.ts exists  | CONFIRMED                                                              |
| env-vars-namespace-pagination.test.ts exists | CONFIRMED                                                              |
| snapshot-service-integration.test.ts exists  | NOT FOUND                                                              |
| deployment-repo-integration.test.ts exists   | NOT FOUND                                                              |
| guardrail-policies.ts route exists           | CONFIRMED                                                              |
| guardrail-providers.ts route exists          | CONFIRMED                                                              |
| GuardrailsConfigPage.tsx exists              | CONFIRMED                                                              |
| GuardrailPolicyForm.tsx exists               | CONFIRMED                                                              |
| guardrails-comprehensive-e2e.spec.ts exists  | CONFIRMED (Playwright)                                                 |
| guardrails/e2e/ directory exists             | NOT FOUND -- none of the 12 planned E2E files exist                    |
| guardrail-edge-cases.e2e.test.ts exists      | CONFIRMED, but is compiler-level test, not HTTP API E2E                |
| environment-variables-authz.test.ts exists   | CONFIRMED, uses vi.mock()                                              |
| cross-project-isolation.test.ts exists       | CONFIRMED                                                              |
