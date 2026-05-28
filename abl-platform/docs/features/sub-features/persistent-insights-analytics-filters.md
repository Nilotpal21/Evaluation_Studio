# Feature: Persistent Insights & Analytics Filters

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Analytics Insights Dashboard](../analytics-insights-dashboard.md) / [Billing & Usage](../billing.md)
**Status**: IMPLEMENTED
**Feature Area(s)**: `customer experience`, `admin operations`, `observability`
**Package(s)**: `apps/studio`, `packages/database`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/persistent-insights-analytics-filters.md](../../testing/sub-features/persistent-insights-analytics-filters.md)
**Last Updated**: 2026-04-22

---

## 1. Introduction / Overview

### Problem Statement

Studio now expects operators to move fluidly across Dashboard, Analytics, Billing & Usage, Agent Performance, Quality Monitor, Customer Insights, and Voice Analytics within the same Insights navigation group. Those surfaces all expose date ranges, tabs, searches, chips, or advanced filters, but most of that state still lives in page-local `useState`.

That creates a repetitive and error-prone workflow:

- refreshing the page or revisiting later resets the analysis context
- switching from Dashboard to Analytics and back forces users to rebuild the same view
- returning on another device loses the exact filters that explained the last insight
- denser operator surfaces like Sessions Explorer and Traces Explorer feel especially "reset-happy"

The problem became more visible once Analytics returned as a first-class page under Insights. Users now move between executive summaries and operational explorers in one continuous workflow, but the product does not remember where they left off.

Studio already has two adjacent persistence patterns:

- a server-backed user-preferences path for durable user settings
- local-only `localStorage` persistence for narrow UI concerns such as column customization and ROI inputs

Without a dedicated feature, filter persistence would likely be added piecemeal as one-off `localStorage` helpers on each page, creating inconsistent behavior, duplicated validation, and no cross-device continuity.

### Goal Statement

Provide quiet, predictable persistence for the last intentional analysis context on every Insights and Analytics surface. A returning user should land back on the same project, page, date range, tab, search, and filters they were using before, while unrelated pages remain independent and transient UI state stays ephemeral.

### Summary

Persistent Insights & Analytics Filters adds one versioned preference payload to the existing Studio user-preferences flow and uses it to remember page-specific analysis context per user, per project, and per surface. The feature covers Dashboard, Analytics, Billing & Usage, Agent Performance, Quality Monitor, Customer Insights, and Voice Analytics.

The experience is intentionally lightweight:

- saved state restores automatically with no extra banner
- the controls themselves show the restored state
- complex pages get a visible `Reset filters` escape hatch
- transient state such as pagination, selected sessions, expanded rows, and SQL editor text is not persisted

This spec assumes Analytics is a live first-class page under Insights and treats persistence as a continuity upgrade across the full analysis workflow rather than as isolated page-level polish.

---

## 2. Scope

### Goals

- Persist analysis context per user, per project, and per surface across all Insights and Analytics pages.
- Use the existing Studio user-preferences infrastructure so saved filters survive refreshes, revisits, and device changes.
- Restore valid saved state automatically without blocking the first render.
- Keep each surface independent so Dashboard, Analytics, and Billing can remember different time windows and filters.
- Provide an obvious `Reset filters` affordance on filter-rich surfaces.
- Validate and version saved state so stale or malformed values fail back to safe defaults.
- Keep the feature aligned with Studio design-system patterns, semantic color rules, and business-user-friendly copy.

### Non-Goals (Out of Scope)

- A single global date range shared across all Insights and Analytics pages
- Persistence for transient UI state such as pagination, expanded cards, selected rows, selected sessions, selected traces, open drawers, or open dialogs
- Persistence for `Query` SQL editor text or ad hoc query drafts
- Saved views, named presets, or shareable filter URLs
- A visual redesign of charts, tables, or page layouts beyond the small UX affordances needed for persistence
- New runtime analytics, trace, or billing APIs beyond extending the existing Studio user-preferences contract

---

## 3. User Stories

