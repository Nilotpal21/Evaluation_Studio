# Test Specification: Persistent Insights & Analytics Filters

**Feature Spec**: [docs/features/sub-features/persistent-insights-analytics-filters.md](../../features/sub-features/persistent-insights-analytics-filters.md)
**HLD**: [docs/specs/persistent-insights-analytics-filters.hld.md](../../specs/persistent-insights-analytics-filters.hld.md)
**LLD**: [docs/plans/2026-04-22-persistent-insights-analytics-filters-impl-plan.md](../../plans/2026-04-22-persistent-insights-analytics-filters-impl-plan.md)
**Status**: PARTIAL
**Last Updated**: 2026-04-22

---

## 1. Coverage Matrix

| FR    | Description                                                                | Unit | Integration | E2E | Manual | Status  |
| ----- | -------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Per-user, per-tenant, per-project, per-surface partitioning                | YES  | NO          | NO  | YES    | PARTIAL |
| FR-2  | Versioned `insightsAnalyticsFilters` payload via existing preferences flow | NO   | NO          | NO  | YES    | PARTIAL |
| FR-3  | Auto-restore with schema fallback to defaults                              | YES  | NO          | NO  | YES    | PARTIAL |
| FR-4  | Surface-scoped `Reset filters` behavior                                    | YES  | NO          | NO  | YES    | PARTIAL |
| FR-5  | Dashboard / At a Glance persistence                                        | NO   | NO          | NO  | YES    | PARTIAL |
| FR-6  | Analytics page-shell persistence                                           | YES  | NO          | NO  | YES    | PARTIAL |
| FR-7  | Sessions Explorer persistence                                              | YES  | NO          | NO  | YES    | PARTIAL |
| FR-8  | Traces Explorer persistence                                                | YES  | NO          | NO  | YES    | PARTIAL |
| FR-9  | Generations persistence                                                    | YES  | NO          | NO  | YES    | PARTIAL |
| FR-10 | Billing & Usage date-range persistence                                     | NO   | NO          | NO  | YES    | PARTIAL |
| FR-11 | Agent Performance persistence                                              | NO   | NO          | NO  | YES    | PARTIAL |
| FR-12 | Quality Monitor persistence                                                | NO   | NO          | NO  | YES    | PARTIAL |
| FR-13 | Customer Insights date-range persistence                                   | NO   | NO          | NO  | YES    | PARTIAL |
| FR-14 | Voice Analytics date-range persistence                                     | NO   | NO          | NO  | YES    | PARTIAL |
| FR-15 | Transient UI state and SQL editor text stay ephemeral                      | YES  | NO          | NO  | YES    | PARTIAL |
| FR-16 | Debounced writes and search persistence                                    | NO   | NO          | NO  | YES    | PARTIAL |
| FR-17 | Fail-open behavior on cache or server sync failure                         | YES  | NO          | NO  | YES    | PARTIAL |
| FR-18 | Business-friendly restored-state UX without banners or color-only cues     | NO   | NO          | NO  | YES    | PARTIAL |

### Current Baseline

The repository already has adjacent seams that this feature should extend:

- `preferences-store.ts` persists pinned-project preferences only
- `ColumnCustomizer` already persists column state separately through local storage
- Insights and Analytics pages currently own most filter state locally
- there is no shared E2E proof for refresh, revisit, cross-project restore, or `Reset filters`

Those seams show where the feature belongs, but they do not yet prove the persistent-filter contract.

### Implemented Coverage Snapshot

- Unit coverage now exists for the shared persistence descriptors and helpers in `apps/studio/src/__tests__/stores/insights-analytics-filters.test.ts`.
- Existing navigation and Sessions Explorer tests still pass with the persistence wiring in place.
- Browser verification has been run against the restored Studio UI for Dashboard, Analytics shell, Sessions Explorer, Traces, Generations, Query ephemerality, Billing & Usage, Agent Performance, Quality Monitor, Customer Insights, and Voice Analytics.
- A legacy ad hoc QA harness in `/tmp` still has stale selectors for some newer UI treatments; it is not repo-tracked coverage and should be refreshed separately.

