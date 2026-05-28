# Critical Module Remediation Plan

**Created**: 2026-03-25
**Source**: `critical-module-triage-2026-03-25.md` (10 CRITICAL, 22 HIGH findings across 9 modules)
**Goal**: Resolve all CRITICAL findings, close HIGH gaps, establish honest coverage baselines

---

## Phase 0: Immediate Fixes (Day 1) — No Code Risk

Zero-risk documentation and classification corrections. No production code changes.

### 0.1 Reclassify Mock-Heavy Tests Across All Test Specs

Update these test spec coverage matrices to reclassify `vi.mock`-heavy tests as "unit" instead of "E2E" or "integration":

| Test Spec                                      | Files to Reclassify                                                                                                                       |      Current Label      |          New Label           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | :---------------------: | :--------------------------: |
| `docs/testing/auth-profiles.md`                | 3 phantom E2E files                                                                                                                       | E2E (EXISTS UNVERIFIED) |    MISSING — remove refs     |
| `docs/testing/model-hub.md`                    | `llm-wiring.test.ts` (20+ mocks), `tenant-models.test.ts`, `model-resolution-comprehensive.test.ts`                                       |       Integration       |             Unit             |
| `docs/testing/environment-variables.md`        | `env-vars-e2e.test.ts` (14+ mocks), `environment-variables-authz.test.ts` (10+ mocks)                                                     |           E2E           |             Unit             |
| `docs/testing/agent-anatomy.md`                | `project-agents-authz.test.ts` (10), `agent-model-config-authz.test.ts` (7), `versions-authz.test.ts` (9), `version-routes.test.ts` (12+) |       Integration       |             Unit             |
| `docs/testing/agent-transfer-orchestration.md` | `kore-e2e.test.ts` (mocks + direct imports)                                                                                               |           E2E           |   Integration (with mocks)   |
| `docs/testing/guardrails.md`                   | `guardrail-edge-cases.e2e.test.ts` (no HTTP, direct compiler imports)                                                                     |           E2E           | Integration (compiler-level) |
| `docs/testing/pii-detection.md`                | `builtin-pii-e2e.test.ts` (pipeline-level, no HTTP)                                                                                       |           E2E           | Integration (pipeline-level) |
| `docs/testing/pii-detection.md`                | `pii-pattern-loader.test.ts`, `output-pii-filter.test.ts` (vi.mock)                                                                       |       Integration       |             Unit             |

**Exit criteria:**

- [ ] All 9 test spec coverage matrices updated
- [ ] E2E columns show "N" or "MISSING" where no genuine E2E exists
- [ ] Coverage matrix totals recalculated

### 0.2 Status Downgrades

Update feature spec status fields:

| Feature Spec                                    | Current | New  | Reason                             |
| ----------------------------------------------- | :-----: | :--: | ---------------------------------- |
| `docs/features/auth-profiles.md`                | STABLE  | BETA | Zero E2E, phantom test refs        |
| `docs/features/model-hub.md`                    | STABLE  | BETA | Zero E2E, FR-7 unimplemented       |
| `docs/features/agent-anatomy.md`                | STABLE  | BETA | Zero genuine E2E, 6/10 FRs PARTIAL |
| `docs/features/agent-transfer-orchestration.md` | STABLE  | BETA | No HLD/LLD, 3 untested areas       |

Also reconcile cross-artifact status:

| Module                | Fix                                                                           |
| --------------------- | ----------------------------------------------------------------------------- |
| environment-variables | Set test spec status to BETA (matches feature spec), HLD to BETA, LLD to BETA |
| pii-detection         | Standardize all docs to "BETA" (drop "Implemented" prefix)                    |

**Exit criteria:**

- [ ] All 6 feature specs updated
- [ ] Cross-artifact status consistent for environment-variables and pii-detection
- [ ] No module claims STABLE without genuine E2E coverage

### 0.3 Archive/Supersede Duplicate LLDs