1. As a **project manager**, I want Dashboard to reopen with the same date range and tab I used last time so that I can continue the same review without rebuilding context.
2. As an **operations lead**, I want Analytics to remember the tab, explorer filters, and search terms I was using so that I can resume investigation after leaving the page.
3. As a **quality analyst**, I want Quality Monitor to remember my score and dimension filters so that repeated triage sessions start from the same working set.
4. As a **finance or operations owner**, I want Billing & Usage to remember my date range so that I can compare usage without reselecting the period every visit.
5. As a **customer insights lead**, I want Customer Insights and Voice Analytics to reopen on the same time window I last reviewed so that trend analysis feels continuous.
6. As a **business user**, I want the product to restore my filters quietly and offer a simple `Reset filters` action when needed so that persistence feels helpful instead of sticky or technical.
7. As a **returning user on another device**, I want my last analysis context to follow me so that I can continue work from a laptop, desktop, or shared workstation.

---

## 4. Functional Requirements

1. **FR-1**: The system must persist Insights and Analytics filter state per `userId + tenantId + projectId + surfaceKey`, and the saved state for one project must never be reused for another project.
2. **FR-2**: The system must extend the existing Studio user-preferences flow with one versioned `insightsAnalyticsFilters` payload and use local cache plus background server sync rather than page-specific one-off `localStorage` keys.
3. **FR-3**: The system must restore saved state automatically on page revisit or browser refresh when the saved values remain valid, and must fall back to page defaults when saved values are missing, invalid, or incompatible with the current schema version.
4. **FR-4**: The system must expose a `Reset filters` action on surfaces with more than one persistent control, and that action must clear the saved state for the current surface only.
5. **FR-5**: The system must persist the Dashboard / At a Glance surface state: `dateRange`, `activeTab`, and `conversationFilter`.
6. **FR-6**: The system must persist Analytics page shell state: `dateRangeMode`, quick range or custom range values, and `activeTab`.
7. **FR-7**: The system must persist Analytics `Sessions Explorer` state: `statusFilter`, `search`, `channelFilter`, `environmentFilter`, and advanced `filters`.
8. **FR-8**: The system must persist Analytics `Traces Explorer` state: `activeSubTab`, `typeFilter`, `searchQuery`, and advanced `filterRows`.
9. **FR-9**: The system must persist Analytics `Generations` state: `searchQuery` and advanced `filterRows`.
10. **FR-10**: The system must persist Billing & Usage state: `dateRange`.
11. **FR-11**: The system must persist Agent Performance state: `dateRange`, `compareEnabled`, `search`, and `statusFilter`.
12. **FR-12**: The system must persist Quality Monitor state: `dateRange`, `dimensionFilter`, and `scoreFilter`.
13. **FR-13**: The system must persist Customer Insights state: `dateRange`.
14. **FR-14**: The system must persist Voice Analytics state: `dateRange`.
15. **FR-15**: The system must not persist pagination, expanded cards or rows, selected sessions, selected traces, timeline or detail presentation mode toggles, open drawers or dialogs, column-customizer state, ROI settings, or raw SQL editor text.
16. **FR-16**: The system must debounce write operations and search-term persistence so that preference saves do not create excessive rerenders or chatty network traffic.
17. **FR-17**: The system must fail open when local cache hydration or server preference sync fails: the page must remain usable with default filters and existing analytics data fetches must continue to work.
18. **FR-18**: The system must keep the restored state understandable through the existing control values and business-friendly labels, without adding a separate "restored" banner or relying on color alone to communicate active state.

> Preference writes are part of the UX contract, but the authoritative behavior is still page-specific. Each page owns its defaults, valid enum values, and fallback behavior.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                  |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | State is partitioned by project and improves continuity while moving between project-level surfaces.   |
| Agent lifecycle            | NONE         | No compile, deployment, or runtime agent behavior changes.                                             |
| Customer experience        | PRIMARY      | The main value is a calmer, faster operator experience for business users reviewing analytics.         |
| Integrations / channels    | NONE         | No channel- or connector-specific runtime behavior changes.                                            |
| Observability / tracing    | SECONDARY    | Analytics explorers and trace surfaces gain continuity, but trace generation/storage is unchanged.     |
| Governance / controls      | SECONDARY    | Saved state needs clear ownership, reset behavior, and strict validation to avoid cross-surface drift. |
| Enterprise / compliance    | SECONDARY    | Preferences remain user-scoped and tenant-scoped, and must not leak project or user context.           |
| Admin / operator workflows | PRIMARY      | Persistent filters primarily benefit repeated Studio investigation and reporting workflows.            |

