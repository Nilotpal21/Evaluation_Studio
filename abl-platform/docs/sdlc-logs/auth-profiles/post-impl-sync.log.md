# SDLC Log: Auth Profiles — Post-Implementation Sync

**Feature**: auth-profiles
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-03

## Documents Updated

- Feature spec: `docs/features/auth-profiles.md` — refreshed runtime API section, corrected gaps, updated representative implementation/test inventory, and aligned coverage summary with the live codebase
- Test spec: `docs/testing/auth-profiles.md` — replaced stale 24-file inventory with the current 84-file package-by-package count, resolved moved-path drift, and updated remaining gap focus
- HLD: `docs/specs/auth-profiles.hld.md` — testing strategy updated to reflect shipped route/runtime/shared coverage
- LLD: `docs/plans/auth-profiles.lld.md` — converted from open gap-closure framing to historical/post-sync status with current remaining work

## Coverage Delta

| Area                                           | Prior doc state                          | Post-sync state                                                                                                               |
| ---------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Verified auth-profile/OAuth-focused test files | 24 listed, 13 "missing"                  | 84 counted across database, shared, shared-auth-profile, runtime, studio, and project-io                                      |
| Runtime API documentation                      | No dedicated router documented           | Dedicated runtime router, by-name lookup, delete guards, and durable OAuth grant service documented                           |
| Gap inventory                                  | Dominated by missing files / stale paths | Focused on real remaining gaps: legacy migration records, addon E2E breadth, remaining dual-read consumers, TraceStore parity |

## Notable Findings

- Runtime now has a dedicated auth-profile router at `apps/runtime/src/routes/auth-profiles.ts`; prior docs incorrectly described auth profiles as Studio-only on the HTTP surface.
- The old "missing test files" list was mostly path drift. Runtime auth suites moved under `apps/runtime/src/__tests__/auth/**`, Studio auth-profile routes consolidated under `apps/studio/src/__tests__/api-routes/**`, and shared coverage is split across both `packages/shared` and `packages/shared-auth-profile`.
- Legacy `oauth2_token` profiles are intentionally read-only migration records. Durable OAuth grant flows resolve from linked `oauth2_app` profiles through `oauth-grant-service.ts`, so docs now treat that as a design constraint instead of a missing feature.

## Remaining Gaps

- Advanced addon and phase-3 auth flows still need broader end-to-end coverage.
- Some platform consumers still rely on dual-read instead of auth-profile-only resolution.
- Health/alerting signals are structured and queryable in their current subsystems, but not yet surfaced as first-class TraceStore-native auth-profile lifecycle spans.

---

## 2026-05-06 — Post-Implementation Sync (r2 Completion + hardening pass)

### Documents Updated

- Feature spec: `docs/features/auth-profiles.md`
  - Updated status/date, corrected FR-9..FR-17 testing rows from planned to implemented coverage references.
  - Synced data model uniqueness notes to current 4 partial-index reality.
  - Fixed ST-1 contract row to include `redirectUri` binding + callback verification.
  - Updated key API rows (`/api/auth-profiles/oauth/*`, `/tools/workflow-compatible`) to implemented.
  - Reconciled GAP statuses for completed implementation items (GAP-7..GAP-20, GAP-22 where applicable) and retained strict-testing-depth follow-up under open GAP-4.
- Test spec: `docs/testing/auth-profiles.md`
  - Updated status/date and FR-9..FR-17 matrix from PLANNED to PARTIAL/covered.
  - Refreshed test-file mapping paths to current files (`mcp-auth-resolver`, `tool-test-service`, workspace OAuth routes, matrix/sanitizer/drift-lint).
  - Added explicit note separating implementation-complete from strict acceptance lane completion.
- Testing index: `docs/testing/README.md`
  - Updated Auth Profiles row with 2026-05-06 status and revised E2E/INT completion split.
- HLD: `docs/specs/auth-profiles.hld.md`
  - Updated last-updated timestamp.
  - Added post-implementation notes section for completion state vs strict acceptance follow-up.
  - Marked previously stale feature-spec alignment questions as resolved in this sync pass.
