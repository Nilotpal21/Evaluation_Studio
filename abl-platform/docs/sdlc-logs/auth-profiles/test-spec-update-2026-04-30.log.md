# SDLC Log: Auth Profiles — Test Spec UPDATE (Phase 2)

**Date**: 2026-04-30
**Phase**: Test Spec — gap-closure rebalance for r2 mandatory rules
**Feature**: auth-profiles (BETA, r2 gap-closure scope)
**Branch**: `fixes/AuthProfiles`
**Test spec**: `docs/testing/auth-profiles.md` (403 lines pre-update)

---

## Trigger

User invoked `/test-spec auth-profiles` after `/feature-spec` landed. The test guide had been pre-restructured to match the new mandatory §1-§9 template (Coverage Matrix, 10 E2E, 8 INT, 6 unit, security checklist, perf, infra, file mapping, open questions) — but was missing 3 NEW skill-mandated requirements:

1. **Form error path E2E scenarios** (E2E-ERR-N)
2. **Wiring verification E2E** for new Studio API routes
3. **Coverage Matrix row for error/failure path** of each form/mutation

Plus the test spec status incorrectly said BETA (testing README correctly said PARTIAL).

## Inputs Consulted (fresh from disk)

- `docs/features/auth-profiles.md` (1050 lines, BETA, FR-1..FR-17)
- `docs/testing/auth-profiles.md` (403 lines, pre-restructured)
- `docs/features/AUTHORING_GUIDE.md` (status definitions)
- `docs/sdlc-logs/auth-profiles/feature-spec-update-2026-04-30.log.md`
- `docs/sdlc-logs/auth-profiles/feature-spec-audit-2026-04-30.log.md`
- `docs/testing/README.md` (already says PARTIAL 04-30)
- `CLAUDE.md` (E2E Test Standards, Test Architecture, Core Invariants)
- `packages/database/src/auth-profile/audit-events.ts` (verified constants exist, never emitted)
- `packages/shared/src/services/mcp-auth-resolver.ts:34-131` (verified GAP-7 in-memory cache)
- `apps/search-ai/src/services/auth-profile-resolver.ts` (cross-feature scoping)
- `docker-compose.yml` (verified Mongo + Redis sufficient)

## Clarifying Questions & Oracle Decisions

### Section A — Test Scope & Priorities

| #   | Question                            | Classification | Resolution                                                                                                             |
| --- | ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A1  | Top-3 highest-risk FRs              | INFERRED       | FR-13 (workspace OAuth — security-sensitive, ST-1), FR-11 (MCP CK-1), FR-15 (6 protocol handlers). Confirmed.          |
| A2  | Status BETA vs PARTIAL              | ANSWERED       | Test spec status → **PARTIAL** (line 6). Feature spec stays BETA. Testing README already correct.                      |
| A3  | Production failure modes to seed    | INFERRED       | GAP-7/8/9/10 + GAP-19 (SSRF) + GAP-22 (rate limits) seed E2E + INT scenarios; no other Sentry/Jira context accessible. |
| A4  | External deps mock at HTTP boundary | ANSWERED       | All via nock/msw or local mock servers. Kerberos env-gated separate CI lane (OQ-2).                                    |
| A5  | New test infrastructure?            | DECIDED        | None. Existing Docker stack + `Redis SELECT` for isolated DB index. Workflow engine on random port for FR-9 E2E.       |

### Section B — E2E Scenarios

| #   | Question                                  | Classification | Resolution                                                                                                                                                                    |
| --- | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Form error scenarios separate or sub-step | DECIDED        | Add E2E-ERR-1 (form invalid data, FR-14), E2E-ERR-2 (API 422 duplicate name, FR-14), E2E-ERR-3 (FR-12/FR-13 reconnect dialog error path) as **separate** scenarios.           |
| B2  | Wiring verification scenarios             | DECIDED        | Add E2E-WIRE-1 (workspace OAuth routes reachable through full Next.js middleware chain) and E2E-WIRE-2 (`/api/projects/:id/tools/workflow-compatible` reachable from Studio). |
| B3  | RBAC matrix cells missing                 | INFERRED       | Add as sub-assertions within E2E-7: project-OWNER without workspace `auth-profile:write` → 403; API key principal cannot initiate workspace OAuth.                            |
| B4  | Cross-feature interactions                | DECIDED        | SearchAI + connectors dual-read scoped OUT of this test spec — owned by their own test specs + non-touch boundary regression test (E2E-10/FR-17). Note in §7.                 |
| B5  | Perf SLOs concrete vs objective           | DECIDED        | Pin from feature spec: 0%/50 runs flake, P99 < 200ms cache miss. Defer matrix runtime budget (OQ-1) and cache hit ratio to LLD.                                               |

### Section C — Integration Boundaries

| #   | Question                             | Classification | Resolution                                                                                                                                                                                                               |
| --- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | INT-9 workflow tool_call boundary?   | INFERRED       | YES — workflow-engine → `/api/internal/tools/execute` → ToolBindingExecutor → middleware → resolver. Maps to existing planned test file `apps/runtime/src/__tests__/integration/internal-tools-auth.test.ts`.            |
| C2  | INT-10 audit event emission?         | ANSWERED       | YES — closes GAP-14 (constants defined but never emitted at `packages/database/src/auth-profile/audit-events.ts:15-16`). Asserts `OAUTH_INITIATED/COMPLETED/FAILED` with `idpErrorMapped` payload.                       |
| C3  | INT-11 cross-tenant isolation suite? | DECIDED        | YES — fast (~1-2s) defense-in-depth complement to E2E-10's full matrix. Covers Redis CC cache, OAuth state, audit log, resolver query.                                                                                   |
| C4  | INT-12 profile mutation × refresh?   | INFERRED       | YES — race scenario not covered by INT-3/4. Tests CK-1 cache key behavior under concurrent profileVersion bump and in-flight refresh.                                                                                    |
| C5  | INT-13/14 error path scenarios?      | DECIDED        | YES on 2: INT-13 (IdP 429 retry-with-backoff, GAP-22), INT-14 (Redis unavailable mid-refresh degraded mode). NO on third (DB-write-fails-after-IdP-exchange) — no rollback mechanism for IdP grants; unit-level concern. |

