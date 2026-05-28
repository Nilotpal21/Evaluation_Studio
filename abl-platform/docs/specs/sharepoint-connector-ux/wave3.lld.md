# SharePoint Connector UX -- Wave 3 LLD (Monitoring)

**HLD Reference:** sharepoint-connector-ux.hld.md
**Wave:** 3 of 4 -- Monitoring (Overview, Sync Progress, Notifications, Permissions, Error/Empty States)
**Tasks:** T-26 to T-37
**Builds on:** Wave 1 foundation (useConnector, useConnectorSync, useConnectorStore, SharePointDetailPanel, TypeToConfirmInput), Wave 2 setup flow (ConnectTab, ProposalTab, ScopeFiltersSplitPane, PreviewTab)

---

## Task T-26: Create Overview Tab (KPIs, Config Summary, Sync History)

### Problem

The Overview tab is the default landing view for existing (non-draft) connectors. It replaces the old `ConnectorDetailPanel.tsx` (765 lines) that was identified for replacement in the HLD. The tab must show progressively-loaded sections: KPIs and config summary first (<500ms), content breakdown next (1-2s), sync history last (1-3s). Each section renders independently with skeleton placeholders.

The existing `SharePointDetailPanel.tsx` (Wave 1 T-10) currently renders placeholder text for the `overview` tab case (line ~170 area). This task replaces that placeholder with the real component.

The existing `useConnector` hook at `apps/studio/src/hooks/useConnector.ts` (line 10-77) provides connector detail including `syncState`, `permissionConfig`, and `errorState`, which powers the KPIs. The content breakdown and sync history require new SWR hooks that call the new backend routes from T-28.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line ~170 area) -- Replace overview placeholder with `<OverviewTab>` import and render

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/OverviewTab.tsx` -- Main Overview tab component
- `apps/studio/src/components/search-ai/sharepoint/ContentBreakdown.tsx` -- By-type bar chart + by-site list
- `apps/studio/src/components/search-ai/sharepoint/ConfigSummary.tsx` -- Collapsed config summary with action links
- `apps/studio/src/components/search-ai/sharepoint/SyncHistoryTable.tsx` -- Paginated sync history table
- `apps/studio/src/components/search-ai/sharepoint/ContentFreshnessWarning.tsx` -- Conditional freshness warning
- `apps/studio/src/components/search-ai/sharepoint/QuickActionsBar.tsx` -- Action buttons bar
- `apps/studio/src/hooks/useConnectorOverview.ts` -- SWR hook for overview KPI data
- `apps/studio/src/hooks/useContentBreakdown.ts` -- SWR hook for content breakdown aggregation
- `apps/studio/src/hooks/useSyncHistory.ts` -- SWR hook for paginated sync history

### Component Interfaces

```tsx
// OverviewTab.tsx

interface OverviewTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToTab: (tab: ConnectorTab) => void;
  onRefresh: () => void;
}

// Orchestrates all overview sections with progressive loading.
// Uses useConnector(indexId, connectorId) for KPI data (fast load).
// Uses useContentBreakdown(indexId, connectorId) for type/site aggregation.
// Uses useSyncHistory(indexId, connectorId) for sync history table.
// Detects active sync (syncState.syncInProgress === true) and renders
// SyncProgressView (T-27) instead of overview content.
```

```tsx
// ContentBreakdown.tsx

interface ContentBreakdownProps {
  indexId: string;
  connectorId: string;
}

// Renders horizontal bar chart for byType and a site list for bySite.
// Uses useContentBreakdown hook. Shows skeleton while loading.
// For byType: top 5 types + "Other" grouping when >5 types.
// For bySite: scrollable list, truncated at 10 with "Show all N sites".
```

```tsx
// ConfigSummary.tsx

interface ConfigSummaryProps {
  connector: ConnectorDetail;
  onEditConfig: () => void;
  onViewFullConfig: () => void;
}

// Read-only summary of scope, filters, schedule, permissions.
// [View Full Configuration] calls onViewFullConfig (navigates to scope-filters tab).
// [Edit Configuration] calls onEditConfig (same navigation with edit mode).
```

```tsx
// SyncHistoryTable.tsx

interface SyncHistoryTableProps {
  indexId: string;
  connectorId: string;
}

// Uses useSyncHistory hook with pagination.
// Columns: Date, Type (Full/Delta), Docs (+added, -removed, ~modified),
//          Duration, Status (Done/Failed/Cancelled with Badge).
// Uses DataTable<SyncHistoryEntry> from '../../ui/DataTable'.
```

```tsx
// ContentFreshnessWarning.tsx

interface ContentFreshnessWarningProps {
  lastSuccessfulSync: string | null;
  recentFailedAttempts: number;
  scheduledInterval: string | null;
  onSyncNow: () => void;
  onViewHistory: () => void;
}

// Conditionally rendered when lastSuccessfulSync is 3+ days ago.
// Shows warning banner with time since last sync, failed attempt count,
// and [Sync Now] + [View Sync History] actions.
```

```tsx
// QuickActionsBar.tsx

interface QuickActionsBarProps {
  connectorId: string;
  indexId: string;
  isPaused: boolean;
  syncInProgress: boolean;
  onSyncNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onEditConfig: () => void;
  onReAuth: () => void;
  onHealthCheck: () => void;
  onSearchDocuments: () => void;
}

// Renders: [Sync Now], [Pause] or [Resume], [Edit Configuration],
// [Re-auth], [Health Check], [Search Documents], [Configure Alerts].
// Uses Button from '../../ui/Button' with ghost/secondary variants.
```

### SWR Hook Signatures

```ts
// useConnectorOverview.ts

interface OverviewData {
  connectorName: string;
  status: 'healthy' | 'syncing' | 'error' | 'paused' | 'disconnected';
  connectedDate: string;
  authenticatedBy: string;
  totalDocuments: number;
  totalSize: number;
  siteCount: number;
  libraryCount: number;
  configSummary: {
    scope: string;
    filters: string;
    schedule: string;
    permissionMode: string;
  };
  contentFreshness: {
    lastSuccessfulSync: string | null;
    scheduledInterval: string | null;
    recentFailedAttempts: number;
  };
  permissionSync: {
    permissionMode: string;
    lastCrawled: string | null;
    coverageTotal: number;
    coverageMapped: number;
    stalenessWarning: boolean;
    nextCrawl: string | null;
  };
}