- LLD (active plan): `docs/plans/2026-05-01-auth-profiles-impl-plan.md`
  - Updated status to DONE (with strict-acceptance follow-up caveat).
  - Added post-implementation notes capturing implemented phases and deferred strict-lane validation work.

### Coverage Delta (doc-reported)

| Type                                     | Before                           | After                                                                                   |
| ---------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Unit/integration mapping for FR-9..FR-17 | Mostly planned placeholders      | Implemented file references + partial status tracking                                   |
| Matrix E2E representation                | Planned-only wording             | Baseline matrix test present + strict exhaustive lane explicitly deferred               |
| Feature gap table consistency            | Mixed open/closed contradictions | Implementation-closed gaps marked closed; testing-depth follow-up called out separately |

### Remaining Follow-Up (strict acceptance, not implementation)

- Exhaustive whole-feature E2E matrix permutations and long-run flake lanes.
- Remaining strict INT lane family completion (`INT-9`..`INT-14`) as acceptance evidence.
- Optional enterprise-depth protocol/test expansions beyond current implementation baseline.

## 2026-05-07 — Post-Implementation Sync (server-side OAuth popup finalization)

### Documents Updated

- Feature spec: `docs/features/auth-profiles.md`
  - Replaced stale React callback component references with the current browser callback route (`apps/studio/src/app/oauth/auth-profile-callback/route.ts`).
  - Added the shared callback finalizer (`apps/studio/src/app/api/auth-profiles/oauth/_oauth-callback-finalizer.ts`) to the implementation inventory.
  - Clarified that `/oauth/auth-profile-callback` exchanges the provider code server-side, stores the durable OAuth grant, marks the profile `active`, and returns a popup handoff without refreshing the parent page.
- Test spec: `docs/testing/auth-profiles.md`
  - Updated OAuth lifecycle and INT-3 scenarios to cover browser callback finalization and no parent-page navigation.
  - Removed stale React callback component test mapping and pointed FR-13 coverage to `auth-profile-oauth-callback-route.test.ts`.
- HLD: `docs/specs/auth-profiles.hld.md`
  - Documented the single browser callback route plus shared finalizer design.
- Active LLD: `docs/plans/2026-05-01-auth-profiles-impl-plan.md`
  - Resolved the OAuth callback URL strategy open question to the single browser callback route with authenticated POST callback fallbacks.

### Verification Notes

- Verified referenced route/finalizer files exist before updating docs.
- Focused Studio OAuth callback route tests and Studio typecheck were run before this sync.

---

## 2026-05-07 — Post-Implementation Sync (UI hardening + callback resilience pass)

### Documents Updated

- Feature spec: `docs/features/auth-profiles.md`
  - Updated `Last Updated` metadata.
  - Synced Studio UI/API sections for explicit on-demand verification chip behavior and added workspace OAuth state-resolution endpoint (`GET /api/auth-profiles/oauth/state`).
  - Added key implementation inventory entries for `AuthProfileListHealthPill`, `AuthProfileHealthPill`, OAuth state service/route, and browser callback fallback flow.
  - Appended 2026-05-07 post-implementation note for verification-chip, OAuth callback, and OAuth parameter UX hardening.
- Test spec: `docs/testing/auth-profiles.md`
  - Updated `Last Updated` metadata.
  - Added 2026-05-07 sync note and expanded FR-13/FR-14 mapping rows for newly landed Studio tests (`AuthProfileListHealthPill`, `AuthProfileHealthPill`, `use-batch-oauth`, `HttpConfigForm`).
- Testing index: `docs/testing/README.md`
  - Updated top timestamp and Auth Profiles status row date to 05-07.
- HLD: `docs/specs/auth-profiles.hld.md`
  - Updated `Last Updated` metadata.
  - Added incremental hardening notes covering explicit verify UX, no-hover chip messaging, OAuth state route usage, and key/value auth-parameter UI.
