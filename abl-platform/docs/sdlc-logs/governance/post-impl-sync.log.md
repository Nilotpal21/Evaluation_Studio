# Post-Implementation Sync Log: Agent Governance Dashboard

**Date**: 2026-04-29
**Feature slug**: governance
**JIRA**: ABLP-698

## Documents Updated

- [x] Feature spec `docs/features/governance.md` — Status PLANNED → ALPHA; §11 Configuration: added GOVERNANCE_ENABLED (opt-out, default on); §10 Tests: updated to reflect actual test files; §16 Gaps: added GAP-011 through GAP-014; §17 Testing: updated coverage matrix with actual ✅/PARTIAL/❌/NOT_IMPLEMENTED
- [x] Test spec `docs/testing/governance.md` — Status PLANNED → IN PROGRESS; Coverage Matrix: all FRs updated with actual unit/integration coverage; §8 Test File Mapping: split into "actual" and "planned but not yet created"
- [x] Testing index `docs/testing/README.md` — Governance row updated from PLANNED to PARTIAL; E2E count corrected to 0; last updated date corrected to 2026-04-29
- [x] LLD `docs/plans/2026-04-29-governance-impl-plan.md` — Status DRAFT → DONE; File-Level Change Map: 3 consolidated contract test files marked as ~~struck~~; Post-Implementation Notes section added with deviations table

## Coverage Delta

| Type        | Before | After                                                        |
| ----------- | ------ | ------------------------------------------------------------ |
| Unit tests  | 0      | 36 (governance-unit.test.ts)                                 |
| Integration | 0      | 12 (contract test via RuntimeApiHarness + MongoMemoryServer) |
| E2E tests   | 0      | 0 (deferred — GAP-012: requires live ClickHouse)             |

## Remaining Gaps

- GAP-011: FR-31 external auditor `governance:audit-read` provisioning UI — RBAC check implemented; invitation flow deferred to BETA
- GAP-012: All ClickHouse-backed integration tests (breach detection, CSV/PDF export, Redis caching, audit filtering) not written — requires live ClickHouse seeding
- GAP-012a: Explicit 401 test for policy CRUD (no-auth) not in contract test
- GAP-012b: Cross-tenant isolation for CRUD endpoints not covered (only GET /status tested)

## Deviations from Plan

1. `GOVERNANCE_ENABLED` is opt-out (`!== 'false'`) not opt-in — governance active by default when env var unset
2. Contract tests consolidated into single file (was planned as 4 separate files)
3. `governance-policy-version.model.ts` added (not in original data model — resolves Open Question #4)
4. Data-flow audit found CRITICAL: Studio GOVERNANCE_METRICS had wrong metric names; fixed in audit fix commit
5. Data-flow audit found HIGH: `GovernancePolicyVersion.deleteMany/findOne` missing `projectId`; fixed in audit fix commit
6. Data-flow audit found HIGH: empty `catch {}` in audit service; replaced with structured log

## Phase Auditor Findings (1 round)

Round 1: NEEDS_REVISION (4 findings). All fixed:

- CRITICAL PS-1: GOVERNANCE_ENABLED default mismatch → fixed in feature spec §11
- HIGH PS-1: Testing README column swap → fixed
- HIGH PS-3: Item #3 cross-tenant CRUD coverage overstated → downgraded to PARTIAL
- HIGH PS-4: LLD file map had 3 non-existent contract files → marked as consolidated