| Action                          | File                                                                 | Change                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark SUPERSEDED                 | `docs/plans/2026-03-22-environment-variables-impl-plan.md`           | Add header: `> **SUPERSEDED** by `2026-03-23-environment-variables-impl-plan.md`. Decisions in this doc are outdated.`                            |
| Mark as existing-impl reference | `docs/plans/oauth-tooling.lld.md`                                    | Add header: `> **REFERENCE ONLY** — Documents existing ToolOAuthService internals. Forward-looking plan: `2026-03-23-oauth-tooling-impl-plan.md`` |
| Fix feature spec ref            | `docs/features/environment-variables.md` Section 18                  | Update LLD reference to 2026-03-23                                                                                                                |
| Fix phantom HLD ref             | `docs/plans/2026-03-23-environment-variables-impl-plan.md` Section 5 | Remove "Per HLD decision D-13" (no such decision exists)                                                                                          |

**Exit criteria:**

- [ ] Older env-vars LLD header says SUPERSEDED
- [ ] Older oauth-tooling LLD header says REFERENCE ONLY
- [ ] Feature spec references point to canonical LLDs
- [ ] No phantom cross-references

### 0.4 Remove Phantom E2E File References

Remove references to files in the nonexistent `apps/runtime/src/__tests__/e2e/` directory:

| Document                                  | Remove Reference To                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `docs/features/auth-profiles.md`          | `auth-profile-connector-setup.test.ts`, `auth-profile-oauth-flow.test.ts`, `auth-profile-token-refresh.test.ts` |
| `docs/testing/auth-profiles.md`           | Same 3 files (mark as MISSING, not EXISTS UNVERIFIED)                                                           |
| `docs/plans/auth-profiles.lld.md` Phase 3 | Rewrite from "verify existing E2E" to "create E2E tests"                                                        |

**Exit criteria:**

- [ ] Zero references to nonexistent `e2e/` directory in any spec
- [ ] auth-profiles LLD Phase 3 accurately describes work needed

---

## Phase 1: Production Bug Fixes (Day 1-2)

### 1.1 Fix guardrails `projectId: 'default'` Bug (C4)

The pipeline factory auto-wiring hardcodes `projectId: 'default'` instead of using the actual project ID. This breaks:

- Cache key isolation (`guardrail:{tenantId}:{projectId}:...`)
- Cost tracking key generation

**Approach:**

1. Read `packages/compiler/src/platform/guardrails/pipeline-factory.ts` (or wherever auto-wiring occurs)
2. Find the hardcoded `'default'` value
3. Replace with actual `projectId` from context/config
4. Verify cache key and cost tracking key use the real projectId
5. Add a test verifying project-scoped cache keys are distinct

**Exit criteria:**

- [ ] No hardcoded `projectId: 'default'` in pipeline factory
- [ ] Cache keys include real projectId
- [ ] Test verifies two projects get different cache keys
- [ ] `pnpm build --filter=@abl/compiler` passes
- [ ] Existing guardrails tests pass

### 1.2 Fix agent-anatomy `console.error` (GAP-008)

Replace `console.error` with structured logger in `apps/runtime/src/routes/agents.ts` lines 91 and 143.

**Approach:**

1. Add `import { createLogger } from '@abl/compiler/platform'` (verify actual import path first)
2. Create logger: `const log = createLogger('agents-route')`
3. Replace `console.error(...)` at line 91 with `log.error('message', { context })`
4. Replace `console.error(...)` at line 143 with `log.error('message', { context })`
5. Verify logger signature by reading `createLogger` source first

**Exit criteria:**

- [ ] Zero `console.error` in `agents.ts`
- [ ] Logger uses correct signature (`log.error('message', { context })`)
- [ ] `pnpm build --filter=@abl/runtime` passes

---

## Phase 2: E2E Test Infrastructure (Day 2-4)

Before writing module-specific E2E tests, establish shared infrastructure.

### 2.1 Create E2E Test Helper Utilities

Create `apps/runtime/src/__tests__/e2e/` directory with shared helpers.

**File: `apps/runtime/src/__tests__/e2e/helpers.ts`**

Provide:

- `createTestApp()` — starts Express on random port with full middleware chain (auth, rate limiting, tenant isolation, validation)
- `createTestTenant(app)` — creates tenant + API key via the real API
- `createTestProject(app, tenantId)` — creates project under tenant
- `authenticatedRequest(app, apiKey)` — returns supertest agent with auth headers
- `waitForReady(app)` — health check polling
- MongoMemoryServer setup/teardown

**Pattern reference**: `attachment-pii.e2e.test.ts` (pii-detection) or `tool-invocations-api.e2e.test.ts` (tool-invocations) — verify which is the best existing pattern.