- LLD (active plan): `docs/plans/2026-05-01-auth-profiles-impl-plan.md`
  - Updated `Last Updated` metadata.
  - Added incremental post-implementation notes for the same UI/runtime hardening deltas.

### Coverage Delta (doc-reported)

| Type                           | Before                                   | After                                                                |
| ------------------------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| Studio UI regression mapping   | Slide-over + metadata focused            | Includes verification-chip and callback-resilience regressions       |
| OAuth callback resilience docs | Callback route/page documented partially | Includes explicit `oauth/state` scope-resolution fallback endpoint   |
| HTTP auth form behavior docs   | Generic auth form validation only        | Documents `authProfileRef` precedence over inline OAuth2 auth fields |

### Verification Notes

- Verified every newly referenced implementation/test path exists via `rg --files` before finalizing doc links.
- Consistency check completed: feature spec, test spec, testing index, HLD, and active LLD now carry aligned 2026-05-07 metadata and incremental-hardening notes.

### Remaining Follow-Up (strict acceptance, not implementation)

- Exhaustive whole-feature E2E matrix permutations and long-run flake lanes.
- Remaining strict INT lane family completion (`INT-9`..`INT-14`) as acceptance evidence.
- Optional enterprise-depth protocol/test expansions beyond current implementation baseline.

---

## 2026-05-12 — Post-Implementation Sync (ABLP-913 core implementation)

### Summary

Full ABLP-913 implementation pass: 19 commits landing database migrations, shared services, runtime wiring, connectors integration, Studio API routes, and Studio UI components. All P0 functional requirements (FR-9 through FR-18, FR-22–FR-28, FR-30) now have working implementation. Test count jumped from 84 to 191 auth-related files.

### Documents Updated

- Feature spec: `docs/features/auth-profiles.md`
  - Updated `Last Updated` to 2026-05-12
  - Updated P8 delivery status from PLANNED to IN PROGRESS
  - Marked GAP-7..GAP-19 as Mitigated (all implemented); GAP-20 Deferred (pre-filter on arrival)
  - Added 7 new files to Auth Profile Service Modules table
  - Added 4 new Runtime Integration files
  - Added Connectors Integration section
  - Added 10 new Studio UI component entries
  - Updated coverage matrix: FR-9..FR-31 from NOT TESTED to PARTIAL
  - Updated test summary: 84 → 191 auth-related test files
  - Updated reference counts: 17 → 23 service modules, 9 → 24 Studio components
- Test spec: `docs/testing/auth-profiles.md`
  - Updated status line: 84 → 191 test files; ABLP-913 status from PLANNED to IN PROGRESS
  - Updated ABLP-913 coverage matrix: all FRs now show PARTIAL status with actual test file mappings
  - FR-20 marked REMOVED; FR-19 marked DEFERRED
- Testing index: `docs/testing/README.md`
  - Updated top timestamp to 2026-05-12
  - Updated Auth Profiles row with current coverage state
- HLD: `docs/specs/auth-profiles.hld.md`
  - Updated status to reflect ABLP-913 IN PROGRESS
  - Updated `Last Updated` to 2026-05-12
- LLD: `docs/plans/2026-05-08-auth-profile-ablp913-impl-plan.md`
  - Updated status from DRAFT to IN PROGRESS

### Coverage Delta

| Type                        | Before (2026-05-07)       | After (2026-05-12)                                   |
| --------------------------- | ------------------------- | ---------------------------------------------------- |
| Auth-related test files     | 84                        | 191 (+107)                                           |
| ABLP-913 FR coverage status | All NOT TESTED            | All PARTIAL (unit + integration landed; E2E minimal) |
| E2E tests (ABLP-913)        | 0                         | 1 (`integration-auth-profiles.e2e.test.ts`)          |
| New shared services         | 0 ABLP-913 specific       | 7 new modules                                        |
| New Studio API routes       | 0 ABLP-913 specific       | 5 new endpoints                                      |
| New Runtime services        | 0 ABLP-913 specific       | 3 new services                                       |
| Connectors integration      | No auth-profile awareness | `ConnectionResolver` synthesizes from auth-profile   |
| Studio UI components        | 9 files                   | 24 files (+15 new)                                   |
| Migrations                  | 0 ABLP-913 specific       | 2 new                                                |
| Gap table                   | GAP-7..GAP-20 Open        | GAP-7..GAP-19 Mitigated; GAP-20 Deferred             |