interface UseConnectorOverviewReturn {
  overview: OverviewData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorOverview(
  indexId: string | null,
  connectorId: string | null,
): UseConnectorOverviewReturn;
// SWR key: indexId && connectorId
//   ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/overview`
//   : null
// Note: Studio SWR keys use `/api/search-ai/` prefix. The Studio dev proxy
// maps this to the search-ai service at `/api/`. This matches the existing
// pattern in useConnector.ts (line 65). The backend mounts routes under
// `/api/indexes`, so `/api/search-ai/indexes/...` -> `/api/indexes/...`.
```

```ts
// useContentBreakdown.ts

interface ContentBreakdownData {
  byType: Array<{ type: string; count: number; percentage: number }>;
  bySite: Array<{ siteName: string; docCount: number; size: number }>;
}

interface UseContentBreakdownReturn {
  breakdown: ContentBreakdownData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useContentBreakdown(
  indexId: string | null,
  connectorId: string | null,
): UseContentBreakdownReturn;
// SWR key: indexId && connectorId
//   ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content-breakdown`
//   : null
```

```ts
// useSyncHistory.ts

interface SyncHistoryEntry {
  date: string;
  type: 'full' | 'delta';
  docsAdded: number;
  docsRemoved: number;
  docsModified: number;
  duration: number; // seconds
  status: 'done' | 'failed' | 'cancelled';
}

interface UseSyncHistoryReturn {
  history: SyncHistoryEntry[];
  total: number;
  page: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
  setPage: (page: number) => void;
}

export function useSyncHistory(
  indexId: string | null,
  connectorId: string | null,
  options?: { page?: number; limit?: number },
): UseSyncHistoryReturn;
// SWR key: indexId && connectorId
//   ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/sync-history?page=${page}&limit=${limit}`
//   : null
```

### i18n Keys

Namespace: `search_ai.sharepoint.overview` under `packages/i18n/locales/en/studio.json`

Keys:

- `status_healthy`: "Healthy"
- `status_syncing`: "Syncing"
- `status_error`: "Error"
- `status_paused`: "Paused"
- `status_disconnected`: "Disconnected"
- `connected_info`: "Connected {{date}} . Authenticated by {{email}}"
- `kpi_documents`: "documents indexed"
- `kpi_size`: "total size"
- `kpi_sites`: "sites"
- `kpi_libraries`: "document libraries"
- `content_breakdown_title`: "Content Breakdown"
- `by_type`: "By type"
- `by_site`: "By site"
- `other_types`: "Other"
- `show_all_sites`: "Show all {{count}} sites"
- `config_summary_title`: "Configuration Summary"
- `config_scope`: "Scope"
- `config_filters`: "Filters"
- `config_schedule`: "Schedule"
- `config_permissions`: "Permissions"
- `view_full_config`: "View Full Configuration"
- `edit_config`: "Edit Configuration"
- `freshness_warning`: "Content may be stale -- last successful sync was {{days}} days ago."
- `freshness_scheduled`: "Scheduled sync: {{interval}} (last {{count}} attempts failed)"
- `sync_now`: "Sync Now"
- `view_sync_history`: "View Sync History"
- `sync_history_title`: "Sync History"
- `sync_col_date`: "Date"
- `sync_col_type`: "Type"
- `sync_col_docs`: "Docs"
- `sync_col_duration`: "Duration"
- `sync_col_status`: "Status"
- `sync_type_full`: "Full"
- `sync_type_delta`: "Delta"
- `sync_status_done`: "Done"
- `sync_status_failed`: "Failed"
- `sync_status_cancelled`: "Cancelled"
- `issues_title`: "Issues"
- `no_issues`: "No issues."
- `notifications_title`: "Notifications"
- `quick_actions_title`: "Quick Actions"
- `btn_pause`: "Pause"
- `btn_resume`: "Resume"
- `btn_reauth`: "Re-auth"
- `btn_health_check`: "Health Check"
- `btn_search_docs`: "Search Documents"
- `btn_configure_alerts`: "Configure Alerts"
- `source_attribution_note`: "Each search result shows which connector it came from. Not yet populated -- requires backend work."

### Subtasks (execution order)

1. **ST-26.1:** Create `useConnectorOverview.ts` SWR hook. Pattern: same as `useConnector.ts` (line 60-77). SWR key conditional on `indexId && connectorId`. Return `{ overview, isLoading, error, mutate }`. No polling (overview data is static until user action).
2. **ST-26.2:** Create `useContentBreakdown.ts` SWR hook. Same pattern. No polling. Separate hook because this aggregation query is slower (1-2s) and renders independently.
3. **ST-26.3:** Create `useSyncHistory.ts` SWR hook. Accepts `options.page` and `options.limit`. Encodes pagination as query params in the SWR key. Returns `{ history, total, page, isLoading, error, mutate, setPage }`. `setPage` triggers SWR key change via React state.
4. **ST-26.4:** Create `ContentBreakdown.tsx`. Read `Progress` component signature from `apps/studio/src/components/ui/Progress.tsx` (props: `value: number`, `className`, `indicatorClassName`). Use Progress bars for byType percentages. Use a simple list for bySite. Top 5 + "Other" grouping for byType when >5 types. Truncate bySite at 10 with expand toggle.
5. **ST-26.5:** Create `ConfigSummary.tsx`. Renders 4 key-value rows: Scope, Filters, Schedule, Permissions. Two action links: [View Full Configuration] and [Edit Configuration]. Uses `connector.filterConfig`, `connector.permissionConfig` from `useConnector` data.
6. **ST-26.6:** Create `ContentFreshnessWarning.tsx`. Conditionally rendered when `lastSuccessfulSync` is >3 days ago (compare ISO date with `Date.now()`). Shows warning icon, days-ago text, failed attempt count, and two Button actions.
7. **ST-26.7:** Create `SyncHistoryTable.tsx`. Uses `DataTable<SyncHistoryEntry>` from `'../../ui/DataTable'` (props: `columns: Column<T>[]`, `data: T[]`, `keyExtractor`, `emptyMessage`). Define 5 columns. Status column uses `Badge` with variant mapping: `done` -> `success`, `failed` -> `error`, `cancelled` -> `warning`. Duration formatted as human-readable (e.g., "2m 15s"). Docs column shows "+N, -N, ~N" format.
8. **ST-26.8:** Create `QuickActionsBar.tsx`. Renders 7 action buttons in a flex row. Conditional: [Pause] when not paused and sync in progress, [Resume] when paused. [Sync Now] disabled when sync in progress. Uses `Button` from `'../../ui/Button'`.
9. **ST-26.9:** Create `OverviewTab.tsx`. Orchestrates all sub-components. Progressive loading: renders `ConfigSummary` and KPI MetricCards immediately from `useConnector` data. Renders `ContentBreakdown` and `SyncHistoryTable` with their own loading states. Detects `syncState.syncInProgress === true` and renders `SyncProgressView` (T-27, placeholder div until T-27 is complete) instead of overview content. Includes `ContentFreshnessWarning`, Permission Sync Status (T-32, placeholder), Issues section ("No issues" static), Notifications section (T-30, placeholder), and `QuickActionsBar`.
10. **ST-26.10:** Update `SharePointDetailPanel.tsx` to import and render `OverviewTab` for the `overview` tab case. Pass `indexId`, `connectorId`, `onNavigateToTab`, and `onRefresh` props.
11. **ST-26.11:** Add i18n keys to `packages/i18n/locales/en/studio.json` under `search_ai.sharepoint.overview`.
12. **ST-26.12:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Overview tab renders KPI MetricCards (documents, size, sites, libraries) from connector data.
  - Verify: Component test with mocked `useConnectorOverview` returning sample data
  - Expected: 4 MetricCard components rendered with correct values
- AC-02: Content breakdown renders horizontal bars for byType and list for bySite.
  - Verify: Component test with mocked `useContentBreakdown`
  - Expected: Progress bars visible for each type, site names listed
- AC-03: Sync history table renders with 5 columns and status badges.
  - Verify: Component test with mocked `useSyncHistory` returning 4 entries
  - Expected: DataTable with 4 rows, Badge components for status
- AC-04: Content freshness warning appears when last sync is >3 days ago.
  - Verify: Component test with `lastSuccessfulSync` set to 7 days ago
  - Expected: Warning banner visible with "7 days ago" text
- AC-05: Content freshness warning hidden when last sync is <3 days ago.
  - Verify: Component test with `lastSuccessfulSync` set to 1 day ago
  - Expected: Warning banner not rendered
- AC-06: Quick actions bar renders all 7 buttons with correct disabled states.
  - Verify: Component test with `syncInProgress: true`
  - Expected: [Sync Now] disabled, [Pause] visible (not [Resume])
- AC-07: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-10** (SharePointDetailPanel shell) -- OverviewTab renders inside the panel
- **T-08** (SWR hooks foundation) -- uses the SWR fetcher pattern established in Wave 1
- **T-28** (backend overview/content-breakdown/sync-history routes) -- data sources for the new SWR hooks

### Risk Notes

- The Overview tab depends on T-28 backend routes for real data. Until T-28 is complete, the SWR hooks will return errors. This is acceptable for development -- the component should show skeleton/error states gracefully.
- KPI data from `useConnectorOverview` vs `useConnector`: the overview endpoint returns a richer data set (configSummary, contentFreshness, permissionSync). The simpler `useConnector` hook can be used for initial KPI rendering while the overview endpoint loads.
- The "Search Documents" quick action navigates to Data tab > Documents segment with a pre-applied connectorId filter. This navigation depends on the KB detail page's tab routing, which is outside this task's scope. The button should call a callback prop that the parent page handles.

---

## Task T-27: Create Sync Progress View (Overall + Per-Site Bars, Current Doc)

### Problem

When a sync is active (`syncState.syncInProgress === true`), the Overview tab's content is replaced by a real-time sync progress view. This shows overall progress (docs processed/total, size, ETA), the current document being processed, per-site progress bars, and [Pause Sync] / [Stop Sync] action buttons.

The existing `useConnectorSync` hook at `apps/studio/src/hooks/useConnectorSync.ts` (lines 31-60) polls at 5s intervals while sync is active. However, it returns a flat `SyncStatusResponse` that lacks per-site breakdown, current document name/site, and ETA. T-29 enhances the backend to return this data. This task creates the frontend that consumes it.

### Files to Modify

- `apps/studio/src/hooks/useConnectorSync.ts` (lines 11-19) -- Extend `SyncStatusResponse` interface to include per-site progress, current document, ETA, and size data
- `apps/studio/src/components/search-ai/sharepoint/OverviewTab.tsx` (from T-26) -- Integrate `SyncProgressView` rendering when sync is active

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/SyncProgressView.tsx` -- Full sync progress view
- `apps/studio/src/components/search-ai/sharepoint/PerSiteProgressBar.tsx` -- Individual site progress bar component

### Component Interfaces

```tsx
// SyncProgressView.tsx

interface SyncProgressViewProps {
  indexId: string;
  connectorId: string;
  connectorName: string;
  onPause: () => void;
  onStop: () => void;
  onSyncComplete: () => void;
}

// Uses useConnectorSync(connectorId, { pollInterval: 3000 }).
// Shows: sync type header, overall progress bar, current doc indicator,
// per-site progress bars, [Pause Sync] and [Stop Sync] buttons.
// When progress reaches 100%: shows "Sync Complete!" banner for 3s
// then calls onSyncComplete() to transition back to Overview.
```

```tsx
// PerSiteProgressBar.tsx

interface PerSiteProgressBarProps {
  siteName: string;
  percentage: number;
  docsProcessed: number;
  docsTotal: number;
  isComplete: boolean;
}

// Renders: site name, Progress bar, percentage, doc count (e.g., "25% (14/56)").
// When isComplete: green checkmark icon replaces the progress indicator.
```

### Function Signatures (useConnectorSync extension)

**Before (line 11-19):**

```ts
interface SyncStatusResponse {
  status: string;
  progress?: {
    docsProcessed: number;
    docsTotal: number;
    percentage: number;
    currentDocument?: string;
  };
}
```

**After:**

```ts
interface SyncStatusResponse {
  status: string;
  syncType?: 'full' | 'delta';
  isActive: boolean;
  progress?: {
    docsProcessed: number;
    docsTotal: number;
    sizeProcessed?: number;
    sizeTotal?: number;
    percentage: number;
    etaSeconds?: number | null;
    currentDocument?: {
      name: string;
      sourceSite: string;
    };
  };
  perSiteProgress?: Array<{
    siteName: string;
    percentage: number;
    docsProcessed: number;
    docsTotal: number;
  }>;
}
```

### i18n Keys

Namespace: `search_ai.sharepoint.sync_progress` under `packages/i18n/locales/en/studio.json`

Keys:

- `full_sync_title`: "Full Sync in Progress"
- `delta_sync_title`: "Delta Sync in Progress"
- `docs_progress`: "{{processed}} of {{total}} documents"
- `size_progress`: "{{processedSize}} of {{totalSize}}"
- `eta`: "ETA: {{time}}"
- `eta_estimating`: "Estimating..."
- `current_doc`: "Current: Processing \"{{name}}\" from {{site}}"
- `per_site_title`: "Per-site progress"
- `btn_pause_sync`: "Pause Sync"
- `btn_stop_sync`: "Stop Sync"
- `sync_complete`: "Sync Complete!"
- `pause_confirm_title`: "Pause Sync?"
- `pause_confirm_description`: "The sync will stop at the current checkpoint. You can resume later without re-processing completed documents."
- `stop_confirm_title`: "Stop Sync?"
- `stop_confirm_description`: "The sync will be cancelled. Already processed documents are retained. A new sync will start from the beginning."

### Subtasks (execution order)

1. **ST-27.1:** Extend `SyncStatusResponse` in `useConnectorSync.ts` (line 11-19) to include `syncType`, `isActive`, `sizeProcessed`, `sizeTotal`, `etaSeconds`, `currentDocument: { name, sourceSite }`, and `perSiteProgress` array. These are optional fields -- existing callers are not broken.
2. **ST-27.2:** Create `PerSiteProgressBar.tsx`. Uses `Progress` from `'../../ui/Progress'` (props: `value`, `className`, `indicatorClassName`). When `isComplete`, render a green check icon (from lucide-react `Check` or `CheckCircle`) and set `indicatorClassName` to green variant. Format: `"Site Name   ====____  25% (14/56)"`.
3. **ST-27.3:** Create `SyncProgressView.tsx`. Uses `useConnectorSync(connectorId, { pollInterval: 3000 })` for faster updates during active sync. **Note:** `useConnectorSync` uses the old route pattern (`/api/search-ai/connectors/${connectorId}/sync/status` — no `indexId` in path), whereas the new overview/monitoring routes include `indexId` in the path (`/api/search-ai/indexes/${indexId}/connectors/${connectorId}/...`). This is intentional — the sync status endpoint predates the index-scoped route convention. Renders: sync type header, overall Progress bar, size progress line, ETA display, current document indicator, list of `PerSiteProgressBar` components, and action buttons. [Pause Sync] and [Stop Sync] each open a `ConfirmDialog` from `'../../ui/ConfirmDialog'` (props: `open`, `onClose`, `onConfirm`, `title`, `description`, `variant`). On [Pause] confirm: calls `POST /connectors/:id/sync/pause` via API. On [Stop] confirm: calls `POST /connectors/:id/sync/stop`. Sync completion detection: when `progress.percentage === 100` or `status` transitions out of active set, show "Sync Complete!" banner for 3s (via `setTimeout`), then call `onSyncComplete()`.
4. **ST-27.4:** Update `OverviewTab.tsx` to detect `syncState.syncInProgress` and render `SyncProgressView` instead of regular overview content. Pass `onSyncComplete` callback that triggers `mutate()` on all overview SWR hooks and calls parent `onRefresh()`.
5. **ST-27.5:** Add `pauseConnectorSync` and `stopConnectorSync` API functions to `apps/studio/src/api/search-ai.ts` (append after existing connector functions ~line 2218).
6. **ST-27.6:** Add i18n keys to `packages/i18n/locales/en/studio.json` under `search_ai.sharepoint.sync_progress`.
7. **ST-27.7:** Build: `pnpm build --filter=@agent-platform/studio`.

### API Functions (Studio side)

Add to `apps/studio/src/api/search-ai.ts`:

```ts
export async function pauseConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ success: boolean; data: { paused: boolean; reason: string } }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/pause`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(response);
}

export async function stopConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ success: boolean; data: { stopped: boolean; reason: string } }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/stop`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(response);
}
```

### Acceptance Criteria