---

## 2. E2E Test Scenarios (MANDATORY)

### E2E-1: Dashboard restores date range, active tab, and conversation filter after refresh

- **FR Coverage**: FR-3, FR-5, FR-17
- **Preconditions**: Authenticated Studio user with access to a project and existing dashboard data
- **Steps**:
  1. Open Dashboard and set a non-default date range, tab, and conversation filter.
  2. Refresh the browser.
  3. Observe the page after reload.
- **Expected Result**: The same Dashboard control values are restored automatically and the page remains functional if the preference call is delayed.

### E2E-2: Analytics restores page shell and Sessions Explorer filters, but not the selected session

- **FR Coverage**: FR-6, FR-7, FR-15
- **Preconditions**: Authenticated Studio user with Analytics data
- **Steps**:
  1. Open Analytics, switch to a non-default page tab, and set a non-default date range.
  2. In Sessions Explorer, apply search, status, channel, environment, and advanced filters.
  3. Select a session row.
  4. Refresh the browser.
- **Expected Result**: The page tab, date range, and Sessions Explorer filters are restored, but the selected session row is not auto-restored.

### E2E-3: Traces Explorer and Generations restore saved filters, but not selected trace context

- **FR Coverage**: FR-8, FR-9, FR-15
- **Preconditions**: Authenticated Studio user with trace and generation data
- **Steps**:
  1. Open Analytics `Traces Explorer`.
  2. Apply type filters, search text, and advanced filter rows.
  3. Select a trace or generation detail.
  4. Refresh the browser and revisit both `Traces` and `Generations`.
- **Expected Result**: Saved filters restore in both tabs; selected trace, detail pane state, and other ephemeral context do not restore.

### E2E-4: Switching projects preserves independent saved state

- **FR Coverage**: FR-1, FR-3
- **Preconditions**: Same user has access to Project A and Project B
- **Steps**:
  1. In Project A, save non-default Dashboard and Analytics filters.
  2. Switch to Project B and set different filter values.
  3. Return to Project A.
- **Expected Result**: Project A reopens with Project A's saved state only; Project B values do not bleed across.

### E2E-5: `Reset filters` clears only the current surface

- **FR Coverage**: FR-4, FR-17
- **Preconditions**: A surface with multiple saved controls such as Dashboard or Analytics
- **Steps**:
  1. Apply several non-default filters and leave the page.
  2. Reopen the page and confirm restore.
  3. Use `Reset filters`.
  4. Navigate away and back again.
- **Expected Result**: The current surface returns to defaults and stays at defaults on revisit, while other saved surfaces in the same project remain untouched.

### E2E-6: Server-backed persistence survives a second browser context

- **FR Coverage**: FR-2, FR-3
- **Preconditions**: Two authenticated browser contexts for the same Studio user
- **Steps**:
  1. In browser context A, save non-default filters on Dashboard and Analytics.
  2. Open browser context B on the same project and revisit those pages.
- **Expected Result**: Browser context B restores the saved server-backed state without requiring the same local cache.

### E2E-7: Billing, Agent Performance, Quality Monitor, Customer Insights, and Voice Analytics restore correctly

- **FR Coverage**: FR-10, FR-11, FR-12, FR-13, FR-14
- **Preconditions**: Project with seeded data for each surface
- **Steps**:
  1. Apply non-default values on each supported surface.
  2. Refresh or leave and revisit each surface.
- **Expected Result**: Each surface restores only its supported persistent fields and stays usable with no restore banner.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Preferences route reads and writes `insightsAnalyticsFilters` without losing existing fields

- **FR Coverage**: FR-2
- **Boundary**: Studio route handler -> preferences store contract -> database model
- **Suggested File**: `apps/studio/src/app/api/user/preferences/__tests__/route.test.ts`
- **Expected Result**: `pinnedProjectIds` and other existing preference fields remain intact when the new payload is added or updated.

### INT-2: Preferences route enforces user and tenant isolation