**Exit criteria:**

- [ ] `apps/runtime/src/__tests__/e2e/helpers.ts` exists
- [ ] Helper starts real Express with full middleware
- [ ] MongoMemoryServer integration works
- [ ] At least 1 smoke test using the helper passes

### 2.2 Create Guardrails E2E Directory

Create `apps/runtime/src/__tests__/guardrails/e2e/` directory structure per the existing LLD plan (Phases 1-8). Start with helpers file.

**Exit criteria:**

- [ ] Directory exists
- [ ] `guardrail-e2e-helpers.ts` provides server startup + policy/provider seed utilities

---

## Phase 3: Critical E2E Tests — Isolation & Security (Day 3-7)

Priority: tests that verify security-critical paths (tenant isolation, auth, data leakage).

### 3.1 guardrails — Runtime API E2E (Highest Priority)

**Why first**: Production isolation bug (C4), 147/175 untested combos, BETA with zero runtime E2E.

Create at minimum:

1. `builtin-pii-input.e2e.ts` — PII detection via HTTP API (no external providers needed)
2. `policy-scoping.e2e.ts` — verify project-scoped policies don't leak across projects
3. `isolation.e2e.ts` — cross-tenant guardrail isolation

**Exit criteria:**

- [ ] 3+ E2E tests exercising real HTTP with full middleware
- [ ] Tests verify tenant and project isolation
- [ ] Zero `vi.mock` of codebase components
- [ ] All tests pass

### 3.2 agent-anatomy — Agent CRUD + Isolation E2E

Create:

1. `agent-crud-isolation.e2e.test.ts` — Create agent in Tenant A, verify Tenant B gets 404
2. `version-lifecycle.e2e.test.ts` — Create version, promote, verify via API
3. `model-config-override.e2e.test.ts` — Set project-level model config, verify resolution

**Exit criteria:**

- [ ] 3 genuine E2E tests (zero vi.mock)
- [ ] Tenant isolation verified through real HTTP
- [ ] Version promotion lifecycle tested end-to-end
- [ ] All tests pass

### 3.3 auth-profiles — Credential Management E2E

Create:

1. `auth-profile-crud.e2e.test.ts` — CRUD lifecycle with tenant isolation
2. `auth-profile-connector-setup.e2e.test.ts` — Attach profile to connector, verify resolution
3. `auth-profile-redaction.e2e.test.ts` — Verify secrets are redacted in API responses (FR-5)

**Exit criteria:**

- [ ] 3 genuine E2E tests
- [ ] Secret redaction verified (security-critical path)
- [ ] Tenant isolation verified
- [ ] All tests pass

### 3.4 tool-invocations — Isolation E2E (LLD Phase 1)

Create:

1. `tool-invocations-isolation.e2e.test.ts` — Cross-tenant tool secret isolation

**Exit criteria:**

- [ ] 1 genuine E2E test
- [ ] Cross-tenant isolation verified
- [ ] Test passes

### 3.5 environment-variables — Real E2E Replacing Mock Test

Create:

1. `env-vars-api.e2e.test.ts` — CRUD + base fallback + override via real HTTP (replacing the 14-mock test)
2. `env-vars-isolation.e2e.test.ts` — Cross-tenant and cross-project isolation

**Exit criteria:**

- [ ] 2 genuine E2E tests
- [ ] Replaces coverage claimed by mock-heavy `env-vars-e2e.test.ts`
- [ ] All tests pass

### 3.6 pii-detection — PII Pattern CRUD API E2E

Create:

1. `pii-pattern-crud.e2e.test.ts` — Pattern CRUD via `/api/projects/:projectId/pii-patterns`
2. `pii-pattern-isolation.e2e.test.ts` — Cross-tenant pattern isolation

**Exit criteria:**

- [ ] 2 genuine E2E tests for the 6-endpoint API
- [ ] Tenant isolation verified
- [ ] All tests pass

---

## Phase 4: Coverage Gap Closure (Week 2)

### 4.1 model-hub — E2E + FR-7 Acknowledgment

1. Create 3 E2E tests per the LLD Phase 4 plan (provisioning, isolation, overrides)
2. Update feature spec FR-7 to say "Schema exists, enforcement not yet implemented"
3. Add "Exists" column to HLD API endpoint tables

**Exit criteria:**