- AC-01: When `syncState.syncInProgress` is true, SyncProgressView replaces Overview content.
  - Verify: Component test with `syncInProgress: true`
  - Expected: SyncProgressView visible, regular overview sections hidden
- AC-02: Overall progress bar updates from poll data.
  - Verify: Component test advancing poll response from 30% to 50%
  - Expected: Progress bar width increases, doc count updates
- AC-03: Per-site progress bars render for each site in scope.
  - Verify: Component test with 4-site `perSiteProgress` array
  - Expected: 4 PerSiteProgressBar components rendered
- AC-04: [Pause Sync] opens ConfirmDialog before calling API.
  - Verify: Component test clicking [Pause Sync]
  - Expected: ConfirmDialog opens, API not called until confirm
- AC-05: Sync completion shows banner for 3s then transitions to Overview.
  - Verify: Component test with `percentage: 100`
  - Expected: "Sync Complete!" text visible, `onSyncComplete` called after 3s
- AC-06: ETA shows "Estimating..." for first 10% of sync.
  - Verify: Component test with `percentage: 5` and `etaSeconds: null`
  - Expected: "Estimating..." text instead of ETA
- AC-07: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-26** (OverviewTab) -- SyncProgressView renders inside the Overview tab
- **T-29** (backend enhanced sync progress) -- provides per-site data, current document, ETA
- **T-02** (Wave 1, pauseSync fix) -- pause/stop functionality depends on working backend

### Risk Notes

- The 3-second completion banner uses `setTimeout`. If the component unmounts during the timeout (user closes panel), the callback must be cleaned up via `useEffect` cleanup to avoid a React state-update-on-unmounted-component warning.
- Polling at 3s during active sync generates ~20 requests/minute per open panel. If multiple users watch the same connector, the load multiplies. Acceptable for v1; SSE would be better.
- ETA accuracy: the backend may return wildly varying ETAs early in the sync. Show "Estimating..." for the first 10% (check `progress.percentage < 10 || etaSeconds === null`).

---

## Task T-28: Backend: Overview, Content-Breakdown, Sync-History Routes

### Problem

Three new backend endpoints are needed for the Overview tab (T-26):

1. `GET /:indexId/connectors/:connectorId/overview` -- Returns KPIs, config summary, content freshness, permission sync status (<500ms target)
2. `GET /:indexId/connectors/:connectorId/content-breakdown` -- Returns byType and bySite aggregations (1-2s, heavier query)
3. `GET /:indexId/connectors/:connectorId/sync-history` -- Returns paginated sync history entries

The connector detail endpoint at `apps/search-ai/src/routes/connectors.ts` (line 69-79) already returns the full connector document, but it does not include computed fields like content breakdown, sync history, or config summary projections.

The `connector.service.ts` `getSyncStatus()` at line 1145-1174 returns basic sync state but not aggregated history.

### Files to Modify

- `apps/search-ai/src/server.ts` (line ~185) -- Import and mount new connector-monitoring routes
- `apps/search-ai/src/services/connector.service.ts` (after line 1174, after `getSyncStatus`) -- Add overview, contentBreakdown, and syncHistory service functions

### Files to Create

- `apps/search-ai/src/routes/connector-monitoring.ts` -- Express routes for overview, content-breakdown, sync-history
- `apps/search-ai/src/services/connector-monitoring.service.ts` -- Service functions for monitoring data

### Route Signatures

```ts
// connector-monitoring.ts

// Mounted under /api/indexes/:indexId/connectors/:connectorId/
// Auth middleware applied on mount

// GET /:indexId/connectors/:connectorId/overview
// Returns: { success: true, data: OverviewData }

// GET /:indexId/connectors/:connectorId/content-breakdown
// Returns: { success: true, data: { byType: [...], bySite: [...] } }

// GET /:indexId/connectors/:connectorId/sync-history
// Query: ?page=1&limit=20
// Returns: { success: true, data: { history: [...], total: number, page: number, limit: number } }
```

### Zod Validation Schemas

```ts
const monitoringParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const syncHistoryQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
```

### Service Signatures

```ts
// connector-monitoring.service.ts

import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from './connector.service.js';
import * as repo from '../repos/connector.repository.js';
import { getLazyModel } from '../db/index.js';

const logger = createLogger('connector-monitoring-service');

/** Fast overview (<500ms): KPIs, config summary, content freshness, permission sync. */
export async function getOverview(connectorId: string, tenantId: string): Promise<OverviewData>;
// Implementation:
// 1. repo.findConnectorByIdAndTenantLean(connectorId, tenantId) — returns connector doc
// 2. Compute connectorName from connectionConfig.name or source name
// 3. Derive status from syncState + errorState (mapping logic in function body)
// 4. Build configSummary from filterConfig, permissionConfig, connectionConfig
// 5. Build contentFreshness from syncState.lastFullSyncAt, errorState
// 6. Build permissionSync from permissionConfig

/** Content breakdown (1-2s): aggregations by type and site. */
export async function getContentBreakdown(
  connectorId: string,
  tenantId: string,
): Promise<{ byType: TypeBreakdown[]; bySite: SiteBreakdown[] }>;
// Implementation:
// 1. Query indexed documents for this connector using discovery profiles
// 2. Aggregate by file extension -> byType
// 3. Aggregate by site -> bySite
// Uses ConnectorDiscovery model for profiled data

/** Paginated sync history. */
export async function getSyncHistory(
  connectorId: string,
  tenantId: string,
  options: { page: number; limit: number },
): Promise<{
  history: SyncHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}>;
// Implementation:
// 1. Query ConnectorAuditEntry (from Wave 1 T-06) filtered by
//    category: 'sync', connectorId, tenantId
// 2. Map audit entries to SyncHistoryEntry format
// 3. Apply pagination
// Alternative: query BullMQ completed/failed jobs if audit entries
//   don't capture sync history granularly enough
```

### Subtasks (execution order)

1. **ST-28.1:** Create `connector-monitoring.service.ts` with `getOverview()`. Read `connector.repository.ts` to verify `findConnectorByIdAndTenantLean` signature. Compute status: `syncInProgress` -> `'syncing'`, `isPaused` -> `'paused'`, `!oauthTokenId` -> `'disconnected'`, `consecutiveFailures > 0` -> `'error'`, else `'healthy'`. Build config summary strings from filter/permission/connection config.
2. **ST-28.2:** Add `getContentBreakdown()`. Use `ConnectorDiscovery` model (via `getLazyModel('ConnectorDiscovery')`) to find the latest completed discovery for this connector. Aggregate `profiles[].fileTypes` for byType. Aggregate `resources[]` for bySite. If no discovery exists, return empty arrays. Every query includes `tenantId`.
3. **ST-28.3:** Add `getSyncHistory()`. Query `ConnectorAuditEntry` (via `getLazyModel('ConnectorAuditEntry')`) with `{ connectorId, tenantId, category: 'sync' }`, sorted by `timestamp: -1`, with `skip` and `limit` for pagination. Map audit entry metadata to `SyncHistoryEntry` fields. Count total with `countDocuments()`.
4. **ST-28.4:** Create `connector-monitoring.ts` routes file. Follow the `handleError` pattern from `connectors.ts` (lines 23-37) which handles `ConnectorError` with proper status codes (400, 404, etc.): import Router, z, authMiddleware, createLogger. Define a local `handleError` that checks `error instanceof ConnectorError` and returns `error.statusCode`. Define Zod schemas. Three GET routes. Each validates params with Zod, extracts `tenantId` from `req.tenantContext!.tenantId`, calls service, returns `{ success: true, data }`.
5. **ST-28.5:** Mount routes in `server.ts` **before line 202 (before the `// 404 handler` comment)**, after `connectorConfigVersionRouter` (line 185):
   ```ts
   import connectorMonitoringRouter from './routes/connector-monitoring.js';
   app.use('/api/indexes', connectorMonitoringRouter);
   ```
   **IMPORTANT:** The 404 catch-all handler is at line 202-204. All new route mounts must be inserted between line 187 and line 202, not appended after it.
6. **ST-28.6:** Build: `pnpm build --filter=@agent-platform/search-ai`.

### Acceptance Criteria

- AC-01: `GET /api/indexes/:indexId/connectors/:connectorId/overview` returns KPI data with status computed from syncState/errorState.
  - Verify: Integration test with a connector in various states
  - Expected: Status correctly mapped (syncing, paused, error, healthy)
- AC-02: `GET /api/indexes/:indexId/connectors/:connectorId/content-breakdown` returns byType and bySite arrays.
  - Verify: Integration test with a connector that has discovery data
  - Expected: Non-empty byType and bySite arrays with percentage calculations
- AC-03: `GET /api/indexes/:indexId/connectors/:connectorId/sync-history?page=1&limit=5` returns paginated results.
  - Verify: Integration test with 10 audit entries, requesting page 1 limit 5
  - Expected: 5 entries returned, total=10, page=1
- AC-04: All queries include `tenantId` filter (tenant isolation).
  - Verify: Code review of service functions
  - Expected: Every DB query includes `tenantId`
- AC-05: Invalid `connectorId` returns 404.
  - Verify: Integration test with non-existent connectorId
  - Expected: `{ success: false, error: { code: 'NOT_FOUND' } }` with status 404
- AC-06: `pnpm build --filter=@agent-platform/search-ai` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai`
  - Expected: Exit code 0

### Dependencies

- **T-06** (Wave 1, ConnectorAuditEntry model) -- sync history queries audit entries
- **T-07** (Wave 1, ConnectorConfigVersion model) -- overview may reference latest version

### Risk Notes

- Content breakdown relies on discovery profile data. If discovery has not been run or is stale, the breakdown will be empty or inaccurate. The API should return metadata indicating discovery freshness.
- Sync history from audit entries: if audit entries are not being written during sync operations (audit logging was added in T-06 but may not be wired into sync worker), the sync history will be empty. Verify that the sync worker calls `auditService.logEvent()` on sync start/complete/fail events. If not wired, this is a gap that T-28 should address by adding audit logging calls to the sync start/stop/complete code paths.
- The overview endpoint targets <500ms. Avoid N+1 queries. Use `.lean()` for all Mongoose queries and project only needed fields.

---

## Task T-29: Backend: Enhanced Sync-Progress with Per-Site Data

### Problem

The existing `getSyncStatus()` at `apps/search-ai/src/services/connector.service.ts` (lines 1145-1174) returns basic progress data: `status`, `syncState`, `errorState`, and a `progress` object with `percentage`, `processed`, `total`, `failed`. It does not return:

- `syncType` (full/delta)
- `isActive` boolean
- `sizeProcessed` / `sizeTotal`
- `etaSeconds`
- `currentDocument` (name + source site)
- `perSiteProgress` array

The sync worker at `apps/search-ai/src/workers/connector-sync-worker.ts` needs to write per-site progress and current document info to the connector's `syncState` (or a Redis key) so the status endpoint can read it.

### Files to Modify

- `apps/search-ai/src/services/connector.service.ts` (lines 1145-1174) -- Enhance `getSyncStatus()` return value with per-site progress, current document, ETA, size data

### Function Signatures

**Before (line 1145-1174):**

```ts
export async function getSyncStatus(connectorId: string, tenantId: string) {
  // Returns: { status, syncState, errorState, progress: { percentage, processed, total, failed } }
}
```

**After:**

```ts
export async function getSyncStatus(connectorId: string, tenantId: string) {
  // Returns: {
  //   status, syncType, isActive, syncState, errorState,
  //   progress: {
  //     docsProcessed, docsTotal, sizeProcessed, sizeTotal,
  //     percentage, etaSeconds,
  //     currentDocument: { name, sourceSite } | null
  //   },
  //   perSiteProgress: Array<{ siteName, percentage, docsProcessed, docsTotal }>
  // }
}
```

### Subtasks (execution order)

1. **ST-29.1:** Examine the sync worker at `apps/search-ai/src/workers/connector-sync-worker.ts` to understand how it updates `syncState` during sync. Identify where per-site progress, current document, and size data can be written. The sync coordinator likely updates `syncState.processedDocuments` and `syncState.totalDocuments` — verify.
2. **ST-29.2:** Extend the `syncState` subdocument in `packages/database/src/models/connector-config.model.ts` to include **persistent** fields only: `syncType: { type: String, enum: ['full', 'delta'] }`, `syncStartedAt: Date`, `sizeTotal: Number`. **Ephemeral sync runtime data** (`sizeProcessed`, `currentDocument`, `perSiteProgress`) should be stored in **Redis** under key `sync:progress:${connectorId}` with a TTL of 1 hour (auto-cleanup after sync). This avoids frequent writes to a MongoDB document during sync. `getSyncStatus()` (ST-29.3) should read progress from Redis first (`HGETALL sync:progress:${connectorId}`), falling back to MongoDB `syncState` for persistent fields.
3. **ST-29.3:** Enhance `getSyncStatus()` at line 1145-1174 to read the new fields from `syncState` and include them in the response. Compute `isActive` from `syncInProgress`. Compute `etaSeconds` from `(Date.now() - syncStartedAt) / docsProcessed * (docsTotal - docsProcessed) / 1000` when `docsProcessed > 0` and `syncStartedAt` is set, else `null`.
4. **ST-29.4:** Build: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database`.

