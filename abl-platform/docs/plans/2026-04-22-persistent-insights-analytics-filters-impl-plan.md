# LLD: Persistent Insights & Analytics Filters

**Feature Spec**: `docs/features/sub-features/persistent-insights-analytics-filters.md`
**HLD**: `docs/specs/persistent-insights-analytics-filters.hld.md`
**Test Spec**: `docs/testing/sub-features/persistent-insights-analytics-filters.md`
**UX Spec**: `docs/specs/persistent-insights-analytics-filters.ux.md`
**Status**: DONE
**Date**: 2026-04-22

---

## 0. Progress Snapshot

- Implemented the shared preferences substrate, per-surface descriptors, and reset/filter-strip shared UI.
- Wired Tier 1 and Tier 2 surfaces to persisted filter state.
- Wired Analytics shell, Sessions Explorer, Traces Explorer, and Generations to persisted state per the finalized UX doc.
- Restored Analytics as an active Insights surface in the local Studio navigation/runtime wiring so the feature is reachable in this worktree.
- Verification completed so far:
  - `pnpm --filter @agent-platform/studio build`
  - `pnpm --filter @agent-platform/database build`
  - `npx prettier --write <touched files>`
- Final verification completed:
  - `pnpm --filter @agent-platform/database build`
  - `pnpm --filter @agent-platform/studio typecheck`
  - `pnpm --filter @agent-platform/studio build`
  - `pnpm --filter @agent-platform/studio test:fast -- src/__tests__/stores/insights-analytics-filters.test.ts src/__tests__/stores/navigation-store.test.ts src/__tests__/components/sessions-explorer-filters.test.tsx`
  - targeted browser restore/reset/isolation and accessibility passes across supported surfaces
- Non-blocking follow-up: refresh the legacy ad hoc `/tmp/persistent-filters-qa.js` selectors so it matches the current Studio UI chrome.

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                           | Rationale                                                                                             | Alternatives Rejected                                       |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D-1 | Extend the existing Studio preferences flow instead of page-local `localStorage` helpers                           | Gives cross-device persistence, one schema/migration path, and consistent UX semantics                | Per-page `localStorage` helpers                             |
| D-2 | Keep persistent state partitioned by `projectId` and `surfaceKey`                                                  | Matches the finalized UX requirement that surfaces remember independent analysis context              | Global shared date range or one flat preference object      |
| D-3 | Drive page state directly from the shared preference store via a shared hook                                       | Avoids default-then-restored flashes on project switch and keeps updates centralized                  | Copying persisted state into page-local mirrors             |
| D-4 | Reuse existing `FilterTags` styling semantics inside a new `ActiveFiltersStrip` instead of adding another chip row | Matches the final UX requirement for unified active-state presentation on dense surfaces              | Two separate rows for page-level chips and advanced filters |
| D-5 | Keep `activeSubTab` persisted for Traces Explorer but exclude it from reset semantics                              | Aligns with the final UX rationale that reset should not navigate the user away from the current view | Resetting the sub-tab back to `traces`                      |

### Key Interfaces & Types

```ts
type SurfaceKey =
  | 'atAGlance'
  | 'analyticsPage'
  | 'analyticsSessions'
  | 'analyticsTraces'
  | 'analyticsGenerations'
  | 'billingUsage'
  | 'agentPerformance'
  | 'qualityMonitor'
  | 'customerInsights'
  | 'voiceAnalytics';

interface PersistedInsightsAnalyticsFilters {
  version: 1;
  byProject: Record<string, Partial<Record<SurfaceKey, unknown>>>;
}

interface PersistedSurfaceDescriptor<T> {
  defaults: T;
  validate: (raw: unknown) => T;
  countNonDefault: (state: T) => number;
  resetState?: (state: T) => T;
  getPageChips?: (state: T) => Array<{ key: string; label: string; value: string }>;
}
```

### Module Boundaries

| Module                                          | Responsibility                                                      | Depends On                                 |
| ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `lib/preferences/insights-analytics-filters.ts` | Types, defaults, per-surface descriptors, validation helpers        | `zod`                                      |
| `store/preferences-store.ts`                    | Local cache, server sync, surface read/write/reset helpers          | client API                                 |
| `hooks/usePersistedSurfaceFilters.ts`           | Surface hydration, setters, reset, counts, page-level chip metadata | preferences store, navigation store        |
| Shared UI components                            | Reset button, filter strip, chip rendering                          | descriptor output + existing design tokens |
| Surface components                              | Bind specific control state to the shared hook                      | shared hook + existing data hooks          |

---

## 2. File-Level Change Map

### New Files

| File                                                            | Purpose                                                     | LOC Estimate |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| `apps/studio/src/lib/preferences/insights-analytics-filters.ts` | Shared types, defaults, descriptors, and validation helpers | 250          |
| `apps/studio/src/hooks/usePersistedSurfaceFilters.ts`           | Shared persistence hook                                     | 140          |
| `apps/studio/src/components/shared/ResetFiltersButton.tsx`      | Tier 2 / Tier 3 reset affordance                            | 60           |
| `apps/studio/src/components/shared/FilterChip.tsx`              | Shared chip primitive                                       | 70           |
| `apps/studio/src/components/shared/ActiveFiltersStrip.tsx`      | Tier 3 unified active-filters strip                         | 160          |