### Related Feature Integration Matrix

| Related Feature                                                    | Relationship Type | Why It Matters                                                                                                  | Key Touchpoints                                                                          | Current State      |
| ------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| [Analytics Insights Dashboard](../analytics-insights-dashboard.md) | extends           | Dashboard, Analytics, Agent Performance, Quality Monitor, and Customer Insights are core surfaces.              | Insights navigation, page shell routing, date ranges, tabs, filters, and search          | Active integration |
| [Billing & Usage](../billing.md)                                   | extends           | Billing sits in the same Insights workflow and already uses a date-range control that should persist.           | `ProjectBillingPage`, billing period controls, usage charts                              | Active integration |
| [Voice Analytics](../voice-analytics.md)                           | extends           | Voice Analytics should match the same per-project date-memory behavior as other Insights pages.                 | `VoiceAnalyticsPage`, time-window selection                                              | Active integration |
| [Tracing & Observability](../tracing-observability.md)             | shares data with  | Sessions Explorer and Traces Explorer are operator observability surfaces whose context should restore cleanly. | `AnalyticsPage`, `SessionsExplorerTab`, `TracesExplorerTab`, trace/session drill-down UI | Active integration |

---

## 6. Design Considerations

### Design Goals

- **Quiet and predictable**: Persistence should feel invisible. Returning to a page should simply show the same analysis context in the controls, with no restoration banner or tutorial state.
- **Business-user-first**: The feature should reduce repeated setup work without making the UI feel more technical. Advanced controls remain behind `Filters`; core page language stays simple and outcome-oriented.
- **One design language, different density**: Executive Insights pages stay calm and spacious. Analytics stays denser and more exploration-oriented. Both still use the same shell, spacing, control treatments, and empty-state language.
- **Per-surface memory, not surprising coupling**: Dashboard can remember `30d` while Analytics remembers `24h`. Billing can remember the current usage view without overwriting a trace investigator's explorer context.
- **Performance is part of the UX**: The saved state should appear immediately from local cache and server sync should happen in the background without delaying charts or tables.

### UX Rules

- **Auto-restore by default**: If a user revisits the same surface in the same project, the last valid saved state should load automatically.
- **Visible escape hatch**: Multi-filter surfaces such as Dashboard, Analytics, Agent Performance, and Quality Monitor should provide `Reset filters`.
- **Simple pages stay simple**: Single-control pages such as Customer Insights and Voice Analytics do not need extra affordances beyond the restored date picker or segmented control.
- **No persistence banner**: The controls are already the explanation. Showing a banner for normal restore behavior would add noise and make the feature feel heavier than it is.
- **No cross-surface global time range**: Analytics uses operational windows like `30m`, `1h`, and `24h`; the rest of Insights is more likely to use `7d`, `30d`, or billing-period-oriented views.

### Final UX Adoption

The final UX reference is [docs/specs/persistent-insights-analytics-filters.ux.md](../../specs/persistent-insights-analytics-filters.ux.md). That document is the source of truth for:

- density-tier classification across Insights and Analytics surfaces
- `Reset filters` placement and count-badge behavior
- unified active-filter strip behavior on operator-dense surfaces
- individual chip-dismiss semantics
- accessibility copy and live-region behavior
- graceful degradation and invalid-saved-state fallback behavior

The three UX tiers are:

- **Tier 1: Single control** — Billing & Usage, Customer Insights, Voice Analytics. No new UI beyond silent control restoration.
- **Tier 2: Executive multi-control** — Dashboard / At a Glance, Agent Performance, Quality Monitor. PageHeader-level `Reset filters` button only when non-default state exists.
- **Tier 3: Operator dense** — Analytics shell, Sessions Explorer, Traces Explorer, Generations. Toolbar or header-level `Reset filters` plus unified active-filter strip where page-level and advanced filters coexist.