- **FR Coverage**: FR-1
- **Boundary**: Authenticated Studio route -> `user_preferences` query
- **Suggested File**: `apps/studio/src/app/api/user/preferences/__tests__/route.test.ts`
- **Expected Result**: A user cannot read or update another user's preference record, and cross-tenant access is impossible.

### INT-3: Invalid enums, unknown keys, and stale versions fall back safely

- **FR Coverage**: FR-3, FR-17
- **Boundary**: Route validation + client/store hydration
- **Suggested File**: `apps/studio/src/app/api/user/preferences/__tests__/route.test.ts`
- **Expected Result**: Unknown fields are stripped, invalid values are replaced with page defaults, and malformed blobs do not crash the client.

### INT-4: Surface-scoped reset clears only the targeted nested object

- **FR Coverage**: FR-4
- **Boundary**: Shared persistence helper -> preference store -> route patch
- **Suggested File**: `apps/studio/src/store/__tests__/preferences-store.test.ts`
- **Expected Result**: Resetting one surface leaves sibling surfaces and sibling projects unchanged.

### INT-5: Debounced saves coalesce rapid filter changes

- **FR Coverage**: FR-16
- **Boundary**: Shared persistence helper -> debounced preference save
- **Suggested File**: `apps/studio/src/hooks/__tests__/usePersistedSurfaceFilters.test.ts`
- **Expected Result**: Rapid typing or chip changes produce one logical persisted update after the debounce window.

### INT-6: Server failures and corrupt cache fall back to defaults without blocking page data

- **FR Coverage**: FR-17
- **Boundary**: Shared persistence helper + page integration seam
- **Suggested File**: `apps/studio/src/hooks/__tests__/usePersistedSurfaceFilters.test.ts`
- **Expected Result**: Pages stay usable with default filters when cache parsing fails or the PATCH request errors.

---

## 4. Unit Test Scenarios

### UT-1: Shared helper serializes and hydrates each supported surface shape

- **FR Coverage**: FR-5 through FR-14
- **Suggested File**: `apps/studio/src/hooks/__tests__/usePersistedSurfaceFilters.test.ts`
- **Expected Result**: Each supported surface maps its page state to and from the shared `insightsAnalyticsFilters` payload correctly.

### UT-2: Transient state is explicitly excluded from persistence

- **FR Coverage**: FR-15
- **Suggested File**: `apps/studio/src/components/analytics/__tests__/persistent-filters.test.tsx`
- **Expected Result**: Selected session, selected trace, pagination, detail-mode toggles, and SQL text do not appear in saved payloads.

### UT-3: `Reset filters` visibility matches surface complexity

- **FR Coverage**: FR-4, FR-18
- **Suggested File**: `apps/studio/src/components/insights/__tests__/persistent-filters.test.tsx`
- **Expected Result**: Multi-filter surfaces render `Reset filters`; simple single-control pages do not add unnecessary UI.

### UT-4: Restored-state controls remain understandable without a banner

- **FR Coverage**: FR-18
- **Suggested File**: `apps/studio/src/components/insights/__tests__/persistent-filters.test.tsx`
- **Expected Result**: Active states are visible through controls, labels, badges, and accessible text rather than banner copy or color alone.

---

## 5. Manual Validation

1. Confirm Dashboard feels executive and calm while Analytics remains denser but visually consistent.
2. Confirm restored filter states are obvious from the controls without any extra "restored" messaging.
3. Confirm `Reset filters` is easy to find on complex pages and absent on simple pages where it would add clutter.
4. Confirm color semantics stay consistent: accent for selection, success/warning/error for meaning, and no color-only cues.
5. Confirm performance feels immediate on refresh and on cross-device revisit.

---

## 6. Notes

- This feature should reuse the existing Studio user-preferences seam rather than introducing per-page `localStorage` helpers.
- `ColumnCustomizer` persistence and At a Glance ROI settings are adjacent but intentionally out of scope for this test matrix.
- The first implementation pass should prioritize correctness of restore/reset/isolation over saved-view sophistication.