### Acceptance Criteria

- AC-01: `getSyncStatus()` returns `syncType`, `isActive`, and enhanced `progress` fields.
  - Verify: Unit test with mock connector doc containing new syncState fields
  - Expected: Response includes `syncType: 'full'`, `isActive: true`, `progress.sizeProcessed`, etc.
- AC-02: `perSiteProgress` returns array of site progress when available.
  - Verify: Unit test with `syncState.perSiteProgress` populated
  - Expected: Array passed through to response
- AC-03: `etaSeconds` is computed correctly from sync duration and progress.
  - Verify: Unit test with `syncStartedAt` 60s ago, 30 of 100 docs processed
  - Expected: `etaSeconds` approximately 140 (60s \* 70/30)
- AC-04: `etaSeconds` is `null` when no progress data or <10% complete.
  - Verify: Unit test with 0 docs processed
  - Expected: `etaSeconds: null`
- AC-05: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database`
  - Expected: Exit code 0

### Dependencies

- **T-02** (Wave 1, pauseSync fix) -- Sync status includes pause state
- None for the schema extension itself

### Risk Notes

- Adding fields to the `syncState` subdocument in the Mongoose schema is additive (no migration needed for existing documents -- new fields default to `undefined`).
- The sync worker must actually write per-site progress to these fields for the data to be available. If the worker does not write them yet, the status endpoint returns `null`/empty for those fields. This is acceptable for v1 -- the frontend handles missing data gracefully.
- ETA calculation is naive (linear extrapolation). Real-world sync speed varies wildly (large PDFs vs small text files). The frontend should display ETA with appropriate caveats.

---

## Task T-30: Create Notification Config (Email Toggle, Webhook, Events)

### Problem

The Overview tab includes a Notifications section where users configure email alerts (toggle + event checkboxes) and webhook alerts (URL input + test button + event checkboxes). This requires a new frontend component and integration with the notification preferences API from T-31.

The design specifies 4 notification events: `sync_failure`, `token_expiry`, `permission_crawl_fail`, `sync_complete`. Both email and webhook channels can subscribe to any combination of these events.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/NotificationConfig.tsx` -- Email and webhook configuration section
- `apps/studio/src/hooks/useNotificationConfig.ts` -- SWR hook for notification preferences

### Component Interfaces

```tsx
// NotificationConfig.tsx

interface NotificationConfigProps {
  indexId: string;
  connectorId: string;
}

// Two subsections:
// 1. Email Alerts: Toggle + 4 event checkboxes
// 2. Webhook Alerts: URL input + [Test] + [Save] + 4 event checkboxes
// Auto-saves on change (debounced 1s) via PUT /connectors/:id/notifications
// [Test] calls POST /connectors/:id/notifications/test-webhook
// Shows inline success/error for webhook test
```

```ts
// useNotificationConfig.ts

interface NotificationConfigData {
  emailAlertsEnabled: boolean;
  emailEvents: string[];
  webhookUrl: string | null;
  webhookEvents: string[];
}

interface UseNotificationConfigReturn {
  config: NotificationConfigData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
  updateConfig: (updates: Partial<NotificationConfigData>) => Promise<void>;
  testWebhook: () => Promise<{ success: boolean; error?: string }>;
}

export function useNotificationConfig(
  indexId: string | null,
  connectorId: string | null,
): UseNotificationConfigReturn;
// SWR key: indexId && connectorId
//   ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/notifications`
//   : null
// updateConfig: PUT to same endpoint, then mutate
// testWebhook: POST to .../notifications/test-webhook
```

### i18n Keys

Namespace: `search_ai.sharepoint.notifications` under `packages/i18n/locales/en/studio.json`

Keys:

- `email_title`: "Email alerts"
- `email_toggle_label`: "Enable email alerts"
- `email_service_note`: "Uses platform email service (AWS SES/Resend/SMTP)."
- `webhook_title`: "Webhook"
- `webhook_url_placeholder`: "https://hooks.slack.com/..."
- `webhook_url_label`: "Webhook URL"
- `btn_test`: "Test"
- `btn_save`: "Save"
- `webhook_test_success`: "Webhook test successful"
- `webhook_test_failed`: "Failed: {{error}}"
- `webhook_integrations_note`: "Integrates with Slack, PagerDuty, or any HTTP endpoint."
- `webhook_payload_note`: "Payload: JSON with event type, connector ID, severity, timestamp."
- `event_sync_failure`: "Sync failure"
- `event_token_expiry`: "Token expiry (7-day warning)"
- `event_permission_crawl_fail`: "Permission crawl failure"
- `event_sync_complete`: "Sync complete"

### Subtasks (execution order)

1. **ST-30.1:** Create `useNotificationConfig.ts` SWR hook. Pattern: same as `useConnectorOverview`. Adds `updateConfig` function that uses **SWR optimistic update**: call `mutate(newData, { revalidate: false })` immediately with the merged config for instant UI feedback, then fire the `PUT` request. On PUT success, call `mutate()` to revalidate from server. On PUT failure, call `mutate()` to rollback to server state and show an error toast. Adds `testWebhook` that calls `POST` to test endpoint.
2. **ST-30.2:** Create `NotificationConfig.tsx`. Read `Toggle` component from `apps/studio/src/components/ui/Toggle.tsx` for email toggle props. Read `Input` from `apps/studio/src/components/ui/Input.tsx` for webhook URL input. Read `Checkbox` from `apps/studio/src/components/ui/Checkbox.tsx` for event checkboxes. Email section: Toggle + 4 Checkbox components. Webhook section: Input + [Test] Button + [Save] Button + 4 Checkbox components. Debounced auto-save: use `useRef` for timeout and clear on unmount. Webhook test: inline success/error message below [Test] button.
3. **ST-30.3:** Add API functions `saveNotificationConfig` and `testWebhook` to `apps/studio/src/api/search-ai.ts`.
4. **ST-30.4:** Integrate `NotificationConfig` into `OverviewTab.tsx` (T-26) in the Notifications section.
5. **ST-30.5:** Add i18n keys to `packages/i18n/locales/en/studio.json`.
6. **ST-30.6:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Email toggle changes trigger `updateConfig` with debounced save.
  - Verify: Component test toggling email, checking API call after 1s
  - Expected: PUT called with `emailAlertsEnabled: true/false`
- AC-02: Webhook [Test] button calls test-webhook endpoint and shows inline result.
  - Verify: Component test with mocked success/failure responses
  - Expected: Success message or error message displayed inline
- AC-03: All 4 event checkboxes render for both email and webhook channels.
  - Verify: Component test counting checkbox elements
  - Expected: 8 checkboxes total (4 per channel)
- AC-04: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-26** (OverviewTab) -- NotificationConfig renders inside the overview
- **T-31** (backend notification routes) -- data source

### Risk Notes

- Debounced auto-save means rapid toggle changes only fire one API call. If the user toggles quickly and navigates away before the debounce fires, the last change is lost. The debounce should flush on component unmount.
- Webhook test is synchronous in the backend. If the target URL is slow to respond (>5s), the test may timeout. The UI should show a loading state during the test.

---

## Task T-31: Backend: Notification Preferences + Test-Webhook Routes

### Problem

Two new endpoints for notification configuration:

1. `PUT /:indexId/connectors/:connectorId/notifications` -- Save notification preferences
2. `POST /:indexId/connectors/:connectorId/notifications/test-webhook` -- Test webhook URL by sending a sample payload

The HLD defines a `NotificationSubscription` model (section 4f). However, for v1, notification preferences can be stored as a subdocument on the `ConnectorConfig` model to avoid a new collection. If the `NotificationSubscription` model is needed for multi-user subscriptions later, it can be added in Wave 4.

### Files to Modify

- `packages/database/src/models/connector-config.model.ts` -- Add `notifications` subdocument to connector schema
- `apps/search-ai/src/server.ts` (line ~185) -- Mount notification routes (can share the connector-monitoring router)

### Files to Create

- `apps/search-ai/src/routes/connector-notifications.ts` -- Express routes
- `apps/search-ai/src/services/connector-notification.service.ts` -- Service functions

### Zod Validation Schemas

```ts
const notificationParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const notificationBody = z.object({
  emailAlertsEnabled: z.boolean().optional(),
  emailEvents: z
    .array(z.enum(['sync_failure', 'token_expiry', 'permission_crawl_fail', 'sync_complete']))
    .optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookEvents: z
    .array(z.enum(['sync_failure', 'token_expiry', 'permission_crawl_fail', 'sync_complete']))
    .optional(),
});

const testWebhookBody = z.object({
  url: z.string().url(),
});
```

### Service Signatures

```ts
// connector-notification.service.ts

export async function getNotificationConfig(
  connectorId: string,
  tenantId: string,
): Promise<NotificationConfigData>;

export async function updateNotificationConfig(
  connectorId: string,
  tenantId: string,
  updates: Partial<NotificationConfigData>,
): Promise<NotificationConfigData>;
// Merges updates with existing config, saves to connector doc