### Design-System Expectations

- Reuse existing Studio building blocks such as KPI cards, chart wrappers, empty states, chip filters, and advanced filter panels instead of introducing a second visual language for persistence.
- Keep strong saturation reserved for semantic states only: `success`, `warning`, `error`, selected `accent`, and subdued `muted` backgrounds.
- Do not rely on color alone to explain an active filter, selection, or health state; pair color with label text, badge text, or iconography.
- Keep categorical charts restrained. Prefer a focused highlighted series or an `Other` bucket over rainbow palettes when the goal is business readability.

### Performance Expectations

- Hydrate from local cache first.
- Debounce persistence for search and filter typing.
- Save only compact filter objects.
- Do not persist noisy state that would increase payload size or trigger unnecessary rerenders.

---

## 7. Technical Considerations

- Extend the existing user-preferences seam in Studio instead of adding page-specific `localStorage` helpers. The relevant path is the existing `preferences-store` client cache, the `api/preferences.ts` client, the Studio `/api/user/preferences` route, and the `user_preferences` database model.
- Treat the saved state as one versioned preference payload (`insightsAnalyticsFilters`) with per-project and per-surface nesting.
- Keep `ColumnCustomizer` persistence separate. Column visibility and ordering are already independently stored and should not be merged into this feature.
- Keep At a Glance ROI inputs on their current local-only path. Those settings behave more like local scenario inputs than reusable analysis filters.
- Add a shared adapter hook or helper for hydrate / validate / persist / reset so every page does not reimplement debouncing and schema fallback logic.
- Use strict validation on the Studio preference PATCH route and avoid reading the request body twice after validation. The route must explicitly scope all queries with `userId` and `tenantId` because Studio route handlers do not get tenant scoping from AsyncLocalStorage.
- Fail open: if the saved payload is malformed or the save request fails, page defaults continue to work and analytics data routes remain unaffected.
- Prefer lazy pruning of empty project entries and invalid surface blobs so the preference document remains compact over time.

---

## 8. How to Consume

### Studio UI

The feature is consumed passively. Users do not "turn on" persistence; they simply use the existing controls and the product remembers the last valid state.

| Surface                       | Route                                    | Persistent State                                                                 | `Reset filters` |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| Dashboard / At a Glance       | `/projects/:projectId/dashboard`         | `dateRange`, `activeTab`, `conversationFilter`                                   | Yes             |
| Analytics (page shell)        | `/projects/:projectId/analytics`         | date-range mode, quick/custom range values, `activeTab`                          | Yes             |
| Analytics / Sessions Explorer | `/projects/:projectId/analytics`         | `statusFilter`, `search`, `channelFilter`, `environmentFilter`, advanced filters | Yes             |
| Analytics / Traces Explorer   | `/projects/:projectId/analytics`         | `activeSubTab`, `typeFilter`, `searchQuery`, advanced filter rows                | Yes             |
| Analytics / Generations       | `/projects/:projectId/analytics`         | `searchQuery`, advanced filter rows                                              | Yes             |
| Billing & Usage               | `/projects/:projectId/billing`           | `dateRange`                                                                      | No              |
| Agent Performance             | `/projects/:projectId/agent-performance` | `dateRange`, `compareEnabled`, `search`, `statusFilter`                          | Yes             |
| Quality Monitor               | `/projects/:projectId/quality-monitor`   | `dateRange`, `dimensionFilter`, `scoreFilter`                                    | Yes             |
| Customer Insights             | `/projects/:projectId/customer-insights` | `dateRange`                                                                      | No              |
| Voice Analytics               | `/projects/:projectId/voice-analytics`   | `dateRange`                                                                      | No              |

The Analytics `Query` tab inherits only the page-shell state. Raw SQL text, examples/help panel visibility, and copy state remain ephemeral in Phase 1.

Tier-specific UX behavior follows the final UX spec:

- Tier 1 surfaces add no extra reset or chip UI.
- Tier 2 surfaces expose only the `Reset filters` ghost button with a count badge.
- Tier 3 explorer surfaces use `Reset filters` plus a unified active-filter strip for dismissible page-level and advanced filter chips.

