# Critical Module Triage Report — 2026-03-25

**Scope**: 9 critical SDLC modules audited across all artifacts (feature spec, test spec, HLD, LLD)
**Auditor**: Phase Auditor (3 parallel agents)
**Detailed reports**: `critical-module-audit-batch{1,2,3}.md`

---

## Executive Summary

| Metric                           | Count                                                                     |
| -------------------------------- | ------------------------------------------------------------------------- |
| Modules audited                  | 9                                                                         |
| CRITICAL findings                | 10                                                                        |
| HIGH findings                    | 22                                                                        |
| MEDIUM findings                  | 14                                                                        |
| Modules needing status downgrade | 4 (auth-profiles, model-hub, agent-anatomy, agent-transfer-orchestration) |
| Modules with zero real E2E tests | 7 of 9                                                                    |

### The #1 Systemic Problem: Fake E2E Coverage

**7 of 9 modules have zero genuine E2E tests** — tests labeled "E2E" use 7-20+ `vi.mock()` calls, mocking auth, repos, middleware, and services. The test spec coverage matrices report PASS based on these tests, creating false confidence.

Only **tool-invocations** (19-scenario genuine E2E suite) and **guardrails** (Studio Playwright E2E) have real E2E coverage. Even those have gaps (tool-invocations missing isolation E2E, guardrails missing runtime API E2E).

---

## Tier 1: CRITICAL — Fix Before Any STABLE Promotion

### C1. Systemic: Mock-Heavy Tests Misclassified as E2E (ALL 9 MODULES)

Every module has tests using `vi.mock()` that are labeled "E2E" or "integration" in test specs. Worst offenders:

| Module                | File                               |                 vi.mock count                  | What's mocked                              |
| --------------------- | ---------------------------------- | :--------------------------------------------: | ------------------------------------------ |
| environment-variables | `env-vars-e2e.test.ts`             |                      14+                       | auth, repos, rate-limiter, RBAC, DB models |
| agent-anatomy         | `version-routes.test.ts`           |                      12+                       | auth, repos, services, middleware, RBAC    |
| agent-anatomy         | `project-agents-authz.test.ts`     |                       10                       | auth, repos, services                      |
| guardrails            | `guardrail-edge-cases.e2e.test.ts` | 0 mocks BUT imports compiler directly, no HTTP |
| model-hub             | `llm-wiring.test.ts`               |                      20+                       | every dependency                           |
| agent-transfer        | `kore-e2e.test.ts`                 |            vi.mock + direct imports            |

**Action**: Reclassify all mock-heavy tests as unit tests in every test spec. Update coverage matrices to honestly reflect E2E = 0 for affected modules.

### C2. Phantom E2E Directory: `apps/runtime/src/__tests__/e2e/` Does Not Exist

auth-profiles and model-hub specs reference files in this directory. All are phantoms.

**Action**: Remove all phantom file references. Create the directory when writing real E2E tests.

### C3. agent-transfer-orchestration: No HLD, No LLD for Hub Feature (STABLE)

This hub feature coordinates 4 sub-features but has zero design artifacts of its own. Claims STABLE with 3 NOT TESTED areas and 4 open gaps.

**Action**: Either produce hub-level HLD/LLD or explicitly document that sub-feature artifacts suffice. Downgrade to BETA until gaps are closed.

### C4. guardrails GAP-1: `projectId` Hardcoded to `'default'` in Pipeline Factory

Production correctness bug — all guardrail cache keys and cost tracking keys use wrong projectId, breaking multi-project isolation.

**Action**: Fix immediately. This is a data isolation bug in production code.

### C5. oauth-tooling: Two Conflicting LLDs

`oauth-tooling.lld.md` and `2026-03-23-oauth-tooling-impl-plan.md` describe fundamentally different architectures (ToolOAuthService internals vs Auth Profile integration). No cross-reference.

**Action**: Archive older LLD, mark `2026-03-23` as canonical.

### C6. environment-variables: Two LLDs with Contradictory Decisions

D-2 in `2026-03-22` says "fallback in secrets-provider." D-2 in `2026-03-23` says "fallback in EnvVarStore." Both live in docs/plans/ with no supersession marker.

**Action**: Mark `2026-03-22` as SUPERSEDED. Fix feature spec Section 18 reference.

---

## Tier 2: HIGH — Should Fix Before Next Sprint

### Status Downgrades Required

| Module                       | Current | Recommended | Reason                                                                              |
| ---------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------- |
| auth-profiles                | STABLE  | BETA        | Zero E2E tests, 3 phantom test files, FR-5 (redaction) untested                     |
| model-hub                    | STABLE  | BETA        | Zero E2E tests, FR-7 (policy enforcement) unimplemented, LLD Phases 1-3 not started |
| agent-anatomy                | STABLE  | BETA        | Zero genuine E2E tests, 6/10 FRs PARTIAL, GAP-008 unfixed                           |
| agent-transfer-orchestration | STABLE  | BETA        | No HLD/LLD, 3 NOT TESTED areas, multi-intent dispatch uncovered                     |

### Status Inconsistencies to Reconcile

| Module                | Feature Spec | Test Spec | HLD                | LLD                |
| --------------------- | ------------ | --------- | ------------------ | ------------------ |
| environment-variables | BETA         | STABLE    | IMPLEMENTED        | DONE               |
| pii-detection         | BETA         | —         | Implemented (BETA) | Implemented (BETA) |

