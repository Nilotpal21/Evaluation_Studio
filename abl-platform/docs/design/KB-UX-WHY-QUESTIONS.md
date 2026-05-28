# KB UX Enhancements — "Why" Questions for Product Discussion

**Date:** 2026-03-20
**Context:** After implementing 15 KB UX gaps (Phases 1–9), three rounds of "Why" questions were run across user journeys to surface design decisions that need product owner input.

---

## Priority: HIGH (6 items)

### 1. No UI to Clear Active Status Filter

**Journey:** NeedsAttentionCard → Data tab with statusFilter
**Issue:** When NeedsAttentionCard navigates to the Data tab with a pre-set filter (e.g., `statusFilter: 'error'`), there's no visible UI element showing the active filter or allowing the user to clear it. The filter chips in ChunksTable show active state, but DocumentTable has no equivalent filter chip UI — users may not realize they're seeing a filtered view.
**Question:** Should we add a visible "Filtered by: error" badge with a clear button to DocumentTable, matching ChunksTable's pattern?

### 2. No Edit Source Capability

**Journey:** SourcesTable → SourceDetailPanel
**Issue:** SourceDetailPanel shows source details and supports delete, but there's no edit capability. Users who need to update a source's configuration (URL, connection string, schedule) must delete and recreate.
**Question:** Is edit-source a planned feature? Should we add an edit button that's disabled with a tooltip ("Coming soon") to set expectations?

### 3. "View Documents" Filters by sourceType, Not sourceId

**Journey:** SourcesTable → onViewDocuments → DocumentTable
**Issue:** When clicking "View Documents" from a source row, the navigation sets `sourceType` filter in the pending filter store. But if a user has multiple sources of the same type (e.g., two 'web' sources), the filter shows documents from ALL web sources, not just the one they clicked.
**Question:** Should `onViewDocuments` filter by `sourceId` instead of `sourceType`? This would require extending DocumentTable's API call to support sourceId filtering.

### 4. ConnectorDetailPanel Missing Management Actions

**Journey:** SourcesTable → ConnectorDetailPanel (enterprise sources)
**Issue:** When clicking an enterprise source, ConnectorDetailPanel opens but it's read-only — no sync trigger, no delete, no edit. Non-enterprise sources get full management via SourceDetailPanel. This creates an inconsistent experience where enterprise connectors appear less manageable.
**Question:** Should ConnectorDetailPanel support sync-now, pause, and delete actions? Or is management of enterprise connectors intentionally handled elsewhere (admin portal)?

### 5. G9 sourceType Normalization is Frontend-Only

**Journey:** ConnectorsTab → addSource
**Issue:** The fix for G9 normalizes 'file' → 'manual' in ConnectorsTab's frontend code. But if other entry points create sources (API, bulk import, other UI paths), they could still send 'file' as the sourceType. The backend doesn't enforce this normalization.
**Question:** Should the backend also normalize sourceType on creation? Or is the frontend the only entry point for source creation?

### 6. consumeFilter Only Runs on Mount (Fragility)