### Surface Semantics Matrix

| Asset / Entity Type           | Source of Truth / Ownership                               | Design-Time Surface(s)                  | Editable or Read-Only? | Consumer Reference / Binding Model                                              | Runtime Materialization / Resolution                            | Notes / Unsupported State                                                                             |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `insightsAnalyticsFilters`    | `user_preferences` record for the authenticated user      | All Studio Insights and Analytics pages | Editable               | Resolved by `projectId` + `surfaceKey`; pages map local UI state into that slot | Used only to initialize and update Studio control values        | Not shared between users, tenants, or projects                                                        |
| Local preference cache        | Browser cache owned by Studio preferences store           | Same as above                           | Editable               | Mirrors the last successfully known payload for fast initial hydration          | Hydrates controls before or alongside background server sync    | Corrupt cache must be ignored and replaced with defaults                                              |
| Advanced filter builder state | Surface-specific subset inside `insightsAnalyticsFilters` | Analytics explorers, Quality Monitor    | Editable               | Stored as validated arrays of filter rows or filter objects                     | Replayed into existing filter-builder controls and query params | Unsupported operators or stale fields must be dropped during validation                               |
| Transient explorer UI state   | In-memory page state only                                 | Analytics explorers                     | Editable               | Not written into the shared preference payload                                  | Resets normally on reload or revisit                            | Selected sessions, selected traces, presentation-mode toggles, drawers, and pagination stay ephemeral |

### Design-Time vs Runtime Behavior

These preferences live entirely in the Studio control plane. They change which existing analytics, trace, and billing requests are sent from the UI, but they do not alter deployed agent configuration, runtime sessions, trace emission, or billing materialization.

The expected lifecycle is:

1. Studio loads the page and hydrates the last known local preference snapshot.
2. The page validates and applies the saved state for the current `projectId` and `surfaceKey`.
3. Studio reconciles with the server-backed preference record in the background.
4. User edits update local state immediately and persist asynchronously.

Phase 1 uses last-write-wins semantics. A newer save from another tab or device is picked up on the next mount or revisit; it does not interrupt an active in-page editing session.

### API (Runtime)

No new runtime APIs are required. Existing analytics, trace, and billing routes continue to work as-is; the restored preferences only influence the request parameters Studio sends to them.

### API (Studio)

| Method | Path                    | Purpose                                                                                      |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/user/preferences` | Return the current user preference record, including `insightsAnalyticsFilters` when present |
| PATCH  | `/api/user/preferences` | Persist, update, or clear validated `insightsAnalyticsFilters` entries                       |

### Admin Portal

No dedicated Admin portal behavior. The feature is scoped to authenticated Studio users working within their own tenant and project context.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is not channel-aware. It does not change SDK payloads, voice runtime behavior, A2A behavior, or MCP traffic. `Voice Analytics` participates only as a Studio page that benefits from the same date-range persistence contract.

---

## 9. Data Model

### Collections / Tables

No new collection is required. The feature extends the existing `user_preferences` record.

```text
Collection: user_preferences
Fields:
  - _id: ObjectId
  - userId: string (required, indexed)
  - tenantId: string (required, indexed)
  - pinnedProjectIds: string[] (existing)
  - insightsAnalyticsFilters: object (optional)
      - version: 1
      - byProject: Record<string, object>
          - <projectId>.atAGlance:
              - dateRange: string
              - activeTab: string
              - conversationFilter: string
          - <projectId>.analyticsPage:
              - dateRangeMode: 'quick' | 'custom'
              - quickRange: string
              - customFrom: string
              - customTo: string
              - activeTab: string
          - <projectId>.analyticsSessions:
              - statusFilter: string
              - search: string
              - channelFilter: string
              - environmentFilter: string
              - filters: filter[]
          - <projectId>.analyticsTraces:
              - activeSubTab: string
              - typeFilter: string
              - searchQuery: string
              - filterRows: filterRow[]
          - <projectId>.analyticsGenerations:
              - searchQuery: string
              - filterRows: filterRow[]
          - <projectId>.billingUsage:
              - dateRange: string
          - <projectId>.agentPerformance:
              - dateRange: string
              - compareEnabled: boolean
              - search: string
              - statusFilter: string
          - <projectId>.qualityMonitor:
              - dateRange: string
              - dimensionFilter: string
              - scoreFilter: string
          - <projectId>.customerInsights:
              - dateRange: string
          - <projectId>.voiceAnalytics:
              - dateRange: string
