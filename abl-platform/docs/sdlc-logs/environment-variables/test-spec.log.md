# SDLC Log: Environment Variables — Test Spec

**Date:** 2026-03-23
**Phase:** Test Spec (Phase 2)
**Artifact:** `docs/testing/environment-variables.md`

## Process

### Sources Read

1. `docs/features/environment-variables.md` — feature spec (Phase 1 output)
2. `apps/runtime/src/routes/environment-variables.ts` — all CRUD, copy, validate endpoints
3. `apps/runtime/src/services/secrets-provider.ts` — RuntimeSecretsProvider resolution chain
4. `apps/runtime/src/services/snapshot-service.ts` — snapshot with base+override dedup
5. `apps/runtime/src/repos/deployment-repo.ts` — retirePreviousActiveDeployment
6. `apps/runtime/src/__tests__/environment-variables-authz.test.ts` — existing authz tests
7. `apps/runtime/src/__tests__/cross-project-isolation.test.ts` — existing isolation tests
8. `packages/config/src/__tests__/environment.test.ts` — existing unit tests
9. `apps/studio/src/services/tool-test-service.ts` — reference base fallback implementation
10. `apps/runtime/src/services/execution/llm-wiring.ts` — EnvVarStore (bug location)

### Test Scenario Counts

| Layer       | Scenarios | Requirement                     |
| ----------- | --------- | ------------------------------- |
| E2E         | 14        | Min 5 required                  |
| Integration | 11        | Min 5 required                  |
| Unit        | 3         | Covered by config package tests |

### Clarifying Questions (Self-Resolved)

| #   | Question                              | Classification | Resolution                                                                                     |
| --- | ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Should E2E tests use real encryption? | DECIDED        | Yes — using `encryption_master_key` env var. Mocking encryption would miss ciphertext bugs.    |
| 2   | How to test concurrent deployment?    | DECIDED        | Use Promise.all with two simultaneous deploy requests. Assert at most one active deployment.   |
| 3   | Should we test Studio UI?             | DECIDED        | No — Studio UI component tests are out of scope for this test spec. Only API-level testing.    |
| 4   | How to seed auth for E2E?             | INFERRED       | Use test helper to create JWT with required permissions, same pattern as existing authz tests. |

## Key Decisions

1. **14 E2E scenarios** covering full lifecycle, base+override, copy, validation, isolation, namespaces, limits, diff, export/import, bug fix verifications
2. **11 integration scenarios** covering secrets provider, snapshot service, deployment repo, encryption, concurrency, namespace pagination, cache sentinel, tool-test-service
3. **No mocks** — all tests use real MongoDB (MongoMemoryServer), real encryption, real middleware chain
4. **Existing tests identified** — authz and cross-project isolation tests already exist, this spec adds missing coverage
5. **FR-5 (Studio UI)** excluded from test spec — UI component testing is out of scope for API-level test spec

## Audit Results

### Round 1 (inline audit)

| #   | Severity | Finding                                                                 | Resolution                                              |
| --- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| F1  | MEDIUM   | FR-5 (Studio UI base tab) has no test coverage                          | Acceptable — UI feature, API-level tests can't cover it |
| F2  | LOW      | SDLC log showed stale counts (10 E2E / 8 integration vs actual 14 / 11) | Fixed — updated log to reflect actual counts            |
| F3  | LOW      | E2E-10 references `MAX_ENV_VARS_PER_PROJECT` without specifying value   | Test reads constant from config at runtime              |
| F4  | LOW      | INT-8 tests pure functions — more unit than integration                 | Acceptable — validates config package boundary          |

**Result:** No CRITICAL or HIGH findings. Proceeding to round 2.

### Round 2 (cross-phase consistency)

| #   | Severity | Finding                                                  | Resolution                                                             |
| --- | -------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| F5  | LOW      | E2E-9 doesn't specify exact deployment API endpoint path | Minor — deployment API paths are documented in deployment feature spec |

**Cross-phase checks:**

- All 11 FRs from feature spec mapped in coverage matrix — PASS
- All E2E scenarios have auth context (tenantId, projectId, userId) — PASS
- No mocks in E2E scenarios, real server pattern — PASS
- All integration scenarios specify service boundary — PASS
- Test file mapping covers all scenarios — PASS
- Security section has concrete expected behaviors — PASS

**Result:** APPROVED — no CRITICAL or HIGH findings across both rounds.

## Gaps Identified

4 open testing questions documented in section 9 of the test spec.