### Missing Test Files Claimed by LLDs

| Module                | Missing File                              | LLD Phase        |
| --------------------- | ----------------------------------------- | ---------------- |
| environment-variables | `snapshot-service-integration.test.ts`    | Phase 4 Task 4.5 |
| environment-variables | `deployment-repo-integration.test.ts`     | Phase 4 Task 4.6 |
| tool-invocations      | `tool-invocations-isolation.e2e.test.ts`  | Phase 1          |
| tool-invocations      | `tool-invocations-resilience.e2e.test.ts` | Phase 2          |
| guardrails            | 12 E2E files under `guardrails/e2e/`      | Phases 1-8       |

### Code Issues

| Module        | Issue                                            | Location                                   |
| ------------- | ------------------------------------------------ | ------------------------------------------ |
| agent-anatomy | `console.error` instead of `createLogger`        | `apps/runtime/src/routes/agents.ts:91,143` |
| guardrails    | `projectId` hardcoded to `'default'`             | pipeline factory auto-wiring               |
| model-hub     | FR-7 reads as implemented but only schema exists | Feature spec FR-7                          |

### Plan Fragmentation

| Module                | Extra Plans                                                     | Risk                         |
| --------------------- | --------------------------------------------------------------- | ---------------------------- |
| guardrails            | 4 additional plans (UI design, UI plan, hardening, DSL cleanup) | Unclear completion, no index |
| environment-variables | 2 LLDs                                                          | Contradictory decisions      |
| oauth-tooling         | 2 LLDs                                                          | Different architectures      |

---

## Tier 3: MEDIUM — Recommended Improvements

| ID  | Module                | Finding                                                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------- |
| M1  | pii-detection         | EventStore reference inconsistency between feature spec and HLD                        |
| M2  | pii-detection         | `pii-pattern-loader.test.ts` uses vi.mock but listed as integration                    |
| M3  | tool-invocations      | Data model toolType enum narrower than FR-1 list — needs clarifying note               |
| M4  | agent-anatomy         | GAP-004 (no tenantId on agent_versions) — no timeline                                  |
| M5  | model-hub             | Auth Profile integration status inconsistent between feature specs                     |
| M6  | model-hub             | No browser E2E for Studio model management                                             |
| M7  | environment-variables | LLD references phantom "HLD decision D-13"                                             |
| M8  | environment-variables | No browser E2E for Studio base value tab                                               |
| M9  | oauth-tooling         | Test spec E2E scenarios use existing runtime routes, not planned Studio routes         |
| M10 | oauth-tooling         | HLD doesn't clarify relationship between new Studio flow and existing ToolOAuthService |
| M11 | oauth-tooling         | US-5 deferral not mentioned in test spec                                               |
| M12 | oauth-tooling         | Redis dependency for Studio not verified                                               |
| M13 | guardrails            | 147/175 provider-kind combinations untested                                            |
| M14 | agent-transfer        | Hub test spec has no cross-cutting integration scenarios                               |

---

## Positive Findings

1. **LLD file path accuracy**: All 9 LLDs reference files that actually exist (zero fabricated paths in batches 2 & 3; batch 1 phantom refs are in test specs, not LLD code refs)
2. **Cross-phase terminology**: Consistent naming across all artifacts for all 9 modules
3. **Scope discipline**: No scope drift in any module
4. **Gap documentation honesty**: Most modules honestly document their gaps rather than hiding them
5. **tool-invocations**: Genuine 19-scenario E2E suite, clean architecture, accurate LLD
6. **guardrails Studio**: Real Playwright E2E tests exist and pass
7. **guardrails LLD wiring checklist**: Fully verified (all checked)

---

## Recommended Action Plan

### Week 1: Triage & Reclassify

1. Reclassify all mock-heavy tests as unit tests across all 9 test specs
2. Update coverage matrices to show true E2E = 0 where applicable
3. Downgrade auth-profiles, model-hub, agent-anatomy, agent-transfer from STABLE to BETA
4. Archive/supersede duplicate LLDs (oauth-tooling, environment-variables)
5. Fix guardrails `projectId: 'default'` bug
6. Fix agent-anatomy `console.error` (2-line change)
7. Reconcile environment-variables status across all 4 docs

### Week 2-3: E2E Test Creation (Priority Order)

1. **guardrails** — runtime API E2E (highest risk: 147 untested combos, production isolation bug)
2. **agent-anatomy** — agent CRUD + version lifecycle E2E (STABLE claim is completely unsupported)
3. **auth-profiles** — credential management E2E (security-critical path)
4. **environment-variables** — real E2E replacing mock-heavy test
5. **model-hub** — provisioning + resolution chain E2E
6. **pii-detection** — PII pattern CRUD API E2E
7. **tool-invocations** — isolation E2E only (existing suite is solid)

### Week 3-4: LLD Phase Execution

1. Execute guardrails LLD Phases 1-3 (E2E infrastructure + provider matrix)
2. Execute model-hub LLD Phases 1-3 (policy enforcement, cache invalidation, health check)
3. Execute agent-anatomy LLD Phases 1-2 (GAP-008 fix + test coverage)
4. Execute tool-invocations LLD Phase 1 (isolation E2E)