### Modified Files

| File                                                                | Change Description                                                                            | Risk   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| `apps/studio/src/api/preferences.ts`                                | Extend preference types and request payload                                                   | Low    |
| `apps/studio/src/store/preferences-store.ts`                        | Add new preference payload, helpers, debounced save, and load-once behavior                   | Medium |
| `apps/studio/src/app/api/user/preferences/route.ts`                 | Validate and persist new payload shape                                                        | Medium |
| `packages/database/src/models/user-preferences.model.ts`            | Add new mixed/nested preference field                                                         | Low    |
| `apps/studio/src/components/ui/PageHeader.tsx`                      | Add `beforeActions` slot for Tier 2 reset placement                                           | Low    |
| `apps/studio/src/components/insights/AtAGlancePage.tsx`             | Replace local state with persisted state and add reset button                                 | Medium |
| `apps/studio/src/hooks/useAtAGlance.ts`                             | Accept external `conversationFilter` instead of owning it internally                          | Medium |
| `apps/studio/src/components/insights/AgentPerformancePage.tsx`      | Persist state and add reset button                                                            | Low    |
| `apps/studio/src/components/insights/QualityMonitorPage.tsx`        | Hoist table filters, persist them, add reset button                                           | Medium |
| `apps/studio/src/components/projects/ProjectBillingPage.tsx`        | Persist date range silently                                                                   | Low    |
| `apps/studio/src/components/insights/CustomerInsightsPage.tsx`      | Persist date range silently                                                                   | Low    |
| `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` | Persist date range silently                                                                   | Low    |
| `apps/studio/src/components/analytics/AnalyticsPage.tsx`            | Persist shell state and add shell reset                                                       | Medium |
| `apps/studio/src/components/analytics/SessionsExplorerTab.tsx`      | Persist filters, add reset button, replace `FilterTags` with unified strip                    | Medium |
| `apps/studio/src/components/analytics/TracesExplorerTab.tsx`        | Persist Traces + Generations state, add reset button, replace `FilterTags` with unified strip | High   |
| `apps/studio/src/components/shared/index.ts`                        | Export new shared UI components if needed                                                     | Low    |

### Deleted Files (if any)

| File | Reason |
| ---- | ------ |
| None | —      |

---

## 3. Implementation Phases

### Phase 1: Preference Substrate

**Goal**: Land the shared persistence model and reusable primitives before touching page wiring.

**Tasks**:
1.1. Add shared filter types, defaults, validation helpers, and surface descriptors.
1.2. Extend the Studio preference client, store, and route with `insightsAnalyticsFilters`.
1.3. Extend the `UserPreferences` model with the additive field.
1.4. Create `usePersistedSurfaceFilters`, `ResetFiltersButton`, `FilterChip`, and `ActiveFiltersStrip`.
1.5. Add `PageHeader.beforeActions`.

**Files Touched**:

- `apps/studio/src/lib/preferences/insights-analytics-filters.ts`
- `apps/studio/src/api/preferences.ts`
- `apps/studio/src/store/preferences-store.ts`
- `apps/studio/src/app/api/user/preferences/route.ts`
- `packages/database/src/models/user-preferences.model.ts`
- `apps/studio/src/hooks/usePersistedSurfaceFilters.ts`
- `apps/studio/src/components/shared/ResetFiltersButton.tsx`
- `apps/studio/src/components/shared/FilterChip.tsx`
- `apps/studio/src/components/shared/ActiveFiltersStrip.tsx`
- `apps/studio/src/components/ui/PageHeader.tsx`

**Exit Criteria**:

- [x] `insightsAnalyticsFilters` is readable and writable through the store and Studio route
- [x] `usePersistedSurfaceFilters` can restore, update, and reset at least one synthetic surface in tests or manual harness checks
- [x] `npx prettier --write` has been run on touched files
- [x] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/database` succeeds

**Test Strategy**:

- Unit: helper validation and descriptor count/chip logic
- Integration: Studio route GET/PATCH payload handling

**Rollback**: Remove the new field from UI consumption first; the additive backend field can remain safely unused.

---

### Phase 2: Tier 1 and Tier 2 Surface Wiring

**Goal**: Wire the silent-restore and PageHeader reset behavior onto the simpler surfaces first.

**Tasks**:
2.1. Wire Billing & Usage, Customer Insights, and Voice Analytics date ranges to the shared hook.
2.2. Wire Dashboard state and refactor `useAtAGlance` so `conversationFilter` is page-owned and persisted.
2.3. Wire Agent Performance to persisted date/search/status/compare state and add reset affordance.
2.4. Hoist Quality Monitor's flagged-conversation filters to page scope, persist them, and add reset affordance.

**Files Touched**:

- `apps/studio/src/components/projects/ProjectBillingPage.tsx`
- `apps/studio/src/components/insights/CustomerInsightsPage.tsx`
- `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx`
- `apps/studio/src/components/insights/AtAGlancePage.tsx`
- `apps/studio/src/hooks/useAtAGlance.ts`
- `apps/studio/src/components/insights/AgentPerformancePage.tsx`
- `apps/studio/src/components/insights/QualityMonitorPage.tsx`

**Exit Criteria**:

- [x] Tier 1 surfaces restore date controls silently with no new UI
- [x] Tier 2 surfaces show `Reset filters` only when non-default state exists
- [x] Dashboard reset does not clear ROI settings
- [x] Quality Monitor reset clears page + flagged-table persisted filters together
- [x] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Unit: surface-specific count behavior for Dashboard, Agent Performance, and Quality Monitor
- Manual: verify Tier 1 adds no new chrome and Tier 2 stays visually calm

**Rollback**: Revert each page to its previous `useState` initializers while leaving the substrate in place.

---

### Phase 3: Tier 3 Surface Wiring

**Goal**: Wire Analytics shell and explorer surfaces, including the unified active-filter strip.

**Tasks**:
3.1. Persist Analytics shell date mode, quick/custom range, and active tab; add shell reset.
3.2. Wire Sessions Explorer persisted state and replace standalone `FilterTags` with `ActiveFiltersStrip`.
3.3. Wire Traces Explorer persisted state, preserve ephemeral selected session/detail view, and add reset.
3.4. Wire Generations persisted state and use the shared filter strip.
3.5. Keep Query SQL text explicitly ephemeral.

**Files Touched**:

- `apps/studio/src/components/analytics/AnalyticsPage.tsx`
- `apps/studio/src/components/analytics/SessionsExplorerTab.tsx`
- `apps/studio/src/components/analytics/TracesExplorerTab.tsx`

**Exit Criteria**:

- [x] Analytics shell reset clears only shell state
- [x] Sessions Explorer reset clears page-level + advanced filters but not column config, sort, pagination, or selected sessions
- [x] Traces reset clears current-subtab state without navigating away from the current sub-tab
- [x] Active filter strips render unified page-level and advanced chips with dismiss behavior
- [x] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Unit: chip generation and dismiss behavior
- Manual: verify strip layout, count badges, and reset semantics against the UX doc wireframes

**Rollback**: Revert explorer components back to existing `useState`/`FilterTags` behavior while keeping underlying substrate code.

---

### Phase 4: Verification and Hardening

**Goal**: Confirm the implementation matches the UX contract and does not regress Studio.

**Tasks**:
4.1. Run targeted builds and any feasible tests for touched Studio/database files.
4.2. Run a manual matrix across Tier 1, Tier 2, and Tier 3 surfaces.
4.3. Update docs if implementation-required deviations appear.

**Files Touched**:

- Any touched implementation files requiring small follow-up fixes
- Potentially the feature spec and test spec for sync

**Exit Criteria**:

- [x] Formatting complete
- [x] Targeted builds green
- [x] Manual checks cover restore, reset, project isolation, and invalid-state fallback
- [x] Remaining gaps are documented explicitly

**Test Strategy**:

- Build: `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/database`
- Optional targeted tests where coverage exists or can be added safely

**Rollback**: Revert only the UI consumers if needed; the additive preference schema remains backward-compatible.

---

## 4. Wiring Checklist

- [x] `insightsAnalyticsFilters` added to preference API types
- [x] `insightsAnalyticsFilters` added to Studio GET/PATCH route response and update path
- [x] `insightsAnalyticsFilters` added to the `UserPreferences` model
- [x] Shared hook imported by every supported surface
- [x] `PageHeader.beforeActions` used by Tier 2 pages
- [x] `ResetFiltersButton` rendered only on eligible non-default multi-control surfaces
- [x] `ActiveFiltersStrip` replaces `FilterTags` on Tier 3 Insights/Analytics explorer surfaces
- [x] Query SQL text remains unmanaged by the persistence hook

## 5. Cross-Phase Concerns

### Database Migrations

No formal migration is required. The new field is additive, optional, and can be introduced lazily.

### Feature Flags

No feature flag is planned for Phase 1. The blast radius is limited to additive preference behavior and reversible UI consumers.

### Configuration Changes

No new environment variables or tenant settings are required.

## 6. Acceptance Criteria (Whole Feature)

- [x] All supported surfaces restore their intended persisted controls per the feature spec
- [x] Tier 1 surfaces add no new reset or chip UI
- [x] Tier 2 surfaces add only the reset button with count badge
- [x] Tier 3 surfaces add reset plus unified active-filter strip where applicable
- [x] Project switching restores per-project state without filter bleed
- [x] Targeted Studio/database builds pass
- [x] Remaining testing gaps are documented in the final summary

## 7. Open Questions

1. If the Analytics shell later gains a visible active-chip strip, should it reuse the Tier 3 strip primitive or keep the current lighter treatment?
2. Do we want a later cleanup phase to centralize more page-level filter labels in i18n once the persistence contract stabilizes?