**Journey:** Any navigation using setPendingFilter → DataSection
**Issue:** `consumeFilter` is called in a mount-only `useEffect` in DataSection. If DataSection is already mounted when a filter is set (e.g., user is already on Data tab and clicks a NeedsAttentionCard link), the filter won't be consumed because the effect doesn't re-run.
**Question:** Should we add a subscription pattern (e.g., `useEffect` watching the store's pending filter) instead of mount-only consumption? Or is re-mount guaranteed by the navigation flow?

---

## Priority: MEDIUM (7 items)

### 7. ProgressView Error Actions Are Generic

**Journey:** ProgressView → action links
**Issue:** When ProgressView shows errors (e.g., "3 documents failed"), the action link navigates to the Data tab generically. It doesn't set a statusFilter to pre-filter to errored documents, unlike NeedsAttentionCard which does set specific filters.
**Question:** Should ProgressView action links also use `setPendingFilter` with specific status filters, matching NeedsAttentionCard's behavior?

### 8. Multiple Stat Cards Navigate to Same Destination

**Journey:** OperationsDashboard stat cards → Data tab
**Issue:** "Total Documents", "Active Sources", and "Total Chunks" stat cards all navigate to the Data tab. Clicking any of them lands on the same view. The only difference would be if they pre-selected the appropriate SegmentedControl view (documents/sources/chunks).
**Question:** Should each stat card navigate to its corresponding view (documents → Documents view, sources → Sources view, chunks → Chunks view)?

### 9. Source Syncing Warning May Cause Alert Fatigue

**Journey:** NeedsAttentionCard health checks
**Issue:** Sources in 'syncing' state are shown as warnings in NeedsAttentionCard. But syncing is a normal, expected state — especially for scheduled connectors. Showing it as a warning alongside actual errors may dilute the signal and cause users to ignore the card.
**Question:** Should 'syncing' sources be shown as 'info' severity instead of 'warning'? Or omitted from NeedsAttentionCard entirely since syncing is expected behavior?

### 10. Credential Masking is Client-Side Only

**Journey:** SourceDetailPanel → connection string display
**Issue:** Connection string masking (`://***@`) happens in the frontend. The full connection string with credentials is sent over the API and exists in the browser's memory/network tab. A determined user or XSS attack could access the raw credentials.
**Question:** Should the backend mask or omit credentials before sending to the frontend? This is a defense-in-depth concern — the current approach works but credentials are in the API response.

### 11. ChunksTable Stats Are Misleading (Page-Local)

**Journey:** ChunksTable → stats bar
**Issue:** The status counts in ChunksTable's stats bar are computed from the current page of results only (e.g., "5 indexed, 2 pending" out of 20 visible chunks). But the total count is from the full dataset. This can mislead users — they see "Total: 1,247" but status breakdown only reflects 20 chunks.
**Question:** Should we add a separate stats endpoint that returns full status distribution? Or add a disclaimer like "Status counts shown for current page"?

### 12. Empty KB Dashboard Shows No Guidance

**Journey:** New KB with zero data → Home tab
**Issue:** When a KB has no sources, no documents, and no activity, the Home tab shows empty states in each card independently. There's no unified "Getting Started" experience guiding users through the first steps (add a source → upload documents → configure pipeline).
**Question:** Should we add a first-run experience / onboarding wizard for empty KBs?

### 13. Empty States Don't Reflect Filter Context

**Journey:** DataSection with active filter → no results
**Issue:** When a filter is active (e.g., statusFilter='error') and there are no matching results, the empty state shows the generic "No documents yet" message. It doesn't indicate that the empty state is because of the active filter, not because there's no data.
**Question:** Should empty states be context-aware? E.g., "No documents matching filter 'error'" with a "Clear filter" button?

---

## Priority: LOW (10 items)

### 14. ChunkExplorerDialog Opens with totalChunks=0

**Issue:** In ChunksTable, `ChunkExplorerDialog` is passed `totalChunks={0}` because the total for a specific document isn't available in the all-chunks context. The dialog may show "0 chunks" briefly before loading.

### 15. No Keyboard Shortcut for Panel Close

**Issue:** SlidePanel and CrawledPageViewer support Escape to close, but there's no visible hint of this. Power users may not discover it.

### 16. Health Check Polling at 30s May Be Too Aggressive

**Issue:** NeedsAttentionCard polls health every 30 seconds via SWR. For large deployments with many KBs open in tabs, this could create unnecessary load.

### 17. No Batch Operations in SourcesTable

**Issue:** Sources can only be deleted one at a time. No multi-select for bulk delete or bulk sync trigger.

### 18. ActivityFeed Load-More Accumulates in Memory

**Issue:** ActivityFeed appends pages to `allActivities` state without limit. A very active KB with users clicking "Load More" repeatedly could accumulate large arrays.

### 19. Date Formatting Not Locale-Aware

**Issue:** `formatDate()` and `formatRelativeTime()` use `toLocaleDateString` but the relative time strings ("5 minutes ago") use English-only i18n keys. RTL languages or non-Gregorian calendars may not render correctly.

### 20. No Confirmation Before Navigating Away from Unsaved State

**Issue:** If a user is in the middle of editing (e.g., SourceDetailPanel open, delete confirmation shown) and clicks a navigation element, the state is lost without warning.

### 21. Search in ChunksTable Has No Minimum Length

**Issue:** The debounced search fires after 300ms regardless of input length. Single-character searches may return too many results and stress the backend.

### 22. SourcesTable Enterprise Connector Map Refetches on Every Source Change

**Issue:** The `useEffect` that fetches enterprise connectors has `sources` in its dependency array. Any source list change (even just a status update from SWR revalidation) triggers a re-fetch of the connector map.

### 23. No Visual Indicator for Sort Direction in DataTable

**Issue:** DataTable columns support `sortable: true` but there's no visible indicator (arrow up/down) showing which column is sorted and in which direction.

---

## Round 4: Source Model & File Upload Deep-Dive (2026-03-21)

### 24. SourceDetailPanel is Wrong UI for File/Manual Sources — HIGH

**Journey:** User clicks a file/manual source in SourcesTable → SourceDetailPanel opens
**Issue:** The panel shows connector-style layout: "Configuration" section (empty — "No configuration"), "Last Sync" (meaningless for manual uploads), status badge. It's a generic shell designed for connector sources (database, API, web) reused for file sources where none of this applies. A file source user needs: list of uploaded files, drag-and-drop upload area, per-file delete, file type restrictions — none of which are shown.
**Question:** Should file/manual sources have a dedicated `FileSourcePanel` with file management UI, separate from a `ConnectorSourcePanel` for database/API/web?

### 25. Non-Enterprise Connector Sources (database/API/web) Have No Sync Controls — HIGH

**Journey:** User clicks a database or API source in SourcesTable → SourceDetailPanel opens
**Issue:** These sources have real configuration (connection strings, URLs, auth) displayed in the panel, but no sync controls — no "Sync Now", no "Pause", no "Re-crawl". The ConnectorDetailPanel (enterprise only) has all these controls. A database source that's stale has no way to trigger a refresh from this panel.
**Question:** Should SourceDetailPanel for connector-type sources (database, API, web) include sync trigger, pause, and schedule controls matching ConnectorDetailPanel's pattern?

### 26. Duplicate "Add Source" Buttons on Documents View — MEDIUM

**Journey:** User is on Data tab → Documents view
**Issue:** Two identical `<AddSourceButton>` components render simultaneously: one at the top-right of DataSection (line 111, always visible across all 3 views), and one inside SourceFilterBar (line 107, visible in Documents view only). When on Documents view, users see two identical "+ Add Source" buttons stacked vertically.
**Question:** Should the SourceFilterBar's Add Source button be removed since the top-level one covers all views? Or should the top-level one be hidden on Documents view to avoid duplication?

### 27. SourceFilterBar Groups by Type, Not by Individual Source — MEDIUM

**Journey:** User has 3 web sources → wants to see documents from just one
**Issue:** SourceFilterBar shows filter chips grouped by `sourceType` (e.g., "manual (2)", "web (3)"). Clicking "web" filters to ALL web source documents. There's no way to filter to a specific source by name/ID. If a user has "Product Docs" and "Marketing Blog" (both web type), they can't isolate documents from just one.
**Question:** Should the filter bar show individual sources (by name) instead of grouping by type? Or add a secondary dropdown for specific source selection within a type?

### 28. File Upload Source Selector Shows Only Names — No Context — MEDIUM

**Journey:** User opens FileUploadDialog → needs to pick which source to upload to
**Issue:** The source dropdown (`<select>`) lists manual sources by name only. No document count, no last upload date, no description. A user with 10 manual sources (e.g., "HR Policies", "Product Specs", "Training Materials") can distinguish by name, but can't see which one already has 500 documents vs. which is empty. No "recently used" indicator either.
**Question:** Should the source selector show richer context (document count, last upload date)? Should we highlight the most recently used source?

### 29. SharePoint = One Connector = One Source (No Multi-Site Support) — LOW

**Journey:** Admin configures SharePoint → wants to ingest from multiple SharePoint sites
**Issue:** Each SharePoint connector creates exactly one `SearchAISource` (1:1 relationship via `sourceId` on `EnterpriseConnector`). To ingest from 3 SharePoint sites, a user must create 3 separate connectors, each with its own OAuth setup. There's no multi-site connector concept.
**Question:** Is this the intended model? Should we support a single connector that maps to multiple sources (one per site/library)?

---

## Round 5: User Journey Gap Analysis (2026-03-21)

### Journey A: "I just created a KB and want to add my first content"

#### 30. No Guided First-Content Flow — HIGH

**Scenario:** New user creates KB → lands on Home tab → sees empty dashboard with zero stats, empty NeedsAttentionCard ("All healthy"), empty ActivityFeed ("No activity")
**Gap:** There's no call-to-action. The user has to discover on their own that they need to: (1) go to Data tab, (2) click Add Source, (3) pick a type, (4) configure it, (5) upload files or trigger sync. The empty Home tab looks like a finished state, not a starting point.
**Question:** Should the Home tab detect zero-source state and show a prominent "Get Started" wizard instead of the empty dashboard?

#### 31. Source Creation and File Upload Are Separate Flows — MEDIUM

**Scenario:** User clicks "+ Add Source" → picks "File Upload" type → enters source name → submits → source created → dialog closes → user is back at the table → now must find the upload button or re-open the source
**Gap:** After creating a file source, the user gets `onSourceAdded` which opens FileUploadDialog only if sourceType is manual/file (line 82-84 in DataSection). But this depends on AddSourceButton returning the source object, which only happens for file type (line 213: `onSourceAdded(selectedType === 'file' ? source : undefined)`). The flow works but feels disjointed — create source is step 1, upload is step 2, and there's a flash between them.
**Question:** Should file source creation flow directly into the upload area in a single continuous dialog? Create + Upload as one flow?

### Journey B: "I uploaded files last week, now I want to add more to the same source"

#### 32. No Quick "Upload More" Entry Point from Home Tab — MEDIUM

**Scenario:** User lands on Home tab → sees "150 documents" stat → wants to upload 10 more → must navigate: Data tab → switch to Sources view (or stay on Documents and find upload button) → find the right source → click upload icon
**Gap:** The most common repeated action (upload more files) requires 3+ clicks and view switching. No "Quick Upload" shortcut on Home tab.
**Question:** Should there be a "Quick Upload" button on the Home tab or in the header for KBs that have manual sources?

#### 33. Upload History Not Visible — LOW

**Scenario:** User uploaded 20 files yesterday, 5 failed → comes back today → no record of what was uploaded when, what failed, what succeeded
**Gap:** FileUploadDialog resets completely on close. ActivityFeed might show "source.sync" events but not individual file uploads. There's no upload history or batch tracking.
**Question:** Should we persist upload batch history (files, statuses, timestamps) and show it in the source detail panel?

### Journey C: "I have a database source that seems stale, I want to re-sync"

#### 34. No Sync Controls for Non-Enterprise Sources — HIGH (duplicate of #25, but different journey)

**Scenario:** User sees database source with "Last sync: 3 days ago" → clicks it → SourceDetailPanel opens → shows connection string and document count → no "Sync Now" button anywhere
**Gap:** The only way to trigger a sync for non-enterprise sources is... there isn't one from the UI. The user is stuck.
**Question:** Is sync for non-enterprise sources handled differently (cron? backend-only)? If yes, should the UI at least show the schedule and next sync time?

#### 35. Source Error State Has No Recovery Path — HIGH

**Scenario:** User sees source with status "error" → clicks it → SourceDetailPanel shows `syncError` message → only actions are "View Documents" and "Delete"
**Gap:** There's no "Retry", "Re-sync", "Test Connection", or "View Logs" action. The user knows something is wrong but can't do anything about it except delete the source and recreate it.
**Question:** Should error-state sources show diagnostic actions (test connection, view error logs, retry sync)?

### Journey D: "I want to understand why my search results are poor"

#### 36. No Connection Between Search Quality and Source/Document Health — MEDIUM

**Scenario:** User tests search queries in Search & Test tab → gets poor results → switches to Data tab → sees documents and chunks but no quality indicators
**Gap:** There's no way to trace a bad search result back to its source. ChunksTable shows token counts and status but no embedding quality score, no relevance indicators. DocumentTable shows status but not extraction quality. The user can't answer "is the problem in my data or my pipeline?"
**Question:** Should document/chunk views show quality metrics (extraction confidence, embedding similarity scores, chunk coverage)?

#### 37. Chunks View Doesn't Show Which Pipeline Processed Them — LOW

**Scenario:** User has multiple pipeline versions → some chunks were processed by v1, others by v2 → no way to tell which from ChunksTable
**Gap:** ChunksTable shows status, content preview, token count, but not `flowId` or pipeline version. After a reindex, user can't verify which chunks were reprocessed.
**Question:** Should ChunksTable show pipeline version/flowId as a column or filter?

### Journey E: "I want to reorganize my sources — move documents between them"

#### 38. No Document Move/Reassign Between Sources — MEDIUM

**Scenario:** User created "General Docs" source, uploaded 200 files → now wants to split into "HR Docs" and "Engineering Docs" → no way to move documents between sources
**Gap:** Documents are permanently tied to their source. The only way to reorganize is: download files → delete source → create new sources → re-upload. There's no move, copy, or reassign operation.
**Question:** Is document-source reassignment a valid use case? Or are sources intended to be immutable containers?

### Journey F: "I'm managing 20+ sources and need an overview"

#### 39. SourcesTable Has No Search or Filter — MEDIUM

**Scenario:** User has 25 sources across different types → wants to find "Marketing Blog" → must scroll through the entire table, no search input, no type filter
**Gap:** SourcesTable has no search bar and no filter chips (unlike ChunksTable which has both). DocumentTable has search + source type filter. SourcesTable is the least equipped for scale.
**Question:** Should SourcesTable have a search bar and/or type filter chips, especially for users with many sources?

#### 40. No Source Health Dashboard — LOW

**Scenario:** Admin managing 30 sources → wants a quick view: which sources are healthy, which are errored, which haven't synced in days
**Gap:** SourcesTable shows a small health summary bar (total/active/syncing/error counts) but no visual dashboard — no timeline of sync history, no "last sync" distribution chart, no aging alert for stale sources.
**Question:** At what source count does a dedicated health dashboard become necessary? Is the current table + health bar sufficient?

---

## Round 6: Wave 1 Implementation Review (2026-03-21)

Items #1, #3, #6, #8, #35 implemented. Post-implementation "Why Round" found 3 bugs (fixed inline) and 5 new gaps.

### Bugs Found & Fixed During Review

- **B1:** `sourceId` leaked into DocumentTable query when SourceFilterBar type chip was active — `activeSource._id` was passed alongside `sourceType`. Fixed: pass `activeSourceId ?? undefined` instead of `activeSourceId ?? activeSource?._id`.
- **B2:** `activeSourceId` not cleared when referenced source is deleted from the sources list — user sees empty table with no explanation. Fixed: added cleanup `useEffect` that clears stale `activeSourceId`.
- **B3:** `retrying` state not reset on source change in SourceDetailPanel — loading spinner would persist across source switches. Fixed: added `setRetrying(false)` to source-change reset effect.

### 41. Empty DocumentTable Shows No Hint of Active Status Filter — HIGH

**Journey:** OperationsDashboard "error (5)" → Data tab with statusFilter → all errors resolved → empty table
**Issue:** When `statusFilter` is active and all matching documents change status (e.g., errors resolved), DocumentTable shows generic "No documents" empty state. No hint that a filter is active and should be cleared. The filter badge is above the table in DataSection but DocumentTable's empty state doesn't reference it.
**Question:** Should DocumentTable's empty state detect when `statusFilter` is active and show "No documents matching status 'error'" with a clear action?

### 42. NeedsAttentionCard Source Errors Discard sourceId — HIGH

**Journey:** "2 sources with errors" in NeedsAttentionCard → "View in Data" → Sources view (all sources shown)
**Issue:** `checkSourceHealth` aggregates error sources into one issue with `dataView: 'sources'`, discarding individual `sourceId` values from `HealthSourceError`. For a KB with 20+ sources, user must scan the full table to find errored ones. The `PendingFilter` store now supports `sourceId` — single-error-source cases could navigate directly to that source's documents.
**Question:** For single-source errors, should the action navigate to `{ view: 'documents', sourceId: errorSource.sourceId }` instead of `{ view: 'sources' }`? For multi-source errors, should Sources view support a status pre-filter?

### 43. Source Error Navigation Is 4 Clicks Instead of 1 — HIGH

**Journey:** NeedsAttentionCard → Sources view → find error source → click → SourceDetailPanel → "View Documents"
**Issue:** Seeing documents from an errored source requires 4 steps. With `sourceId` filtering now working end-to-end, this could be 1 click: "View error source documents" → `setPendingFilter({ view: 'documents', sourceId, statusFilter: 'error' })`.
**Question:** Should NeedsAttentionCard's source error action change from navigating to Sources view to navigating directly to the errored source's documents?

### 44. ProgressView Does Not Leverage sourceId Filtering — LOW

**Journey:** KB in error state → ProgressView shows "View failed docs" → lands on documents with statusFilter only
**Issue:** ProgressView sets `{ view: 'documents', statusFilter: 'error' }` without source scoping. This is reasonable since ProgressView doesn't have source-level error info, but users in a multi-source KB see all errors mixed together.
**Question:** Acceptable for now, or should ProgressView show per-source error breakdown?

### 45. SourcesTable onViewDocuments Drops sourceName Parameter — LOW

**Journey:** Code analysis of SourcesTable → DataSection callback wiring
**Issue:** `SourcesTable` declares `onViewDocuments: (sourceId: string, sourceName: string) => void` but `DataSection` only captures `sourceId`. The source name for badge display is resolved via `sources.find()`. Works correctly now but the contract mismatch could mislead future developers.
**Question:** Simplify callback to `(sourceId: string) => void`, or use `sourceName` for display optimization?

---

## Round 7: Post-Review Why Round (2026-03-21)

Findings from code review loop after all Wave 1 fixes applied and reviewed to zero findings.

### Bugs Found & Fixed During Review

- **B4:** consumeFilter priority logic — `sourceId` + `view` combination caused `view` to override then `sourceId` to re-override, resulting in wasted state updates. Fixed: `sourceId` branch now takes full precedence (skips `view` setter).
- **B5:** "Retry Sync" label shown for healthy sources — misleading. Fixed: healthy sources show "Sync Now", error sources show "Retry Sync".
- **B6:** `selectedSource` in SourcesTable was a stale `useState` snapshot — after `onRefresh()`, panel still showed old status/error. Fixed: derived from `sources.find()` using `selectedSourceId`.

### 46. Compound statusFilter + activeSourceId Empty State Has No Filter Explanation — MEDIUM

**Journey:** User filters by status "error" from dashboard, then also selects a specific source → intersection returns 0 results
**Issue:** DocumentTable empty state says generic "No documents" despite two active filter badges being visible above. No mention of the compound filter narrowing results.
**Question:** Show "No documents matching these filters" with a "clear all filters" action?

### 47. View Tab Switch Does Not Clear statusFilter or activeSourceId — MEDIUM

**Journey:** User on Documents view with filters active → switches to Chunks → switches back → filters still applied
**Issue:** Filters are invisible on Chunks/Sources views but persist in local state. User returns to a filtered view with no memory of why.
**Question:** Clear document-level filters on tab switch, or show a "filtered view" indicator when returning?

### 48. SourceFilterBar "All" Chip Highlights When activeSourceId Overrides Type Filter — LOW

**Journey:** User has specific source selected → SourceFilterBar shows "All" highlighted → table shows only that source's docs
**Issue:** "All" implies no filter, but sourceId filter is active. Visual mismatch.
**Question:** Show distinct state in SourceFilterBar when sourceId is active?

### 49. Retry Sync Success Does Not Update Panel Status In-Place — MEDIUM (fixed B6)

Status: Fixed via derived `selectedSource` from fresh `sources` prop. Panel now auto-updates when sources list refreshes. Residual: backend sync is async — status may not change immediately even after refresh.

### 50. DataSection.onViewDocuments Ignores sourceName — Stale During Deletion Race — LOW

**Journey:** User clicks "View Documents" for source that is simultaneously deleted by another user
**Issue:** `sourceName` from callback is dropped; name is resolved from `sources` array which may no longer contain the source.
**Question:** Accept and store `sourceName` as fallback for display during source list transitions?

### 51. "Retry Sync" vs "Sync Now" Label Context — LOW (fixed B5)

Status: Fixed. Error sources show "Retry Sync", healthy sources show "Sync Now".

### 52. ChunksTable Status Counts Are Page-Local, Shown As Totals — MEDIUM

**Journey:** User on Chunks view sees "3 error" in stats bar → actually 300 errors across all pages
**Issue:** Stats computed from current page (max 20 items) but rendered without "approximate" qualifier.
**Question:** Add separate stats endpoint for chunks, or add "on this page" qualifier?

### 53. No Keyboard Focus Management When Filter Badge Cleared — LOW

**Journey:** Keyboard user clears a filter badge → focus drops to `<body>`
**Issue:** Badge DOM removal leaves no focus target. Need `aria-live` region or focus redirect.
**Question:** Move focus to next badge, search input, or table after clearing?

### 54. Invalid sourceId Shows Generic Error or Silently Clears — MEDIUM

**Journey:** Deep link with deleted sourceId → fetch returns empty → cleanup effect nulls sourceId → user sees all docs without explanation
**Issue:** No "source not found" feedback in either error or empty path.
**Question:** Detect sourceId not in sources array and show "Source may have been deleted" message?

### 55. Manual Source Panel With No Config Shows Sparse Empty State — LOW

**Journey:** New manual source → SourceDetailPanel → "No configuration" + 0 documents + generic actions
**Issue:** No onboarding guidance. Upload Files button not emphasized as primary next step.
**Question:** Promote Upload Files to primary when `documentCount === 0`?

---

## Round 8: Wave 2 Implementation Review (2026-03-21)

### 56. 2A: Why Only Single-Source Direct Navigation? — ANALYZED, CORRECT

**Journey:** NeedsAttentionCard shows "3 sources with sync errors" → user clicks → lands on sources view
**Analysis:** When multiple sources have errors, navigating to one source's documents would hide the others. The sources view gives a better overview. Single source → direct is unambiguous; multi → sources list is the right landing.
**Decision:** Correct as-is.

### 57. 2B: Why Doesn't "Clear Filters" Also Clear searchQuery? — ANALYZED, CORRECT

**Journey:** User has search + statusFilter → 0 results → sees "Clear Filters" but search stays
**Analysis:** Search has its own visible input field. Mixing search clearing into "Clear Filters" would be unexpected — filters and search are conceptually separate. Consistent with existing patterns.
**Decision:** Correct as-is.

### 58. 2C: Should activeFilter (sourceType Chip) Be Cleared on View Switch? — FIXED

**Journey:** User selects "Web" chip filter → switches to Sources → switches back to Documents → "Web" filter is gone
**Issue:** Original implementation cleared all 3 filters. But `activeFilter` is user-set from the visible chip bar, not externally injected. Clearing it is a regression from pre-Wave-2 behavior.
**Fix:** Only clear `statusFilter` and `activeSourceId` (externally-set). Preserve `activeFilter`.

### 59. 2D: Toast Fires on Mount Race Condition? — ANALYZED, NOT A BUG

**Analysis:** `sources` comes from parent SWR which is always fresher than health API. If health API has the source, `sources` should too. Cleanup only fires when `activeSourceId` is genuinely stale.

### 60. 2B: "Clear Filters" Priority Over "Upload Files" — ANALYZED, CORRECT

**Journey:** User filters by sourceId on manual source → 0 results → sees "Clear Filters" instead of "Upload Files"
**Analysis:** The filter is likely the cause of 0 results. Primary action should be to clear the filter. If still 0 after clearing, upload action will appear. Correct priority.

### 61. 2A: statusFilter: 'error' for Single-Source Navigation — FIXED

**Journey:** Source has sync errors → NeedsAttentionCard navigates with sourceId + statusFilter='error' → documents view shows 0 results because documents have status 'indexed', not 'error'
**Issue:** Source sync errors ≠ document status errors. `statusFilter` in data tab filters by document status.
**Fix:** Removed `statusFilter: 'error'` from single-source action. Just navigate to the source's documents.

### 62. 2D: Is the Toast Too Noisy? — ANALYZED, CORRECT

**Analysis:** Only fires when user has active sourceId filter AND source disappears (rare event). `toast.info` is appropriate — not error, just informational. Better than silent clearing.

---

## Round 9: Wave 3 Implementation Review (2026-03-21)

### 63. Manual Empty State Guards on onUploadFiles — ANALYZED, CORRECT

**Analysis:** Defensive guard. SourcesTable always passes `onUploadFiles` for manual/file types. The guard handles hypothetical future consumers that might not. Falls through to "View Documents" safely.

### 64. Manual Source 0 Docs Without onUploadFiles Callback — ANALYZED, CORRECT

**Analysis:** Defensive fallback path. Only one consumer (SourcesTable) and it always provides the callback for manual sources.

### 65. sync_automated Shows for Disabled Web Source Type — ANALYZED, CORRECT

**Analysis:** Web type is disabled in UI but could exist in DB via API. The "Sync is managed automatically" message is neutral and accurate for any non-enterprise connector source.

### 66. Backend Normalization Doesn't Migrate Existing 'file' Records — ANALYZED, NOT A BUG

**Analysis:** Frontend already handles both 'file' and 'manual' via `isManual` check. Normalization prevents new inconsistencies. Migration of existing data is a separate concern, not a regression.

### 67. AddSourceButton Removed from SourceFilterBar — ANALYZED, NO FUNCTIONALITY LOST

**Analysis:** DataSection header still has the button (visible across all views). SourceFilterBar removal only eliminates the duplicate per #26.

---

## Round 10: Full UX Audit — Home, Data, Search & Intelligence (2026-03-21)

Comprehensive "Why" round across all KB tabs. Focus on first-run experience, state accuracy, cross-tab consistency, and missing feedback.

### SetupGuide Issues (#68–#72)

#### 68. SetupGuide "Add Source" Navigates to Data Tab Instead of Opening Dialog — HIGH

**Journey:** New KB → SetupGuide → click "Add a data source" → lands on Data tab → empty table → user must find small "+" button
**Issue:** `SetupGuide.tsx:79` — `onClick: () => onNavigate?.('data')`. Pure tab switch. No `setPendingFilter`, no auto-open flag. The user clicked "Add Source" and expected to add a source — instead they got an empty page.
**Fix:** Add `autoOpenAddSource` flag to `data-tab-filter-store`. SetupGuide sets it, DataSection consumes it and auto-opens the AddSourceButton dialog.

#### 69. `hasPipeline` Check Is Always True — BUG — HIGH

**Journey:** SetupGuide shows "Configure Pipeline" as step 2
**Issue:** `SetupGuide.tsx:70` — `const hasPipeline = !!knowledgeBase.searchIndexId`. But `searchIndexId` is ALWAYS set during KB creation (`knowledge-bases.ts:149-184`), and a default pipeline is auto-seeded via `createDefaultPipeline()`. This checklist item shows as "done" (green checkmark) the moment the KB is created. The user never sees it as an actionable step.
**Fix:** Remove from checklist. Pipeline is auto-configured with sensible defaults. Power users can customize it in Intelligence tab.

#### 70. "Run Your First Search" Shown When There's Zero Data — MEDIUM

**Journey:** SetupGuide step 3 → user clicks → Search tab → searches → 0 results → confused
**Issue:** `SetupGuide.tsx:92-93` — "Run your first search" is clickable even when `documentCount === 0`. Searching an empty KB returns nothing. The step isn't actionable until data is ingested.
**Fix:** Disable step 3 until `documentCount > 0`. Show "Add content first" hint.

#### 71. No LLM Status Visibility in Setup or Dashboard — MEDIUM

**Journey:** New KB → all steps "done" → search returns nothing → no explanation
**Issue:** SetupGuide and OperationsDashboard have zero awareness of LLM configuration. If tenant has no LLM credentials, search degrades to static vocabulary matching silently. No banner, no warning, no health check for LLM availability.
**Fix:** Add LLM status to SetupGuide (conditional step: "Configure LLM for intelligent search"). Show LLM status in OperationsDashboard. Add LLM health check to NeedsAttentionCard.

#### 72. SetupGuide Doesn't Reflect Actual User Journey — MEDIUM

**Issue:** Current checklist: Add Source → Configure Pipeline (always done) → Run Search (not actionable). Actual journey: Add Content → (optionally) Configure LLM → Test Search. The checklist should match what users actually need to do, not internal system concepts.

### Home Tab State Machine Issues (#73–#78)

#### 73. Sources Added + 0 Documents Shows OperationsDashboard With All Zeroes — HIGH

**Journey:** User adds a file source but hasn't uploaded files yet → status is `active`
**Issue:** `HomeSection.tsx:27` — setup state requires `sources.length === 0 AND documentCount === 0`. If sources exist but no docs, it falls through to `operations`, showing a dashboard with "0 documents, 0 chunks" — looks like a broken mature KB instead of a KB waiting for content.
**Fix:** Add intermediate state: `sources.length > 0 AND documentCount === 0 AND status === 'active'` → show "Waiting for content" state with upload prompt.

#### 74. ProgressView Has No Label for `rebuilding` Status — LOW

**Issue:** `ProgressView.tsx:44-55` — `statusLabel()` has no case for `'rebuilding'`, falls through to generic `status_default`. User triggering a reindex sees a vague message.
**Fix:** Add `rebuilding` case with "Rebuilding index..." label.

#### 75. ProgressView Error State Always Shows "Configure LLM" Regardless of Cause — MEDIUM

**Issue:** `ProgressView.tsx:100-119` — Error actions hardcode "Configure LLM" and "View Failed Docs". But errors can be embedding failures, vector store issues, connectivity problems. Showing "Configure LLM" for a Qdrant connection error is misleading.
**Fix:** Show generic "View Error Details" action, or inspect error type to show relevant action.

#### 76. NeedsAttentionCard Has No LLM or Embedding Health Check — MEDIUM

**Issue:** 4 checkers exist: source health, pipeline health, circuit breaker, document health. Missing: LLM credential validity, embedding service availability, stale index warning (lastIndexedAt very old).
**Fix:** Add LLM health checker. At minimum: check if `queryLLMConfig` can resolve to a model.

#### 77. Progress Bar Caps at 90%, Never Shows Completion — LOW

**Issue:** `ProgressView.tsx:18` — `MAX_PROGRESS = 0.9`. Progress jumps from ~90% to disappearing when state machine transitions to `operations`. No "Complete!" state.
**Fix:** Minor UX polish. Show 100% briefly before transitioning.

#### 78. HALF_OPEN Circuit Breaker Shows "Open" Message — LOW

**Issue:** `NeedsAttentionCard.tsx:121-129` — HALF_OPEN reuses `circuit_breaker_open` i18n key. Semantically incorrect: HALF_OPEN means testing recovery, not fully open.
**Fix:** Add `circuit_breaker_half_open` i18n key with appropriate message.

### Data Tab Issues (#79–#86)

#### 79. 3 In-Progress Document Statuses Missing From Badge Map — HIGH

**Issue:** `DocumentTable.tsx:43-49` — Badge map covers `indexed`, `enriched`, `extracted`, `pending`, `error`. Missing: `extracting`, `enriching`, `embedding` (defined in `search-ai-sdk/constants.ts:60-69`). In-progress documents look identical to `pending` — user can't tell if a document is queued or actively processing.
**Fix:** Add 3 statuses with distinct "processing" badge variant (e.g., blue/info with spinner indication).

#### 80. `disabled` Source Status Missing From SourcesTable Badge Map — MEDIUM

**Issue:** `SourcesTable.tsx:29-34` — Map covers `active`, `pending`, `syncing`, `error`. Missing: `disabled`. Disabled sources render as `pending`. Admin can't distinguish intentionally-off sources.
**Fix:** Add `disabled` variant (e.g., gray with "Disabled" label).

#### 81. SourcesTable Health Summary Ignores `disabled` and `pending` Counts — MEDIUM

**Issue:** `SourcesTable.tsx:115-125` — Only tracks active/syncing/error. Numbers don't add up: 10 total, 5 active, 2 error = 3 unaccounted.
**Fix:** Add disabled/pending to health bar.

#### 82. CrawledPageViewer "Original" and "Side by Side" Tabs Non-Functional for Non-Web Documents — HIGH

**Issue:** `CrawledPageViewer.tsx:145-153` — Tabs include "Original" (renders HTML via `rawHtmlUrl`) and "Side by Side". For PDF/DOCX uploads, `rawHtmlUrl` is null. Two of four tabs show empty panes with no explanation. The component name itself reveals it was designed for web crawl results only.
**Fix:** Conditionally hide "Original" and "Side by Side" tabs when document is not web-sourced, or show "Original not available for uploaded files" placeholder.

#### 83. No Duplicate File Detection in FileUploadDialog — MEDIUM

**Issue:** `FileUploadDialog.tsx:169-189` — `validateAndAddFiles` checks extension and size but not duplicates. Dropping the same file twice creates duplicate documents.
**Fix:** Deduplicate by filename before adding to queue. Show warning if duplicate detected.

#### 84. Sequential Upload With No Cancel/Abort — MEDIUM

**Issue:** `FileUploadDialog.tsx:329-349` — Files uploaded in a `for`/`await` loop. Cancel button disabled during upload. No abort mechanism. User is locked into an uninterruptible sequence.
**Fix:** Add AbortController support. Re-enable Cancel to stop remaining uploads.

#### 85. Inline Delete Confirmation in SourcesTable Is Fragile — MEDIUM

**Issue:** `SourcesTable.tsx:240-274` — Single `confirmDeleteId` state. Clicking delete on source B while A's confirmation is showing silently dismisses A. No cascade warning (documents will be deleted). Inconsistent with DocumentTable which uses a proper modal.
**Fix:** Use `ConfirmDialog` modal matching DocumentTable pattern. Include document count warning.

#### 86. KnowledgeGraphCard Has Hardcoded English String Bypassing i18n — LOW

**Issue:** `KnowledgeGraphCard.tsx:66-67` — Template literal `` `${total} attribute${total === 1 ? '' : 's'} need review` `` bypasses `t()`.
**Fix:** Use i18n key with ICU plural syntax.

### Search & Intelligence Tab Issues (#87–#95)

#### 87. Two Separate Search Inputs With No Shared State — HIGH

**Journey:** Search & Test tab → user types query in Playground → sees results → scrolls down to Debug section → must retype the same query
**Issue:** `SearchTestSection.tsx:129-209` — QueryPlaygroundTab has its own search input. Debug section has a completely separate search input. They fire independently. No shared query state.
**Fix:** Unify into single search input that populates both result views. Or auto-populate debug input from playground query.

#### 88. Search Tab Has Zero LLM Awareness — HIGH

**Journey:** User navigates to Search tab → types query → gets generic error → no explanation
**Issue:** Neither SearchTestSection nor QueryPlaygroundTab check LLM config. If no LLM configured, search fails with a sanitized error string. No proactive banner like "Configure an LLM model to enable search" with link to Intelligence > LLM Models.
**Fix:** Check LLM readiness on mount. Show banner if not configured.

#### 89. Search "No Results" Doesn't Distinguish "No Data" From "No Matches" — MEDIUM

**Issue:** `QueryPlaygroundTab.tsx:350-355` — Same `EmptyState` for zero-doc KB and a query that just didn't match. User can't tell if the problem is missing data or a bad query.
**Fix:** Check `documentCount` and show different message: "Your KB has no indexed documents yet" vs "No results matched your query."

#### 90. No Guard When `indexId` Is Empty String — MEDIUM

**Issue:** `KBDetailLayout.tsx:57` — `indexId ?? ''` passed to all tabs. SWR calls hit malformed URLs like `/indexes//query`. Should show "Index not ready" state.
**Fix:** Guard at layout level. Don't render data-dependent tabs if `indexId` is null.

#### 91. Search Tab State Lost on Tab Switch — MEDIUM

**Issue:** All state in SearchTestSection/QueryPlaygroundTab is `useState`. Switching to Data tab and back loses query text, results, debug trace, selections.
**Fix:** Persist query/results in Zustand store or keep component mounted (hidden) across tab switches.

#### 92. PipelineCard Shows "Not Configured" During Indexing — LOW

**Issue:** `PipelineCard.tsx:32-35` — Only checks `status === 'active'` for healthy. Indexing/creating KB shows as "not-configured" in IntelligenceHub.
**Fix:** Handle indexing/creating states as intermediate (blue/processing indicator).

#### 93. ActivityFeed Has No Document Events and No Auto-Refresh — LOW

**Issue:** Activity registry (`ActivityFeed.tsx:36-70`) tracks source.sync, index.rebuild, pipeline/vocabulary/mapping changes. No document upload, document deletion, or processing events. Also no `refreshInterval` — feed only updates on mount.
**Fix:** Add document event types. Add 30s polling or event-driven refresh.

#### 94. OperationsDashboard Stats Use Parent Props, Not Own SWR Fetch — LOW

**Issue:** Stat cards use `knowledgeBase.documentCount` and `connectorCount` from parent. Document Status section does its own SWR fetch. Numbers can diverge.
**Fix:** Minor — accept or align refresh timing.

#### 95. Header Metrics All Navigate to Same "data" Tab — LOW

**Issue:** `KBHeader.tsx:43-60` — Documents, Chunks, Sources metrics all navigate to `data`. Unlike OperationsDashboard stat cards which set `setPendingFilter({ view: 'sources' })` etc, header metrics don't set a view.
**Fix:** Set appropriate `pendingFilter` with view matching the clicked metric.

---

## Recommended Next Steps

### Completed (Wave 1)

- ~~#1 Active filter badge with clear button~~ — DONE
- ~~#3 sourceId filtering end-to-end~~ — DONE
- ~~#6 Reactive consumeFilter~~ — DONE
- ~~#8 Stat card view-specific navigation~~ — DONE
- ~~#35 Error source recovery actions~~ — DONE
- ~~#49 SourceDetailPanel stale snapshot~~ — DONE (B6)
- ~~#51 Retry/Sync label context~~ — DONE (B5)

### Completed (Wave 2)

- ~~#42, #43: NeedsAttentionCard sourceId navigation~~ — DONE
- ~~#41, #46: Context-aware empty states~~ — DONE
- ~~#47: Clear filters on view tab switch~~ — DONE
- ~~#54: Invalid sourceId toast notification~~ — DONE

### Completed (Wave 3)

- ~~#24, #55: Manual source upload-focused panel + onboarding hint~~ — DONE
- ~~#25, #34: Non-enterprise connector sync info message~~ — DONE
- ~~#26: Duplicate AddSourceButton removed from SourceFilterBar~~ — DONE
- ~~#5: Backend sourceType validation + normalization~~ — DONE
- ~~Regression tests for B1, B2, B4, #58, #61~~ — DONE (8 tests)
- #2: Edit source — DEFERRED (product decision, read-only is implicit)

### Wave 4 — SetupGuide & First-Run Fix (HIGH impact, foundational)

**Theme:** Fix the new-user experience before adding features on top of it.

1. **#68:** SetupGuide "Add Source" auto-opens dialog — HIGH
2. **#69:** Remove dead "Configure Pipeline" checklist item — HIGH (bug fix, ~5 lines)
3. **#70:** Disable "Run Search" step until data exists — MEDIUM
4. **#72:** Redesign checklist: Add Content → Configure LLM (conditional) → Test Search — MEDIUM
5. **#73:** State machine gap: sources + 0 docs → intermediate "waiting for content" state — HIGH
6. **#71, #76:** LLM status visibility: SetupGuide conditional step + NeedsAttentionCard health check — MEDIUM

### Wave 5 — Data Accuracy & Status Fidelity (Correctness)

**Theme:** Make statuses and numbers trustworthy.

7. **#79:** Add 3 missing in-progress document statuses to badge map — HIGH
8. **#80, #81:** Add `disabled` source status + fix health summary counts — MEDIUM
9. **#52:** ChunksTable stats accuracy (per-page vs totals) — MEDIUM
10. **#82:** CrawledPageViewer hide non-functional tabs for non-web docs — HIGH
11. **#9:** Syncing severity downgrade in NeedsAttentionCard — LOW
12. **#78:** HALF_OPEN circuit breaker message fix — LOW

### Wave 6 — Search Tab UX (User-facing quality)

**Theme:** Make Search & Test tab functional and self-explanatory.

13. **#87:** Unify two search inputs into single shared query — HIGH
14. **#88:** LLM awareness banner on Search tab — HIGH
15. **#89:** Distinguish "no data" vs "no matches" in search results — MEDIUM
16. **#90:** Guard for empty `indexId` across all tabs — MEDIUM
17. **#91:** Persist search state across tab switches — MEDIUM

### Wave 7 — Filter & Discoverability (Original Wave 4 items)

**Theme:** Scale the Data tab for users with many sources/documents.

18. **#7, #13, #27:** Filter improvements + context-aware empty states — MEDIUM
19. **#39:** SourcesTable search/filter — MEDIUM
20. **#48:** SourceFilterBar visual state for sourceId — LOW
21. **#44:** ProgressView sourceId filtering — LOW

### Wave 8 — Upload & Delete Robustness

**Theme:** Make destructive and additive operations reliable.

22. **#83:** Duplicate file detection in FileUploadDialog — MEDIUM
23. **#84:** Upload cancel/abort support — MEDIUM
24. **#85:** SourcesTable delete confirmation → proper modal with cascade warning — MEDIUM
25. **#30, #31, #32, #28:** Onboarding + upload UX (original Wave 5) — MEDIUM

### Backlog (Active)

- **#4:** ConnectorDetailPanel management actions — enterprise feature, needs product decision
- **#10:** Backend credential masking — security track, not UX
- **#53:** Keyboard focus management on filter badge clear — a11y
- **#75:** ProgressView error state always shows "Configure LLM" — needs error type inspection
- **#86:** KnowledgeGraphCard hardcoded English string — i18n fix
- **#92:** PipelineCard "not-configured" during indexing — LOW
- **#93:** ActivityFeed no document events, no auto-refresh — LOW
- **#94:** OperationsDashboard stats stale vs SWR — LOW
- **#95:** Header metrics don't set view-specific pendingFilter — LOW
- **#74:** ProgressView no `rebuilding` label — LOW
- **#77:** Progress bar caps at 90% — LOW

### Backlog (Deferred — review notes for future why rounds)

- ~~**#11:** ChunksTable stats page-local~~ — **Duplicate of #52** (tracked in Wave 5). If raised again, point to #52.
- ~~**#12:** Empty KB dashboard no guidance~~ — **Superseded by #68-#73** (tracked in Wave 4). SetupGuide redesign covers this.
- ~~**#36:** Search quality ↔ source health connection~~ — **Feature epic, not UX gap.** Would require new backend endpoints for quality scores, embedding similarity, extraction confidence. Needs its own RFC if product decides to pursue. Not a bug or missing UX pattern.
- ~~**#38:** Document move/reassign between sources~~ — **Product design decision, not UX bug.** Sources are immutable containers in current model. Reassignment would require reprocessing through pipeline. If product wants this, needs separate RFC covering data model implications.
- ~~**#45:** SourcesTable.onViewDocuments drops sourceName~~ — **No user impact.** Name is correctly resolved via `sources.find()`. Extra callback parameter is harmless.
- ~~**#50:** DataSection.onViewDocuments stale sourceName during deletion race~~ — **Extremely unlikely race condition.** Negligible impact.
