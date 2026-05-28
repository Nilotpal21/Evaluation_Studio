# SDLC Log: Integration Auth Profiles — Post-Implementation Sync

**Feature**: integration-auth-profiles
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-05

---

## Documents Updated

- [x] Feature spec: `docs/features/sub-features/integration-auth-profiles.md` — status PLANNED→ALPHA, updated test coverage table, gaps table, implementation files, resolved open question #3
- [x] Test spec: `docs/testing/sub-features/integration-auth-profiles.md` — status PLANNED→IN PROGRESS, coverage matrix updated with ✅/❌, E2E-6 description updated, test file mapping with actual counts
- [x] Testing index: `docs/testing/README.md` — updated coverage status
- [x] HLD: `docs/specs/integration-auth-profiles.hld.md` — status DRAFT→APPROVED
- [x] LLD: `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md` — status DRAFT→DONE

## Coverage Delta

| Type              | Before | After   |
| ----------------- | ------ | ------- |
| Unit tests        | 0      | 25      |
| Integration tests | 0      | 91      |
| E2E tests         | 0      | 14      |
| **Total**         | **0**  | **130** |

## Remaining Gaps

- ~~GAP-001~~: Resolved — `providers.json` populated with 254 OAuth2 providers
- ~~GAP-005~~: Resolved — 17 UI component unit tests written (6 IntegrationAuthTab, 7 IntegrationCard, 4 SlideOver)
- GAP-006: E2E-6 tests non-existent project instead of cross-tenant (dev-login limitation)
- GAP-007: Bridge upsert means multiple profiles share one bridge (last-write wins)

## Deviations from Plan

1. **Bridge creation pattern**: Changed from `findOne+create` to `findOneAndUpdate` with `upsert: true` to handle multiple profiles per connector without unique index violations
2. **DELETE blocker exclusion**: Bridge `ConnectorConnection` was blocking its own profile's deletion via `summarizeDeleteBlockers` — added exclusion when profile has `connector` field
3. **Encryption DEK scope fallback**: Tenant-scoped profiles (`projectId: null`) with encryption plugin `scope: 'project'` needed a fallback to `projectId: '_tenant'` sentinel
4. **E2E-6 cross-tenant test**: Dev-login auto-attaches all users to same tenant, making cross-tenant E2E impossible — changed to non-existent project test

## Status Transition Justification (Historical 2026-04-05 Snapshot)

**PLANNED → ALPHA** because:

- [x] All 7 implementation phases complete
- [x] Core happy path works (create integration profile → bridge → providers → delete cascade)
- [x] 14 E2E tests exercising real system via HTTP API at the 2026-04-05 sync point (later expanded to 18 by 2026-04-25)
- [x] 91 mocked-boundary and route-focused tests were counted as "integration" at the 2026-04-05 sync point; the 2026-04-25 refresh reclassified those to avoid overstating dedicated integration coverage
- [x] UI component unit tests written (GAP-005) — 17 tests across 3 files
- [x] `providers.json` populated (GAP-001) — 254 OAuth2 providers

BETA promotion criteria now met for GAP-001 and GAP-005. Remaining gaps (GAP-002, GAP-006, GAP-007) are Accepted/Low severity.

---

## Update — 2026-04-25

### Documents Updated

- [x] Feature spec: `docs/features/sub-features/integration-auth-profiles.md` — corrected shipped connector count, catalog behavior, Power BI auth mapping, and key implementation/test files
- [x] Test spec: `docs/testing/sub-features/integration-auth-profiles.md` — corrected coverage classification, updated current catalog/E2E counts, and removed references to non-existent dedicated bridge integration tests
- [x] Testing index: `docs/testing/README.md` — updated row to reflect strong E2E coverage with targeted mocked-boundary route tests instead of overstated integration counts
- [x] HLD: `docs/specs/integration-auth-profiles.hld.md` — added post-implementation notes and corrected catalog/test-strategy counts
- [x] LLD: `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md` — added post-implementation notes for real connector promotion and auth-aware Connections catalog reuse

### Coverage Delta

| Type                     | Before (Doc Claim) | After (Synced Reality)                                       |
| ------------------------ | ------------------ | ------------------------------------------------------------ |
| Unit / component tests   | 25                 | 58+ targeted unit/component assertions across shipped suites |
| Dedicated integration    | 91                 | 0 dedicated non-mocked integration suites documented         |
| Targeted route / service | not separated      | 26 mocked-boundary route/service tests                       |
| E2E tests                | 14                 | 18                                                           |

### Remaining Gaps

- Bridge rollback / cascade behavior is strongly covered by E2E, but there is still no dedicated non-mocked route-level regression suite on disk for that path.
- Cross-tenant E2E is still limited by the dev-login harness and remains approximated by the non-existent project path.
- `http` and `postgres` remain intentionally hidden from visible integration catalogs rather than receiving auth-profile flows.

### Deviations from Plan

- The broader Connections catalog was upgraded to consume the same auth-aware provider service as the Auth Profiles integrations tab.
- Several Microsoft/Azure/AWS connectors were promoted from planned auth-only virtual entries to real generated connector catalog entries by adding their ActivePieces pieces.
- Power BI shipped on the Azure AD path instead of the earlier client-credentials override.
- The previous doc sync overstated dedicated integration coverage; this refresh corrects the status back to an ALPHA-level evidence profile.