Indexes:
  - { userId: 1, tenantId: 1 } (existing)
  - { tenantId: 1 } (existing)
```

### Key Relationships

- One `user_preferences` record owns all durable filter memory for a user within a tenant.
- Each project gets its own nested map so filters never bleed across projects.
- Each surface owns its own sub-object so pages remain independent even within the same project.
- `ColumnCustomizer` state and At a Glance ROI inputs remain outside this model and keep using their existing local-only storage.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/studio/src/store/preferences-store.ts`                    | Extend client-side preference cache, hydration, merge, and debounced save behavior |
| `apps/studio/src/api/preferences.ts`                            | Extend Studio preference types and GET/PATCH client helpers                        |
| `apps/studio/src/lib/preferences/insights-analytics-filters.ts` | Shared surface defaults, validation, and descriptor logic                          |
| `apps/studio/src/hooks/usePersistedSurfaceFilters.ts`           | **New** shared helper for hydrate, validate, persist, and reset per surface        |
| `packages/database/src/models/user-preferences.model.ts`        | Extend durable user preference schema with `insightsAnalyticsFilters`              |

### Routes / Handlers

| File                                                | Purpose                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/app/api/user/preferences/route.ts` | Read and persist validated `insightsAnalyticsFilters` payloads with explicit `userId` and `tenantId` scoping |

### UI Components

| File                                                                | Purpose                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/studio/src/components/shared/ResetFiltersButton.tsx`          | Tier 2 and Tier 3 reset affordance with count badge and live-region announcement |
| `apps/studio/src/components/shared/FilterChip.tsx`                  | Shared dismissible filter chip primitive for muted and accent variants           |
| `apps/studio/src/components/shared/ActiveFiltersStrip.tsx`          | Tier 3 unified active-filter strip for page-level and advanced filters           |
| `apps/studio/src/components/insights/AtAGlancePage.tsx`             | Persist Dashboard filters and surface-specific reset behavior                    |
| `apps/studio/src/components/analytics/AnalyticsPage.tsx`            | Persist Analytics page shell state and tab selection                             |
| `apps/studio/src/components/analytics/SessionsExplorerTab.tsx`      | Persist sessions explorer search, chips, and advanced filters                    |
| `apps/studio/src/components/analytics/TracesExplorerTab.tsx`        | Persist traces and generations filter state while keeping selections ephemeral   |
| `apps/studio/src/components/projects/ProjectBillingPage.tsx`        | Persist billing date range                                                       |
| `apps/studio/src/components/insights/AgentPerformancePage.tsx`      | Persist compare, search, and status filters                                      |
| `apps/studio/src/components/insights/QualityMonitorPage.tsx`        | Persist quality score and dimension filters                                      |
| `apps/studio/src/components/insights/CustomerInsightsPage.tsx`      | Persist customer-insights date range                                             |
| `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` | Persist voice-analytics date range                                               |
| `apps/studio/src/components/shared/AdvancedFilterPanel.tsx`         | Reuse existing advanced-filter UI with restored rows                             |

### Jobs / Workers / Background Processes

| File | Purpose                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| N/A  | No new background worker is required; server sync rides on the existing Studio preferences flow. |

### Tests

| File                                                                         | Type        | Coverage Focus                                                                |
| ---------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `apps/studio/src/hooks/__tests__/usePersistedSurfaceFilters.test.ts`         | unit        | Hydration, validation, debounce, and reset behavior                           |
| `apps/studio/src/app/api/user/preferences/__tests__/route.test.ts`           | integration | GET/PATCH validation, tenant/user isolation, and payload merge                |
| `apps/studio/src/components/insights/__tests__/persistent-filters.test.tsx`  | unit        | Dashboard, Billing, Agent Performance, Quality, Customer, and Voice mappings  |
| `apps/studio/src/components/analytics/__tests__/persistent-filters.test.tsx` | unit        | Analytics shell, Sessions Explorer, Traces Explorer, and Generations mappings |
| `apps/studio/e2e/insights/persistent-filters.spec.ts`                        | e2e         | Refresh, revisit, reset, project isolation, and cross-device restore          |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                |
| -------- | ------- | ------------------------------------------ |
| None     | —       | No new environment variables are required. |