export async function testWebhook(
  url: string,
  connectorId: string,
  tenantId: string,
): Promise<{ success: boolean; statusCode?: number; error?: string }>;
// Sends a test payload to the URL:
// { event: "test", connectorId, tenantId, severity: "info",
//   timestamp: new Date().toISOString(), message: "Webhook test from ABL Platform" }
// Returns success/failure with status code or error message
// Timeout: 10s
```

### Subtasks (execution order)

1. **ST-31.1:** Add `notifications` subdocument to `ConnectorConfig` schema in `connector-config.model.ts`. Fields: `emailAlertsEnabled: { type: Boolean, default: false }`, `emailEvents: { type: [String], default: [] }`, `webhookUrl: { type: String, default: null }`, `webhookEvents: { type: [String], default: [] }`. This is an additive schema change -- existing documents get defaults.
2. **ST-31.2:** Create `connector-notification.service.ts`. `getNotificationConfig` reads from `connector.notifications` subdocument. `updateNotificationConfig` uses `findOneAndUpdate` with `$set` for only the provided fields (partial update). `testWebhook` uses Node `fetch()` with a 10-second `AbortController` timeout. **SSRF mitigation:** Before making the HTTP request, validate the URL: (1) parse with `new URL(url)`, (2) resolve hostname to IP via `dns.promises.lookup()`, (3) reject if IP matches `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, or `::1`. Return `{ success: false, error: 'URL resolves to a private/loopback address' }` for blocked URLs. Catches network errors and returns them as `{ success: false, error }`.
3. **ST-31.3:** Create `connector-notifications.ts` routes. Two routes: `PUT /:indexId/connectors/:connectorId/notifications` and `POST /:indexId/connectors/:connectorId/notifications/test-webhook`. Follow the `handleError` pattern from `connectors.ts` (lines 23-37) which handles `ConnectorError` with proper status codes. Include Zod validation and `tenantContext`.
4. **ST-31.4:** Also add a `GET /:indexId/connectors/:connectorId/notifications` route for the SWR hook to fetch current config.
5. **ST-31.5:** Mount in `server.ts` **before line 202 (before the `// 404 handler` comment)**:
   ```ts
   import connectorNotificationsRouter from './routes/connector-notifications.js';
   app.use('/api/indexes', connectorNotificationsRouter);
   ```
   **IMPORTANT:** All new route mounts must be inserted between line 187 and line 202, before the 404 catch-all handler.
6. **ST-31.6:** Build: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database`.

### Acceptance Criteria

- AC-01: `PUT /notifications` saves email and webhook preferences to connector doc.
  - Verify: Integration test saving config and re-reading
  - Expected: Saved values match request body
- AC-02: `POST /notifications/test-webhook` with valid URL returns `{ success: true }`.
  - Verify: Integration test with a mock HTTP server
  - Expected: Test payload received, success returned
- AC-03: `POST /notifications/test-webhook` with unreachable URL returns `{ success: false, error }`.
  - Verify: Integration test with non-existent URL
  - Expected: `success: false` with error message (connection refused or timeout)
- AC-04: All queries include `tenantId` filter.
  - Verify: Code review
  - Expected: Every DB query includes `tenantId`
- AC-05: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai --filter=@agent-platform/database`
  - Expected: Exit code 0

### Dependencies

- None

### Risk Notes

- Webhook test uses Node `fetch()`. SSRF protection is implemented in ST-31.2: hostname resolution is checked against private/loopback/link-local IP ranges before the request is made. This blocks requests to `localhost`, `127.0.0.1`, `169.254.169.254` (cloud metadata), and RFC 1918 private ranges.
- Storing notification preferences on the connector doc means they are per-connector, not per-user. If multiple users configure notifications, the last writer wins. For v1 this is acceptable. The `NotificationSubscription` model from the HLD supports per-user subscriptions for Wave 4.

---

## Task T-32: Create Permission Sync Status Section (Crawl Now, Schedule)

### Problem

The Overview tab includes a Permission Sync Status section showing coverage ratio, staleness warning, last crawl time, next crawl time, and two interactive buttons: [Crawl Now] and [Set Schedule]. This section has independent loading timing (may show "Checking..." spinner if permission data is slow).

The existing `useConnector` hook returns `permissionConfig` with `mode`, `crawlSchedule`, `lastCrawlAt`, `crawlInProgress`, `documentsProcessed`, `averageAccuracy`, `lastCrawlError`. The overview endpoint (T-28) adds `coverageTotal`, `coverageMapped`, `stalenessWarning`, `nextCrawl`.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/PermissionSyncStatus.tsx` -- Permission sync section

### Component Interfaces

```tsx
// PermissionSyncStatus.tsx

interface PermissionSyncStatusProps {
  connectorId: string;
  indexId: string;
  permissionConfig: ConnectorDetail['permissionConfig'];
  permissionSync: OverviewData['permissionSync'] | null;
  isLoading: boolean;
}

// Renders:
// - Mode: Enabled/Disabled
// - Last crawled: relative time
// - Coverage: "N of M documents have permissions mapped"
// - Staleness warning (when stalenessWarning === true)
// - Next crawl: scheduled time or "Not scheduled"
// - [Crawl Now] button (disabled when crawlInProgress)
// - [Set Schedule] button (opens inline schedule editor)
// - Explanatory note about last-crawled permissions
```

### i18n Keys

Namespace: `search_ai.sharepoint.permission_sync` under `packages/i18n/locales/en/studio.json`

Keys:

- `title`: "Permission Sync Status"
- `mode_label`: "Mode"
- `mode_enabled`: "Enabled (permission-aware search active)"
- `mode_disabled`: "Disabled"
- `last_crawled`: "Last crawled"
- `coverage`: "{{mapped}} of {{total}} documents have permissions mapped"
- `staleness_warning`: "Permissions may not reflect recent SharePoint changes"
- `next_crawl`: "Next crawl"
- `not_scheduled`: "Not scheduled (scheduler not active)"
- `checking`: "Checking..."
- `btn_crawl_now`: "Crawl Now"
- `btn_set_schedule`: "Set Schedule"
- `crawling`: "Crawling..."
- `permission_note`: "Note: Search results respect the last-crawled permissions. If a user's access was revoked in SharePoint after the last crawl, they may still see that document in search until the next crawl."

### Subtasks (execution order)

1. **ST-32.1:** Create `PermissionSyncStatus.tsx`. When `isLoading`, render skeleton with "Checking..." text. When `permissionConfig.mode === 'disabled'`, render simplified view with just the mode indicator. When enabled: show all fields. [Crawl Now] calls existing `POST /connectors/:connectorId/permissions/crawl` (already available at `apps/search-ai/src/routes/connectors.ts` line 342). [Set Schedule] opens an inline form or navigates to T-33's schedule configuration.
2. **ST-32.2:** Add `triggerPermissionCrawl` API function to `apps/studio/src/api/search-ai.ts` if not already present. Check existing functions -- `connectors.ts` route at line 342 exists, need to verify Studio API wrapper.
3. **ST-32.3:** Integrate `PermissionSyncStatus` into `OverviewTab.tsx` (T-26). Pass `permissionConfig` from `useConnector` and `permissionSync` from `useConnectorOverview`.
4. **ST-32.4:** Add i18n keys.
5. **ST-32.5:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Permission Sync Status renders coverage ratio when permission mode is enabled.
  - Verify: Component test with `mode: 'enabled'`, `coverageMapped: 200`, `coverageTotal: 237`
  - Expected: "200 of 237 documents have permissions mapped" text visible
- AC-02: Staleness warning renders when `stalenessWarning` is true.
  - Verify: Component test with `stalenessWarning: true`
  - Expected: Warning text visible
- AC-03: [Crawl Now] is disabled when `crawlInProgress` is true.
  - Verify: Component test with `crawlInProgress: true`
  - Expected: Button disabled, shows "Crawling..."
- AC-04: When permission mode is disabled, section shows simplified view.
  - Verify: Component test with `mode: 'disabled'`
  - Expected: Only mode indicator shown, no coverage/crawl details
- AC-05: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-26** (OverviewTab) -- renders inside the overview
- **T-28** (backend overview route) -- provides permissionSync data

### Risk Notes

- The [Crawl Now] button triggers a potentially long-running operation (minutes to hours). The UI should show progress indication. The existing `permissionConfig.crawlInProgress` field on the connector can be polled to detect completion.
- [Set Schedule] integration with T-33 backend. If T-33 is not yet complete, the [Set Schedule] button can be disabled with a tooltip "Coming soon".

---

## Task T-33: Backend: Permission-Schedule Route

### Problem

A new endpoint to set the permission crawl schedule for a connector. The design shows a [Set Schedule] button that configures when permission crawls run (e.g., "Every 24 hours", "Weekly", "Manual only").

The existing `permissionConfig.crawlSchedule` field on `ConnectorConfig` is a string that stores the cron expression or schedule label. This task adds an endpoint to update it.

### Files to Modify

- `apps/search-ai/src/routes/connector-monitoring.ts` (from T-28, or create new file) -- Add permission-schedule route

### Files to Create

- None (add to existing files)

### Zod Validation Schema

```ts
const permissionScheduleBody = z
  .object({
    schedule: z.enum(['manual', 'daily', 'weekly', 'custom']),
    cronExpression: z.string().min(1).optional(),
  })
  .refine(
    (data) => data.schedule !== 'custom' || (data.cronExpression && data.cronExpression.length > 0),
    {
      message: 'cronExpression is required when schedule is "custom"',
      path: ['cronExpression'],
    },
  );
```

### Service Signature

```ts
// Add to connector-monitoring.service.ts or connector.service.ts

export async function updatePermissionSchedule(
  connectorId: string,
  tenantId: string,
  schedule: string,
  cronExpression?: string,
): Promise<{ schedule: string; nextCrawl: string | null }>;
// Updates permissionConfig.crawlSchedule on the connector doc
// Returns the new schedule and computed next crawl time
```

### Subtasks (execution order)

1. **ST-33.1:** Add `updatePermissionSchedule` to `connector-monitoring.service.ts`. Maps schedule labels to cron expressions: `daily` -> `'0 2 * * *'` (2am), `weekly` -> `'0 2 * * 0'` (Sunday 2am), `manual` -> `null`, `custom` -> user-provided cron. Updates `permissionConfig.crawlSchedule` via `findOneAndUpdate`. Every query scoped to `tenantId`.
2. **ST-33.2:** Add `PUT /:indexId/connectors/:connectorId/permission-schedule` route to the monitoring routes file. Validate body with Zod. Validate that `cronExpression` is present when `schedule === 'custom'`.
3. **ST-33.3:** Build: `pnpm build --filter=@agent-platform/search-ai`.

### Acceptance Criteria

- AC-01: `PUT /permission-schedule` with `{ schedule: 'daily' }` updates `permissionConfig.crawlSchedule`.
  - Verify: Integration test setting schedule and reading connector
  - Expected: `permissionConfig.crawlSchedule` contains daily cron expression
- AC-02: `PUT /permission-schedule` with `{ schedule: 'custom', cronExpression: '0 */6 * * *' }` works.
  - Verify: Integration test
  - Expected: Custom cron stored
- AC-03: `PUT /permission-schedule` with `{ schedule: 'custom' }` (no cron) returns validation error.
  - Verify: Integration test
  - Expected: 400 error
- AC-04: `pnpm build --filter=@agent-platform/search-ai` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai`
  - Expected: Exit code 0

### Dependencies

- None

### Risk Notes

- Storing a cron expression does not automatically schedule the crawl. The actual scheduling requires integration with BullMQ repeatable jobs or a separate scheduler service. For v1, this endpoint stores the preference; the scheduler wiring is a follow-up.

---

## Task T-34: Create Error State Components (E1-E10)

### Problem

The design defines 10 discriminated error types (§10), each with a distinct UI template. A dispatcher component inspects the error type discriminator on the connector status and renders the appropriate template. Each template shows contextual information, fix steps, and action buttons.

Error states appear in different tabs:

- E1 (Auth Failed): Connect tab
- E2 (Discovery Timeout): Scope tab
- E8 (Zero Sites): Scope tab
- E9 (Popup Blocked): Connect tab (inline)
- E10 (All Unsupported): Preview tab
- E3, E4, E5, E6, E7: Overview tab

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/errors/ConnectorErrorState.tsx` -- Dispatcher component
- `apps/studio/src/components/search-ai/sharepoint/errors/AuthFailedError.tsx` -- E1
- `apps/studio/src/components/search-ai/sharepoint/errors/DiscoveryTimeoutError.tsx` -- E2
- `apps/studio/src/components/search-ai/sharepoint/errors/SyncFailureError.tsx` -- E3
- `apps/studio/src/components/search-ai/sharepoint/errors/TokenExpiredError.tsx` -- E4
- `apps/studio/src/components/search-ai/sharepoint/errors/PermissionRevokedError.tsx` -- E5
- `apps/studio/src/components/search-ai/sharepoint/errors/ThrottledError.tsx` -- E6
- `apps/studio/src/components/search-ai/sharepoint/errors/PartialSiteFailureError.tsx` -- E7
- `apps/studio/src/components/search-ai/sharepoint/errors/ZeroSitesError.tsx` -- E8
- `apps/studio/src/components/search-ai/sharepoint/errors/PopupBlockedError.tsx` -- E9
- `apps/studio/src/components/search-ai/sharepoint/errors/AllUnsupportedError.tsx` -- E10

### Component Interfaces

```tsx
// ConnectorErrorState.tsx (dispatcher)

type ErrorType =
  | 'auth_failed'
  | 'discovery_timeout'
  | 'sync_failed'
  | 'token_expired'
  | 'permission_revoked'
  | 'throttled'
  | 'partial_failure'
  | 'zero_sites'
  | 'popup_blocked'
  | 'all_unsupported';

interface ConnectorErrorData {
  type: ErrorType;
  errorCode?: string;
  errorMessage?: string;
  // E1-specific
  appRegistrationName?: string;
  secretCreatedDate?: string;
  // E2-specific
  sitesDiscovered?: number;
  sitesProfiled?: number;
  drivesFound?: number;
  estimatedFullDiscoveryTime?: string;
  // E3-specific
  docsProcessed?: number;
  docsTotal?: number;
  checkpointSaved?: boolean;
  resumeFromDoc?: number;
  // E4-specific
  tokenExpiryDate?: string;
  daysUntilExpiry?: number;
  lastRefreshAttempt?: string;
  refreshErrorCode?: string;
  // E5-specific
  revokedPermission?: string;
  impactList?: string[];
  indexedDocCount?: number;
  syncAutoPaused?: boolean;
  // E6-specific
  retryAfterSeconds?: number;
  requestsMade?: number;
  throttleScope?: string;
  syncProgressPercent?: number;
  // E7-specific
  siteStatuses?: Array<{
    siteName: string;
    status: 'ok' | 'failed';
    docsSynced: number;
    docsTotal: number;
    errorReason: string | null;
  }>;
  // E8-specific
  currentPermissionScope?: string;
  possibleReasons?: Array<{ reason: string; fix: string }>;
  // E9-specific
  popupBlockReason?: string;
  // E10-specific
  totalDiscoveredFiles?: number;
  discoveredFileTypes?: string[];
  supportedFileTypes?: string[];
}

interface ConnectorErrorStateProps {
  error: ConnectorErrorData;
  connectorId: string;
  indexId: string;
  onRetry: (action: string) => void;
  onNavigateToTab: (tab: ConnectorTab) => void;
  onReAuth: () => void;
}

// Dispatcher: switch on error.type, render the corresponding component.
// All error components receive the full error data (they pick what they need).
```

### i18n Keys

Namespace: `search_ai.sharepoint.errors` under `packages/i18n/locales/en/studio.json`

Keys (selected, one per error type plus shared):

- `auth_failed_title`: "Authentication Failed"
- `auth_failed_how_to_fix`: "How to fix:"
- `discovery_timeout_title`: "Discovery Partial -- Large Environment"
- `discovery_timeout_description`: "I found {{sitesDiscovered}} sites but timed out while profiling drive contents."
- `sync_failed_title`: "Sync Failed"
- `sync_failed_docs_processed`: "Full sync failed after processing {{processed}} of {{total}} documents."
- `sync_failed_checkpoint`: "Checkpoint saved -- can resume without re-downloading the first {{processed}}."
- `token_expired_title`: "Token Expiring"
- `token_expired_description`: "Access token expires in {{days}} days ({{date}})."
- `permission_revoked_title`: "Access Revoked"
- `throttled_title`: "Throttled"
- `throttled_description`: "Microsoft Graph API rate limit hit (HTTP 429)."
- `throttled_reassurance`: "This is normal for large syncs. The connector backs off automatically."
- `partial_failure_title`: "Partial Success"
- `partial_failure_description`: "Sync completed with errors on {{failedCount}} of {{totalCount}} sites."
- `zero_sites_title`: "No Sites Found"
- `popup_blocked_title`: "Sign-In Popup Blocked"
- `all_unsupported_title`: "No Indexable Files"
- `btn_retry`: "Retry"
- `btn_resume_sync`: "Resume Sync"
- `btn_reduce_scope`: "Reduce Scope"
- `btn_keep_partial`: "Keep Partial"
- `btn_reauth`: "Re-authenticate Now"
- `btn_open_azure_portal`: "Open Azure Portal"
- `btn_retry_new_secret`: "Retry with New Secret"
- `btn_share_with_admin`: "Share Issue with IT Admin"
- `btn_delete_connector`: "Delete Connector"
- `btn_retry_discovery`: "Retry Discovery"
- `btn_upgrade_scope`: "Upgrade Scope"
- `btn_enter_url`: "Enter Site URL Manually"
- `btn_switch_device_code`: "Switch to Device Code"
- `btn_try_again`: "Try Again"
- `btn_select_different_sites`: "Select Different Sites"
- `btn_upload_files`: "Upload Files Instead"
- `btn_cancel_setup`: "Cancel Setup"
- `btn_retry_failed`: "Retry Failed Sites"
- `btn_accept_partial`: "Accept Partial"
- `btn_rerun_full`: "Re-run Full Sync"
- `btn_request_access`: "Request Access"
- `btn_remove_from_scope`: "Remove from Scope"

### Subtasks (execution order)

1. **ST-34.1:** Create `ConnectorErrorState.tsx` dispatcher. A `switch` on `error.type` that returns the corresponding error component. Uses `const t = useTranslations('search_ai.sharepoint.errors');`.
2. **ST-34.2:** Create `AuthFailedError.tsx` (E1). Shows error code, human-readable message, numbered fix steps interpolating `appRegistrationName` and `secretCreatedDate`. Actions: [Open Azure Portal] (external link using `appId` from connectionConfig), [Retry with New Secret].
3. **ST-34.3:** Create `DiscoveryTimeoutError.tsx` (E2). Three options: continue with partial, search input, re-run. Stats bar at bottom.
4. **ST-34.4:** Create `SyncFailureError.tsx` (E3). Shows docs processed/total, error code/message, checkpoint info. Three actions: [Resume Sync], [Reduce Scope], [Keep Partial].
5. **ST-34.5:** Create `TokenExpiredError.tsx` (E4). Shows expiry date, days remaining, consequence, auto-refresh failure details, "To fix" guidance. Action: [Re-authenticate Now]. [Send Delegation Invite] shown but disabled (out of scope for phase 1).
6. **ST-34.6:** Create `PermissionRevokedError.tsx` (E5). Names exact revoked permission, bulleted impact list, auto-paused notification. Actions: [Share Issue with IT Admin], [Re-authenticate], [Delete Connector].
7. **ST-34.7:** Create `ThrottledError.tsx` (E6). Shows retry-after countdown, requests made, throttle scope, progress percent, resume doc number. Uses `useEffect` with `setInterval(1000)` for live countdown timer. **The `useEffect` must return a cleanup function that calls `clearInterval` on unmount** to prevent React state-update-on-unmounted-component warnings. When countdown reaches 0, clear the interval and trigger a re-fetch of connector status. Reassurance message. No action buttons (passive).
8. **ST-34.8:** Create `PartialSiteFailureError.tsx` (E7). Per-site list with OK/FAIL badges. Failed sites show error reason and per-site actions: [Request Access], [Remove from Scope]. Summary line. Global actions: [Retry Failed Sites], [Accept Partial], [Re-run Full Sync].
9. **ST-34.9:** Create `ZeroSitesError.tsx` (E8). Three numbered reasons. Current scope display. Actions: [Retry Discovery], [Upgrade Scope], [Enter Site URL Manually] (inline URL input with [Check Access] button).
10. **ST-34.10:** Create `PopupBlockedError.tsx` (E9). Reasons list. Alternative suggestion. Actions: [Switch to Device Code], [Try Again], [Contact IT Admin].
11. **ST-34.11:** Create `AllUnsupportedError.tsx` (E10). File count, discovered types, supported types with expand. Contextual insight. Actions: [Select Different Sites], [Upload Files Instead], [Cancel Setup].
12. **ST-34.12:** Integrate `ConnectorErrorState` into `OverviewTab.tsx` for E3-E7, into `ConnectTab.tsx` for E1/E9, into Scope tab for E2/E8, and into Preview tab for E10. The integration point depends on each tab detecting the error state from `connector.errorState` or a dedicated error field.
13. **ST-34.13:** Add i18n keys.
14. **ST-34.14:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: `ConnectorErrorState` dispatcher renders the correct component for each error type.
  - Verify: Component test with each of the 10 error types
  - Expected: Correct error component rendered for each type
- AC-02: E1 (Auth Failed) shows error code and numbered fix steps.
  - Verify: Component test with `type: 'auth_failed'`, `errorCode: 'AADSTS7000215'`
  - Expected: Error code and fix steps visible, [Open Azure Portal] link functional
- AC-03: E6 (Throttled) countdown timer decrements every second.
  - Verify: Component test with `retryAfterSeconds: 45`, advancing timers
  - Expected: Countdown shows 45, then 44, then 43...
- AC-04: E7 (Partial Failure) renders per-site list with OK/FAIL badges.
  - Verify: Component test with 5-site `siteStatuses` array (4 OK, 1 failed)
  - Expected: 5 site rows, 1 with error badge and per-site actions
- AC-05: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-26** (OverviewTab) -- error states render inside overview for E3-E7
- **T-36** (backend error discriminator) -- provides the error data structure

### Risk Notes

- 10 components is significant breadth. Each is relatively simple (template-based), but the total i18n key count is large. Consider grouping implementation into sub-batches: Overview errors (E3-E7) first, then tab-specific errors (E1, E2, E8-E10).
- The E6 countdown timer uses `setInterval`. Clean up on unmount and when countdown reaches 0. When countdown reaches 0, trigger a re-fetch of connector status to check if the throttle has cleared.
- E9 (Popup Blocked) is detected client-side via `window.open()` returning `null`. This detection happens in the Connect tab auth flow, not from backend state.

---

## Task T-35: Create Empty State Components (EM1-EM3)

### Problem

Three empty states when connector data is missing or zero:

1. **EM1 -- No Connectors**: Redirects to Connect tab first-time experience (already handled by Wave 2 T-13).
2. **EM2 -- No Documents**: After sync completes with 0 indexed docs. Shows filter analysis.
3. **EM3 -- No Sites Accessible**: After auth with Sites.Selected and 0 approved sites.

EM1 is already covered by the Connect tab logic. This task creates EM2 and EM3 as standalone components.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/errors/ConnectorEmptyState.tsx` -- Dispatcher
- `apps/studio/src/components/search-ai/sharepoint/errors/NoDocumentsEmpty.tsx` -- EM2
- `apps/studio/src/components/search-ai/sharepoint/errors/NoSitesAccessibleEmpty.tsx` -- EM3

### Component Interfaces