### Deviations from Plan

- FR-20 (inline-Add) removed per 2026-05-09 meeting
- Integrations page redesigned from connections-centric to informational vendor catalog
- `ConnectionResolver` fallback added for backward compat (not in original LLD)

### Remaining Follow-Up

- Full E2E matrix permutations (E2E-8 through E2E-15)
- FR-19 (pre-filter on arrival) — deferred
- Strict acceptance lane completion for INT scenarios
- Browser/Playwright tests for UI behavior

---

## 2026-05-13 — Post-Implementation Sync (review hardening + data-flow reconciliation)

### Summary

Post-review hardening for ABLP-913 landed after the core implementation sync. This pass reconciled the docs with the actual branch state: project OAuth callback delegation is restored through the shared finalizer, project-scoped OAuth grants carry `projectId`/`profileId`, `isAuthorized` propagates through list/detail/integrations/assignment surfaces, runtime session scanner and force-invalidate typing are hardened, and the dead local duplicate token refresh service was removed. Canonical OAuth token refresh is now documented as `packages/shared-auth-profile/src/token-refresh-service.ts`.

### Documents Updated

- Feature spec: `docs/features/auth-profiles.md`
  - Updated `Last Updated` to 2026-05-13.
  - Updated ABLP-913 status language from planned/in-progress to core implementation plus hardening landed.
  - Replaced stale `packages/shared/src/services/auth-profile/token-refresh-service.ts` references with canonical `packages/shared-auth-profile/src/token-refresh-service.ts`.
  - Reconciled FR-20/inline-Add language so the docs consistently state saved profiles only.
  - Added 2026-05-13 build/focused-test verification notes.
- Test spec: `docs/testing/auth-profiles.md`
  - Updated `Last updated` to 2026-05-13.
  - Documented 8 authored ABLP-913 E2E specs while keeping strict E2E execution as pending.
  - Updated INT-18/INT-20 from inline-Add round-trip to inline credential rejection + saved-profile redaction.
  - Added 2026-05-13 execution history for build and 77 focused tests.
- Testing index: `docs/testing/README.md`
  - Updated top timestamp and Auth Profiles row to 2026-05-13.
  - Captured build green, focused suite green, full-test blocker on develop.
- HLD: `docs/specs/auth-profiles.hld.md`
  - Updated `Last Updated` to 2026-05-13.
  - Updated ABLP-913 status to core implemented with strict E2E depth pending.
  - Reconciled inline-Add design text to saved-profile-only credentials.
  - Updated testing strategy from 84-file inventory to 191-file inventory plus 77-test hardening pass.
- LLD: `docs/plans/2026-05-08-auth-profile-ablp913-impl-plan.md`
  - Updated status to core implementation and 2026-05-13 review hardening done.
  - Added post-implementation and verification notes.
  - Updated token refresh file ownership to `packages/shared-auth-profile/src/token-refresh-service.ts`.

### Verification Notes

- `pnpm build`: PASS.
- Focused regression suites: PASS, 77 tests across shared auth-profile authorization/refresh, Studio OAuth callback/integrations routes, and runtime session scanner/force invalidation.
- `pnpm test`: blocked by known `@agent-platform/shared-auth` platform-key scope registry mismatch already present on `origin/develop`; no branch changes under `packages/shared-auth`.
- `helix`: not available on PATH during the review pass, so doc sync used local inventory and skill-guided audit.

### Remaining Follow-Up

- Strict E2E execution for authored ABLP-913 specs under `apps/studio/e2e/auth-profiles/`.
- Full `pnpm test` once the develop-owned `@agent-platform/shared-auth` registry mismatch is fixed.
- Production soak / CI lane evidence before promoting the feature from BETA to STABLE.