### Runtime Configuration

- No new runtime feature flag is required for Phase 1.
- The client save debounce interval should be a local Studio constant, not a tenant-facing setting.
- Reset behavior is surface-scoped and uses page defaults already defined by each page.

### DSL / Agent IR / Schema

N/A for DSL and Agent IR. The only new schema is the Studio-side validated preference payload shape for `insightsAnalyticsFilters`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every project-scoped preference read/write must resolve only the current `projectId`, and state from another project must never appear. |
| Tenant isolation  | Studio preference routes must query `user_preferences` with explicit `tenantId` filtering. Cross-tenant access must not be possible.    |
| User isolation    | Preference payloads are user-owned. Users must only read and update their own preference record.                                        |

### Security & Compliance

- Preference payloads must not contain secrets, session transcripts, raw SQL drafts, or identifiers that materially increase data sensitivity.
- Studio preference PATCH validation should be strict and should strip unknown keys rather than storing arbitrary JSON blobs.
- Because Studio route handlers do not inherit tenant scoping automatically, the user-preferences route must always scope queries explicitly with the authenticated `userId` and `tenantId`.
- The feature does not change encryption or secret-management requirements because it stores only UI state and search/filter text.

### Performance & Scalability

- Local hydration should occur fast enough that controls appear populated before users begin interacting with the page.
- Preference saves must be debounced and batched through the existing store flow so search typing does not generate one network request per keystroke.
- The payload should remain compact by storing only intentional analysis context and pruning empty project or surface entries.
- Existing lazy-loaded chart and explorer surfaces should remain lazy-loaded; persistence must not force eager loading of heavy components.

### Reliability & Failure Modes

- If the preference GET request fails, the page must continue with defaults.
- If the preference PATCH request fails, the current page state must still work locally and the next successful save should heal the server record.
- If cached data is malformed, the client must discard it and return to page defaults instead of crashing the page or blocking data fetches.
- Last-write-wins is acceptable for Phase 1. Multi-tab conflict resolution beyond that is deferred.

### Observability

- Studio should log or instrument preference load/save failures and validation fallbacks so broken persistence is diagnosable.
- Preference-save latency and failure rates should be observable through existing frontend or route-level telemetry.
- No new trace events are required; the feature improves the UX of trace consumption rather than trace production.

### Data Lifecycle

- Preference data lives as long as the user preference record lives.
- Clearing a surface or using `Reset filters` removes only the relevant nested state, not the whole record.
- Orphaned per-project entries should be pruned lazily when discovered empty or invalid.

---

## 13. Delivery Plan / Work Breakdown

Use parent tasks with numbered subtasks so execution can be tracked clearly.

1. Preference substrate
   1.1 Extend the Studio preference types, route validation, and database model with `insightsAnalyticsFilters`.
   1.2 Add local-cache hydration, background reconciliation, and debounced save support.
   1.3 Add per-surface reset helpers and invalid-payload fallback behavior.
2. Surface integration
   2.1 Wire Dashboard, Billing & Usage, Agent Performance, Quality Monitor, Customer Insights, and Voice Analytics into the shared persistence helper.
   2.2 Wire Analytics page shell, Sessions Explorer, Traces Explorer, and Generations into the same helper.
   2.3 Keep Query SQL text, selected rows, detail panes, and other transient state explicitly ephemeral.
3. UX and design-system polish
   3.1 Add `Reset filters` affordances only where the surface complexity justifies them.
   3.2 Confirm semantic color use, accessible active-state cues, and simple business-facing labels.
   3.3 Validate that restore behavior feels instant and does not introduce loading noise.