- [ ] 3 genuine E2E tests
- [ ] FR-7 honestly documented
- [ ] HLD distinguishes existing vs planned endpoints

### 4.2 agent-transfer-orchestration — Hub Design Decision

Either:

- **Option A**: Produce hub-level HLD addressing cross-feature concerns (auth propagation, thread resume, multi-intent dispatch)
- **Option B**: Document in the feature spec that sub-feature artifacts are sufficient, with a cross-cutting test scenario

**Exit criteria:**

- [ ] Decision documented
- [ ] If Option A: HLD exists
- [ ] If Option B: Cross-cutting integration test scenario defined
- [ ] Multi-intent dispatch at least has unit test coverage for 4 strategies

### 4.3 guardrails — Plan Consolidation

Create an index section in `guardrails.lld.md` that references and summarizes completion status of:

- `2026-03-08-guardrails-ui-design.md`
- `2026-03-08-guardrails-ui-plan.md`
- `2026-03-10-guardrails-hardening-plan.md`
- `2026-03-18-dsl-constraints-guardrails-cleanup-plan.md`

**Exit criteria:**

- [ ] LLD has "Related Plans" section with status per plan
- [ ] Each supplementary plan has a header noting its relationship to the primary LLD

### 4.4 Execute Remaining LLD Improvement Phases

| Module           | LLD Phase | Work                                        |
| ---------------- | --------- | ------------------------------------------- |
| model-hub        | Phase 1   | Policy enforcement middleware               |
| model-hub        | Phase 2   | Cache invalidation service                  |
| model-hub        | Phase 3   | Health check worker                         |
| tool-invocations | Phase 2   | Resilience E2E test                         |
| agent-anatomy    | Phase 2   | Test coverage for FR-5 through FR-10        |
| auth-profiles    | Phase 1   | Complete `redact.test.ts`                   |
| auth-profiles    | Phase 2   | Feature flag, signing, webhook, proxy tests |

**Exit criteria per phase:**

- [ ] Phase exit criteria checkboxes checked in LLD
- [ ] `pnpm build` passes
- [ ] New tests pass

---

## Phase 5: Test Spec & Coverage Matrix Refresh (Week 2-3)

After Phases 1-4, update all test specs to reflect reality:

### 5.1 Per-Module Test Spec Updates

For each of the 9 modules:

1. Refresh the test file inventory (add new E2E files, remove phantoms)
2. Update coverage matrix E2E/Integration/Unit columns
3. Recalculate coverage percentages
4. Update "Quick Health Dashboard" if present
5. Mark resolved gaps as PASS with test file references

### 5.2 Re-evaluate Feature Status

After E2E tests exist, re-evaluate whether BETA modules can be promoted:

| Module                       | Current | Promote to STABLE when                              |
| ---------------------------- | ------- | --------------------------------------------------- |
| auth-profiles                | BETA    | 3+ E2E tests pass, FR-5 redaction tested            |
| model-hub                    | BETA    | 3+ E2E tests pass, FR-7 status clarified            |
| agent-anatomy                | BETA    | 3+ genuine E2E pass, GAP-008 fixed                  |
| agent-transfer-orchestration | BETA    | Hub design decision made, cross-cutting test exists |
| environment-variables        | BETA    | 2+ real E2E tests, status reconciled                |
| guardrails                   | BETA    | 3+ runtime API E2E, GAP-1 fixed, plan consolidated  |
| pii-detection                | BETA    | 2+ CRUD API E2E                                     |
| tool-invocations             | STABLE  | Isolation E2E added (already strongest module)      |
| oauth-tooling                | PLANNED | N/A until implementation begins                     |

**Exit criteria:**

- [ ] All test specs reflect actual coverage
- [ ] Status promotions have documented justification
- [ ] No module claims STABLE without minimum 5 genuine E2E tests

---

## Success Metrics

| Metric                            | Before |                Target                 |
| --------------------------------- | :----: | :-----------------------------------: |
| Modules with genuine E2E          |  2/9   | 8/9 (oauth-tooling exempt as PLANNED) |
| CRITICAL findings                 |   10   |                   0                   |
| HIGH findings                     |   22   |          < 5 (deferred-only)          |
| Modules honestly reporting status |  5/9   |                  9/9                  |
| Duplicate/conflicting LLDs        |   3    |                   0                   |
| Production isolation bugs         |   1    |                   0                   |