```tsx
// ConnectorEmptyState.tsx (dispatcher)

type EmptyStateType = 'no_connectors' | 'no_documents' | 'no_sites_accessible';

interface ConnectorEmptyStateProps {
  type: EmptyStateType;
  connectorId: string;
  indexId: string;
  onNavigateToTab: (tab: ConnectorTab) => void;
  // EM2-specific
  filterExclusions?: Array<{
    filterType: string;
    excludedCount: number;
    detail: string;
  }>;
  // EM3-specific
  currentPermissionScope?: string;
  approvedSiteCount?: number;
}
```

```tsx
// NoDocumentsEmpty.tsx (EM2)

interface NoDocumentsEmptyProps {
  filterExclusions: Array<{
    filterType: string;
    excludedCount: number;
    detail: string;
  }>;
  onAdjustFilters: () => void;
  onSelectDifferentSites: () => void;
  onViewAllDiscovered: () => void;
}

// Renders inside Overview tab when totalDocuments === 0 and lastFullSyncAt !== null.
// Shows: "Sync completed but 0 documents were indexed."
// Filter exclusion analysis list.
// Actions: [Adjust Filters], [Select Different Sites], [View All Discovered Files].
```

```tsx
// NoSitesAccessibleEmpty.tsx (EM3)

interface NoSitesAccessibleEmptyProps {
  currentPermissionScope: string;
  onCheckAccess: (siteUrl: string) => void;
  onSendRequestToAdmin: () => void;
  onUpgradeScope: () => void;
}

// Renders inside Scope tab when Sites.Selected and 0 approved sites.
// Shows: explanation, inline URL input with [Check Access], [Send Request to Admin],
// [Upgrade to Sites.Read.All].
```

### i18n Keys

Namespace: `search_ai.sharepoint.empty` under `packages/i18n/locales/en/studio.json`

Keys:

- `no_docs_title`: "No Documents Indexed"
- `no_docs_description`: "Sync completed but 0 documents were indexed."
- `no_docs_filter_note`: "This usually means your filters are too restrictive."
- `no_docs_exclusion_label`: "Current filters exclude all discovered documents:"
- `btn_adjust_filters`: "Adjust Filters"
- `btn_select_different_sites`: "Select Different Sites"
- `btn_view_all_discovered`: "View All Discovered Files"
- `no_sites_title`: "No Sites Accessible"
- `no_sites_description`: "You are using Sites.Selected, which grants access only to sites that your Azure AD admin has explicitly approved."
- `no_sites_count`: "Currently, {{count}} sites are approved for this app registration."
- `no_sites_option1`: "Enter site URLs and we will check if they are accessible"
- `no_sites_url_placeholder`: "https://contoso.sharepoint.com/sites/"
- `btn_check_access`: "Check Access"
- `no_sites_option2`: "Ask your admin to grant access to specific sites"
- `no_sites_admin_note`: "Your admin needs to use PowerShell or Graph API to grant Sites.Selected access. There is no Azure Portal UI for this."
- `btn_send_request_admin`: "Send Request to Admin"
- `no_sites_option3`: "Upgrade to Sites.Read.All for automatic discovery"
- `no_sites_upgrade_note`: "This is broader access (read-only to all sites) but enables auto-discovery, recommendations, and activity scoring."
- `btn_upgrade_to_read_all`: "Upgrade to Sites.Read.All"
- `no_sites_upgrade_consent`: "requires admin re-consent"

### Subtasks (execution order)

1. **ST-35.1:** Create `ConnectorEmptyState.tsx` dispatcher. Switch on `type`. For `no_connectors`, return `null` (handled by Connect tab). For `no_documents` and `no_sites_accessible`, render the corresponding component.
2. **ST-35.2:** Create `NoDocumentsEmpty.tsx`. Uses `EmptyState` from `'../../ui/EmptyState'` (props: `icon`, `title`, `description`, `action`) for the main layout. Below the EmptyState, render the filter exclusion list as a bullet list. Three action buttons.
3. **ST-35.3:** Create `NoSitesAccessibleEmpty.tsx`. Three numbered options. Option 1 includes an `Input` component for URL entry + [Check Access] `Button`. Option 2 has [Send Request to Admin]. Option 3 has [Upgrade to Sites.Read.All] with "(requires admin re-consent)" note.
4. **ST-35.4:** Integrate EM2 into `OverviewTab.tsx`: when `totalDocuments === 0` and connector has completed at least one sync (`lastFullSyncAt !== null`), render `NoDocumentsEmpty` instead of content breakdown.
5. **ST-35.5:** Integrate EM3 into scope-related tab: when connector has `Sites.Selected` scope and 0 accessible sites, render `NoSitesAccessibleEmpty`. The exact integration point depends on Wave 2 scope tab implementation.
6. **ST-35.6:** Add i18n keys.
7. **ST-35.7:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: EM2 renders when `totalDocuments === 0` and `lastFullSyncAt` is non-null.
  - Verify: Component test with zero docs and completed sync
  - Expected: "Sync completed but 0 documents were indexed" visible
- AC-02: EM2 shows filter exclusion analysis list.
  - Verify: Component test with 2 filter exclusions
  - Expected: 2 bullet items with exclusion details
- AC-03: EM3 renders inline URL input and [Check Access] button.
  - Verify: Component test rendering EM3
  - Expected: Input field and Check Access button visible
- AC-04: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-26** (OverviewTab) -- EM2 renders inside overview
- **T-37** (backend filter-analysis, check-site-access) -- EM2 and EM3 data

### Risk Notes

- EM2 filter exclusion data comes from `GET /connectors/:id/filter-analysis` (T-37). Until T-37 is complete, the exclusion list will be empty.
- EM3's [Check Access] calls `POST /connectors/:id/check-site-access` (T-37). The response determines if the entered URL is accessible.
- EM3's [Upgrade to Sites.Read.All] triggers a re-consent flow, which is a complex OAuth interaction. For v1, this can call `initiateAuth` with a scope override parameter.

---

## Task T-36: Backend: Error Discriminator Enrichment + Retry Routes

### Problem

The frontend error state components (T-34) require the backend to classify connector errors into 10 discriminated types and return type-specific fields. The existing connector detail endpoint returns `errorState.lastErrorMessage` as a plain string, not a structured error object.

Two new endpoints:

1. Enhanced `GET /connectors/:id` response (or new `GET /connectors/:id/status`) with discriminated error data
2. `POST /connectors/:id/retry` with action discriminator for multi-action retry

### Files to Modify

- `apps/search-ai/src/services/connector.service.ts` (after `getSyncStatus` at line 1174) -- Add error classification logic and retry handler

### Files to Create

- `apps/search-ai/src/routes/connector-error-recovery.ts` -- Retry and error status routes
- `apps/search-ai/src/services/connector-error.service.ts` -- Error classification and retry logic

### Service Signatures

```ts
// connector-error.service.ts

import { createLogger } from '@abl/compiler/platform';
import { IConnectorConfig } from '@agent-platform/database';
import { ConnectorError } from './connector.service.js';
import * as repo from '../repos/connector.repository.js';
import { getLazyModel } from '../db/index.js';

const logger = createLogger('connector-error-service');

type ErrorType =
  | 'auth_failed'
  | 'discovery_timeout'
  | 'sync_failed'
  | 'token_expired'
  | 'permission_revoked'
  | 'throttled'
  | 'partial_failure'
  | 'zero_sites'
  | 'popup_blocked'
  | 'all_unsupported'
  | null;

/** Classify connector error into discriminated type. */
export function classifyError(connector: IConnectorConfig): {
  type: ErrorType;
  data: Record<string, unknown>;
} | null;
// Logic:
// - Check errorState.lastErrorMessage for known patterns
// - Check syncState for partial failure indicators
// - Check oauthTokenId for auth/token issues
// - Return null if no active error
// - Return { type, data } with type-specific fields

type RetryAction =
  | 'retry_auth'
  | 'retry_discovery'
  | 'resume_sync'
  | 'retry_failed_sites'
  | 'rerun_full_sync'
  | 'rerun_full_discovery';

/** Execute retry action. */
export async function executeRetry(
  connectorId: string,
  tenantId: string,
  action: RetryAction,
): Promise<{ success: boolean; message: string; jobId?: string }>;
// Dispatches to the correct service function based on action:
// - retry_auth -> initiateAuth
// - retry_discovery -> triggerDiscovery
// - resume_sync -> resumeSync
// - retry_failed_sites -> startSync (with failed-sites-only flag)
// - rerun_full_sync -> restartSync
// - rerun_full_discovery -> triggerDiscovery (full mode)
```

### Zod Validation

```ts
const errorRecoveryParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const retryBody = z.object({
  action: z.enum([
    'retry_auth',
    'retry_discovery',
    'resume_sync',
    'retry_failed_sites',
    'rerun_full_sync',
    'rerun_full_discovery',
  ]),
});
```

### Subtasks (execution order)

1. **ST-36.1:** Create `connector-error.service.ts` with `classifyError()`. Parse `errorState.lastErrorMessage` and `errorState.lastErrorAt` to determine error type. Pattern matching: `'AADSTS'` prefix -> `auth_failed`, `'ENOSPC'` or `'storage'` -> `sync_failed`, `'429'` or `'throttl'` -> `throttled`, `'revoked'` or `'permission'` -> `permission_revoked`, `'expired'` or `'invalid_grant'` -> `token_expired`. Check `syncState.failedDocuments > 0 && syncState.processedDocuments > 0` -> `partial_failure`. For each type, populate type-specific data from the connector document.
2. **ST-36.2:** Add `executeRetry()`. Import existing service functions (`initiateAuth`, `resumeSync`, `restartSync` from `connector.service.ts`). Dispatch based on `action`. Each action validates prerequisites (e.g., `resume_sync` requires `isPaused`). Return `{ success, message, jobId }`.
3. **ST-36.3:** Create `connector-error-recovery.ts` routes. Two routes: `GET /:indexId/connectors/:connectorId/error-status` (returns classified error) and `POST /:indexId/connectors/:connectorId/retry` (executes retry action). Follow the `handleError` pattern from `connectors.ts` (lines 23-37) which handles `ConnectorError` with proper status codes. Include Zod validation and `tenantContext`.
4. **ST-36.4:** Mount in `server.ts` **before line 202 (before the `// 404 handler` comment)**, between line 187 and line 202. All new route mounts must appear before the 404 catch-all handler.
5. **ST-36.5:** Build: `pnpm build --filter=@agent-platform/search-ai`.

### Acceptance Criteria

- AC-01: `classifyError` returns `type: 'auth_failed'` for connector with AADSTS error.
  - Verify: Unit test with `lastErrorMessage: 'AADSTS7000215: Invalid client secret'`
  - Expected: `{ type: 'auth_failed', data: { errorCode: 'AADSTS7000215', ... } }`
- AC-02: `classifyError` returns `null` for healthy connector.
  - Verify: Unit test with no errors
  - Expected: `null`
- AC-03: `POST /retry` with `action: 'resume_sync'` resumes a paused connector.
  - Verify: Integration test with paused connector
  - Expected: `{ success: true, message: 'Sync will resume...', jobId: '...' }`
- AC-04: `POST /retry` with `action: 'resume_sync'` on non-paused connector returns error.
  - Verify: Integration test with active connector
  - Expected: 400 error