4. Validation and rollout
   4.1 Add unit, integration, and E2E coverage for restore, reset, project isolation, and invalid-state fallback.
   4.2 Run manual UX review across executive and operational surfaces.
   4.3 Roll out without changing analytics or billing data APIs.

---

## 14. Success Metrics

| Metric                                                                                | Baseline                   | Target                                                     | How Measured                                |
| ------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Repeat visits that require manual filter re-entry before first meaningful interaction | High; no persistence today | <25% of repeat visits                                      | Studio usage telemetry or targeted UX study |
| Preference hydration latency                                                          | No explicit SLO today      | P95 local hydration <100ms                                 | Frontend timing instrumentation             |
| Preference save reliability                                                           | No feature today           | >99% successful persisted saves or graceful local fallback | Route telemetry and error logs              |
| Reset-filter usage on persisted revisits                                              | No reset action today      | <10% of revisits after stabilization                       | Click telemetry on `Reset filters`          |

---

## 15. Open Questions

1. Should Phase 1 cap the number of per-project filter maps retained in `insightsAnalyticsFilters`, and if so what is the retention limit?
2. Should Billing & Usage stay in the first rollout if its date semantics later move closer to billing-period presets than generic quick ranges?
3. Do we want Phase 2 to introduce named saved views or shared links, and should the preference schema reserve an extension point for that now?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                        | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | Phase 1 does not support named presets, shared links, or reusable saved views.                                     | Medium   | Open   |
| GAP-002 | Query editor text is intentionally excluded, so SQL-heavy users still restart drafts manually.                     | Low      | Open   |
| GAP-003 | Multi-tab and multi-device conflicts use last-write-wins only; there is no live merge or in-session update prompt. | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                      | Coverage Type      | Status     | Test File / Note                                     |
| --- | ----------------------------------------------------------------------------- | ------------------ | ---------- | ---------------------------------------------------- |
| 1   | Dashboard restore and reset flow                                              | e2e                | NOT TESTED | Add Studio E2E coverage for refresh/revisit          |
| 2   | Analytics page shell restore plus Sessions Explorer persistence               | e2e                | NOT TESTED | Must verify selected session stays ephemeral         |
| 3   | Traces Explorer and Generations restore plus reset flow                       | e2e                | NOT TESTED | Must verify selected trace stays ephemeral           |
| 4   | Billing, Agent Performance, Quality, Customer, and Voice surface mapping      | unit / e2e         | NOT TESTED | Add page-level serializer tests and a smoke E2E pass |
| 5   | User + tenant + project isolation on preference routes                        | integration        | NOT TESTED | Extend user-preferences route coverage               |
| 6   | Invalid payload fallback and unknown-key stripping                            | unit / integration | NOT TESTED | Validate strict schema and fail-open behavior        |
| 7   | Debounced save behavior and local-cache hydration                             | unit               | NOT TESTED | Shared helper coverage                               |
| 8   | Manual UX review for business readability, color semantics, and accessibility | manual             | NOT TESTED | Validate restored filters across multiple surfaces   |

### Testing Notes

There is no shared persistence coverage today for Insights and Analytics filters. Existing coverage around preferences is limited to unrelated user settings, and existing page tests do not prove refresh, revisit, reset, or cross-project restoration behavior.

> Full testing details: [../../testing/sub-features/persistent-insights-analytics-filters.md](../../testing/sub-features/persistent-insights-analytics-filters.md)

---

## 18. References

- Parent docs: [Analytics Insights Dashboard](../analytics-insights-dashboard.md), [Billing & Usage](../billing.md), [Tracing & Observability](../tracing-observability.md), [Voice Analytics](../voice-analytics.md)
- Final UX doc: [docs/specs/persistent-insights-analytics-filters.ux.md](../../specs/persistent-insights-analytics-filters.ux.md)
- Related testing docs: [docs/testing/analytics-insights-dashboard.md](../../testing/analytics-insights-dashboard.md), [docs/testing/billing.md](../../testing/billing.md)
- Expected future design docs: `docs/specs/persistent-insights-analytics-filters.hld.md`, `docs/plans/2026-04-22-persistent-insights-analytics-filters-impl-plan.md`