## Decisions Summary

- **Status**: line 6 `BETA` → `PARTIAL`
- **E2E count**: 10 → **15** (add E2E-ERR-1, E2E-ERR-2, E2E-ERR-3, E2E-WIRE-1, E2E-WIRE-2)
- **INT count**: 8 → **14** (add INT-9..INT-14)
- **Coverage Matrix**: add FR-13-ERR and FR-14-ERR rows for error/failure paths
- **Perf SLOs**: pin 0%/50 runs flake + P99 200ms; defer total matrix budget to LLD
- **Cross-feature scope**: SearchAI + connectors stay out
- **Test infra**: existing Docker stack sufficient; Redis SELECT for isolated DB
- **Kerberos**: env-gated separate CI lane

## No Items Escalated

All 15 oracle questions resolved without user input.

## Audit Outcomes

### Phase 4b — Round 1 (phase-auditor)

**Verdict**: APPROVED with 0 CRITICAL + 2 HIGH + 4 MEDIUM. All 6 fixed for round 2.

| ID  | Severity | Section               | Issue                                                                                                       | Fix Applied                                                                                                                                                                                                            |
| --- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | HIGH     | E2E-WIRE-1            | Direct Redis + DB inspection violates CLAUDE.md E2E API-only rule                                           | Reworked to API-only assertions: concurrent-init 409 proves init-lock; `GET /api/auth-profiles/:id` returning `hasGrant: true, principalKind: 'tenant'` proves token persistence; replay callback proves atomic GETDEL |
| F-2 | HIGH     | INT-10                | Step 3 references `AUTH_PROFILE_OAUTH_FAILED` constant that does not exist in `audit-events.ts:15-16` today | Annotated as `(planned constant — added by FR-13 Phase F)` in INT-10 steps 3 + 5 and E2E-ERR-3 expected-result; added Prerequisites section documenting current state vs Phase F additions                             |
| F-3 | MEDIUM   | E2E-ERR-1/2/3         | Missing `**Isolation Check**:` subsection                                                                   | Added to all 3: cross-tenant invisibility (ERR-1), partial-index tenant scoping (ERR-2), cross-tenant reconnect 404 + personal-profile invisibility (ERR-3)                                                            |
| F-4 | MEDIUM   | E2E-WIRE file mapping | Paths under `apps/studio/src/__tests__/api-routes/...` but typed `e2e` — convention mismatch                | Moved to `apps/studio/e2e/auth-profile-workspace-oauth-wiring.spec.ts` and `apps/studio/e2e/tools-workflow-compatible-wiring.spec.ts` matching `*.spec.ts` convention                                                  |
| F-5 | MEDIUM   | §7 env vars           | Generic "feature flags for kill-switch tests" without enumeration                                           | Enumerated all 12 flags in 5 grouped categories: encryption/infra, test principals, kill-switch, per-protocol, build-time gate                                                                                         |
| F-6 | MEDIUM   | E2E-ERR-2 step 3      | Partial-index description missing `visibility: 'shared'` filter                                             | Corrected to `{tenantId, name, environment}` where `projectId: null AND visibility: 'shared'` per `auth-profile.model.ts:231-245`                                                                                      |

### Phase 4b — Round 2 (phase-auditor)

**Verdict**: **APPROVED**. 0 CRITICAL + 0 HIGH + 1 LOW (carry-forward).

All 6 R1 findings cleanly resolved. Quality gates verified:

- 15 E2E scenarios (≥5 ✓)
- 14 integration scenarios (≥5 ✓)
- All FR-1..FR-17 mapped + FR-13-ERR + FR-14-ERR error rows
- No `vi.mock` / `jest.mock` of internal packages anywhere
- All E2E scenarios specify auth context (tenantId + projectId + userId)
- Cross-tenant 404, cross-project 404, cross-user 404, missing auth 401 all covered
- 6 perf SLOs pinned to feature spec §14
- 50+ test file mappings, all 15 existing paths verified on disk

### Carry-Forward to HLD/LLD (1 LOW item)

- INT-11 step 7 description uses `findOne({_id, tenantId})` syntax — appropriate for integration-tier (not E2E) but implementation should note model-level access is justified by integration scope. Low-risk editorial; address at LLD time.

## Status After This Phase

- `docs/testing/auth-profiles.md` line 6: `Status: PARTIAL` (correct per AUTHORING_GUIDE testing-status mapping for BETA feature)
- `docs/testing/README.md` row 1: PARTIAL 04-30 (15 E2E / 14 INT)
- `docs/features/auth-profiles.md`: BETA (unchanged this phase)

## Next Steps

1. Format + commit test-spec changes with `[ABLP-775]` header
2. Update agents.md cross-cutting log with test-spec learnings
3. Tell user `/hld auth-profiles` is the next SDLC phase