- AC-05: `pnpm build --filter=@agent-platform/search-ai` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai`
  - Expected: Exit code 0

### Dependencies

- **T-02** (Wave 1, pauseSync fix) -- resume_sync action depends on working pause/resume
- **T-06** (Wave 1, audit model) -- retry actions should be logged

### Risk Notes

- Error classification from string matching is fragile. As the system evolves, error messages may change format. Consider storing a structured `errorType` field on the connector document rather than inferring from messages.
- The retry endpoint is essentially a multiplexer for existing service functions. Each action must be idempotent -- calling `retry_auth` twice should not create two auth sessions (the SET NX PX guard in T-03 handles this).

---

## Task T-37: Backend: Site-Statuses, Filter-Analysis, Check-Site-Access Routes

### Problem

Three utility endpoints for error states (T-34) and empty states (T-35):

1. `GET /connectors/:id/site-statuses` -- Per-site sync results for partial failure (E7)
2. `GET /connectors/:id/filter-analysis` -- Filter exclusion breakdown for empty state (EM2)
3. `POST /connectors/:id/check-site-access` -- Check manual site URL for EM3 and E8

### Files to Create

- `apps/search-ai/src/routes/connector-utilities.ts` -- Express routes
- `apps/search-ai/src/services/connector-utility.service.ts` -- Service functions

### Zod Validation

```ts
const utilityParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const checkSiteAccessBody = z.object({
  siteUrl: z.string().url(),
});
```

### Service Signatures

```ts
// connector-utility.service.ts

/** Returns per-site sync statuses for partial failure display. */
export async function getSiteStatuses(
  connectorId: string,
  tenantId: string,
): Promise<
  Array<{
    siteName: string;
    status: 'ok' | 'failed';
    docsSynced: number;
    docsTotal: number;
    errorReason: string | null;
  }>
>;
// Reads from syncState.perSiteProgress (T-29) or discovery profiles.
// Augments with error info from last sync audit entries.

/** Returns filter exclusion analysis for zero-document empty state. */
export async function getFilterAnalysis(
  connectorId: string,
  tenantId: string,
): Promise<{
  exclusions: Array<{
    filterType: string;
    excludedCount: number;
    detail: string;
  }>;
  totalDiscoveredFiles: number;
}>;
// Uses discovery profiles to count total files per type/folder.
// Applies current filterConfig rules to compute per-rule exclusion counts.

/** Checks if a site URL is accessible with current connector credentials. */
export async function checkSiteAccess(
  connectorId: string,
  tenantId: string,
  siteUrl: string,
): Promise<{
  accessible: boolean;
  siteName?: string;
  error?: string;
}>;
// Uses the connector's OAuth token to call Graph API:
// GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{path}
// Returns accessible: true with siteName, or accessible: false with error.
```

### Subtasks (execution order)

1. **ST-37.1:** Create `connector-utility.service.ts` with `getSiteStatuses()`. Read `syncState.perSiteProgress` from the connector document (added by T-29). If not available, fall back to discovery profile data. Map to the expected response format.
2. **ST-37.2:** Add `getFilterAnalysis()`. Load connector's `filterConfig` and discovery data. For each filter rule, estimate how many discovered files it would exclude. Group by filter type. Return the breakdown.
3. **ST-37.3:** Add `checkSiteAccess()`. Load connector's OAuth token via `repo.findOAuthToken`. Use the token to call `GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{path}`. Parse the Graph API response. Return `accessible: true` with `siteName` from the response, or `accessible: false` with the error message.
4. **ST-37.4:** Create `connector-utilities.ts` routes. Three routes: `GET /:indexId/connectors/:connectorId/site-statuses`, `GET /:indexId/connectors/:connectorId/filter-analysis`, `POST /:indexId/connectors/:connectorId/check-site-access`. Follow the `handleError` pattern from `connectors.ts` (lines 23-37) which handles `ConnectorError` with proper status codes. Zod validation on all routes.
5. **ST-37.5:** Mount in `server.ts` **before line 202 (before the `// 404 handler` comment)**, between line 187 and line 202. All new route mounts must appear before the 404 catch-all handler.
6. **ST-37.6:** Build: `pnpm build --filter=@agent-platform/search-ai`.

### Acceptance Criteria

- AC-01: `GET /site-statuses` returns per-site array with OK/FAIL statuses.
  - Verify: Integration test with connector that has per-site data
  - Expected: Array of site status objects
- AC-02: `GET /filter-analysis` returns exclusion breakdown.
  - Verify: Integration test with connector that has filters and discovery data
  - Expected: Exclusion list with per-rule counts
- AC-03: `POST /check-site-access` with accessible site returns `accessible: true`.
  - Verify: Integration test with mocked Graph API success response
  - Expected: `{ accessible: true, siteName: '...' }`
- AC-04: `POST /check-site-access` with inaccessible site returns `accessible: false`.
  - Verify: Integration test with mocked Graph API 403 response
  - Expected: `{ accessible: false, error: '403 Forbidden' }`
- AC-05: All queries include `tenantId` filter.
  - Verify: Code review
  - Expected: Every DB query includes `tenantId`
- AC-06: `pnpm build --filter=@agent-platform/search-ai` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/search-ai`
  - Expected: Exit code 0

### Dependencies

- **T-29** (enhanced sync progress) -- `getSiteStatuses` reads `perSiteProgress`
- **T-28** (monitoring service) -- shares similar query patterns

### Risk Notes

- `checkSiteAccess` makes a real Graph API call using the connector's OAuth token. If the token is expired or revoked, the call will fail. The function should handle token errors gracefully and return them as part of the `error` field.
- `getFilterAnalysis` is an approximation. It applies filter rules to discovery profile metadata, not to actual files. The counts may not exactly match what a real sync would produce. The response should include a note about this.
- `checkSiteAccess` requires decrypting the OAuth token. The Mongoose encryption plugin handles this automatically when loading the token document, but the service must use `.findOne()` (not `.lean()`) to trigger the plugin.

---

## Task Independence Matrix

**Note:** T-28, T-29, T-31, T-33, T-36, T-37 all create new files in `apps/search-ai/src/`. They add routes to `server.ts` at different import lines. For safe parallel execution, serialize the `server.ts` mount additions.

| Task | Can Parallel With                              | Blocked By         | Blocks                       |
| ---- | ---------------------------------------------- | ------------------ | ---------------------------- |
| T-26 | T-28, T-29, T-31, T-33, T-36, T-37             | T-10 (panel shell) | T-27, T-30, T-32, T-34, T-35 |
| T-27 | T-28, T-29, T-30, T-31, T-33, T-36, T-37       | T-26               | --                           |
| T-28 | T-26, T-27, T-29, T-30, T-31, T-33, T-36, T-37 | T-06 (audit model) | --                           |
| T-29 | T-26, T-27, T-28, T-30, T-31, T-33, T-36, T-37 | T-02 (pause fix)   | T-37 (partial)               |
| T-30 | T-28, T-29, T-31, T-33, T-36, T-37             | T-26               | --                           |
| T-31 | T-26, T-27, T-28, T-29, T-30, T-33, T-36, T-37 | --                 | --                           |
| T-32 | T-28, T-29, T-31, T-33, T-36, T-37             | T-26               | --                           |
| T-33 | T-26, T-27, T-28, T-29, T-30, T-31, T-36, T-37 | --                 | --                           |
| T-34 | T-28, T-29, T-31, T-33, T-36, T-37             | T-26               | --                           |
| T-35 | T-28, T-29, T-31, T-33, T-36, T-37             | T-26               | --                           |
| T-36 | T-26, T-27, T-28, T-29, T-30, T-31, T-33, T-37 | T-02 (pause fix)   | --                           |
| T-37 | T-26, T-27, T-28, T-29, T-30, T-31, T-33, T-36 | --                 | --                           |

**Recommended execution order:**

- **Batch 1 (parallel):** T-28 (backend monitoring routes), T-29 (enhanced sync progress), T-31 (notification routes), T-33 (permission schedule route), T-36 (error discriminator + retry), T-37 (utility routes). **Exception:** The `server.ts` mount edits (ST-28.5, ST-31.5, ST-36.4, ST-37.5) must be serialized or consolidated into a final "mount all new routers" step after all backend route files are created, to avoid merge conflicts on the same file region.
- **Batch 2 (after Batch 1, parallel):** T-26 (Overview tab -- largest frontend task)
- **Batch 3 (after T-26, parallel):** T-27 (sync progress view), T-30 (notification config), T-32 (permission sync status), T-34 (error state components), T-35 (empty state components)

**Rationale:** All backend tasks (T-28, T-29, T-31, T-33, T-36, T-37) are independent and can run in parallel. T-26 is the frontend foundation that all other frontend tasks depend on. T-27, T-30, T-32, T-34, T-35 all render inside T-26's Overview tab and can be parallelized once T-26 is complete.

---

## File Overlap Check (CRITICAL)

| File                                                                        | Tasks Touching It                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/search-ai/src/server.ts`                                              | T-28, T-31, T-36, T-37 (each adds import + mount line -- different imports, no functional overlap)                                                                                         |
| `apps/search-ai/src/services/connector.service.ts`                          | T-29 (enhance `getSyncStatus` at line 1145-1174)                                                                                                                                           |
| `packages/database/src/models/connector-config.model.ts`                    | T-29 (add syncState fields), T-31 (add notifications subdocument)                                                                                                                          |
| `apps/studio/src/hooks/useConnectorSync.ts`                                 | T-27 (extend `SyncStatusResponse` interface at lines 11-19)                                                                                                                                |
| `apps/studio/src/api/search-ai.ts`                                          | T-27 (add pauseConnectorSync, stopConnectorSync), T-30 (add saveNotificationConfig, testWebhook)                                                                                           |
| `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` | T-26 (replace overview placeholder with OverviewTab import)                                                                                                                                |
| `apps/studio/src/components/search-ai/sharepoint/OverviewTab.tsx`           | T-26 (create), T-27 (integrate SyncProgressView), T-30 (integrate NotificationConfig), T-32 (integrate PermissionSyncStatus), T-34 (integrate error states), T-35 (integrate empty states) |
| `packages/i18n/locales/en/studio.json`                                      | T-26, T-27, T-30, T-32, T-34, T-35 (each adds keys under different namespaces, no overlap)                                                                                                 |

**Overlap analysis:**

1. **`server.ts`** is touched by T-28, T-31, T-36, T-37 -- each adding a different import + `app.use()` mount line. These are additive operations at different lines. **Can be parallel** if each task appends at a distinct location. To be safe, serialize `server.ts` edits: T-28 first, then T-31, T-36, T-37 in any order.

2. **`connector-config.model.ts`** is touched by T-29 (syncState fields) and T-31 (notifications subdocument). Different subdocuments, no overlap. **Can be parallel** since they modify different schema sections.

3. **`search-ai.ts` (Studio API)** is touched by T-27 and T-30, each adding new functions at the end of the file. **Can be parallel** if appending to distinct line ranges.

4. **`OverviewTab.tsx`** is created by T-26 and then modified by T-27, T-30, T-32, T-34, T-35. **T-26 must complete first.** The subsequent tasks modify different sections of the component (SyncProgressView conditional, NotificationConfig section, PermissionSyncStatus section, error/empty state conditionals). **Serialize modifications** or have T-26 include placeholder sections for each integration point that subsequent tasks fill in.

5. **`useConnectorSync.ts`** is only touched by T-27. No cross-task overlap.

6. **`packages/i18n/locales/en/studio.json`** is touched by T-26, T-27, T-30, T-32, T-34, T-35 -- each adding keys under a different namespace. These are additive JSON operations under different paths. **Can be parallel** but may cause merge conflicts if not coordinated. Recommend serializing i18n edits or using distinct namespace paths (which is already the case).
