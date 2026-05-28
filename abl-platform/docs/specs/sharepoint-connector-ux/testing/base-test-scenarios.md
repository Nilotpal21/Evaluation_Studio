# SharePoint Connector UX — Base Test Scenarios

**Source:** SHAREPOINT-DESIGN-FINAL-v3.md + HLD + Phase 1 Capability Notes (C-01 through C-12)
**Coverage Target:** All 4 waves, all 12 cards, all edge cases
**Excluded from scope:** Delegation flow, email notifications

---

## Traceability Matrix

| Wave      | Cards Covered                 | E2E Scenarios | Integration Scenarios | LLD-Derived | Total   |
| --------- | ----------------------------- | ------------- | --------------------- | ----------- | ------- |
| 1         | C-01, C-07, C-09 (foundation) | 8             | 8                     | 39          | 55      |
| 2         | C-02, C-03, C-04, C-05        | 16            | 13                    | 52          | 81      |
| 3         | C-08, C-11                    | 15            | 9                     | 56          | 80      |
| 4         | C-06, C-09, C-10, C-12        | 11            | 9                     | 63          | 83      |
| CW        | Cross-wave                    | 5             | --                    | --          | 5       |
| **Total** |                               | **55**        | **39**                | **210**     | **304** |

---

## Wave 1: Foundation (T-01 to T-12)

**Cards:** C-01 (Panel Shell & Navigation), C-07 (Draft Mode), C-09 (SourcesTable — foundation), plus backend bug fixes

### E2E Scenarios

#### E2E-W1-01: Panel Opens from Flow A (New KB, Home Tab)

- **User Journey:** First-time user with an empty KB clicks "Connect Source" on the SetupGuide, selects SharePoint from the type picker dialog, and the Detail Panel slides in.
- **Design Reference:** §2 Flow A (lines 57-110), C-01 UI Behaviors
- **Preconditions:** KB exists with 0 sources and 0 documents. User is authenticated with project access.
- **Steps:**
  1. Navigate to KB Detail Page, Home tab
  2. Verify SetupGuide renders with "Upload Files" and "Connect Source" cards
  3. Click "Connect Source" button
  4. Verify Add Source dialog opens on the Home tab (no tab switch to Data)
  5. Click "SharePoint" in the type picker
  6. Verify dialog closes
  7. Verify Detail Panel slides in from right at 720px width
  8. Verify Connect tab is active, other tabs show lock icons
- **Expected Outcome:** Panel opens with Connect tab active on the Home tab. No navigation to Data tab occurs until after setup completes.
- **Error Path:** If API to create draft connector fails, panel should show error state with retry option.
- **Edge Cases:** [C-01 Edge Case: Browser back/forward with panel open — back button should not close panel unless URL-tracked]

#### E2E-W1-02: Panel Opens from Flow D (Existing Connector Click)

- **User Journey:** User navigates to Data tab > Sources, clicks an existing Active SharePoint connector row, and the Detail Panel opens with Overview tab active.
- **Design Reference:** §2 Flow D (lines 186-225), C-01 UI Behaviors
- **Preconditions:** KB has at least one Active SharePoint connector. SourcesTable is visible on Data tab > Sources segment.
- **Steps:**
  1. Navigate to KB Detail Page > Data tab > Sources segment
  2. Click the SharePoint source row/card
  3. Verify Detail Panel slides in at 720px
  4. Verify Overview tab is active (not Connect tab)
  5. Verify connector name appears in panel header
  6. Verify [<>] expand button and [X] close button are present
  7. Click [X] to close panel
  8. Verify panel slides out and SourcesTable is fully visible
- **Expected Outcome:** Panel opens with Overview tab for Active connector. Panel closes cleanly on [X] click.
- **Error Path:** If GET connector returns 404 (deleted by another user), panel should show "Connector no longer exists" error and close gracefully. (C-01 Edge Case)
- **Edge Cases:** [C-01 Edge Case: Panel already open, user clicks different connector row — should swap connectors]

#### E2E-W1-03: Panel Tab Routing by Connector Status

- **User Journey:** User opens connectors in different statuses and verifies the correct initial tab is shown for each status.
- **Design Reference:** §3 Architecture Diagram (lines 290-336), C-01 UI Behaviors, C-09 Row Click Routing
- **Preconditions:** KB has connectors in Draft, Awaiting Auth, Active, Syncing, and Error states.
- **Steps:**
  1. Click a "Draft" connector row — verify Connect tab is active, other tabs locked
  2. Close panel, click an "Awaiting Auth" connector row — verify Connect tab is active
  3. Close panel, click an "Active" connector row — verify Overview tab is active
  4. Close panel, click a "Syncing" connector row — verify Overview tab shows sync progress
  5. Close panel, click an "Error" connector row — verify Overview tab shows error state
- **Expected Outcome:** Each status routes to the correct initial tab per design specification.
- **Error Path:** If connector status is unknown/unexpected, panel should default to Overview tab.
- **Edge Cases:** [C-09 Edge Case: Rapid status transitions — Draft to Awaiting Auth quickly should not flash intermediate states]

#### E2E-W1-04: Simplified View Toggle Persistence

- **User Journey:** User toggles Simplified View OFF, closes the panel, reopens it, and verifies the preference persisted.
- **Design Reference:** §4 Panel Structure (lines 540-598), C-01 Simplified View toggle
- **Preconditions:** Active connector exists. localStorage is accessible.
- **Steps:**
  1. Open Detail Panel for an Active connector
  2. Verify Simplified View is ON by default (tabs: Connect, Proposal, Preview, Security)
  3. Toggle Simplified View to OFF
  4. Verify additional tabs appear: Scope+Filters, History
  5. Close the panel
  6. Reopen the panel for the same connector
  7. Verify Simplified View is still OFF with all tabs visible
- **Expected Outcome:** Simplified View preference is persisted per-user in localStorage across panel open/close cycles.
- **Error Path:** If localStorage is unavailable (private browsing), Simplified View should default to ON without error. (C-01 Edge Case)
- **Edge Cases:** [C-01 Edge Case: User toggles Simplified ON while on a hidden tab (Scope+Filters) — should redirect to nearest available tab]

#### E2E-W1-05: Draft Mode — Configure Before Auth

- **User Journey:** User creates a new SharePoint connector, configures filters and schedule while auth is pending, then resumes from SourcesTable after closing browser.
- **Design Reference:** §5 Draft Mode (lines 1968-2012), C-07 UI Behaviors
- **Preconditions:** User can create a new connector. Auth will remain pending (simulated delay).
- **Steps:**
  1. Create a new SharePoint connector via Add Source flow
  2. Verify panel header shows connector name with "(Draft)" suffix
  3. Verify Connect tab shows "Connect\*" with asterisk and footnote
  4. Verify info banner: "Waiting for authentication..."
  5. Navigate to Scope+Filters tab (if Full View)
  6. Verify Sites section is disabled with "Will be populated after authentication and discovery" placeholder
  7. Verify Filters section is fully editable — select "Documents Only" template
  8. Set schedule frequency to "Every 6 hours"
  9. Verify persistence message at bottom: "These settings will apply automatically when auth completes"
  10. Close panel
  11. Verify connector appears in SourcesTable with "Draft" or "Awaiting Auth" badge
  12. Click the connector row to reopen
  13. Verify all previously configured settings are preserved
- **Expected Outcome:** Draft configuration is persisted server-side, survives panel close/reopen, and pre-configured filter/schedule settings are retained.
- **Error Path:** If PATCH draft update fails, show save error with retry option. (C-07 Edge Case: Browser refresh during draft edit)
- **Edge Cases:** [C-07 Edge Case: Auth fails — all draft config must be preserved, user can retry or switch auth methods. C-07 Edge Case: Multiple draft connectors — each maintains independent config]

#### E2E-W1-06: Expand/Collapse Panel

- **User Journey:** User clicks [<>] expand button to go full viewport, then collapses back to 720px.
- **Design Reference:** §4 Panel Structure, C-01 Expand/Collapse, C-04 Panel Expansion
- **Preconditions:** Active connector with Simplified View OFF (to access Scope+Filters).
- **Steps:**
  1. Open Detail Panel at 720px
  2. Click [<>] expand button
  3. Verify panel expands to full viewport width
  4. Click [<- Back to panel view]
  5. Verify panel returns to 720px
  6. Navigate to Scope+Filters tab
  7. Verify panel auto-expands to full viewport with 300ms ease-out animation
  8. Switch to a non-Scope+Filters tab
  9. Verify panel auto-collapses back to 720px
- **Expected Outcome:** Manual and automatic expand/collapse work correctly. Scope+Filters auto-expands on activation.
- **Error Path:** On narrow viewports (<720px), panel should go full-screen rather than overflow.
- **Edge Cases:** [C-01 Edge Case: Rapid tab switching — debounce to avoid expand/collapse flicker. C-04 Edge Case: localStorage unavailable — collapse state defaults without persistence]

#### E2E-W1-07: More Actions Menu Operations

- **User Journey:** User opens the More Actions overflow menu and performs available actions.
- **Design Reference:** §4 Panel Structure (line 567), C-01 More Actions menu
- **Preconditions:** Active connector with sync history.
- **Steps:**
  1. Open Detail Panel for an Active connector
  2. Click [...] More Actions button
  3. Verify dropdown shows: Clone, Export JSON/YAML, Import Config, Run Health Check, Diagnostics, Delete
  4. Click "Delete"
  5. Verify confirmation dialog appears
  6. Confirm deletion
  7. Verify panel closes and SourcesTable refreshes (deleted connector gone)
- **Expected Outcome:** More Actions menu renders all items; Delete triggers confirmation then removes the connector.
- **Error Path:** If delete API fails (409 Conflict — sync in progress), show error explaining why deletion is blocked.
- **Edge Cases:** [C-01 Edge Case: Connector deleted by another user while panel open — GET returns 404, show error and close]

#### E2E-W1-08: Concurrent Editing Banner

- **User Journey:** Two users open the same connector simultaneously; the second user sees a concurrent editing banner.
- **Design Reference:** §4 Panel Structure (lines 569-576), C-01 Concurrent editing banner
- **Preconditions:** Active connector. Concurrent editing presence endpoint is available.
- **Steps:**
  1. User A opens the Detail Panel for connector X
  2. User B opens the Detail Panel for connector X
  3. Verify User B sees banner: "{User A email} is also editing this connector"
  4. Verify [Refresh to see latest] button is present
  5. Click [Refresh to see latest]
  6. Verify panel data refreshes
- **Expected Outcome:** Presence polling detects concurrent editors and shows warning banner.
- **Error Path:** If presence API is unavailable, banner should not appear (graceful degradation).
- **Edge Cases:** [C-07 Edge Case: Concurrent edits — PATCH conflicts should handle 409 gracefully]

### Integration Scenarios

#### INT-W1-01: OAuth State Moved to Redis (Bug B8 Fix)

- **Components Under Test:** Auth service, Redis, OAuth state store
- **Design Reference:** HLD §4e Bug B8, C-02 Edge Case 8
- **Setup:** Two instances of the auth service running (simulating multi-pod deployment).
- **Trigger:** Initiate OAuth auth on pod A, callback arrives at pod B.
- **Assertions:**
  1. OAuth state written via `SET NX PX` pattern in Redis
  2. Callback on any pod can resolve the state
  3. State expires after TTL (no stale state accumulation)
  4. Concurrent auth attempts for different connectors do not conflict
- **Failure Modes:** Redis connection failure — auth should fail with clear error, not hang.

#### INT-W1-02: resolveScopes Returns Correct Scopes (Bug B1 Fix)

- **Components Under Test:** SharePoint connector service, resolveScopes method
- **Design Reference:** HLD §4e Bug B1, C-02, C-03, C-06
- **Setup:** Connector with permission-aware search enabled.
- **Trigger:** Call resolveScopes() for the connector.
- **Assertions:**
  1. Returns `Sites.Read.All` + `Files.Read.All` + `offline_access` (not `Sites.FullControl.All`)
  2. When permission-aware search is enabled, also returns `GroupMember.Read.All`
  3. When permission-aware search is disabled, omits `GroupMember.Read.All`
- **Failure Modes:** If resolveScopes still returns FullControl, auth will request wrong permissions from Microsoft.

#### INT-W1-03: Pause/Resume Sync Implementation (Bug B7 Fix)

- **Components Under Test:** SharePointConnector service, BullMQ job lifecycle
- **Design Reference:** HLD §4e Bug B7, C-05, C-08
- **Setup:** Active connector with a sync job in progress.
- **Trigger:** Call `pauseSync()` then `resumeSync()`.
- **Assertions:**
  1. `pauseSync()` does not throw "not implemented"
  2. Sync job transitions to paused state
  3. `resumeSync()` resumes from the checkpoint, not from the beginning
  4. Sync status endpoint reflects paused/resumed states accurately
- **Failure Modes:** If BullMQ job is in a terminal state, pause should return an appropriate error.

#### INT-W1-04: ConnectorSchema and FieldMapping Model Registration (Bug B9/B10 Fix)

- **Components Under Test:** ModelRegistry, ConnectorSchema model, FieldMapping model
- **Design Reference:** HLD §4e Bug B9/B10, C-04
- **Setup:** Standard application bootstrap.
- **Trigger:** Query ConnectorSchema and FieldMapping via ModelRegistry standard patterns.
- **Assertions:**
  1. `ModelRegistry.get('ConnectorSchema')` returns the model (not undefined)
  2. `ModelRegistry.get('FieldMapping')` returns the model (not undefined)
  3. Standard CRUD queries work via ModelRegistry pattern (findOne with tenantId)
- **Failure Modes:** Unregistered models cause query failures in downstream scope/filter operations.

#### INT-W1-05: Permission Crawler Fixes (Bug B2, B3, B4, B5)

- **Components Under Test:** Permission crawler service, Graph API integration
- **Design Reference:** HLD §4e Bug B2/B3/B4/B5, C-06
- **Setup:** SharePoint site with group-based permissions and drive-level permissions.
- **Trigger:** Run permission crawl.
- **Assertions:**
  1. SharePoint group IDs are correctly mapped to Azure AD group IDs via Graph API lookup (B2)
  2. Missing `grantedToV2.group` is handled with fallback to group name resolution (B3)
  3. `getDrivePermissions()` is called during the permission crawl flow (B4)
  4. Permission modes are only "enabled" or "disabled" — no "simplified" option (B5)
- **Failure Modes:** Graph API rate limiting during group ID resolution — should retry with backoff.

#### INT-W1-06: SWR Hooks Provide Connector Data

- **Components Under Test:** useConnector, useConnectorList, useConnectorSync SWR hooks, REST API
- **Design Reference:** HLD §4g, C-01 API-1
- **Setup:** KB with 3 connectors (Active, Draft, Error).
- **Trigger:** Mount components that use each SWR hook.
- **Assertions:**
  1. `useConnector(id)` returns full connector detail including status, authStatus, setupProgress
  2. `useConnectorList(kbId, filters)` returns paginated list with type-specific fields
  3. `useConnectorSync(id)` returns sync progress data and polls during active sync
  4. SWR cache is shared — multiple components reading same connector see consistent data
  5. `mutate()` after write operations triggers revalidation in all consumers
- **Failure Modes:** Network failure during SWR fetch — hooks should return cached data with error flag.

#### INT-W1-07: Zustand Connector Store State Management

- **Components Under Test:** useConnectorStore, panel state, tab routing
- **Design Reference:** HLD §4g, C-01 UI Behaviors
- **Setup:** No panel open initially.
- **Trigger:** Open panel, switch tabs, toggle Simplified View, expand panel.
- **Assertions:**
  1. Store tracks: panelOpen, activeConnectorId, activeTab, simplifiedView, expandState
  2. Opening panel for a new connector updates activeConnectorId and sets correct initial tab
  3. Simplified View toggle updates the store and persists to localStorage
  4. Expand state is tracked per-tab (Scope+Filters can auto-expand independently)
  5. Closing panel resets transient state but preserves preferences
- **Failure Modes:** Rapid state updates (quick tab switches) should not produce inconsistent intermediate states.

#### INT-W1-08: ConnectorAuditEntry Model and Routes

- **Components Under Test:** ConnectorAuditEntry model, audit log API routes
- **Design Reference:** HLD §4f, C-06 Immutable Audit Log
- **Setup:** Connector with a series of operations performed (create, auth, update, sync start).
- **Trigger:** `GET /connectors/:id/audit-log` with pagination.
- **Assertions:**
  1. Audit entries are returned in chronological order
  2. Each entry has: timestamp, actor (email or "system"), event description
  3. Pagination works (page/pageSize returns correct slice, total count accurate)
  4. Entries are append-only — no update/delete operations succeed
  5. Entries include tenantId and projectId for isolation
- **Failure Modes:** Very large audit log (10k+ entries) should paginate without timeout.

### Wave 1 LLD-Derived Scenarios (Implementation-Level)

These scenarios are derived from the Wave 1 LLD function signatures, acceptance criteria,
and implementation details. They complement the base E2E/Integration scenarios above.

#### LLD-W1-01: resolveScopes() Matrix — permissionMode x authMethod

- **LLD Task:** T-01, AC-01, AC-02
- **Type:** Unit
- **What to Test:** resolveScopes() returns correct scopes for every combination of permissionMode and authMethod
- **Setup:** Import `resolveScopes` from `connector.service.ts`. No DB or Redis needed.
- **Assertions:**
  1. `resolveScopes('device_code', 'enabled')` returns `['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access']`
  2. `resolveScopes('authorization_code', 'enabled')` returns `['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access']`
  3. `resolveScopes('device_code', 'disabled')` returns `['Sites.Read.All', 'Files.Read.All', 'offline_access']` (no `GroupMember.Read.All`)
  4. `resolveScopes('authorization_code', 'disabled')` returns `['Sites.Read.All', 'Files.Read.All', 'offline_access']`
  5. `resolveScopes('client_credentials', 'enabled')` returns `['https://graph.microsoft.com/.default']`
  6. `resolveScopes('client_credentials', 'disabled')` returns `['https://graph.microsoft.com/.default']`
  7. No returned array contains `Sites.FullControl.All`

#### LLD-W1-02: Mongoose Enum Rejects Old Permission Mode Values

- **LLD Task:** T-01, AC-04
- **Type:** Unit
- **What to Test:** Mongoose validation rejects `'full'` and `'simplified'`, accepts `'enabled'` and `'disabled'`
- **Setup:** Import `ConnectorConfig` model. Create a document with `permissionConfig.mode` set to each value.
- **Assertions:**
  1. `permissionConfig.mode = 'enabled'` passes validation
  2. `permissionConfig.mode = 'disabled'` passes validation
  3. `permissionConfig.mode = 'full'` throws Mongoose `ValidationError`
  4. `permissionConfig.mode = 'simplified'` throws Mongoose `ValidationError`

#### LLD-W1-03: Data Migration — 'full'/'simplified' to 'enabled'

- **LLD Task:** T-01, ST-01.5
- **Type:** Integration
- **What to Test:** Migration script maps existing `'full'` and `'simplified'` values to `'enabled'`
- **Setup:** Insert connector documents with `permissionConfig.mode` set to `'full'`, `'simplified'`, and `'disabled'` into a test collection.
- **Assertions:**
  1. After migration, documents with `'full'` now have `'enabled'`
  2. After migration, documents with `'simplified'` now have `'enabled'`
  3. After migration, documents with `'disabled'` remain `'disabled'` (unchanged)
  4. Migration is idempotent (running twice produces the same result)

#### LLD-W1-04: pauseSync() Publishes Redis Cancel Signal

- **LLD Task:** T-02, AC-01
- **Type:** Integration
- **What to Test:** `pauseSync()` sets `errorState.isPaused` AND publishes a Redis cancel signal on the correct channel
- **Setup:** Active connector with `syncState.currentJobId = 'job-123'`. Redis subscriber on `connector-sync:job-123:cancel`.
- **Assertions:**
  1. After `pauseSync()`, `errorState.isPaused === true` in the DB
  2. Redis subscriber receives a message on `connector-sync:job-123:cancel`
  3. Channel pattern matches `connector-sync:{currentJobId}:cancel` (same as `stopSync()`)

#### LLD-W1-05: resumeSync() Enqueues BullMQ Job with Checkpoint

- **LLD Task:** T-02, AC-02
- **Type:** Integration
- **What to Test:** `resumeSync()` creates a BullMQ job with `resumeFromCheckpoint: true` and includes checkpoint data
- **Setup:** Paused connector with `syncState.checkpointData` populated from a prior pause.
- **Assertions:**
  1. A BullMQ job is added to the sync queue
  2. Job data includes `resumeFromCheckpoint: true`
  3. Job data includes the checkpoint data from `syncState.checkpointData`
  4. `errorState.isPaused` is reset to `false`
  5. `syncState.currentJobId` is updated to the new job ID

#### LLD-W1-06: SET NX PX Prevents Overwriting In-Flight Auth Session

- **LLD Task:** T-03, AC-02
- **Type:** Unit
- **What to Test:** `storeDeviceCodeSession()` uses `SET NX PX` to prevent overwriting an existing session for the same connector
- **Setup:** Call `storeDeviceCodeSession()` for connectorId 'conn-A' twice in rapid succession.
- **Assertions:**
  1. First call succeeds and stores the session
  2. Second call either fails, returns a conflict indicator, or logs a warning
  3. The original session data is not overwritten

#### LLD-W1-07: Redis Error in storeDeviceCodeSession() Throws ConnectorError

- **LLD Task:** T-03, AC-03
- **Type:** Unit
- **What to Test:** Redis connection errors in auth state operations are caught and wrapped in `ConnectorError`
- **Setup:** Mock Redis `setex()` to throw a connection error.
- **Assertions:**
  1. `storeDeviceCodeSession()` throws a `ConnectorError` (not an unhandled rejection)
  2. Error code is `'REDIS_UNAVAILABLE'`
  3. `getDeviceCodeSession()` with a failing Redis also throws `ConnectorError` with code `'REDIS_UNAVAILABLE'`

#### LLD-W1-08: ConnectorSchema in ModelRegistry.getPlatformModels()

- **LLD Task:** T-04, AC-01
- **Type:** Unit
- **What to Test:** ConnectorSchema is registered with ModelRegistry after module import
- **Setup:** Import `ConnectorSchema` model (triggers registration side effect). Import `ModelRegistry`.
- **Assertions:**
  1. `ModelRegistry.getPlatformModels().some(m => m.name === 'ConnectorSchema')` is `true`
  2. Registered with `'platform'` affinity (not `'searchai'`)

#### LLD-W1-09: FieldMapping in ModelRegistry.getPlatformModels()

- **LLD Task:** T-04, AC-02
- **Type:** Unit
- **What to Test:** FieldMapping is registered with ModelRegistry after module import
- **Setup:** Import `FieldMapping` model (triggers registration side effect). Import `ModelRegistry`.
- **Assertions:**
  1. `ModelRegistry.getPlatformModels().some(m => m.name === 'FieldMapping')` is `true`
  2. Registered with `'platform'` affinity

#### LLD-W1-10: processPermission() Handles grantedToV2 and grantedToIdentitiesV2

- **LLD Task:** T-05, ST-05.2
- **Type:** Unit
- **What to Test:** `processPermission()` checks both `perm.grantedToV2` and `perm.grantedToIdentitiesV2`, preferring V2 when present
- **Setup:** Create mock permission objects: one with only `grantedToV2`, one with only `grantedToIdentitiesV2`, one with both.
- **Assertions:**
  1. Permission with `grantedToV2.group` is processed correctly (group extracted)
  2. Permission with `grantedToIdentitiesV2.group` is processed correctly (group extracted)
  3. When both are present, `grantedToV2` is preferred
  4. Permission with neither field does not throw (gracefully skipped or logged)

#### LLD-W1-11: Group ID Resolution Falls Back to 'sharepoint:{id}'

- **LLD Task:** T-05, AC-01, ST-05.3
- **Type:** Unit
- **What to Test:** When Azure AD group lookup fails (404 or no email), the crawler stores `sharepoint:{id}` as a fallback
- **Setup:** Mock `graphClient.getGroupByDisplayName()` to return 404. Permission entry has a group without an email.
- **Assertions:**
  1. `upsertGroup()` is called with `sharepoint:{group.id}` format
  2. A warning log is emitted indicating the fallback
  3. The crawl does not fail or throw

#### LLD-W1-12: getDrivePermissions() Called During Crawl

- **LLD Task:** T-05, AC-03, ST-05.5
- **Type:** Unit
- **What to Test:** `crawlDocument()` calls both `getItemPermissions()` and `getDrivePermissions()`, and results are merged without duplicates
- **Setup:** Mock `graphClient.getItemPermissions()` and `graphClient.getDrivePermissions()` to return overlapping permission sets.
- **Assertions:**
  1. `getItemPermissions()` is called with the document's item ID
  2. `getDrivePermissions()` is called with the document's drive ID
  3. Results are merged: a user appearing in both item-level and drive-level is not double-counted
  4. All unique permissions from both sources are present in the final set

#### LLD-W1-13: resolveAzureADGroupId() Cache — Max Entries and TTL

- **LLD Task:** T-05, ST-05.6
- **Type:** Unit
- **What to Test:** The in-memory cache for group ID resolution respects 10,000 max entries and 1-hour TTL
- **Setup:** Create a `resolveAzureADGroupId()` instance and populate it with entries.
- **Assertions:**
  1. Cached results are returned without making a Graph API call on subsequent lookups
  2. After 10,000 entries, the oldest entry is evicted (LRU) to make room for new ones
  3. Entries older than 1 hour are treated as expired and re-fetched
  4. Cache is scoped to a single crawl run (does not persist across crawl invocations)

#### LLD-W1-14: writeAuditEntry() Creates Document Scoped to tenantId

- **LLD Task:** T-06, AC-02
- **Type:** Unit
- **What to Test:** `writeAuditEntry()` creates a ConnectorAuditEntry document with all required fields, scoped to the given tenantId
- **Setup:** Call `writeAuditEntry()` with known parameters. Read back from the collection.
- **Assertions:**
  1. Created document has `connectorId`, `tenantId`, `event`, `actor`, `actorType`, `category`, `timestamp`
  2. `_id` is a UUIDv7 string
  3. `metadata` field contains the passed metadata object
  4. `_v` defaults to 1

#### LLD-W1-15: getAuditLog() Returns Paginated Results with Category + Date Filters

- **LLD Task:** T-06, AC-03
- **Type:** Integration
- **What to Test:** `getAuditLog()` returns paginated results filtered by connectorId, tenantId, category, and date range
- **Setup:** Insert 30 audit entries across 2 tenants, 2 connectors, 3 categories, spanning 7 days.
- **Assertions:**
  1. Query for tenant-A, connector-1 returns only entries for that combination
  2. Adding `category: 'auth'` filters to only auth entries
  3. Adding `startDate` and `endDate` filters to the specified range
  4. `page: 1, limit: 10` returns first 10 results; `page: 2` returns the next set
  5. `total` reflects the full count matching the filter (not just the page)

#### LLD-W1-16: exportAuditLog() Returns CSV and JSON Formats

- **LLD Task:** T-06, ST-06.3
- **Type:** Unit
- **What to Test:** `exportAuditLog()` returns correctly structured CSV and JSON outputs
- **Setup:** Insert 5 audit entries for a connector. Call `exportAuditLog()` with `format: 'csv'` then `format: 'json'`.
- **Assertions:**
  1. CSV output has correct headers: `timestamp,actor,actorType,event,category,metadata`
  2. CSV contains 5 data rows
  3. JSON output is a valid JSON array of 5 entries
  4. `contentType` is `'text/csv'` for CSV and `'application/json'` for JSON
  5. `filename` includes the connectorId and format extension

#### LLD-W1-17: Audit Routes Return 400 for Invalid Zod Params

- **LLD Task:** T-06, ST-06.4
- **Type:** Integration
- **What to Test:** Audit log routes validate params/query with Zod and return 400 on invalid input
- **Setup:** Running SearchAI server with audit routes mounted.
- **Assertions:**
  1. `GET /audit-log?page=-1` returns 400 with validation error (negative page)
  2. `GET /audit-log?limit=200` returns 400 (exceeds max 100)
  3. `GET /audit-log?category=invalid` returns 400 (not in enum)
  4. `GET /:connectorId/audit-log` with empty connectorId returns 400
  5. All 400 responses have `{ success: false, error: { code, message } }` format

#### LLD-W1-18: Cross-Tenant Audit Access Returns 404

- **LLD Task:** T-06, platform invariant (Resource Isolation)
- **Type:** Integration
- **What to Test:** A request from tenant-A attempting to access tenant-B's audit log receives 404 (not 403)
- **Setup:** Create audit entries for tenant-B connector. Authenticate as tenant-A.
- **Assertions:**
  1. `GET /:indexId/connectors/:connectorId/audit-log` returns 404
  2. Response body does not leak any tenant-B data
  3. No 403 status is returned (existence not revealed)

#### LLD-W1-19: createVersion() Auto-Increments Version Number

- **LLD Task:** T-07, AC-02
- **Type:** Unit
- **What to Test:** `createVersion()` reads the latest version number and increments by 1
- **Setup:** Start with no versions for a connector. Call `createVersion()` twice.
- **Assertions:**
  1. First version has `version: 1`
  2. Second version has `version: 2`
  3. Both versions have the same `connectorId` and `tenantId`
  4. Each version's `configSnapshot` matches the passed config

#### LLD-W1-20: Concurrent createVersion() — Optimistic Concurrency

- **LLD Task:** T-07, AC-04
- **Type:** Integration
- **What to Test:** Two concurrent `createVersion()` calls both succeed via retry on duplicate key error
- **Setup:** Two concurrent calls to `createVersion()` for the same connector.
- **Assertions:**
  1. Both calls complete without throwing (one retries on duplicate key)
  2. The resulting versions have sequential numbers (e.g., 1 and 2)
  3. No duplicate version numbers exist in the collection
  4. The unique compound index `{ tenantId, connectorId, version }` prevents duplicates

#### LLD-W1-21: getVersionHistory() Returns Descending Order with Pagination

- **LLD Task:** T-07, AC-03
- **Type:** Unit
- **What to Test:** `getVersionHistory()` returns versions in descending order, scoped to tenantId and connectorId
- **Setup:** Create 5 versions for connector-A (tenant-1) and 3 versions for connector-B (tenant-2).
- **Assertions:**
  1. Query for tenant-1, connector-A returns 5 versions in descending order (newest first)
  2. Query for tenant-2, connector-B returns 3 versions (no cross-tenant leakage)
  3. `page: 1, limit: 2` returns first 2 versions; `page: 2` returns next 2
  4. `total` accurately reflects the full count

#### LLD-W1-22: Version Routes Return 400 for Invalid Zod Params

- **LLD Task:** T-07, ST-07.4
- **Type:** Integration
- **What to Test:** Version routes validate params/query with Zod and return 400 on invalid input
- **Setup:** Running SearchAI server with version routes mounted.
- **Assertions:**
  1. `GET /config/versions?page=-1` returns 400
  2. `GET /config/versions/:versionNumber` with `versionNumber=0` returns 400 (not positive)
  3. `GET /config/versions/:versionNumber` with `versionNumber=abc` returns 400 (not a number)
  4. All 400 responses have `{ success: false, error: { code, message } }` format

#### LLD-W1-23: Cross-Tenant Version Access Returns 404

- **LLD Task:** T-07, platform invariant (Resource Isolation)
- **Type:** Integration
- **What to Test:** A request from tenant-A attempting to access tenant-B's version history receives 404
- **Setup:** Create versions for tenant-B connector. Authenticate as tenant-A.
- **Assertions:**
  1. `GET /:indexId/connectors/:connectorId/config/versions` returns 404
  2. `GET /:indexId/connectors/:connectorId/config/versions/1` returns 404
  3. Response does not leak tenant-B data

#### LLD-W1-24: useConnector(null, null) Makes No Fetch Request

- **LLD Task:** T-08, AC-02
- **Type:** Component
- **What to Test:** When both `indexId` and `connectorId` are null, the SWR key is null and no network request is made
- **Setup:** Render a component using `useConnector(null, null)`. Spy on `fetch` or SWR's fetcher.
- **Assertions:**
  1. `fetch` is not called
  2. `connector` is `null`
  3. `isLoading` is `false`
  4. `error` is `null`

#### LLD-W1-25: useConnectorSync Polling Interval Changes by Status

- **LLD Task:** T-08, AC-03
- **Type:** Component
- **What to Test:** `useConnectorSync` polls at 5000ms when sync is in progress, stops (0ms) when idle
- **Setup:** Render a component using `useConnectorSync('conn-1')`. Mock SWR responses to alternate between syncing and idle status.
- **Assertions:**
  1. When last response has `status: 'syncing'`, `refreshInterval` is set to 5000
  2. When status transitions to `'active'` or `'error'`, `refreshInterval` is set to 0
  3. Polling resumes if status changes back to `'syncing'`

#### LLD-W1-26: Cache Invalidation Triggers Revalidation Across Consumers

- **LLD Task:** T-08, cache invalidation strategy
- **Type:** Component
- **What to Test:** Calling `mutate()` after a mutation revalidates all SWR consumers sharing the same key
- **Setup:** Mount two components both using `useConnector(indexId, connectorId)`. Trigger a mutation and call `mutate()`.
- **Assertions:**
  1. Both components receive the updated data after revalidation
  2. Only one fetch request is made (SWR deduplication)
  3. The revalidation occurs within the SWR deduplication window

#### LLD-W1-27: openPanel() Sets Correct State for New vs Existing Connector

- **LLD Task:** T-09, AC-01
- **Type:** Unit
- **What to Test:** `openPanel()` sets different state depending on `isNew` and `tab` options
- **Setup:** Import `useConnectorStore`. Call `openPanel` with different option combinations.
- **Assertions:**
  1. `openPanel('conn-1', { isNew: true, tab: 'connect' })` sets `panelOpen: true`, `activeConnectorId: 'conn-1'`, `activeTab: 'connect'`, `isNewConnector: true`
  2. `openPanel('conn-2', { isNew: false, tab: 'overview' })` sets `isNewConnector: false`, `activeTab: 'overview'`
  3. `openPanel('conn-3')` (no options) defaults to `isNew: false`, `tab: 'connect'`
  4. `expandedPanel` is reset to `false` on every `openPanel` call

#### LLD-W1-28: Simplified View Defaults to ON When localStorage Key Absent

- **LLD Task:** T-09, AC-04
- **Type:** Unit
- **What to Test:** First-time user (no `sp-simplified-view` key in localStorage) gets `simplifiedView: true`
- **Setup:** Clear localStorage. Import and initialize `useConnectorStore`.
- **Assertions:**
  1. `simplifiedView` is `true` after store initialization
  2. `localStorage.getItem('sp-simplified-view')` returns `null` (not written until toggled)

#### LLD-W1-29: setSimplifiedView() Persists to localStorage

- **LLD Task:** T-09, AC-03
- **Type:** Unit
- **What to Test:** `setSimplifiedView(false)` writes to localStorage and updates store state
- **Setup:** Initialize store (defaults to `true`). Call `setSimplifiedView(false)`.
- **Assertions:**
  1. `simplifiedView` in store state is `false`
  2. `localStorage.getItem('sp-simplified-view')` is `'false'`
  3. Calling `setSimplifiedView(true)` updates both store and localStorage to `'true'`

#### LLD-W1-30: Panel Renders at 720px Width with CSS Override

- **LLD Task:** T-10, AC-01
- **Type:** Component
- **What to Test:** SharePointDetailPanel renders with 720px width via SlidePanel className override
- **Setup:** Mount `SharePointDetailPanel` with a connector store state of `panelOpen: true`.
- **Assertions:**
  1. The SlidePanel container has `max-width: 720px` applied (via `!max-w-[720px]` class or inline style)
  2. The panel is visible (not collapsed or hidden)

#### LLD-W1-31: Setup Mode Shows Locked Tabs

- **LLD Task:** T-10, AC-02
- **Type:** Component
- **What to Test:** When connector status is draft, only the Connect tab is interactive; other tabs show lock icons and are disabled
- **Setup:** Mount `SharePointDetailPanel` with connector data `status: 'draft'`.
- **Assertions:**
  1. Connect tab is clickable (not disabled)
  2. Proposal, Scope+Filters, Preview, Security tabs are disabled
  3. Disabled tabs visually show a lock icon overlay
  4. Clicking a locked tab does not change the active tab

#### LLD-W1-32: Simplified View Toggle Hides Scope+Filters and History Tabs

- **LLD Task:** T-10, AC-04
- **Type:** Component
- **What to Test:** When `simplifiedView` is `true`, Scope+Filters and History tabs are hidden from the tab bar
- **Setup:** Mount `SharePointDetailPanel` with an active connector. Set `simplifiedView: true` in store.
- **Assertions:**
  1. Tab bar does not contain "Scope+Filters" tab
  2. Tab bar does not contain "History" tab
  3. Connect, Proposal, Preview, Security tabs are visible
  4. Toggling `simplifiedView` to `false` adds both tabs back

#### LLD-W1-33: More Actions — Unimplemented Items Are Disabled with Tooltip

- **LLD Task:** T-10, AC-06, ST-10.2
- **Type:** Component
- **What to Test:** Clone, Export, Import, Health Check, and Diagnostics menu items are disabled with "Available in a future update" tooltip
- **Setup:** Mount `SharePointDetailPanel`, click the More Actions [...] button.
- **Assertions:**
  1. Clone, Export JSON, Export YAML, Import Config, Run Health Check, Diagnostics are present but disabled
  2. Hovering a disabled item shows tooltip: "Available in a future update"
  3. Delete is enabled and clickable
  4. Clicking a disabled item does not trigger any action

#### LLD-W1-34: Expand/Collapse Transitions Between 720px and 100vw

- **LLD Task:** T-10, AC-05
- **Type:** Component
- **What to Test:** Clicking expand transitions panel width from 720px to 100vw; collapse reverses
- **Setup:** Mount `SharePointDetailPanel` at 720px. Click expand button.
- **Assertions:**
  1. After expand click, panel has `max-width: none` or `width: 100vw`
  2. CSS transition is `300ms ease-out`
  3. Clicking collapse returns panel to 720px
  4. Switching to Scope+Filters tab auto-expands to full width
  5. Switching away from Scope+Filters auto-collapses back to 720px

#### LLD-W1-35: TypeToConfirmInput — Button Disabled Until Match

- **LLD Task:** T-11, AC-01, AC-02
- **Type:** Component
- **What to Test:** Confirm button is disabled until user types the exact `confirmText` (case-insensitive)
- **Setup:** Mount `TypeToConfirmInput` with `confirmText="public access"`.
- **Assertions:**
  1. Confirm button is disabled initially
  2. Typing "public acces" (incomplete) keeps button disabled
  3. Typing "public access" enables the button
  4. Typing "Public Access" (mixed case) also enables the button
  5. Clicking the enabled button calls `onConfirm`

#### LLD-W1-36: TypeToConfirmInput — Consequences List Renders as Bullets

- **LLD Task:** T-11, AC-04
- **Type:** Component
- **What to Test:** When `consequences` prop is provided, they render as a bullet list
- **Setup:** Mount `TypeToConfirmInput` with `consequences={['Risk 1', 'Risk 2', 'Risk 3']}`.
- **Assertions:**
  1. Three `<li>` elements are rendered in the DOM
  2. Each contains the corresponding text
  3. The list is contained within a `<ul>` element

#### LLD-W1-37: TypeToConfirmInput — Loading State Disables Both Buttons

- **LLD Task:** T-11, component interface (`loading` prop)
- **Type:** Component
- **What to Test:** When `loading={true}`, both Confirm and Cancel buttons are disabled
- **Setup:** Mount `TypeToConfirmInput` with `loading={true}` and input already matching `confirmText`.
- **Assertions:**
  1. Confirm button is disabled despite input matching
  2. Cancel button is disabled
  3. Neither button triggers its callback when clicked

#### LLD-W1-38: ConnectorsTab.tsx No Longer Exists

- **LLD Task:** T-12, AC-01
- **Type:** Unit
- **What to Test:** The orphaned `ConnectorsTab.tsx` file has been deleted from the codebase
- **Setup:** None.
- **Assertions:**
  1. `apps/studio/src/components/search-ai/ConnectorsTab.tsx` does not exist
  2. No file in `apps/studio/src/` imports from `ConnectorsTab`

#### LLD-W1-39: Studio Build Succeeds After ConnectorsTab Removal

- **LLD Task:** T-12, AC-02
- **Type:** Unit
- **What to Test:** `pnpm build --filter=studio` succeeds with no broken imports referencing the deleted file
- **Setup:** None (relies on the prior deletion).
- **Assertions:**
  1. `pnpm build --filter=studio` exits with code 0
  2. No TypeScript errors related to missing `ConnectorsTab` module

#### LLD-W1-40: closePanel() Resets All Panel State

- **LLD Task:** T-09, AC-02
- **Type:** Unit
- **What to Test:** Calling `closePanel()` resets all transient panel state while preserving preferences
- **Setup:** Store with `openPanel('conn-123', { isNew: true, tab: 'proposal' })` called
- **Assertions:**
  1. After `closePanel()`: `panelOpen === false`
  2. `activeConnectorId === null`
  3. `activeTab === 'connect'` (reset to default)
  4. `isNewConnector === false`
  5. `simplifiedView` unchanged (preference preserved)

#### LLD-W1-41: onCancel Callback Invoked on Cancel Click

- **LLD Task:** T-11, AC-03
- **Type:** Component
- **What to Test:** Clicking the Cancel button calls the `onCancel` callback
- **Setup:** Render `TypeToConfirmInput` with `onCancel` spy, `confirmText="delete"`
- **Assertions:**
  1. Click Cancel button
  2. `onCancel` spy was called exactly once
  3. `onConfirm` spy was NOT called

### LLD Acceptance Criteria Coverage

| Task | AC    | Test Scenario           | Status      |
| ---- | ----- | ----------------------- | ----------- |
| T-01 | AC-01 | LLD-W1-01               | Covered     |
| T-01 | AC-02 | LLD-W1-01               | Covered     |
| T-01 | AC-03 | Implementation-verified | Build check |
| T-01 | AC-04 | LLD-W1-02               | Covered     |
| T-02 | AC-01 | LLD-W1-04               | Covered     |
| T-02 | AC-02 | LLD-W1-05               | Covered     |
| T-03 | AC-01 | INT-W1-01               | Covered     |
| T-03 | AC-02 | LLD-W1-06               | Covered     |
| T-03 | AC-03 | LLD-W1-07               | Covered     |
| T-04 | AC-01 | LLD-W1-08               | Covered     |
| T-04 | AC-02 | LLD-W1-09               | Covered     |
| T-04 | AC-03 | Implementation-verified | Build check |
| T-05 | AC-01 | LLD-W1-11               | Covered     |
| T-05 | AC-02 | LLD-W1-10               | Covered     |
| T-05 | AC-03 | LLD-W1-12               | Covered     |
| T-05 | AC-04 | Implementation-verified | Build check |
| T-06 | AC-01 | INT-W1-08               | Covered     |
| T-06 | AC-02 | LLD-W1-14               | Covered     |
| T-06 | AC-03 | LLD-W1-15               | Covered     |
| T-06 | AC-04 | LLD-W1-17               | Covered     |
| T-07 | AC-01 | INT-W1-08               | Covered     |
| T-07 | AC-02 | LLD-W1-19               | Covered     |
| T-07 | AC-03 | LLD-W1-21               | Covered     |
| T-07 | AC-04 | LLD-W1-20               | Covered     |
| T-08 | AC-01 | INT-W1-06               | Covered     |
| T-08 | AC-02 | LLD-W1-24               | Covered     |
| T-08 | AC-03 | LLD-W1-25               | Covered     |
| T-09 | AC-01 | LLD-W1-27               | Covered     |
| T-09 | AC-02 | LLD-W1-40               | Covered     |
| T-09 | AC-03 | LLD-W1-29               | Covered     |
| T-09 | AC-04 | LLD-W1-28               | Covered     |
| T-10 | AC-01 | LLD-W1-30               | Covered     |
| T-10 | AC-02 | LLD-W1-31               | Covered     |
| T-10 | AC-03 | E2E-W1-02               | Covered     |
| T-10 | AC-04 | LLD-W1-32               | Covered     |
| T-10 | AC-05 | LLD-W1-34               | Covered     |
| T-10 | AC-06 | LLD-W1-33               | Covered     |
| T-11 | AC-01 | LLD-W1-35               | Covered     |
| T-11 | AC-02 | LLD-W1-35               | Covered     |
| T-11 | AC-03 | LLD-W1-41               | Covered     |
| T-11 | AC-04 | LLD-W1-36               | Covered     |
| T-12 | AC-01 | LLD-W1-38               | Covered     |
| T-12 | AC-02 | LLD-W1-39               | Covered     |

---

## Wave 2: Setup Flow (T-13 to T-25)

**Cards:** C-02 (Connect Tab), C-03 (Configuration Proposal), C-04 (Scope+Filters), C-05 (Preview & Approve)

### E2E Scenarios

#### E2E-W2-01: First-Time Connect Tab — Azure App Registration

- **User Journey:** First-time user (0 existing connectors) sees the conversational welcome, enters Client ID and Tenant ID, selects Azure App Registration, and initiates auth.
- **Design Reference:** §4a First-Time Experience (lines 786-845), C-02 UI Behaviors
- **Preconditions:** KB has 0 SharePoint connectors.
- **Steps:**
  1. Open the Detail Panel via Flow A or Flow C
  2. Verify conversational welcome heading: "Let us get you connected to SharePoint"
  3. Verify ~3 minute time estimate is shown
  4. Verify connector name field with placeholder "e.g., Marketing SharePoint, Engineering Docs"
  5. Select "Azure App Registration (production)" radio card
  6. Enter Client ID and Tenant ID
  7. Verify "Configure-before-auth" messaging at bottom
  8. Click [Continue -->]
  9. Verify auth initiates (device code or browser popup)
- **Expected Outcome:** First-time experience shows 2 radio cards (not 3 — delegation excluded), auth initiates with correct scopes.
- **Error Path:** Invalid UUID format for Client ID — inline validation error on blur. (C-02 Edge Case 4)
- **Edge Cases:** [C-02 Edge Case 1: Duplicate connector name — inline error with suggestion. C-02 Edge Case 3: Auth popup blocked — show fallback instructions]

#### E2E-W2-02: First-Time Connect Tab — Sign in with Microsoft (Quick Setup)

- **User Journey:** First-time user selects "Sign in with Microsoft" for quick evaluation without Client ID.
- **Design Reference:** §4a (lines 819-827), C-02 First-Time Experience item 3
- **Preconditions:** KB has 0 SharePoint connectors.
- **Steps:**
  1. Open the Detail Panel via Flow C
  2. Select "Sign in with Microsoft (quick setup)" radio card
  3. Verify no Client ID or Tenant ID fields appear
  4. Click [Continue -->]
  5. Verify OAuth popup opens with `Sites.Read.All` scope automatically (no scope selector shown)
  6. Complete Microsoft sign-in
  7. Verify panel transitions to Proposal tab
- **Expected Outcome:** Quick setup uses platform app registration with Sites.Read.All automatically. No scope configuration needed.
- **Error Path:** Browser popup blocked — show E9 error with [Switch to Device Code] option. (C-11 E9)
- **Edge Cases:** [C-02 Edge Case 7: Rate limit during auth — show "Please wait and try again" with delay]

#### E2E-W2-03: Returning User Connect Tab — Device Code Auth

- **User Journey:** Returning user (1+ connectors) sees compact form, enters credentials, uses Device Code auth method.
- **Design Reference:** §4a Returning user (lines 927-985), C-02 Returning User Experience
- **Preconditions:** KB has at least 1 existing SharePoint connector.
- **Steps:**
  1. Click [+ Add Source] > SharePoint
  2. Verify multi-connector dialog appears (C-10) — select "From Scratch"
  3. Verify compact form: no welcome copy, numbered steps
  4. Enter connector name (required for returning users)
  5. Enter Client ID and Tenant ID
  6. Verify Connection Scopes display shows base scopes and Permission-aware search ENABLED
  7. Select "Device Code" auth method
  8. Click [Connect -->]
  9. Verify device code, user code, and verification URI are displayed
  10. Poll auth status until completed
- **Expected Outcome:** Returning user sees 3 auth methods (Device Code, Browser Login, App-Only), compact form, and device code flow works correctly.
- **Error Path:** Device code expires (15 min timeout) — show [Regenerate Code] button. (C-02 Edge Case 2)
- **Edge Cases:** [C-02 Edge Case 5: Browser closed mid-auth — draft connector resumable from Sources table. C-02 Edge Case 8: Multiple concurrent auth attempts — invalidate previous]

#### E2E-W2-04: Permission-Aware Search Disable (Type-to-Confirm)

- **User Journey:** User disables permission-aware search by completing the type-to-confirm flow.
- **Design Reference:** §4a Connection Scopes (lines 720-754), C-02 Connection Scopes Display
- **Preconditions:** Panel is open with Connect tab showing Connection Scopes section.
- **Steps:**
  1. Verify Permission-aware search shows "ENABLED (default)" with locked indicator
  2. Click "[I need to disable this...]" link
  3. Verify inline expansion (not dialog) with warning text about consequences
  4. Verify [Confirm Disable] button is greyed out
  5. Type "public acces" (wrong text) — verify button remains greyed
  6. Type "public access" (correct text) — verify [Confirm Disable] becomes active
  7. Click [Confirm Disable]
  8. Verify section shows "[Warning] Public Access — Opted In by {email} on {date}"
  9. Verify audit log records who disabled, when, and the confirmation text
- **Expected Outcome:** Type-to-confirm requires exact "public access" match, records opt-in to audit.
- **Error Path:** API failure on permission update — show error, revert UI to ENABLED state.
- **Edge Cases:** [C-02 Edge Case 6: Re-enable after disable — design does not show re-enable path on this tab. C-06 Edge Case 8: Disable then re-enable — verify re-enable path exists]

#### E2E-W2-05: Configuration Proposal — Generation Progress

- **User Journey:** After auth completes, user watches the 9-step proposal generation progress in real time.
- **Design Reference:** §4b (lines 988-1070), C-03 Proposal Generation
- **Preconditions:** Auth just completed successfully.
- **Steps:**
  1. Verify panel transitions to Proposal tab after auth completion
  2. Verify "Generating your Configuration Proposal..." heading
  3. Verify 9 checklist items appear: Connection, Scopes, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate
  4. Verify items show live status updates (e.g., "Done", "Detecting granted scopes...", "Running checks...")
  5. Verify dependent items show "Waiting for..." status (Filters waits for Scope, Security Gate waits for all)
  6. Wait for all items to complete (30-90 seconds)
  7. Verify proposal sections appear incrementally as ready
  8. Verify TOC renders with badges for all 8 sections
- **Expected Outcome:** Generation progress shows real-time 9-step checklist with dependency-aware ordering.
- **Error Path:** If generation fails mid-way (e.g., discovery timeout), show appropriate error with retry option.
- **Edge Cases:** [C-03 Edge Case: Pre-configured draft settings applied automatically during generation]

#### E2E-W2-06: Proposal Section Review — Accept, Modify, Skip

- **User Journey:** User reviews the Configuration Proposal, accepting some sections, modifying others, and skipping one.
- **Design Reference:** §4b per-section action buttons, C-03 Per-Section Action Buttons table
- **Preconditions:** Proposal generation is complete, all 8 sections are in "Pending" state.
- **Steps:**
  1. Verify TOC shows "Progress: 0 of 8 sections reviewed"
  2. Click [Accept] on Connection section — verify it collapses to one-line summary with [Accepted] badge
  3. Click [Accept with warnings] on Health Check — verify badge updates, collapsed summary
  4. Click [Modify] on Scope section — verify inline editor opens (Simplified View) or Scope+Filters tab highlights (Full View)
  5. Deselect one site in the inline editor, click [Apply Changes]
  6. Verify Scope section shows [Accepted — Modified] badge with updated counts
  7. Click [Skip] on Filters section — verify [Skipped] badge
  8. Use [Accept All Remaining] — verify all unreviewed sections become [Accepted]
  9. Verify Permissions defaults to ENABLED on Accept All (safe default)
  10. Verify TOC shows "Progress: 8 of 8 sections reviewed"
  11. (Browser refresh mid-review) After step 6, refresh the browser
  12. Verify the page reloads and restores the exact review state: previously accepted/modified/skipped sections retain their badges, progress count is accurate
- **Expected Outcome:** Each section responds to its specific action buttons. TOC badges and progress update in real time. Auto-scroll to next unreviewed section. Browser refresh preserves server-side proposal state.
- **Error Path:** API failure on section accept — show error, keep section in Pending state.
- **Edge Cases:** [C-03 Edge Case: Skip Permissions keeps ENABLED (safe default). C-03 Edge Case: "Abandon — Do Not Sync" on Sample Preview — confirmation dialog, connector deleted/cancelled. C-03 Edge Case: Browser refresh mid-review — state restored from server]

#### E2E-W2-07: Scope+Filters Split-Pane with Live Preview

- **User Journey:** Power user opens Scope+Filters tab, adjusts filters, and sees live preview updates in the right panel.
- **Design Reference:** §4c (lines 1600-1700), C-04 UI Behaviors
- **Preconditions:** Active connector with discovery complete. Simplified View OFF.
- **Steps:**
  1. Navigate to Scope+Filters tab
  2. Verify panel auto-expands to full viewport with 60/40 split layout
  3. Verify left panel shows: sites list with checkboxes, file type checkboxes, date range pickers, filter templates, folder rules, size limits
  4. Uncheck one site
  5. Verify right panel updates: summary counts change, filter diff shows "-N newly excluded"
  6. Select "Documents Only" template
  7. Verify file type checkboxes update accordingly, right panel recalculates
  8. Set max file size to 50MB
  9. Verify right panel shows updated exclusion count with "Size limit" reason
  10. Click [Undo] — verify last change is reverted
  11. Click [Reset Recommended] — verify filters return to system recommendation
- **Expected Outcome:** 60/40 split layout with real-time preview updates on every filter change. Undo and Reset work correctly.
- **Error Path:** If preview API is slow (>3 seconds), right panel shows "Calculating..." spinner. (C-04 Loading Behavior)
- **Edge Cases:** [C-04 Edge Case 1: Zero sites selected — 0 documents, prompt to select. C-04 Edge Case 2: All documents excluded — warning with Reset CTA. C-04 Edge Case 6: Stale preview — debounce, discard stale responses. C-04 Edge Case 7: Sites.Selected mode — no scores or file counts]

#### E2E-W2-08: CEL Expression Editor with Validation

- **User Journey:** Advanced user writes a CEL expression, gets autocomplete suggestions, validates it, and sees errors.
- **Design Reference:** §4c Advanced Section, C-04 CEL Expression Editor
- **Preconditions:** Scope+Filters tab open, advanced section expanded.
- **Steps:**
  1. Expand the Advanced section in Scope+Filters
  2. Click into the CEL Expression Editor
  3. Type `resource.` — verify autocomplete shows discovered fields (e.g., department, sensitivity)
  4. Type `resource.department == "` — verify value autocomplete with doc counts (e.g., "Engineering (234 docs)")
  5. Complete expression: `resource.department == "Engineering"`
  6. Click [Validate Expression]
  7. Verify validation passes, preview updates with CEL-filtered results
  8. Type an invalid expression: `resource.department =`
  9. Click [Validate Expression]
  10. Verify inline error at exact position with fix suggestion
- **Expected Outcome:** CEL editor provides syntax highlighting, field and value autocomplete, and inline validation errors.
- **Error Path:** CEL with syntax error — preview shows "Cannot preview — fix expression errors" or last valid state. (C-04 Edge Case 3)
- **Edge Cases:** [C-04 Edge Case 5: No metadata fields discovered — show "No custom metadata discovered". C-04 Edge Case 9: OData display with CEL override — clarify pre-fetch vs post-fetch]

#### E2E-W2-09: Preview/Dry-Run Tab

- **User Journey:** User navigates to Preview tab, reviews dry-run results including sample documents, skipped documents, and content type breakdown.
- **Design Reference:** §4d (lines 1730-1800), C-05 Preview/Dry-Run Tab
- **Preconditions:** Connector configuration is complete (scope and filters set).
- **Steps:**
  1. Navigate to Preview tab
  2. Verify summary panel shows: document count ("~N documents across Y sites"), skip count, estimated size, estimated time range
  3. Verify Sample Documents table shows up to 25 documents with Name, Site, Type, Size, Sensitivity columns
  4. Verify Skipped Documents table shows first 10 with Name and Reason columns
  5. Verify Content Type Breakdown shows horizontal bar chart (PDF, DOCX, PPTX, Other)
  6. Modify a filter (go to Scope+Filters, uncheck a site, return to Preview)
  7. Verify filter change tracking shows delta: "+N newly excluded" with net change line
  8. Click [Adjust Filters] — verify navigation to Scope+Filters tab
  9. Return to Preview, click [Approve Sync] — verify navigation to Approve & Start view
- **Expected Outcome:** Dry-run shows accurate counts, representative samples, content type breakdown, and filter change tracking.
- **Error Path:** Zero documents matched — empty state with [Adjust Filters] CTA, [Approve Sync] disabled. (C-05 Edge Case 1)
- **Edge Cases:** [C-05 Edge Case 3: No filter changes — delta block hidden. C-05 Edge Case 10: All one type — single full bar, no "Other". C-05 Edge Case 11: Sensitivity label "WARN" prefix — render with warning treatment]

#### E2E-W2-10: Approve & Start Sync

- **User Journey:** User reviews the configuration summary, confirms, and starts sync. Observes post-approval transition.
- **Design Reference:** §4f Approve & Start, C-05 Approve & Start
- **Preconditions:** Preview completed, user is on the Approve & Start view.
- **Steps:**
  1. Verify Configuration Summary shows: connection (tenant, auth, token days), scope (sites, libraries, docs, size), filters, schedule, permissions, security status
  2. Verify estimated initial sync time range displayed
  3. Verify three action buttons: [Start Sync], [Save as Draft], [Export Template]
  4. Click [Start Sync]
  5. Verify inline confirmation dialog: "This will sync ~N documents (~X GB) from Y SharePoint sites. Sync begins immediately."
  6. Click [Confirm & Start Sync]
  7. Verify panel switches to Overview tab showing sync progress
  8. If entered via Flow A (Home tab), verify navigation to Data tab > Sources segment with new connector row showing "Syncing"
- **Expected Outcome:** Confirmation dialog prevents accidental sync start. Post-approval correctly transitions to sync progress view.
- **Error Path:** Token expired before approval — warning shown, [Start Sync] disabled, prompt to re-authenticate. (C-05 Edge Case 6)
- **Edge Cases:** [C-05 Edge Case 5: Security gate pending — button reads "Submit for Security Approval" instead. C-05 Edge Case 9: Sync starts but immediately fails — show error with [Retry]]

#### E2E-W2-11: Proposal Export (PDF/JSON/YAML)

- **User Journey:** User exports the Configuration Proposal as a security review document.
- **Design Reference:** §4b Export Buttons, C-03 Export Buttons
- **Preconditions:** Proposal is fully reviewed.
- **Steps:**
  1. Locate the Export buttons on the Proposal tab
  2. Click [Export PDF] — verify file downloads
  3. Click [Export JSON] — verify file downloads
  4. Click [Export YAML] — verify file downloads
  5. Verify exports include all sections, their statuses, and the User Decisions Log
- **Expected Outcome:** Three export formats available, each containing the full proposal content.
- **Error Path:** If export API fails, show error toast with retry option.
- **Edge Cases:** [C-03 Security Gate Section: [Export PDF for Review] is a section-specific export distinct from the global export]

#### E2E-W2-12: Flow A Post-Creation Navigation

- **User Journey:** User completes setup via Flow A (Home tab) and verifies correct post-creation navigation to Data tab.
- **Design Reference:** §2 Flow A (lines 103-110), C-01 Post-creation navigation
- **Preconditions:** New KB with no sources, user completes full setup flow from Home tab.
- **Steps:**
  1. Start from Home tab SetupGuide, create connector, complete auth, review proposal, approve and start sync
  2. Verify app navigates to Data tab > Sources segment
  3. Verify new connector appears in SourcesTable with "Syncing" status
  4. Verify Detail Panel auto-opens showing Overview tab with sync progress
- **Expected Outcome:** Post-creation from Flow A correctly navigates to Data tab and auto-opens the panel.
- **Error Path:** If SourcesTable has never been loaded, verify sources list is fetched after navigation. (C-05 Edge Case 8)
- **Edge Cases:** [C-01 Edge Case: Post-creation "auto-open" timing — panel should open without delay]

#### E2E-W2-13: Token Expiry During Proposal Review

- **User Journey:** While the user is mid-proposal-review, the OAuth token expires and the Connection section degrades gracefully.
- **Design Reference:** C-03 Edge Cases — "Token expires during proposal review", C-11 E4
- **Preconditions:** Proposal generation is complete. Token is configured to expire imminently (or expiry is simulated).
- **Steps:**
  1. Open a connector with a fully generated proposal, begin reviewing sections
  2. Accept the Connection section
  3. While reviewing Health Check or Scope, trigger token expiry (e.g., backend invalidates token)
  4. Verify Connection section shows degraded state with [Re-authenticate] button
  5. Verify other sections (Health Check, Scope, Filters, etc.) remain viewable and scrollable
  6. Verify "Approve All & Start Sync" button is disabled
  7. Click [Re-authenticate] on the Connection section
  8. Complete re-authentication
  9. Verify "Approve All & Start Sync" becomes enabled again
- **Expected Outcome:** Token expiry during proposal review degrades only the Connection section. Other sections remain viewable. Sync approval is blocked until re-authentication.
- **Error Path:** Re-authentication fails — Connection section remains degraded, user prompted to retry.
- **Edge Cases:** [C-03 Edge Case: Token auto-refreshes successfully — degraded state never appears. C-11 E4: Expiry date and days remaining display]

#### E2E-W2-14: Sensitive Content Detection with Public Access Opt-In

- **User Journey:** User disables permission-aware search on a connector whose discovery found sensitive content labels (Confidential, Internal Only, Restricted).
- **Design Reference:** C-03 Edge Cases — "Sensitive content detected + Public Access opt-in", C-02 Connection Scopes Display
- **Preconditions:** Connector discovery has identified files with sensitive content labels. Permission-aware search is currently ENABLED.
- **Steps:**
  1. Navigate to the Connection Scopes section (Connect tab or Proposal Connection section)
  2. Click "[I need to disable this...]" to initiate the type-to-confirm disable flow
  3. Verify the inline expansion includes the standard warning text
  4. Verify an additional "Sensitive Content Detected" warning box is displayed
  5. Verify the warning box shows label breakdown (e.g., "Confidential: 12 files, Internal Only: 34 files, Restricted: 5 files")
  6. Type "public access" to enable the [Confirm Disable] button
  7. Click [Confirm Disable]
  8. Verify permission mode switches to disabled with the public access opt-in badge
  9. Verify audit log records the opt-in including the sensitive content warning acknowledgement
- **Expected Outcome:** The sensitive content warning box with label breakdown is shown before the user confirms public access. Audit trail captures the acknowledgement.
- **Error Path:** Sensitive content labels unavailable (discovery incomplete) — standard disable flow without extra warning.
- **Edge Cases:** [C-02 Edge Case 6: Re-enable after disable. C-06 Edge Case 8: Disable then re-enable — verify re-enable path exists]

#### E2E-W2-15: Abandon — Do Not Sync Confirmation Flow

- **User Journey:** User clicks "Abandon — Do Not Sync" on the Sample Preview section and confirms connector deletion.
- **Design Reference:** C-03 Per-Section Action Buttons — Sample Preview section, C-03 Common behavior — "Abandon — Do Not Sync"
- **Preconditions:** Proposal is generated and partially reviewed (at least 3 sections accepted).
- **Steps:**
  1. Scroll to or click into the Sample Preview section of the proposal
  2. Click [Abandon — Do Not Sync]
  3. Verify confirmation dialog appears
  4. Verify dialog content explains what will be lost: discovery results, configuration, review progress
  5. Click [Cancel] — verify dialog closes and no action is taken
  6. Click [Abandon — Do Not Sync] again
  7. Click [Confirm] in the confirmation dialog
  8. Verify connector is deleted or moved to "Cancelled" status
  9. Verify Detail Panel closes
  10. Verify SourcesTable no longer shows the connector (or shows it as "Cancelled")
- **Expected Outcome:** Abandon flow requires confirmation, clearly states what is lost, and removes the connector cleanly.
- **Error Path:** Delete API fails — show error, connector remains in current state, panel stays open.
- **Edge Cases:** [C-03 Edge Case: Abandon while sync is already queued — sync must be cancelled before deletion]

#### E2E-W2-16: Condition Builder AND/OR Grouping

- **User Journey:** User builds filter conditions using the Condition Builder with AND/OR grouping and one level of nesting.
- **Design Reference:** C-04 UI Behaviors item 8 — Condition Builder
- **Preconditions:** Active connector with discovery complete. Simplified View OFF. Scope+Filters tab open.
- **Steps:**
  1. Navigate to Scope+Filters tab, locate the People & Metadata / Condition Builder section
  2. Click [+ Add Condition]
  3. Select a field (e.g., "department"), operator ("equals"), value ("Engineering")
  4. Verify the condition appears in the builder and the filter preview (right panel) updates
  5. Click [+ Add Condition] again
  6. Select field "sensitivityLabel", operator "in list", value "Confidential, Internal Only"
  7. Verify default grouping is AND — both conditions combined
  8. Switch grouping to OR
  9. Verify filter preview updates to reflect OR logic (more documents matched)
  10. Add a nested group: click to create a sub-group within one branch
  11. Add a condition within the nested group
  12. Verify one level of nesting is supported (no deeper nesting option)
  13. Verify filter preview reflects the nested logic correctly
- **Expected Outcome:** Condition Builder supports field/operator/value triplets, AND/OR switching, and one level of nesting. Preview updates on every change.
- **Error Path:** Invalid operator for field type (e.g., "greater than" on a string field) — show inline validation error.
- **Edge Cases:** [C-04 Edge Case 5: No metadata fields discovered — Condition Builder shows "No custom metadata discovered". C-04 Edge Case 6: Stale preview — debounce rapid condition changes]

### Integration Scenarios

#### INT-W2-01: Connector Name Uniqueness Validation

- **Components Under Test:** Connector CRUD API, name check endpoint
- **Design Reference:** C-02 API #2, C-02 Edge Case 1
- **Setup:** KB with existing connector named "Marketing Hub".
- **Trigger:** `GET /connectors/check-name?name=Marketing Hub`
- **Assertions:**
  1. Returns `{ available: false, suggestion: "Marketing Hub (2)" }` for duplicate name
  2. Returns `{ available: true }` for unique name
  3. Uniqueness is scoped to the KB (same name in different KB is allowed)
- **Failure Modes:** Case sensitivity — "marketing hub" vs "Marketing Hub" should be handled consistently.

#### INT-W2-02: Auth Initiation — All Three Methods

- **Components Under Test:** Auth service, OAuth flow, device code flow, client credentials flow
- **Design Reference:** C-02 API #3, C-02 Auth Method Selection
- **Setup:** Valid Azure App Registration credentials.
- **Trigger:** `POST /auth/initiate` with each auth method.
- **Assertions:**
  1. `browser_login`: Returns `{ redirectUrl, state }` — state stored in Redis (not pod-local)
  2. `device_code`: Returns `{ deviceCode, userCode, verificationUri, expiresIn, pollInterval }`
  3. `app_only`: Returns `{ success: true }` on valid credentials, `{ success: false, error }` on invalid
  4. All methods use correct scopes from resolveScopes() (Sites.Read.All, not FullControl)
- **Failure Modes:** Rate limiting from Microsoft — returns retryable error with delay.

#### INT-W2-03: Proposal Generation Orchestration

- **Components Under Test:** ProposalService, discovery, recommendation, health check subsystems
- **Design Reference:** C-03 Proposal Generation, HLD §4d Proposal Subsystem
- **Setup:** Connector with auth completed.
- **Trigger:** Auth status transitions to "completed" — proposal generation begins.
- **Assertions:**
  1. GET `/proposal/status` returns generation steps with real-time status updates
  2. Steps follow dependency order: Connection > Scopes > Health Check > Scope > Filters > Schedule > Permissions > Sample Preview > Security Gate
  3. Dependent steps show "Waiting for..." until prerequisites complete
  4. Pre-configured draft settings (filters, schedule) are applied during generation
  5. On completion, GET `/proposal` returns full proposal with all 8 sections
  6. ProposalState model created with status "generating" then "ready"
- **Failure Modes:** Discovery timeout — generation should fail gracefully with error details in the proposal status.

#### INT-W2-04: Proposal Section Review API

- **Components Under Test:** Proposal routes (accept, modify, skip, accept-all)
- **Design Reference:** C-03 API Requirements (§§3-6), API Coverage Matrix C-03
- **Setup:** Generated proposal with all sections in "Pending" state.
- **Trigger:** Series of section review API calls.
- **Assertions:**
  1. POST `.../sections/scope/accept` — section badge becomes "Accepted", decisions log entry created
  2. PUT `.../sections/filters` with modified config — section badge becomes "Modified", doc counts recalculated
  3. POST `.../sections/schedule/skip` — section badge becomes "Skipped"
  4. POST `.../accept-all` — all remaining pending sections become "Accepted", Permissions set to ENABLED
  5. Each operation creates a DecisionEntry in the User Decisions Log
  6. TOC progress count updates after each operation
- **Failure Modes:** Accepting a section that is already accepted — should be idempotent.

#### INT-W2-05: Filter Preview with Live Counts

- **Components Under Test:** Filter preview endpoint, scope/filter configuration
- **Design Reference:** C-04 API Requirements, API Coverage Matrix C-04
- **Setup:** Connector with discovery complete, 5 sites, ~500 documents.
- **Trigger:** `POST /filters/preview` with various filter configurations.
- **Assertions:**
  1. Returns matchCount, excludedCount, estimatedSyncMinutes
  2. Returns diff from previous state (+N/-N with reasons)
  3. Returns sampleDocuments (up to 20) and excludedDocuments with reasons
  4. Returns exclusionSummary grouped by category (Non-indexable, Site not selected, etc.)
  5. Returns perRuleImpact for Filter Audit table
  6. Returns generatedODataFilter and generatedODataSelect strings
  7. Debouncing: rapid calls produce consistent results (no stale data)
- **Failure Modes:** Very large scope (10k+ documents) — response within 3 seconds or progressive loading.

#### INT-W2-06: Draft Auto-Save and Resume

- **Components Under Test:** Connector CRUD, PATCH update, GET for resume
- **Design Reference:** C-07 API Requirements, C-07 Edge Cases
- **Setup:** Connector in "draft" status with partial configuration.
- **Trigger:** PATCH with filter/schedule changes, then GET to resume.
- **Assertions:**
  1. PATCH updates individual fields without overwriting others
  2. Manual site URLs are persisted alongside filter config
  3. GET returns all previously saved draft configuration
  4. Auth status polling continues independently of draft edits
  5. Auth failure does not reset draft configuration
- **Failure Modes:** Concurrent PATCH from two browser tabs — handle 409 Conflict or last-write-wins.

#### INT-W2-07: Preview Dry-Run Returns Correct Data

- **Components Under Test:** Preview API, connector configuration, SharePoint Graph metadata
- **Design Reference:** C-05 API #1, C-05 Required Data Fields
- **Setup:** Connector with scope (3 sites), filters (Documents Only, max 100MB).
- **Trigger:** `POST /preview`
- **Assertions:**
  1. Returns totalDocCount, siteCount, skipCount, estimatedSizeBytes, estimatedTimeMinRange/MaxRange
  2. Returns sampleDocuments with name, site, type, sizeBytes, sensitivityLabel
  3. Returns skippedDocuments with name and human-readable reason
  4. Returns contentTypeBreakdown with type, count, percentage
  5. Returns hasPreviousPreview and filterChanges when applicable
  6. Preview does NOT download or index content (metadata queries only)
- **Failure Modes:** SharePoint API unavailable — returns error with stale cache fallback if available.

#### INT-W2-08: Start Sync with Security Gate Check

- **Components Under Test:** Sync start API, security gate validation
- **Design Reference:** C-05 API #3 and #4, C-05 Security Gate override
- **Setup:** Two connectors — one with security gate "approved", one with "pending".
- **Trigger:** POST `/sync` on each connector.
- **Assertions:**
  1. Approved connector: returns `{ connectorId, syncJobId, status: "syncing" }`
  2. Pending connector: returns error directing to submit for security approval first
  3. POST `/security-review` on pending connector: returns `{ status: "pending_review", reviewId }`
  4. Connector status transitions correctly (draft → syncing, or draft → pending_review)
- **Failure Modes:** Sync start when token is expired — reject with "Re-authenticate required" error.

#### INT-W2-09: Proposal with Sites.Selected Variant

- **Components Under Test:** Proposal Scope section, site validation, admin request generation
- **Design Reference:** C-03 Scope Section Variant B, C-03 Sites.Selected Information Box
- **Setup:** Connector authenticated with Sites.Selected scope (not Sites.Read.All).
- **Trigger:** Proposal generates with Scope Variant B.
- **Assertions:**
  1. Scope section shows manual site URL entry (not auto-discovered sites)
  2. POST `.../proposal/scope/validate-sites` validates entered URLs
  3. Validation returns per-URL status (OK/FAIL with reasons)
  4. [Send Access Request to Admin] generates pre-written email with PowerShell commands
  5. [Upgrade to Sites.Read.All] triggers re-consent flow
  6. Health Check shows reduced capabilities (4/7 passed vs 7/7)
- **Failure Modes:** All entered site URLs fail validation — E8 (Zero Sites Found) error state.

#### INT-W2-10: IT Admin Email Generation

- **Components Under Test:** Admin email generation endpoint
- **Design Reference:** C-02 API #7, C-02 Returning User Experience
- **Setup:** Connector with Azure App Registration details.
- **Trigger:** `POST /connectors/generate-admin-email`
- **Assertions:**
  1. Returns subject, body, and mailto link
  2. Body includes step-by-step Azure Portal instructions
  3. Body is customized to the connector's tenant
  4. Includes required API permissions (Sites.Read.All, Files.Read.All, etc.)
- **Failure Modes:** Missing tenant info — generate generic instructions.

#### INT-W2-11: Proposal Scope with Zero Discovered Sites (Sites.Read.All)

- **Components Under Test:** ProposalService, Scope section rendering, Approve button state
- **Design Reference:** C-03 Edge Cases — "Zero sites discovered (Sites.Read.All)", C-11 E8
- **Setup:** Connector authenticated with Sites.Read.All scope but the tenant has 0 SharePoint sites (or all sites are inaccessible).
- **Trigger:** Proposal generates with Sites.Read.All but discovery returns 0 sites.
- **Assertions:**
  1. Proposal Scope section shows "No SharePoint sites found" message
  2. Troubleshooting guidance is displayed (check permissions, verify tenant has sites)
  3. "Approve All & Start Sync" button is disabled (cannot approve without at least one site)
  4. Scope section badge shows "[Needs Your Input]" rather than "[Pending]"
  5. All sites excluded by recommendation: if discovery finds sites but recommendation engine excludes all, scope section shows all sites in "Excluded" list with prompt to re-include at least one
- **Failure Modes:** Discovery fails entirely (not just 0 sites) — should show discovery error, not zero-sites message.

#### INT-W2-12: Rate Limit During Proposal Generation — UI Continues Polling

- **Components Under Test:** Proposal generation status endpoint, Health Check step, UI polling behavior
- **Design Reference:** C-03 Edge Cases — "Rate limit exhausted during generation"
- **Setup:** Simulated rate limit hit during Health Check step of proposal generation.
- **Trigger:** Proposal generation begins, Health Check step encounters a rate limit WARN.
- **Assertions:**
  1. Health Check step surfaces a WARN status (not FAIL)
  2. Generation continues past the Health Check step (does not abort)
  3. UI continues polling generation status past 90 seconds without timeout
  4. Final proposal includes Health Check with WARN badge, not error
- **Failure Modes:** Rate limit persists for extended period — generation should eventually timeout with an actionable error.

#### INT-W2-13: Overlapping Webhook Subscriptions — Schedule Section Note

- **Components Under Test:** ProposalService, Schedule section, webhook subscription detection
- **Design Reference:** C-03 Edge Cases — "Overlapping webhook subscriptions"
- **Setup:** Two connectors sharing the same Azure AD app registration, syncing overlapping document libraries.
- **Trigger:** Proposal generates for the second connector.
- **Assertions:**
  1. Schedule section includes a note about potential 409 conflicts from overlapping webhook subscriptions
  2. Note identifies the overlapping connector by name
  3. Schedule section suggests fallback to polling-based delta sync if webhooks conflict
  4. The note does not block proposal approval — it is informational only
- **Failure Modes:** Overlap detection unavailable — Schedule section renders without the note (graceful degradation).

### Wave 2 LLD-Derived Scenarios (Implementation-Level)

#### LLD-W2 Acceptance Criteria Coverage

| AC       | Task | Description                                                         | Test(s)              |
| -------- | ---- | ------------------------------------------------------------------- | -------------------- |
| AC-13.01 | T-13 | First-time renders 2 radio cards, no Client ID fields               | LLD-W2-01            |
| AC-13.02 | T-13 | Returning renders Client ID + Tenant ID + 3 auth radio options      | LLD-W2-02            |
| AC-13.03 | T-13 | Connection Scopes disable requires typing "public access"           | LLD-W2-03            |
| AC-13.04 | T-13 | Auth initiation calls initiateConnectorAuth + polls every 3s        | LLD-W2-04            |
| AC-13.05 | T-13 | Build succeeds                                                      | (build verification) |
| AC-14.01 | T-14 | ProposalState registered with ModelRegistry as 'platform'           | LLD-W2-06            |
| AC-14.02 | T-14 | startGeneration creates 9-step 'generating' proposal                | LLD-W2-07            |
| AC-14.03 | T-14 | acceptSection updates status + appends decision, scoped to tenantId | LLD-W2-08            |
| AC-14.04 | T-14 | approveProposal calls startSync and returns syncJobId               | LLD-W2-10            |
| AC-14.05 | T-14 | Partial unique index: active dupe fails, post-abandon succeeds      | LLD-W2-09            |
| AC-15.01 | T-15 | GET proposal/status returns generation steps                        | LLD-W2-13            |
| AC-15.02 | T-15 | POST sections/:sectionId/accept updates section                     | LLD-W2-14            |
| AC-15.03 | T-15 | Invalid sectionId returns 400 Zod error                             | LLD-W2-15            |
| AC-15.04 | T-15 | All routes require tenantId from auth (401 without auth)            | LLD-W2-16            |
| AC-16.01 | T-16 | Generation progress renders 9 items with correct status icons       | LLD-W2-17            |
| AC-16.02 | T-16 | TOC section click scrolls to corresponding section                  | LLD-W2-18            |
| AC-16.03 | T-16 | Accept button calls API and updates badge                           | LLD-W2-19            |
| AC-16.04 | T-16 | Simplified View shows 4-step progress indicator                     | LLD-W2-20            |
| AC-16.05 | T-16 | useConnectorProposal polls at 2s when generating, stops when ready  | LLD-W2-21            |
| AC-17.01 | T-17 | Split-pane renders with 60/40 width ratio                           | LLD-W2-22            |
| AC-17.02 | T-17 | Panel auto-expands on tab activation                                | LLD-W2-23            |
| AC-17.03 | T-17 | Filter change triggers preview API after 500ms debounce             | LLD-W2-24            |
| AC-17.04 | T-17 | Undo reverts to previous filter configuration                       | LLD-W2-25            |
| AC-17.05 | T-17 | Draft mode shows sites section as disabled                          | LLD-W2-26            |
| AC-18.01 | T-18 | Typing `resource.` shows field suggestions dropdown                 | LLD-W2-27            |
| AC-18.02 | T-18 | Validate button triggers validation and displays result             | LLD-W2-28            |
| AC-18.03 | T-18 | Invalid expression shows error with position                        | LLD-W2-29            |
| AC-19.01 | T-19 | Renders condition row with field, operator, value                   | LLD-W2-30            |
| AC-19.02 | T-19 | Add Condition appends to group                                      | LLD-W2-31            |
| AC-19.03 | T-19 | AND/OR toggle changes group logic                                   | LLD-W2-32            |
| AC-19.04 | T-19 | All 15 operators appear in dropdown                                 | LLD-W2-33            |
| AC-20.01 | T-20 | Preview tab renders 4 summary stats                                 | LLD-W2-34            |
| AC-20.02 | T-20 | Content type breakdown renders proportional bars                    | LLD-W2-35            |
| AC-20.03 | T-20 | Adjust Filters calls onNavigateToFilters                            | LLD-W2-36            |
| AC-20.04 | T-20 | Sample documents table shows max 25 rows                            | LLD-W2-37            |
| AC-21.01 | T-21 | Config summary renders all 6 sections                               | LLD-W2-38            |
| AC-21.02 | T-21 | Start Sync opens confirmation dialog                                | LLD-W2-39            |
| AC-21.03 | T-21 | Confirm starts sync and calls onSyncStarted                         | LLD-W2-40            |
| AC-21.04 | T-21 | Security pending shows "Submit for Security Approval"               | LLD-W2-41            |
| AC-22.01 | T-22 | ConnectionScopesDisplay renders full and compact modes              | LLD-W2-42            |
| AC-22.02 | T-22 | Type-to-confirm works identically in both contexts                  | LLD-W2-43            |
| AC-23.01 | T-23 | Connect Source opens dialog on Home tab (no tab switch)             | LLD-W2-44            |
| AC-23.02 | T-23 | Selecting SharePoint opens SharePointDetailPanel                    | LLD-W2-45            |
| AC-23.03 | T-23 | After setup, navigates to Data tab > Sources                        | LLD-W2-46            |
| AC-24.01 | T-24 | SharePoint row click opens SharePointDetailPanel via store          | LLD-W2-47            |
| AC-24.02 | T-24 | Draft connector opens panel on Connect tab                          | LLD-W2-48            |
| AC-24.03 | T-24 | Active connector opens panel on Overview tab                        | LLD-W2-49            |
| AC-24.04 | T-24 | Non-SharePoint sources open existing SourceDetailPanel              | LLD-W2-50            |
| AC-25.01 | T-25 | checkConnectorName returns available:true when unique               | LLD-W2-51            |
| AC-25.02 | T-25 | checkConnectorName returns available:false + suggestion when taken  | LLD-W2-51            |
| AC-25.03 | T-25 | generateAdminEmail returns subject, body, mailto                    | LLD-W2-52            |
| AC-25.04 | T-25 | GET check-name matched before /:connectorId                         | LLD-W2-51            |
| AC-25.05 | T-25 | All queries include tenantId                                        | LLD-W2-51, LLD-W2-52 |

---

#### T-13: Connect Tab

#### LLD-W2-01: ConnectTab First-Time Experience Rendering

- **LLD Task:** T-13, AC-13.01
- **Type:** Component
- **What to Test:** When `useConnectorList` returns 0 SharePoint connectors, ConnectTab renders the first-time experience with 2 radio cards (Azure App Registration, Sign in with Microsoft) and NO Client ID / Tenant ID input fields. Conversational welcome heading and ~3 minute estimate shown.
- **Setup:** Mock `useConnectorList(indexId)` returning `{ connectors: [] }`. Render `<ConnectTab indexId="idx-1" connectorId={null} onAuthComplete={vi.fn()} onConnectorCreated={vi.fn()} />`.
- **Assertions:**
  1. Two `Card` elements rendered with radio selection behavior
  2. Card labels include "Azure App Registration" and "Sign in with Microsoft"
  3. No `<input>` elements for Client ID or Tenant ID are present in the DOM
  4. Heading text matches i18n key `search_ai.sharepoint.connect.welcome_title`
  5. Connector name field renders with correct placeholder from i18n

#### LLD-W2-02: ConnectTab Returning User Experience Rendering

- **LLD Task:** T-13, AC-13.02
- **Type:** Component
- **What to Test:** When `useConnectorList` returns 1+ SharePoint connectors, ConnectTab renders the compact numbered-step form with mandatory connector name, Client ID, Tenant ID fields, and 3 auth method radio options (Device Code, Browser Login, App-Only).
- **Setup:** Mock `useConnectorList(indexId)` returning `{ connectors: [{ connectorType: 'sharepoint', ... }] }`. Render `<ConnectTab indexId="idx-1" connectorId={null} onAuthComplete={vi.fn()} onConnectorCreated={vi.fn()} />`.
- **Assertions:**
  1. No conversational welcome heading rendered
  2. Three `RadioGroup` options visible: Device Code, Browser Login, App-Only (Client Credentials)
  3. Client ID input field present and validates GUID format (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`)
  4. Tenant ID input field present and validates GUID format
  5. Connector name field is required (not optional as in first-time)

#### LLD-W2-03: ConnectionScopesDisplay Type-to-Confirm Disable Flow

- **LLD Task:** T-13, AC-13.03
- **Type:** Component
- **What to Test:** The ConnectionScopesDisplay component requires typing exactly "public access" before the Confirm button enables. Uses `TypeToConfirmInput` from Wave 1 T-11 with `confirmText="public access"`.
- **Setup:** Render `<ConnectionScopesDisplay permissionAwareEnabled={true} onDisablePermissionAware={vi.fn()} />`.
- **Assertions:**
  1. "[I need to disable this...]" link is visible
  2. Clicking the link expands an inline panel (not a dialog)
  3. Confirm Disable button is disabled when `expanded` state is true but text is empty
  4. Typing "public acces" (missing 's') keeps Confirm Disable button disabled
  5. Typing "public access" enables Confirm Disable button
  6. Clicking Confirm Disable calls `onDisablePermissionAware()`

#### LLD-W2-04: ConnectTab Auth Initiation and Polling

- **LLD Task:** T-13, AC-13.04
- **Type:** Component
- **What to Test:** After clicking Continue/Connect, `initiateConnectorAuth()` is called and SWR polling starts with `refreshInterval: 3000` to check auth status.
- **Setup:** Mock `createEnterpriseConnector()` returning `{ _id: 'conn-1' }`. Mock `initiateConnectorAuth()` returning `{ deviceCode: 'abc', userCode: 'XYZ-123', verificationUri: 'https://...' }`. Render ConnectTab with returning user experience.
- **Assertions:**
  1. `createEnterpriseConnector()` called when connectorId is null
  2. `initiateConnectorAuth()` called after connector creation with correct auth method
  3. SWR hook configured with `refreshInterval: 3000` after auth initiation
  4. Device code display renders userCode and verificationUri when auth method is device_code
  5. `onAuthComplete()` called when polling detects auth status "completed"

#### LLD-W2-05: ConnectTab Auth Popup Blocked Fallback

- **LLD Task:** T-13, Risk Notes (auth popup blocking)
- **Type:** Component
- **What to Test:** When `window.open()` returns null (popup blocked), ConnectTab shows a fallback message offering Device Code as alternative.
- **Setup:** Mock `window.open` to return null. Initiate browser login auth method.
- **Assertions:**
  1. Popup blocked detection triggers fallback UI
  2. Fallback message displayed with "Switch to Device Code" option
  3. Clicking the option switches auth method and re-initiates with device_code

---

#### T-14: ProposalState Model + Service

#### LLD-W2-06: ProposalState Model Registration

- **LLD Task:** T-14, AC-14.01
- **Type:** Unit
- **What to Test:** ProposalState model is registered with ModelRegistry as 'platform' affinity and uses `tenantIsolationPlugin`.
- **Setup:** Import ProposalState model and ModelRegistry.
- **Assertions:**
  1. `ModelRegistry.getPlatformModels().some(m => m.name === 'ProposalState')` returns true
  2. Schema has `tenantIsolationPlugin` applied
  3. Schema uses `uuidv7` for `_id` default
  4. Collection name is `'proposal_states'`
  5. `timestamps: true` is configured

#### LLD-W2-07: startGeneration Creates 9-Step Proposal

- **LLD Task:** T-14, AC-14.02
- **Type:** Integration
- **What to Test:** `startGeneration()` creates a ProposalState document with status 'generating', 9 generation steps all in 'pending', and returns immediately while the pipeline runs in the background.
- **Setup:** MongoDB in-memory. Create a ConnectorConfig document with auth completed.
- **Assertions:**
  1. Returned proposal has `status === 'generating'`
  2. `generationSteps.length === 9`
  3. All steps initially in `'pending'` status
  4. Step IDs match: connection, scopes, health-check, scope, filters, schedule, permissions, sample-preview, security-gate
  5. Step dependencies are correctly defined (e.g., filters depends on scope, security-gate depends on all)
  6. `tenantId` matches the input tenantId

#### LLD-W2-08: Section Review Operations (Accept, Modify, Skip)

- **LLD Task:** T-14, AC-14.03
- **Type:** Integration
- **What to Test:** `acceptSection()`, `modifySection()`, and `skipSection()` update the corresponding section status and append a decision entry. All operations are scoped to `tenantId`.
- **Setup:** MongoDB in-memory. Create a ProposalState with status 'ready' and all sections in 'pending'.
- **Assertions:**
  1. `acceptSection('scope', ...)` sets `sections.scope.status === 'accepted'`
  2. `decisions` array has 1 entry with `decision: 'accept'`, `section: 'scope'`
  3. `modifySection('filters', ..., { template: 'custom' })` sets `sections.filters.status === 'modified'`
  4. `skipSection('schedule', ...)` sets `sections.schedule.status === 'skipped'`
  5. Cross-tenant access blocked: calling with wrong tenantId returns null/throws
  6. `reviewedAt` timestamp set on each reviewed section
  7. `reviewedBy` set to the actor string

#### LLD-W2-09: Partial Unique Index Behavior

- **LLD Task:** T-14, AC-14.05
- **Type:** Integration
- **What to Test:** The partial unique index `{ tenantId: 1, connectorId: 1 }` with `partialFilterExpression: { status: { $nin: ['abandoned', 'failed'] } }` prevents two active proposals for the same connector but allows re-creation after abandon.
- **Setup:** MongoDB in-memory.
- **Assertions:**
  1. Creating two proposals for the same connectorId+tenantId with status 'generating' throws duplicate key error
  2. Creating a proposal, then calling `abandonProposal()`, then creating a new proposal succeeds
  3. Creating a proposal, then forcing status to 'failed', then creating a new proposal succeeds
  4. Two proposals with different connectorIds but same tenantId both succeed

#### LLD-W2-10: approveProposal Triggers Sync

- **LLD Task:** T-14, AC-14.04
- **Type:** Integration
- **What to Test:** `approveProposal()` applies final configuration to the connector, calls `startSync()`, writes an audit entry, and returns a `syncJobId`.
- **Setup:** MongoDB in-memory. ProposalState in 'ready' status with all sections reviewed. Mock `startSync()` and `writeAuditEntry()`.
- **Assertions:**
  1. Returns `{ syncJobId }` where syncJobId is a non-empty string
  2. ProposalState status transitions to 'approved'
  3. `approvedAt` and `approvedBy` are set
  4. `startSync()` called with correct connectorId
  5. Audit entry written via `writeAuditEntry()`

#### LLD-W2-11: acceptAllRemaining Bulk Accept

- **LLD Task:** T-14, ST-14.4
- **Type:** Integration
- **What to Test:** `acceptAllRemaining()` accepts all sections still in 'pending' status and appends a single 'accept_all' decision entry. Permissions defaults to ENABLED.
- **Setup:** ProposalState with 3 sections accepted, 5 sections pending.
- **Assertions:**
  1. All 5 previously-pending sections now have `status === 'accepted'`
  2. Previously-accepted sections unchanged
  3. Single decision entry with `decision: 'accept_all'`
  4. Permissions section data has `mode: 'enabled'` (safe default)

#### LLD-W2-12: Generation Pipeline Step Dependencies and Timeouts

- **LLD Task:** T-14, Generation Logic
- **Type:** Integration
- **What to Test:** The generation pipeline processes steps in dependency order, respects 30s per-step timeout, and transitions to 'failed' on step timeout.
- **Setup:** MongoDB in-memory. Mock discovery to return slowly (>30s simulated).
- **Assertions:**
  1. Connection step runs first (no dependencies)
  2. Scopes step runs only after connection completes
  3. Health-check runs only after scopes completes
  4. Schedule and permissions can run in parallel (both depend on health-check/scopes respectively)
  5. Security-gate runs last (depends on all other steps)
  6. Step exceeding 30s timeout is marked 'failed'
  7. Proposal transitions to 'failed' when a step fails

---

#### T-15: Proposal Routes

#### LLD-W2-13: Proposal Status Endpoint Returns Steps

- **LLD Task:** T-15, AC-15.01
- **Type:** Integration
- **What to Test:** `GET /:indexId/connectors/:connectorId/proposal/status` returns generation steps with real-time status.
- **Setup:** Create a ProposalState with status 'generating', 3 steps 'done', 1 'in_progress', 5 'pending'. Authenticated request with valid tenantId.
- **Assertions:**
  1. HTTP 200 with `{ success: true, data: { status: 'generating', steps: [...] } }`
  2. Steps array has 9 entries
  3. Step statuses match the database state
  4. Response includes `statusText` for each step

#### LLD-W2-14: Section Accept Endpoint

- **LLD Task:** T-15, AC-15.02
- **Type:** Integration
- **What to Test:** `POST /:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept` updates the section and returns updated data.
- **Setup:** ProposalState with status 'ready', section 'scope' in 'pending'. Authenticated request.
- **Assertions:**
  1. HTTP 200 with `{ success: true, data: { status: 'accepted' } }`
  2. ProposalState document updated in DB
  3. Decision entry appended with actor from `req.tenantContext`

#### LLD-W2-15: Zod Validation on Invalid Parameters

- **LLD Task:** T-15, AC-15.03
- **Type:** Integration
- **What to Test:** Invalid or empty path parameters return 400 with Zod validation error. Tests `connectorParams` and `sectionParams` schemas.
- **Setup:** Authenticated request.
- **Assertions:**
  1. `POST .../sections//accept` (empty sectionId) returns 400
  2. `PUT .../sections/scope` with empty body returns 400 (missing `data` field)
  3. `POST .../scope/validate-sites` with `{ siteUrls: [] }` returns 400 (min 1)
  4. `POST .../scope/validate-sites` with `{ siteUrls: ["not-a-url"] }` returns 400 (url validation)
  5. `GET .../export?format=invalid` returns 400 (enum validation)
  6. Error response contains Zod issue details

#### LLD-W2-16: Auth Required on All Proposal Routes

- **LLD Task:** T-15, AC-15.04
- **Type:** Integration
- **What to Test:** All proposal routes return 401 when called without authentication headers. Verifies `router.use(authMiddleware)` is applied.
- **Setup:** No auth headers on request.
- **Assertions:**
  1. `GET .../proposal/status` without auth returns 401
  2. `POST .../proposal/generate` without auth returns 401
  3. `POST .../sections/scope/accept` without auth returns 401
  4. `POST .../proposal/approve` without auth returns 401
  5. `DELETE .../proposal/abandon` without auth returns 401

---

#### T-16: Proposal Tab

#### LLD-W2-17: ProposalGenerationProgress Renders 9 Steps with Icons

- **LLD Task:** T-16, AC-16.01
- **Type:** Component
- **What to Test:** ProposalGenerationProgress renders 9 checklist items with correct status icons (spinner for in_progress, check for done, clock for waiting, X for failed, empty circle for pending).
- **Setup:** Render with mock steps: 2 done, 1 in_progress, 1 waiting, 5 pending.
- **Assertions:**
  1. 9 list items rendered
  2. Done steps show check icon
  3. In-progress step shows spinner icon
  4. Waiting step shows clock icon
  5. Pending steps show empty circle
  6. `statusText` displayed inline for in_progress step (e.g., "Discovering sites...")

#### LLD-W2-18: ProposalTableOfContents Click Scrolls to Section

- **LLD Task:** T-16, AC-16.02
- **Type:** Component
- **What to Test:** Clicking a section entry in the TOC triggers `scrollIntoView` on the corresponding section element.
- **Setup:** Render ProposalTableOfContents with 8 sections. Mock `scrollIntoView` on section refs.
- **Assertions:**
  1. 8 TOC entries rendered with section titles
  2. Clicking "Scope" entry calls `scrollIntoView` on the scope section element
  3. Each entry shows correct badge (Pending, Accepted, Modified, Skipped)
  4. Progress label shows "Progress: N of 8 sections reviewed"

#### LLD-W2-19: Accept Button Updates Badge via API

- **LLD Task:** T-16, AC-16.03
- **Type:** Component
- **What to Test:** Clicking Accept on a section calls `acceptProposalSection()` API and updates the section badge to "Accepted" after success.
- **Setup:** Render ProposalTab with mock proposal in 'ready' status. Mock `acceptProposalSection()` returning success.
- **Assertions:**
  1. Accept button visible on pending section
  2. Clicking Accept calls `acceptProposalSection(indexId, connectorId, sectionId)`
  3. After API success, section badge changes to "Accepted"
  4. SWR cache mutated (optimistic update or revalidation)
  5. TOC progress count increments

#### LLD-W2-20: Simplified View Step Progress Indicator

- **LLD Task:** T-16, AC-16.04
- **Type:** Component
- **What to Test:** When `simplifiedView: true`, ProposalTab renders a 4-step progress indicator (Connect, Proposal, Preview, Security) above the proposal content, with step 2 (Proposal) highlighted.
- **Setup:** Render `<ProposalTab simplifiedView={true} ... />` with mock proposal.
- **Assertions:**
  1. Step indicator visible with 4 steps
  2. Step 2 is highlighted/active
  3. Step labels match: Connect, Proposal, Preview, Security
  4. i18n key `step_indicator` used with current=2, total=4

#### LLD-W2-21: useConnectorProposal Polling Behavior

- **LLD Task:** T-16, AC-16.05
- **Type:** Unit
- **What to Test:** `useConnectorProposal` hook sets SWR `refreshInterval` to 2000 when proposal status is 'generating' and 0 when status changes to 'ready'.
- **Setup:** Render hook with `pollWhileGenerating: true`.
- **Assertions:**
  1. When proposal status is 'generating', `refreshInterval === 2000`
  2. When proposal status transitions to 'ready', `refreshInterval === 0`
  3. SWR key is null when indexId or connectorId is null (no fetch)
  4. SWR key format: `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/proposal`

---

#### T-17: Scope+Filters Split-Pane

#### LLD-W2-22: ScopeFiltersSplitPane 60/40 Layout

- **LLD Task:** T-17, AC-17.01
- **Type:** Component
- **What to Test:** The split-pane renders with 60% left (controls) and 40% right (preview) width allocation.
- **Setup:** Render `<ScopeFiltersSplitPane indexId="idx-1" connectorId="conn-1" isDraftMode={false} simplifiedView={false} />` with mock discovery data.
- **Assertions:**
  1. Left panel has `basis-3/5` (or equivalent 60% flex basis)
  2. Right panel has `basis-2/5` (or equivalent 40% flex basis)
  3. Both panels render within a flex container with gap

#### LLD-W2-23: Panel Auto-Expand on Tab Activation

- **LLD Task:** T-17, AC-17.02
- **Type:** Component
- **What to Test:** On mount, `useConnectorStore.setExpandedPanel(true)` is called. On unmount, `setExpandedPanel(false)` is called.
- **Setup:** Mock `useConnectorStore`. Render and unmount `ScopeFiltersSplitPane`.
- **Assertions:**
  1. `setExpandedPanel(true)` called on mount
  2. `setExpandedPanel(false)` called on unmount
  3. Panel expansion persists while tab is active

#### LLD-W2-24: Filter Change Triggers Debounced Preview

- **LLD Task:** T-17, AC-17.03
- **Type:** Component
- **What to Test:** Changing a filter control (e.g., toggling a file type) triggers the `useFilterPreview` SWR call after a 500ms debounce period.
- **Setup:** Render ScopeFiltersSplitPane with discovery data including multiple file types. Mock preview API.
- **Assertions:**
  1. Toggling a file type checkbox calls `onFilterChange()` immediately
  2. Preview API is NOT called immediately after change
  3. Preview API is called after 500ms debounce delay
  4. Rapid changes (toggling 3 checkboxes within 500ms) result in only 1 API call
  5. Preview panel shows loading skeleton during debounce+fetch

#### LLD-W2-25: Undo Reverts Filter Configuration

- **LLD Task:** T-17, AC-17.04
- **Type:** Component
- **What to Test:** Clicking Undo reverts the filter configuration to the previous state. Undo history is capped at 20 entries.
- **Setup:** Render ScopeFiltersSplitPane. Make 3 filter changes.
- **Assertions:**
  1. After 3 changes, clicking Undo reverts to state after change 2
  2. Clicking Undo again reverts to state after change 1
  3. Undo button disabled when at initial state
  4. `canUndo` prop accurately reflects undo availability

#### LLD-W2-26: Draft Mode Sites Section Disabled

- **LLD Task:** T-17, AC-17.05
- **Type:** Component
- **What to Test:** In draft mode (`isDraftMode: true`), the sites section is disabled with placeholder text "Will be populated after authentication and discovery".
- **Setup:** Render `<ScopeFiltersSplitPane isDraftMode={true} ... />`.
- **Assertions:**
  1. Sites list section shows disabled state (no checkboxes interactive)
  2. Placeholder text displayed instead of site list
  3. Other sections (file types, dates, etc.) remain interactive
  4. Filter templates section still functional

#### LLD-W2-26b: useFilterPreview POST-Based SWR Fetcher

- **LLD Task:** T-17, ST-17.2
- **Type:** Unit
- **What to Test:** `useFilterPreview` uses a POST-based SWR fetcher (not GET) since the preview endpoint requires a filter config body.
- **Setup:** Render hook with a valid connectorId and filterConfig.
- **Assertions:**
  1. SWR fetcher sends POST to `/api/search-ai/connectors/${connectorId}/filters/preview`
  2. Request body contains the serialized filterConfig
  3. SWR key is null when connectorId is null
  4. SWR key is null when filterConfig is null

---

#### T-18: CEL Expression Editor

#### LLD-W2-27: Field Autocomplete on `resource.`

- **LLD Task:** T-18, AC-18.01
- **Type:** Component
- **What to Test:** Typing `resource.` in the CEL editor triggers a dropdown showing field suggestions from discovery metadata.
- **Setup:** Render `<CELExpressionEditor value="" onChange={vi.fn()} onValidate={vi.fn()} fieldSuggestions={[{ field: 'department', type: 'string' }, { field: 'sensitivity', type: 'string' }]} valueSuggestions={{}} />`.
- **Assertions:**
  1. Typing "resource." shows dropdown with "department" and "sensitivity"
  2. Selecting a field appends it to the expression (e.g., "resource.department")
  3. Dropdown closes after selection
  4. No dropdown appears when typing non-trigger text

#### LLD-W2-28: Validation Success Display

- **LLD Task:** T-18, AC-18.02
- **Type:** Component
- **What to Test:** Clicking Validate Expression with a valid expression shows green check icon.
- **Setup:** Render CELExpressionEditor with `validationResult: { valid: true }`.
- **Assertions:**
  1. Validate Expression button triggers `onValidate()` callback
  2. When `validationResult.valid === true`, green check icon rendered
  3. No error message displayed

#### LLD-W2-29: Validation Error with Position

- **LLD Task:** T-18, AC-18.03
- **Type:** Component
- **What to Test:** An invalid CEL expression displays an error message with position indicator and optional fix suggestion.
- **Setup:** Render CELExpressionEditor with `validationResult: { valid: false, error: { position: 15, description: 'Unexpected token', suggestion: 'Did you mean ==' } }`.
- **Assertions:**
  1. Error message "Unexpected token" displayed below editor
  2. Position indicator highlights character at position 15
  3. Fix suggestion "Did you mean ==" shown
  4. Editor border changes to error color

#### LLD-W2-29b: Value Autocomplete After Operator

- **LLD Task:** T-18, ST-18.2
- **Type:** Component
- **What to Test:** After typing `resource.department == "`, value suggestions dropdown appears with doc counts from discovery data.
- **Setup:** Render CELExpressionEditor with `valueSuggestions: { department: [{ value: 'Engineering', docCount: 234 }, { value: 'Marketing', docCount: 156 }] }`.
- **Assertions:**
  1. Typing `== "` after a field name triggers value suggestions
  2. Dropdown shows values with doc counts (e.g., "Engineering (234 docs)")
  3. Selecting a value completes the expression with quotes

---

#### T-19: Condition Builder

#### LLD-W2-30: Condition Row Rendering

- **LLD Task:** T-19, AC-19.01
- **Type:** Component
- **What to Test:** A single condition renders as a row with field select, operator select, and value input, plus a remove button.
- **Setup:** Render `<ConditionBuilder groups={[{ logic: 'AND', conditions: [{ field: 'department', operator: 'equals', value: 'Engineering' }] }]} onChange={vi.fn()} fields={[{ name: 'department', type: 'string' }]} />`.
- **Assertions:**
  1. Field select shows "department" selected
  2. Operator select shows "equals" selected
  3. Value input shows "Engineering"
  4. Remove (X) button present on the row

#### LLD-W2-31: Add Condition Appends to Group

- **LLD Task:** T-19, AC-19.02
- **Type:** Component
- **What to Test:** Clicking [+ Add Condition] calls `onChange` with an additional condition in the group.
- **Setup:** Render ConditionBuilder with one group containing one condition.
- **Assertions:**
  1. [+ Add Condition] button visible within the group
  2. Clicking it calls `onChange` with `groups[0].conditions.length === 2`
  3. New condition has empty default values
  4. Max 10 conditions per group enforced (button hidden at 10)

#### LLD-W2-32: AND/OR Toggle Changes Group Logic

- **LLD Task:** T-19, AC-19.03
- **Type:** Component
- **What to Test:** Toggling from AND to OR changes the group's logic operator.
- **Setup:** Render ConditionBuilder with one group set to `logic: 'AND'` and 2 conditions.
- **Assertions:**
  1. AND/OR toggle (segmented control or buttons) visible
  2. Clicking OR calls `onChange` with `groups[0].logic === 'OR'`
  3. Visual indicator reflects the active logic operator

#### LLD-W2-33: All 15 Operators in Dropdown

- **LLD Task:** T-19, AC-19.04
- **Type:** Component
- **What to Test:** The operator dropdown lists all 15 operators: equals, not_equals, contains, not_contains, starts_with, ends_with, greater_than, less_than, in_list, not_in_list, exists, not_exists, regex_match, between, is_empty.
- **Setup:** Render ConditionBuilder with a condition. Open the operator select.
- **Assertions:**
  1. 15 options listed in the operator dropdown
  2. `exists` and `not_exists` operators hide the value input (no value needed)
  3. `in_list` and `not_in_list` show comma-separated text input for value
  4. `between` shows two value inputs (min/max)

#### LLD-W2-33b: Nesting Limit Enforcement

- **LLD Task:** T-19, ST-19.2
- **Type:** Component
- **What to Test:** Only one level of nesting is allowed. The [+ Add Group] button creates a sub-group, but sub-groups cannot contain further sub-groups.
- **Setup:** Render ConditionBuilder with one group.
- **Assertions:**
  1. [+ Add Group] button visible at top level
  2. Clicking it adds a nested group
  3. Nested group does NOT have a [+ Add Group] button (no deeper nesting)
  4. Maximum nesting depth is 1

---

#### T-20: Preview Tab

#### LLD-W2-34: Preview Tab Summary Stats

- **LLD Task:** T-20, AC-20.01
- **Type:** Component
- **What to Test:** PreviewTab renders 4 summary stats (doc count, skip count, estimated size, time range) from the preview API response.
- **Setup:** Render `<PreviewTab indexId="idx-1" connectorId="conn-1" onNavigateToFilters={vi.fn()} onNavigateToApprove={vi.fn()} />`. Mock `runPreview()` returning `{ totalDocCount: 1500, skipCount: 200, estimatedSizeBytes: 5368709120, estimatedTimeMinRange: 15, estimatedTimeMaxRange: 30, ... }`.
- **Assertions:**
  1. Document count "~1,500 documents" displayed
  2. Skip count "200 skipped" displayed
  3. Size rendered in human-readable format (e.g., "~5 GB")
  4. Time range "15-30 minutes" displayed
  5. Stats rendered in a 4-item grid layout

#### LLD-W2-35: ContentTypeBreakdown Proportional Bars

- **LLD Task:** T-20, AC-20.02
- **Type:** Component
- **What to Test:** ContentTypeBreakdown renders horizontal bars with widths proportional to percentage.
- **Setup:** Render `<ContentTypeBreakdown data={[{ type: 'PDF', count: 500, percentage: 50 }, { type: 'DOCX', count: 300, percentage: 30 }, { type: 'PPTX', count: 150, percentage: 15 }, { type: 'Other', count: 50, percentage: 5 }]} />`.
- **Assertions:**
  1. 4 horizontal bars rendered
  2. PDF bar has `style.width === '50%'`
  3. DOCX bar has `style.width === '30%'`
  4. Each bar shows type label, count, and percentage text
  5. Top 4 types shown individually; if >4 types, remaining grouped as "Other"

#### LLD-W2-36: Adjust Filters Navigation

- **LLD Task:** T-20, AC-20.03
- **Type:** Component
- **What to Test:** Clicking [Adjust Filters] button calls `onNavigateToFilters()`.
- **Setup:** Render PreviewTab with mock data.
- **Assertions:**
  1. [Adjust Filters] button visible
  2. Clicking it calls `onNavigateToFilters()` exactly once
  3. [Approve Sync] button also visible, calling `onNavigateToApprove()`

#### LLD-W2-37: Sample Documents Table Max 25 Rows

- **LLD Task:** T-20, AC-20.04
- **Type:** Component
- **What to Test:** Sample documents table truncates at 25 rows even if API returns more.
- **Setup:** Render PreviewTab with `sampleDocuments` array of 30 items.
- **Assertions:**
  1. Table renders exactly 25 rows
  2. Columns include Name, Site, Type, Size, Sensitivity
  3. Skipped documents table renders separately with max 10 rows
  4. Each skipped document shows human-readable reason

#### LLD-W2-37b: Preview Tab Zero Documents Empty State

- **LLD Task:** T-20, Risk Notes + E2E-W2-09
- **Type:** Component
- **What to Test:** When preview returns 0 matched documents, an empty state is shown with [Adjust Filters] CTA and [Approve Sync] disabled.
- **Setup:** Mock `runPreview()` returning `{ totalDocCount: 0, skipCount: 500, ... }`.
- **Assertions:**
  1. Empty state message displayed (no sample documents table)
  2. [Adjust Filters] CTA prominently visible
  3. [Approve Sync] button is disabled

---

#### T-21: Approve & Start

#### LLD-W2-38: Config Summary Renders All 6 Sections

- **LLD Task:** T-21, AC-21.01
- **Type:** Component
- **What to Test:** ApproveAndStart fetches config summary and renders all 6 sections: Connection, Scope, Filters, Schedule, Permissions, Security.
- **Setup:** Mock `getConfigSummary()` returning full summary data. Render `<ApproveAndStart indexId="idx-1" connectorId="conn-1" onSyncStarted={vi.fn()} onSaveAsDraft={vi.fn()} onExportTemplate={vi.fn()} />`.
- **Assertions:**
  1. Connection section shows auth method, tenant ID, client ID
  2. Scope section shows variant, site count, site list
  3. Filters section shows template, file types, date range
  4. Schedule section shows frequency and next run
  5. Permissions section shows mode and permissionAwareEnabled
  6. Security section shows status and approval requirement

#### LLD-W2-39: Start Sync Opens Confirmation Dialog

- **LLD Task:** T-21, AC-21.02
- **Type:** Component
- **What to Test:** Clicking [Start Sync] opens an inline ConfirmDialog showing doc count and estimated size.
- **Setup:** Render ApproveAndStart with config summary including `totalDocuments: 1500, estimatedSizeBytes: 5368709120`.
- **Assertions:**
  1. Three action buttons rendered: Start Sync, Save as Draft, Export Template
  2. Clicking [Start Sync] opens ConfirmDialog
  3. Dialog text includes "~1,500 documents" and "~5 GB"
  4. Dialog has [Confirm & Start Sync] and [Cancel] buttons

#### LLD-W2-40: Confirm Starts Sync

- **LLD Task:** T-21, AC-21.03
- **Type:** Component
- **What to Test:** Confirming in the dialog calls `approveProposal()` and on success calls `onSyncStarted(syncJobId)`.
- **Setup:** Mock `approveProposal()` returning `{ syncJobId: 'job-123' }`.
- **Assertions:**
  1. Clicking [Confirm & Start Sync] calls `approveProposal(indexId, connectorId)`
  2. On success, `onSyncStarted('job-123')` called
  3. On API error, toast error shown and dialog remains open
  4. Button shows loading spinner during API call

#### LLD-W2-41: Security Pending Button Text

- **LLD Task:** T-21, AC-21.04
- **Type:** Component
- **What to Test:** When `security.status === 'pending'`, the button text changes from "Start Sync" to "Submit for Security Approval".
- **Setup:** Render ApproveAndStart with `security: { status: 'pending', approvalRequired: true }`.
- **Assertions:**
  1. Button text reads "Submit for Security Approval" (not "Start Sync")
  2. Clicking it submits for review (different API path)
  3. When `security.status === 'approved'`, button text reads "Start Sync"

#### LLD-W2-41b: Export Template Button Disabled (Wave 2)

- **LLD Task:** T-21, Risk Notes
- **Type:** Component
- **What to Test:** The Export Template button is disabled in Wave 2 with a tooltip explaining future availability.
- **Setup:** Render ApproveAndStart.
- **Assertions:**
  1. [Export Template] button is disabled
  2. Tooltip text: "Available in a future update"
  3. [Save as Draft] button calls `onSaveAsDraft()` when clicked

---

#### T-22: ConnectionScopes Compact Mode

#### LLD-W2-42: Full vs Compact Rendering

- **LLD Task:** T-22, AC-22.01
- **Type:** Component
- **What to Test:** ConnectionScopesDisplay renders differently based on the `compact` prop: full mode has standard margins and text, compact mode has reduced margins and smaller text for inline use within ProposalPermissionsSection.
- **Setup:** Render with `compact={false}` and `compact={true}` separately.
- **Assertions:**
  1. Full mode: standard padding, normal text size
  2. Compact mode: reduced padding, smaller text
  3. Both modes show base capabilities checklist
  4. Both modes show permission-aware search status

#### LLD-W2-43: Type-to-Confirm Works in Compact Mode

- **LLD Task:** T-22, AC-22.02
- **Type:** Component
- **What to Test:** The type-to-confirm disable flow works identically in compact mode as in full mode.
- **Setup:** Render `<ConnectionScopesDisplay compact={true} permissionAwareEnabled={true} onDisablePermissionAware={vi.fn()} />`.
- **Assertions:**
  1. "[I need to disable this...]" link visible in compact mode
  2. Inline expansion renders within compact layout
  3. Typing "public access" enables Confirm Disable button
  4. `onDisablePermissionAware()` called on confirm

---

#### T-23: Flow A Wiring

#### LLD-W2-44: SetupGuide Opens Dialog on Home Tab

- **LLD Task:** T-23, AC-23.01
- **Type:** Component
- **What to Test:** Clicking "Connect Source" on SetupGuide opens the Add Source dialog on the Home tab without navigating to the Data tab. The `onNavigate` callback is NOT called yet.
- **Setup:** Render SetupGuide. Mock AddSourceButton with `dialogOnly={true}`.
- **Assertions:**
  1. Clicking "Connect Source" sets local `showAddSourceDialog` state to true
  2. AddSourceButton rendered with `dialogOnly={true}` and `open={true}`
  3. `onNavigate` is NOT called at this point
  4. Dialog is visible on the Home tab

#### LLD-W2-45: SharePoint Selection Opens Panel

- **LLD Task:** T-23, AC-23.02
- **Type:** Component
- **What to Test:** Selecting SharePoint in the Add Source dialog triggers `useConnectorStore.openPanel()` instead of opening the old EnterpriseConnectorWizard.
- **Setup:** Render SetupGuide with Add Source dialog open. Mock `useConnectorStore`.
- **Assertions:**
  1. Selecting "SharePoint" type calls `useConnectorStore.openPanel()`
  2. Dialog closes after selection
  3. EnterpriseConnectorWizard is NOT opened

#### LLD-W2-46: Post-Setup Navigation to Data Tab

- **LLD Task:** T-23, AC-23.03
- **Type:** Component
- **What to Test:** After SharePoint setup completes, the `handleSourceAdded` callback navigates to Data tab > Sources.
- **Setup:** Simulate source added callback with `{ _id: 'src-1', name: 'SP', sourceType: 'sharepoint' }`.
- **Assertions:**
  1. `onNavigate('data')` called
  2. `setPendingFilter({ view: 'sources' })` called (not `view: 'documents'`)
  3. `showAddSourceDialog` set to false
  4. Non-SharePoint source navigates to `view: 'documents'` instead

---

#### T-24: Flow D Wiring

#### LLD-W2-47: SharePoint Row Click Opens Panel via Store

- **LLD Task:** T-24, AC-24.01
- **Type:** Component
- **What to Test:** Clicking a SharePoint source row in SourcesTable calls `useConnectorStore.getState().openPanel()` with the connector ID from `connectorMap`.
- **Setup:** Render SourcesTable with a SharePoint source and `connectorMap` containing its mapping. Mock `useConnectorStore`.
- **Assertions:**
  1. Clicking the SharePoint row calls `openPanel(connectorId, { isNew: false, ... })`
  2. Panel opens for the correct connector ID
  3. Old ConnectorDetailPanel is NOT opened for SharePoint sources

#### LLD-W2-48: Draft Connector Opens Connect Tab

- **LLD Task:** T-24, AC-24.02
- **Type:** Component
- **What to Test:** When the clicked connector has status 'draft' or 'awaiting_auth', the panel opens with `tab: 'connect'`.
- **Setup:** SourcesTable row for a draft SharePoint connector.
- **Assertions:**
  1. `openPanel(connectorId, { isNew: false, tab: 'connect' })` called
  2. Status 'awaiting_auth' also routes to 'connect' tab

#### LLD-W2-49: Active Connector Opens Overview Tab

- **LLD Task:** T-24, AC-24.03
- **Type:** Component
- **What to Test:** When the clicked connector has status 'active' or 'syncing', the panel opens with `tab: 'overview'`.
- **Setup:** SourcesTable row for an active SharePoint connector.
- **Assertions:**
  1. `openPanel(connectorId, { isNew: false, tab: 'overview' })` called
  2. Status 'syncing' also routes to 'overview' tab
  3. Status 'error' routes to 'overview' tab (with error state)

#### LLD-W2-50: Non-SharePoint Sources Use Existing Panel

- **LLD Task:** T-24, AC-24.04
- **Type:** Component
- **What to Test:** Clicking a non-SharePoint source row does NOT call `useConnectorStore.openPanel()`. It continues to open the existing SourceDetailPanel.
- **Setup:** SourcesTable with a web source (not in `connectorMap` or with different type).
- **Assertions:**
  1. `useConnectorStore.openPanel` NOT called
  2. Existing SourceDetailPanel behavior preserved

---

#### T-25: Name Uniqueness + Admin Email

#### LLD-W2-51: checkConnectorName Service Function

- **LLD Task:** T-25, AC-25.01, AC-25.02, AC-25.04, AC-25.05
- **Type:** Integration
- **What to Test:** `checkConnectorName()` returns `{ available: true }` for unique names and `{ available: false, suggestion: "Name (2)" }` for duplicates. Route registered before `/:connectorId` to avoid Express matching conflict. All queries scoped to `tenantId`.
- **Setup:** KB with connector named "Marketing SP". Valid tenantId.
- **Assertions:**
  1. `checkConnectorName(indexId, tenantId, "Engineering Docs")` returns `{ available: true }`
  2. `checkConnectorName(indexId, tenantId, "Marketing SP")` returns `{ available: false, suggestion: "Marketing SP (2)" }`
  3. If "Marketing SP (2)" also taken, suggestion increments to "Marketing SP (3)"
  4. `GET /:indexId/connectors/check-name?name=test` returns 200 (not captured by `/:connectorId`)
  5. Query includes `tenantId` filter (verified by different tenant seeing name as available)
  6. Name check is scoped to the KB (indexId) -- same name in different KB is available

#### LLD-W2-52: generateAdminEmail Service Function

- **LLD Task:** T-25, AC-25.03, AC-25.05
- **Type:** Integration
- **What to Test:** `generateAdminEmail()` returns a subject, body, and mailto link with Azure Portal setup instructions customized to the tenant.
- **Setup:** Connector with Azure App Registration details in a specific tenant.
- **Assertions:**
  1. Returns `{ subject, body, mailto }` with all three fields non-empty
  2. Body contains "Sites.Read.All" in the required permissions list
  3. Body contains "Files.Read.All" in the required permissions list
  4. Body contains "GroupMember.Read.All" in the required permissions list
  5. Body includes step-by-step Azure Portal instructions
  6. `mailto` string is a valid `mailto:` link with subject and body encoded
  7. Body includes redirect URI from `getConnectorRedirectUri()`
  8. Query scoped to `tenantId`

---

## Wave 3: Monitoring (T-26 to T-37)

**Cards:** C-08 (Monitoring & Sync Progress), C-11 (Error & Empty States)

### E2E Scenarios

#### E2E-W3-01: Overview Tab — Progressive Loading and KPIs

- **User Journey:** User opens the Detail Panel for an Active connector and sees the Overview tab load progressively.
- **Design Reference:** §7a Overview Tab, C-08 UI Behaviors
- **Preconditions:** Active connector with sync history and 237 indexed documents.
- **Steps:**
  1. Open Detail Panel for Active connector
  2. Verify KPIs load first (<500ms): connector name, status badge "Healthy", connected date, total documents, total size, site count, library count
  3. Verify content breakdown loads next (1-2s): by-type chart (PDF, DOCX, etc.) and by-site breakdown
  4. Verify sync history table loads last (1-3s): Date, Type (Full/Delta), Docs (+/-/~), Duration, Status
  5. Verify Configuration Summary shows scope, filters, schedule, permission mode
  6. Verify Quick Actions bar: [Sync Now], [Pause], [Edit Configuration], [Re-auth], [Health Check], [Search Documents], [Configure Alerts]
  7. Click [Search Documents]
  8. Verify navigation to Data tab > Documents segment with a pre-applied filter for this connectorId
  9. Verify Documents view shows columns: document name, status, connector, indexed date
- **Expected Outcome:** Progressive loading with skeleton placeholders; three loading phases visible. [Search Documents] navigates to Documents view with connector filter.
- **Error Path:** If content-breakdown API fails, show error within that section only — KPIs remain visible.
- **Edge Cases:** [C-08 Edge Case 4: Zero documents after sync — empty state, not broken charts. C-08 Edge Case 8: Very large connector (10k+ docs) — "Top 5 + Other" grouping]

#### E2E-W3-02: Sync Progress — Real-Time During Active Sync

- **User Journey:** User watches an active sync with overall and per-site progress bars updating in real time.
- **Design Reference:** §7b Sync Progress, C-08 Sync Progress
- **Preconditions:** Sync just started for a connector with 3 sites and ~250 documents.
- **Steps:**
  1. Verify Overview content is replaced by sync progress view
  2. Verify sync type header: "Full Sync in Progress" or "Delta Sync in Progress"
  3. Verify overall progress bar: docs processed / total, size processed / total, ETA
  4. Verify current document indicator: file name and source site
  5. Verify per-site progress bars: one per site with percentage and count (e.g., "25% (14/56)")
  6. Verify [Pause Sync] and [Stop Sync] buttons are present
  7. Wait for sync to complete (or simulate completion)
  8. Verify "Sync Complete!" banner for 3 seconds
  9. Verify auto-transition back to Overview with refreshed data
  10. Verify SourcesTable row updates status badge to "Active" with new doc count
- **Expected Outcome:** Real-time progress updates (polling every 2-5s), per-site breakdown, completion transition.
- **Error Path:** Sync fails mid-progress — progress bars freeze, error message appears, [Retry] replaces [Pause]. (C-08 Edge Case 2)
- **Edge Cases:** [C-08 Edge Case 1: Sync starts while Overview is open — auto-detect and transition to progress view. C-08 Edge Case 3: Token expires during sync — status becomes "disconnected". C-08 Edge Case 10: Panel closed during sync — sync continues, re-opening resumes progress display. C-08 Edge Case 11: ETA unreliable — show "Estimating..." for first 10%]

#### E2E-W3-03: Content Freshness Warning

- **User Journey:** User sees a content freshness warning when last successful sync was 3+ days ago.
- **Design Reference:** §7a Content Freshness, C-08 UI Behaviors item 3
- **Preconditions:** Connector with last successful sync > 3 days ago and 3 recent failed attempts.
- **Steps:**
  1. Open Overview tab
  2. Verify Content Freshness warning renders: "Last successful sync: 5 days ago"
  3. Verify warning shows recent failed attempt count
  4. Verify [Sync Now] and [View Sync History] action links
  5. Click [Sync Now]
  6. Verify sync initiates
- **Expected Outcome:** Content freshness warning appears at 3+ days with actionable remediation.
- **Error Path:** All sync history entries failed — all-red rows, prominent warning. (C-08 Edge Case 6)
- **Edge Cases:** [C-08 Edge Case 5: Permission crawl in progress — "Crawling..." spinner, [Crawl Now] disabled]

#### E2E-W3-04: Permission Sync Status with Crawl Actions

- **User Journey:** User views permission sync status, triggers an on-demand crawl, and sets a schedule.
- **Design Reference:** §7a Permission Sync Status, C-08 UI Behaviors item 4
- **Preconditions:** Active connector with permission-aware search enabled.
- **Steps:**
  1. Open Overview tab
  2. Locate Permission Sync Status section
  3. Verify coverage ratio displayed (e.g., "237/237 documents")
  4. Verify staleness warning if applicable
  5. Verify explanatory note: "Search results respect the last-crawled permissions..."
  6. Click [Crawl Now] — verify permission crawl initiates
  7. Click [Set Schedule] — verify schedule configuration opens
  8. Set schedule and save
- **Expected Outcome:** Permission Sync Status shows coverage, staleness, and provides interactive crawl/schedule actions.
- **Error Path:** Permission crawl fails — show error with retry option.
- **Edge Cases:** [C-08 Edge Case 12: Permission crawl concurrent with content sync — both progress indicators visible independently]

#### E2E-W3-05: Notification Configuration (Email + Webhook)

- **User Journey:** User configures email and webhook notifications for connector events.
- **Design Reference:** §7a Notifications, C-08 UI Behaviors item 8
- **Preconditions:** Active connector.
- **Steps:**
  1. Open Overview tab, scroll to Notifications section
  2. Enable email alerts toggle
  3. Select events: sync_failure, token_expiry, permission_crawl_fail, sync_complete
  4. Enter webhook URL
  5. Select webhook events (same 4)
  6. Click [Test] for webhook — verify test payload sent
  7. Click [Save] — verify notification preferences persisted
- **Expected Outcome:** Both email and webhook channels configured with all 4 events available.
- **Error Path:** Webhook test fails — inline error: "Failed: Connection refused" or "Failed: 403 Forbidden". Save still allowed. (C-08 Edge Case 7)
- **Edge Cases:** [C-08 Edge Case 9: Concurrent viewers — both see consistent data]

#### E2E-W3-06: Error State E1 — Auth Failed

- **User Journey:** User encounters an auth failure error state with AADSTS error code and recovery actions.
- **Design Reference:** §10 E1, C-11 E1 Auth Failed
- **Preconditions:** Connector with auth failure (AADSTS error).
- **Steps:**
  1. Open the connector from SourcesTable (should show "Auth Failed" status)
  2. Verify Overview tab shows auth failed error state
  3. Verify raw AADSTS error code and human-readable explanation displayed
  4. Verify numbered fix steps with interpolated context (app registration name, secret creation date)
  5. Verify [Open Azure Portal] external link
  6. Verify [Retry with New Secret] button
  7. Click [Retry with New Secret] — verify re-auth flow initiates
- **Expected Outcome:** Error state correctly identifies auth failure with contextual fix steps.
- **Error Path:** Azure Portal link with wrong appId — should still render the error state (link is best-effort).
- **Edge Cases:** [C-11 Edge Case 1: Error during error recovery — new error replaces old without stale data]

#### E2E-W3-07: Error State E6 — Graph API Throttled (429)

- **User Journey:** User sees a throttle error with live countdown timer and automatic recovery.
- **Design Reference:** §10 E6, C-11 E6 Graph API Throttled
- **Preconditions:** Connector sync hit 429 throttle from Microsoft Graph API.
- **Steps:**
  1. Open the throttled connector
  2. Verify Overview shows throttle banner (informational, not critical)
  3. Verify retry-after seconds displayed with live countdown timer and progress bar
  4. Verify "will resume at doc #N" detail
  5. Verify requests made in window and throttle scope displayed
  6. Verify reassurance: "This is normal for large syncs"
  7. Wait for countdown to complete
  8. Verify sync automatically resumes
- **Expected Outcome:** Passive informational state with live countdown. No user action required — sync auto-resumes.
- **Error Path:** Throttle resolves into partial failure (E7) — UI transitions between error types cleanly. (C-11 Edge Case 2)
- **Edge Cases:** [C-11 Edge Case 8: Stale error display — refresh on panel focus or at intervals]

#### E2E-W3-08: Error State E7 — Partial Site Failure

- **User Journey:** User sees per-site sync results with some sites failing and takes recovery action.
- **Design Reference:** §10 E7, C-11 E7 Partial Site Failure
- **Preconditions:** Connector sync completed with 2 of 5 sites failing.
- **Steps:**
  1. Open the connector (status "Partial")
  2. Verify per-site status list: site name, OK/FAIL badge, doc count per site
  3. Verify failed sites show error reason (e.g., "403 Forbidden")
  4. Verify per-site actions: [Request Access], [Remove from Scope]
  5. Click [Request Access] on a failed site — verify shareable access request generated
  6. Click [Remove from Scope] on a failed site — verify site removed from connector scope
  7. Verify global actions: [Retry Failed Sites], [Accept Partial], [Re-run Full Sync]
  8. Click [Retry Failed Sites] — verify retry initiates for failed sites only
- **Expected Outcome:** Per-site failure granularity with both per-site and global recovery actions.
- **Error Path:** All sites fail — degenerate case of E7. (C-11 Edge Case 6: 50+ failed sites — scrolling/truncation)
- **Edge Cases:** [C-11 Edge Case 3: Discovery timeout with 0 profiled sites — hide "Continue with 0" option]

#### E2E-W3-09: Empty State EM2 — No Documents After Sync

- **User Journey:** Sync completes but 0 documents were indexed. User sees filter exclusion analysis.
- **Design Reference:** §11 EM2, C-11 EM2 No Documents
- **Preconditions:** Connector with sync completed, 0 documents indexed (all excluded by filters).
- **Steps:**
  1. Open the connector
  2. Verify Overview shows "connected" status but 0 docs
  3. Verify filter analysis: per-rule breakdown showing how many files each filter excluded and why
  4. Verify actions: [Adjust Filters], [Select Different Sites], [View All Discovered Files]
  5. Click [Adjust Filters] — verify navigation to Scope+Filters tab
  6. Click [View All Discovered Files] — verify navigation to Preview tab with unfiltered view
- **Expected Outcome:** Filter exclusion analysis explains why 0 documents were indexed, with actionable remediation.
- **Error Path:** No filters active but 0 docs — fallback explanation: "sites contained no indexable files". (C-11 Edge Case 5)
- **Edge Cases:** [C-11 EM3: No Sites Accessible (Sites.Selected, 0 approved) — explains Sites.Selected, offers [Send Request to Admin], [Upgrade to Sites.Read.All]]

#### E2E-W3-10: Error State E3 — Sync Failure with Checkpoint Resume

- **User Journey:** User encounters a sync failure (storage exceeded), sees checkpoint info, and resumes from where sync left off.
- **Design Reference:** §10 E3, C-11 E3 Sync Failure
- **Preconditions:** Connector sync failed with ENOSPC error mid-way through.
- **Steps:**
  1. Open the failed connector
  2. Verify error banner with connector name and "Sync Failed" badge
  3. Verify docs processed vs total displayed
  4. Verify technical error: "Error: ENOSPC — Storage quota exceeded on upload destination"
  5. Verify confirmation: already-processed docs are indexed and searchable
  6. Verify checkpoint saved indicator
  7. Click [Resume Sync] — verify sync resumes from checkpoint, not from beginning
  8. Alternatively, click [Reduce Scope] — verify navigation to Scope tab
  9. Alternatively, click [Keep Partial] — verify connector stays in current state
- **Expected Outcome:** Sync failure shows checkpoint info and offers three recovery options.
- **Error Path:** Resume fails immediately — show updated error with new details.
- **Edge Cases:** [C-11 Edge Case 4: Token expiry in the past — handle "already expired" state differently from "expiring soon"]

#### E2E-W3-11: Error State E2 — Discovery Timeout (1000+ Sites)

- **User Journey:** User opens a connector in discovery-timeout state and sees 3 recovery options with discovery stats.
- **Design Reference:** C-11 E2 — Discovery Timeout (1000+ sites), C-11 Required Data Fields (sitesDiscovered, sitesProfiled, drivesFound)
- **Preconditions:** Connector in discovery-timeout error state. Discovery found 1200 sites but timed out after profiling 300.
- **Steps:**
  1. Open the connector from SourcesTable (status shows error/warning)
  2. Verify Scope tab displays the discovery timeout error state
  3. Verify total sites discovered vs sites fully profiled is shown (e.g., "1200 sites discovered, 300 fully profiled")
  4. Verify three options presented as a numbered list:
     - Option 1: "Continue with partial data" — button label includes profiled count (e.g., "Continue with 300 sites")
     - Option 2: Inline search input to find specific sites by name
     - Option 3: "Re-run full discovery" with estimated time (e.g., "~5 min")
  5. Verify stats bar at bottom: sites discovered | sites profiled (300/1200) | drives found
  6. Click "Continue with partial data"
  7. Verify connector proceeds with the 300 profiled sites
- **Expected Outcome:** Discovery timeout shows three distinct recovery options and accurate stats. "Continue with partial data" uses profiled sites.
- **Error Path:** Continue with partial data fails (0 profiled sites) — "Continue with 0" option should be hidden or show different message. (C-11 Edge Case 3)
- **Edge Cases:** [C-11 Edge Case 3: Discovery timeout with 0 profiled sites — hide "Continue with 0" option]

#### E2E-W3-12: Error State E4 — Token Expired (Refresh Failed)

- **User Journey:** User opens a connector with an expired token (standalone, not during sync) and sees expiry details with re-authentication guidance.
- **Design Reference:** C-11 E4 — Token Expired (Refresh Failed), C-11 Required Data Fields (tokenExpiryDate, daysUntilExpiry, lastRefreshAttempt, refreshErrorCode)
- **Preconditions:** Connector with expired token. Auto-refresh has failed. Connector is not currently syncing.
- **Steps:**
  1. Open the connector from SourcesTable (status shows "Disconnected" or warning badge)
  2. Verify Overview tab shows warning severity banner for token expiry
  3. Verify expiry date displayed in absolute format (e.g., "Expired on Mar 20, 2026")
  4. Verify days remaining / days overdue is shown (e.g., "4 days overdue")
  5. Verify consequence description: "delta syncs stop, content goes stale"
  6. Verify auto-refresh failure details: last attempt timestamp and error code
  7. Verify "To fix" guidance text: "To fix: Someone with admin access needs to re-authenticate."
  8. Verify [Re-authenticate Now] is the sole action button (no delegation button in Phase 1)
  9. Click [Re-authenticate Now]
  10. Verify OAuth re-auth flow initiates
- **Expected Outcome:** Token expiry error state shows all E4-specific fields: expiry date, days remaining, auto-refresh failure details, and "To fix" guidance. Single action: [Re-authenticate Now].
- **Error Path:** Re-authentication fails — error state persists with updated lastRefreshAttempt timestamp.
- **Edge Cases:** [C-11 Edge Case 4: Token expiry in the past — show "Expired X days ago" not "Expires in -X days"]

#### E2E-W3-13: Error State E5 — Permission Revoked

- **User Journey:** User opens a connector with an externally revoked permission and sees impact details with three recovery actions.
- **Design Reference:** C-11 E5 — Permission Revoked, C-11 Required Data Fields (revokedPermission, impactList, indexedDocCount, syncAutoPaused)
- **Preconditions:** A permission (e.g., Sites.Read.All) has been revoked externally (by Azure AD admin). Connector sync is auto-paused.
- **Steps:**
  1. Open the connector from SourcesTable (status shows critical error badge)
  2. Verify Overview tab shows critical severity banner
  3. Verify the exact revoked permission is named (e.g., "Sites.Read.All")
  4. Verify bulleted impact list is displayed (e.g., "Discovery blocked", "Sync blocked", "237 indexed docs going stale")
  5. Verify auto-paused indicator: "Sync schedule was auto-paused"
  6. Verify three action buttons:
     - [Share Issue with IT Admin] — generates shareable summary
     - [Re-authenticate] — re-triggers OAuth with required scopes
     - [Delete Connector] — removes the connector
  7. Click [Share Issue with IT Admin]
  8. Verify a shareable summary is generated (clipboard copy or email template)
  9. Verify the summary includes the revoked permission name and impact details
- **Expected Outcome:** Permission revoked error state names the exact permission, shows bulleted impact, confirms auto-pause, and offers three distinct actions.
- **Error Path:** [Share Issue with IT Admin] generation fails — show fallback with manual copy text.
- **Edge Cases:** [C-11 Edge Case 1: Error during error recovery — e.g., Re-authenticate fails with a new error, old error replaced cleanly]

#### E2E-W3-14: Error State E8 — Zero Sites Found

- **User Journey:** User opens a connector on the Scope tab where discovery found 0 sites, sees numbered reasons and three recovery actions.
- **Design Reference:** C-11 E8 — Zero Sites Found, C-11 Required Data Fields (currentPermissionScope, possibleReasons)
- **Preconditions:** Connector where discovery returned 0 sites. Scope is Sites.Selected or Sites.Read.All with no accessible sites.
- **Steps:**
  1. Open the connector — Scope tab displays the E8 error state
  2. Verify 3 numbered possible reasons with inline fix guidance (e.g., "1. No sites exist in this tenant", "2. Permission scope too narrow", "3. Network connectivity issue")
  3. Verify current permission scope is displayed (e.g., "Current scope: Sites.Selected")
  4. Verify scope upgrade suggestion is shown if on a limited scope
  5. Verify three action buttons:
     - [Retry Discovery] — re-runs site discovery
     - [Upgrade Scope] — re-triggers consent with broader scope (e.g., Sites.Read.All)
     - [Enter Site URL Manually] — shows inline URL input
  6. Click [Enter Site URL Manually]
  7. Verify inline URL input appears
  8. Enter a site URL and click [Check Access]
  9. Verify the check-site-access endpoint is called and result displayed
- **Expected Outcome:** Zero sites error state shows diagnostic reasons, current scope, and three recovery paths including manual URL entry.
- **Error Path:** Manual URL check returns inaccessible — show "403 Forbidden" with guidance to request admin access.
- **Edge Cases:** [C-11 E8: Manual URL entry reuses POST `.../check-site-access` endpoint from EM3. **EM3 coverage note:** This scenario also covers EM3 (No Sites Accessible, Sites.Selected) when run with `Sites.Selected` precondition — the Scope tab UI is identical. Run this scenario with both `Sites.Read.All` and `Sites.Selected` preconditions to cover both E8 and EM3.]

#### E2E-W3-15: Error State E10 — All Files Unsupported

- **User Journey:** User opens the Preview tab for a connector whose discovered files are all non-indexable (e.g., PNG, MP4).
- **Design Reference:** C-11 E10 — All Files Unsupported, C-11 Required Data Fields (totalDiscoveredFiles, discoveredFileTypes, supportedFileTypes)
- **Preconditions:** Connector discovery completed but all files are in non-indexable formats. Preview tab is accessible.
- **Steps:**
  1. Navigate to the Preview tab
  2. Verify E10 error state is displayed (not the normal preview)
  3. Verify total file count is shown (e.g., "128 files found")
  4. Verify discovered format types summary (e.g., "PNG (85), MP4 (32), WAV (11)")
  5. Verify supported file types listed with [View all N types] expandable link
  6. Click [View all N types] — verify expandable list opens showing all indexable formats
  7. Verify contextual insight: "This site appears to contain media assets rather than documents."
  8. Verify three action buttons:
     - [Select Different Sites] — navigates to Scope tab
     - [Upload Files Instead] — navigates to upload flow
     - [Cancel Setup] — cancels connector setup
  9. Click [Select Different Sites]
  10. Verify navigation to Scope tab
- **Expected Outcome:** All-unsupported error state shows file type analysis, contextual insight, and three remediation actions.
- **Error Path:** Supported file types list unavailable — show generic "No indexable files found" without type details.
- **Edge Cases:** [C-11 E10: Supported file types list can be static or from config endpoint — does not change per connector]

### Integration Scenarios

#### INT-W3-01: Overview API — Progressive Loading Endpoints

- **Components Under Test:** Overview, content-breakdown, sync-history endpoints
- **Design Reference:** C-08 API Requirements
- **Setup:** Active connector with 237 documents across 2 sites, 10+ sync history entries.
- **Trigger:** Call all three endpoints concurrently.
- **Assertions:**
  1. GET `/overview` returns KPIs, config summary, freshness, permission status (<500ms target)
  2. GET `/content-breakdown` returns byType and bySite aggregations (1-2s)
  3. GET `/sync-history` returns paginated entries with correct columns (1-3s)
  4. All endpoints enforce tenantId and projectId isolation
  5. Content breakdown by-type percentages sum to ~100%
- **Failure Modes:** One endpoint fails — others should still return independently.
- **Note:** Source attribution (C-08 UI Behaviors item 11) is a backend caveat ("Not yet populated — requires backend work") and is not a testable UI element yet. When backend work completes, add an assertion for the source attribution note display.

#### INT-W3-02: Sync Progress Polling

- **Components Under Test:** Sync progress endpoint, BullMQ job tracking
- **Design Reference:** C-08 API: GET `/sync-progress`, C-05 API #7
- **Setup:** Active sync with 3 sites processing.
- **Trigger:** Poll GET `/sync-progress` every 3 seconds.
- **Assertions:**
  1. Returns docsProcessed, docsTotal, sizeProcessed, sizeTotal, etaSeconds
  2. Returns currentDocument (name + sourceSite)
  3. Returns perSiteProgress array with per-site percentage and counts
  4. Values monotonically increase (no regression)
  5. On completion: returns 100% across all sites
- **Failure Modes:** Sync job terminates unexpectedly — status should transition to "failed" with error.

#### INT-W3-03: Error Discriminator Classification

- **Components Under Test:** Connector status endpoint, error type discriminator
- **Design Reference:** C-11 API: GET `/status`, C-11 Error State Data
- **Setup:** Connectors in various error states (auth_failed, discovery_timeout, sync_failed, token_expired, permission_revoked, throttled, partial_failure, zero_sites, popup_blocked, all_unsupported).
- **Trigger:** GET `/status` for each error-state connector.
- **Assertions:**
  1. Response includes error type discriminator matching one of the 10 types
  2. Response includes all fields required by the corresponding error template (e.g., E1 needs errorCode + appRegistrationName + secretCreatedDate)
  3. Error fields are nested under the error object
  4. Connector status badge matches the error type
- **Failure Modes:** Unknown error type — should return a generic error with raw details.

#### INT-W3-04: Multi-Action Retry Endpoint

- **Components Under Test:** Retry endpoint with action discriminator
- **Design Reference:** C-11 API: POST `/retry`
- **Setup:** Connectors in various error states requiring different retry actions.
- **Trigger:** POST `/retry` with each action type.
- **Assertions:**
  1. `retry_auth` — re-initiates auth flow
  2. `retry_discovery` — re-runs discovery
  3. `resume_sync` — resumes from checkpoint
  4. `retry_failed_sites` — retries only failed sites (not all)
  5. `rerun_full_sync` — starts new full sync
  6. `rerun_full_discovery` — full discovery from scratch
  7. Each action transitions connector to appropriate state
- **Failure Modes:** Retry of a resolved error — should be idempotent or return "no error to retry".

#### INT-W3-05: Per-Site Status Endpoint

- **Components Under Test:** Site statuses endpoint, partial failure tracking
- **Design Reference:** C-11 API: GET `/site-statuses`
- **Setup:** Connector with 5 sites, 2 failed during sync.
- **Trigger:** GET `/site-statuses`
- **Assertions:**
  1. Returns array of SiteStatus objects for all 5 sites
  2. OK sites show docsSynced and docsTotal
  3. Failed sites show errorReason (e.g., "403 Forbidden")
  4. Summary includes total synced vs total across all sites
  5. Removing a failed site via scope update then re-querying shows updated list
- **Failure Modes:** Site statuses unavailable during active sync — return partial data.

#### INT-W3-06: Filter Analysis for Empty State

- **Components Under Test:** Filter analysis endpoint
- **Design Reference:** C-11 API: GET `/filter-analysis`
- **Setup:** Connector with sync completed, 0 indexed documents due to filters.
- **Trigger:** GET `/filter-analysis`
- **Assertions:**
  1. Returns array of FilterExclusion objects
  2. Each exclusion shows filterType, excludedCount, and human-readable detail
  3. Total discovered files count is returned
  4. With no active filters, returns empty array with explanation text
- **Failure Modes:** Analysis for connector with no sync history — return "No sync data available".

#### INT-W3-07: Check Site Access (Manual URL)

- **Components Under Test:** Check site access endpoint, SharePoint Graph API
- **Design Reference:** C-11 API: POST `/check-site-access`, C-11 E8 and EM3
- **Setup:** Connector authenticated with Sites.Selected scope.
- **Trigger:** POST `/check-site-access` with various site URLs.
- **Assertions:**
  1. Accessible site: returns `{ accessible: true, siteName: "...", error: null }`
  2. Inaccessible site: returns `{ accessible: false, siteName: null, error: "403 Forbidden" }`
  3. Invalid URL format: returns `{ accessible: false, error: "Invalid SharePoint URL" }`
  4. URL for non-existent site: returns `{ accessible: false, error: "Site not found" }`
- **Failure Modes:** Token expired — return auth error prompting re-authentication.

#### INT-W3-08: Pause and Resume Sync via UI Actions

- **Components Under Test:** Pause/resume sync endpoints, BullMQ job lifecycle
- **Design Reference:** C-08 API: POST `/pause` and `/stop-sync`, Bug B7 fix
- **Setup:** Active sync in progress.
- **Trigger:** Pause then resume via API.
- **Assertions:**
  1. POST `/pause` transitions sync to paused state (not "not implemented" error)
  2. Sync progress endpoint reflects paused state
  3. Resume via POST `/sync` with resume flag picks up from checkpoint
  4. POST `/stop-sync` terminates the sync job
  5. Stopped sync cannot be resumed (must start new sync)
- **Failure Modes:** Pause during a critical document write — should complete current document then pause.

#### INT-W3-09: Sync Completion SourcesTable Row Update

- **Components Under Test:** Sync completion event, SourcesTable SWR revalidation, status badge update
- **Design Reference:** C-08 Sync Progress item 8 — SourcesTable row update, C-09 Row Status
- **Setup:** Active sync in progress, SourcesTable visible behind the panel.
- **Trigger:** Sync completes (100% progress).
- **Assertions:**
  1. SourcesTable row status badge transitions from "Syncing" to "Active"
  2. Document count refreshes to reflect newly synced documents
  3. Last sync timestamp updates
  4. If panel is open, Overview tab transitions from sync progress to Overview with fresh data
  5. If panel is closed, SourcesTable row update is still visible
- **Failure Modes:** SWR cache stale after completion — row should revalidate within 5 seconds.

### Wave 3 LLD-Derived Scenarios (Implementation-Level)

These scenarios are derived from the Wave 3 LLD (T-26 to T-37) acceptance criteria,
function signatures, and implementation details. They complement the base E2E/Integration scenarios above.

#### LLD-W3-01: OverviewTab KPI MetricCards Render from useConnectorOverview

- **LLD Task:** T-26, AC-01
- **Type:** Component
- **What to Test:** OverviewTab renders 4 KPI MetricCards (documents, size, sites, libraries) from connector overview data
- **Setup:** Mock `useConnectorOverview` returning `{ totalDocuments: 237, totalSize: 1048576, siteCount: 2, libraryCount: 5 }`. Render `<OverviewTab>`.
- **Assertions:**
  1. 4 MetricCard components rendered
  2. Documents card shows "237"
  3. Size card shows formatted value (e.g., "1 MB")
  4. Sites card shows "2", Libraries card shows "5"

#### LLD-W3-02: ContentBreakdown byType Horizontal Bars and bySite List

- **LLD Task:** T-26, AC-02
- **Type:** Component
- **What to Test:** ContentBreakdown renders Progress bars for byType and scrollable list for bySite
- **Setup:** Mock `useContentBreakdown` with 7 types (triggers "Other" grouping) and 12 sites (triggers truncation at 10).
- **Assertions:**
  1. 6 Progress bars visible (top 5 + "Other")
  2. "Other" groups the remaining 2 types
  3. 10 site names visible in bySite list
  4. "Show all 12 sites" expand toggle is present
  5. Clicking expand shows all 12 sites

#### LLD-W3-03: SyncHistoryTable DataTable with Status Badges

- **LLD Task:** T-26, AC-03
- **Type:** Component
- **What to Test:** SyncHistoryTable renders DataTable with 5 columns and correct Badge variants
- **Setup:** Mock `useSyncHistory` with 4 entries: 2 done, 1 failed, 1 cancelled.
- **Assertions:**
  1. DataTable renders 4 rows
  2. Date, Type, Docs, Duration, Status columns present
  3. "Done" entries have `success` Badge variant
  4. "Failed" entries have `error` Badge variant
  5. "Cancelled" entries have `warning` Badge variant
  6. Docs column shows "+N, -N, ~N" format
  7. Duration shows human-readable format (e.g., "2m 15s")

#### LLD-W3-04: ContentFreshnessWarning Appears for Stale Sync

- **LLD Task:** T-26, AC-04
- **Type:** Component
- **What to Test:** Warning banner renders when lastSuccessfulSync is >3 days ago
- **Setup:** Set `lastSuccessfulSync` to 7 days ago, `recentFailedAttempts: 3`.
- **Assertions:**
  1. Warning banner visible
  2. Shows "7 days ago" text
  3. Shows "3 attempts failed" count
  4. [Sync Now] and [View Sync History] buttons present

#### LLD-W3-05: ContentFreshnessWarning Hidden for Recent Sync

- **LLD Task:** T-26, AC-05
- **Type:** Component
- **What to Test:** Warning banner not rendered when last sync is <3 days ago
- **Setup:** Set `lastSuccessfulSync` to 1 day ago.
- **Assertions:**
  1. Warning banner not rendered in DOM

#### LLD-W3-06: QuickActionsBar Button States

- **LLD Task:** T-26, AC-06
- **Type:** Component
- **What to Test:** All 7 action buttons render with correct disabled/visible states
- **Setup:** Render with `syncInProgress: true`, `isPaused: false`.
- **Assertions:**
  1. [Sync Now] button disabled
  2. [Pause] button visible (not [Resume])
  3. [Edit Configuration], [Re-auth], [Health Check], [Search Documents], [Configure Alerts] present
  4. When `isPaused: true`: [Resume] visible, [Pause] hidden

#### LLD-W3-07: SyncProgressView Replaces Overview When Sync Active

- **LLD Task:** T-27, AC-01
- **Type:** Component
- **What to Test:** When `syncState.syncInProgress` is true, SyncProgressView renders instead of regular overview sections
- **Setup:** Mock `useConnector` with `syncState.syncInProgress: true`. Render `<OverviewTab>`.
- **Assertions:**
  1. SyncProgressView component visible
  2. KPI MetricCards, ContentBreakdown, SyncHistoryTable NOT visible
  3. Sync type header (Full/Delta) shown

#### LLD-W3-08: SyncProgressView Overall Progress Bar Updates

- **LLD Task:** T-27, AC-02
- **Type:** Component
- **What to Test:** Overall progress bar updates as poll data advances
- **Setup:** Mock `useConnectorSync` returning 30% initially, then advance to 50%.
- **Assertions:**
  1. Progress bar shows 30% width initially
  2. Doc count shows "30 of 100 documents"
  3. After update, progress bar shows 50%
  4. Doc count updates to "50 of 100 documents"
  5. Size progress line visible when `sizeProcessed` and `sizeTotal` present

#### LLD-W3-09: SyncProgressView Per-Site Progress Bars

- **LLD Task:** T-27, AC-03
- **Type:** Component
- **What to Test:** Per-site progress bars render for each site in the perSiteProgress array
- **Setup:** Mock with 4-site `perSiteProgress` array, one site at 100%.
- **Assertions:**
  1. 4 PerSiteProgressBar components rendered
  2. Each shows site name, percentage, doc count (e.g., "25% (14/56)")
  3. Completed site shows green checkmark icon instead of progress indicator
  4. Progress bars have correct widths matching percentages

#### LLD-W3-10: SyncProgressView Pause Requires Confirmation

- **LLD Task:** T-27, AC-04
- **Type:** Component
- **What to Test:** [Pause Sync] opens ConfirmDialog before calling the pause API
- **Setup:** Render SyncProgressView with active sync.
- **Assertions:**
  1. Click [Pause Sync] — ConfirmDialog opens
  2. Dialog shows title "Pause Sync?" and checkpoint preservation text
  3. API NOT called before user confirms
  4. Click [Confirm] — `POST /connectors/:id/sync/pause` called
  5. Click [Cancel] in dialog — dialog closes, no API call

#### LLD-W3-11: SyncProgressView Completion Banner and Transition

- **LLD Task:** T-27, AC-05
- **Type:** Component
- **What to Test:** At 100%, "Sync Complete!" banner appears for 3s then transitions to Overview
- **Setup:** Mock `useConnectorSync` returning `percentage: 100`.
- **Assertions:**
  1. "Sync Complete!" text visible
  2. `onSyncComplete` callback called after 3 seconds
  3. If component unmounts during the 3s timeout, no React state-update warning (cleanup in useEffect)

#### LLD-W3-12: SyncProgressView ETA Shows Estimating for First 10%

- **LLD Task:** T-27, AC-06
- **Type:** Component
- **What to Test:** ETA display shows "Estimating..." when progress < 10% or etaSeconds is null
- **Setup:** Mock with `percentage: 5`, `etaSeconds: null`.
- **Assertions:**
  1. "Estimating..." text shown (not a numeric ETA)
  2. When percentage is 30% and `etaSeconds: 140`, shows formatted ETA (e.g., "ETA: 2m 20s")

#### LLD-W3-13: Backend Overview Route Returns Computed Status

- **LLD Task:** T-28, AC-01
- **Type:** Integration
- **What to Test:** `GET /api/indexes/:indexId/connectors/:connectorId/overview` returns status computed from syncState/errorState
- **Setup:** Connectors in various states: syncing, paused, error (consecutiveFailures > 0), disconnected (no oauthTokenId), healthy.
- **Assertions:**
  1. Syncing connector returns `status: 'syncing'`
  2. Paused connector returns `status: 'paused'`
  3. Error connector returns `status: 'error'`
  4. Disconnected connector returns `status: 'disconnected'`
  5. Healthy connector returns `status: 'healthy'`
  6. Response includes configSummary, contentFreshness, permissionSync

#### LLD-W3-14: Backend Content Breakdown Aggregation

- **LLD Task:** T-28, AC-02
- **Type:** Integration
- **What to Test:** Content breakdown endpoint returns byType and bySite arrays from discovery data
- **Setup:** Connector with discovery profile containing 5 file types across 3 sites.
- **Assertions:**
  1. `byType` array has 5 entries with `type`, `count`, `percentage`
  2. Percentages sum to approximately 100%
  3. `bySite` array has 3 entries with `siteName`, `docCount`, `size`
  4. Empty discovery returns empty arrays (no 500 error)

#### LLD-W3-15: Backend Sync History Pagination

- **LLD Task:** T-28, AC-03
- **Type:** Integration
- **What to Test:** Sync history returns paginated results from ConnectorAuditEntry
- **Setup:** 10 audit entries with category 'sync' for the connector.
- **Assertions:**
  1. `?page=1&limit=5` returns 5 entries, `total: 10`, `page: 1`
  2. `?page=2&limit=5` returns 5 entries, `page: 2`
  3. Entries sorted newest-first
  4. Each entry has date, type (full/delta), docs counts, duration, status

#### LLD-W3-16: Backend Monitoring Routes Tenant Isolation

- **LLD Task:** T-28, AC-04
- **Type:** Integration
- **What to Test:** All monitoring queries include tenantId filter
- **Setup:** Two tenants with connectors. Authenticate as tenant A.
- **Assertions:**
  1. Overview returns only tenant A connector data
  2. Content breakdown only queries tenant A documents
  3. Sync history only queries tenant A audit entries
  4. Requesting tenant B's connector returns 404

#### LLD-W3-17: Backend Overview Route 404 for Invalid Connector

- **LLD Task:** T-28, AC-05
- **Type:** Integration
- **What to Test:** Invalid connectorId returns 404 with structured error
- **Setup:** Non-existent connectorId.
- **Assertions:**
  1. Response status 404
  2. Body matches `{ success: false, error: { code: 'NOT_FOUND' } }`

#### LLD-W3-18: Enhanced getSyncStatus Returns syncType and isActive

- **LLD Task:** T-29, AC-01
- **Type:** Unit
- **What to Test:** `getSyncStatus()` returns enhanced fields from syncState
- **Setup:** Connector with `syncState.syncInProgress: true`, `syncType: 'full'`, `sizeTotal: 5000`.
- **Assertions:**
  1. `syncType: 'full'` in response
  2. `isActive: true` in response
  3. `progress.sizeProcessed` and `progress.sizeTotal` present
  4. `currentDocument` returns `{ name, sourceSite }` when available

#### LLD-W3-19: Enhanced getSyncStatus perSiteProgress

- **LLD Task:** T-29, AC-02
- **Type:** Unit
- **What to Test:** perSiteProgress array passes through from syncState or Redis
- **Setup:** Connector with `perSiteProgress` populated (4 sites at various percentages).
- **Assertions:**
  1. Response `perSiteProgress` array has 4 entries
  2. Each entry has `siteName`, `percentage`, `docsProcessed`, `docsTotal`

#### LLD-W3-20: ETA Computation from Sync Duration and Progress

- **LLD Task:** T-29, AC-03
- **Type:** Unit
- **What to Test:** `etaSeconds` computed from `(now - syncStartedAt) / docsProcessed * remaining / 1000`
- **Setup:** `syncStartedAt` 60s ago, 30 of 100 docs processed.
- **Assertions:**
  1. `etaSeconds` approximately 140 (60s \* 70/30)
  2. Value is a positive number

#### LLD-W3-21: ETA Null When No Progress Data

- **LLD Task:** T-29, AC-04
- **Type:** Unit
- **What to Test:** `etaSeconds` is null when docs processed is 0 or progress < 10%
- **Setup:** Connector with 0 docs processed.
- **Assertions:**
  1. `etaSeconds: null`
  2. Also null when `percentage < 10` and `etaSeconds` would be unreliable

#### LLD-W3-22: NotificationConfig Email Toggle Debounced Save

- **LLD Task:** T-30, AC-01
- **Type:** Component
- **What to Test:** Email toggle triggers `updateConfig` with debounced 1s save
- **Setup:** Render `<NotificationConfig>` with mocked `useNotificationConfig`.
- **Assertions:**
  1. Toggle email on — no API call immediately
  2. After 1 second debounce — PUT called with `emailAlertsEnabled: true`
  3. Rapid toggles within 1s only fire one API call
  4. SWR optimistic update applied immediately for UI responsiveness

#### LLD-W3-23: NotificationConfig Webhook Test Inline Result

- **LLD Task:** T-30, AC-02
- **Type:** Component
- **What to Test:** [Test] button calls test-webhook endpoint and shows inline success/error
- **Setup:** Render with webhook URL filled in. Mock success and failure responses.
- **Assertions:**
  1. Click [Test] — POST to `/notifications/test-webhook` called
  2. On success: "Webhook test successful" message displayed inline
  3. On failure: "Failed: <error>" message displayed inline
  4. Loading state shown during test

#### LLD-W3-24: NotificationConfig Event Checkboxes Count

- **LLD Task:** T-30, AC-03
- **Type:** Component
- **What to Test:** All 4 event checkboxes render for both email and webhook channels
- **Setup:** Render `<NotificationConfig>`.
- **Assertions:**
  1. 8 checkboxes total (4 per channel)
  2. Events: sync_failure, token_expiry, permission_crawl_fail, sync_complete
  3. Toggling an event checkbox updates the corresponding events array

#### LLD-W3-25: Backend Notification PUT Saves Preferences

- **LLD Task:** T-31, AC-01
- **Type:** Integration
- **What to Test:** `PUT /notifications` saves email and webhook preferences to connector doc
- **Setup:** Connector with default notification config.
- **Assertions:**
  1. PUT with `{ emailAlertsEnabled: true, emailEvents: ['sync_failure'] }` succeeds
  2. Re-read via GET shows updated values
  3. Partial update: only provided fields change, others preserved

#### LLD-W3-26: Backend Webhook Test with Valid URL

- **LLD Task:** T-31, AC-02
- **Type:** Integration
- **What to Test:** `POST /notifications/test-webhook` with reachable URL succeeds
- **Setup:** Mock HTTP server listening. Connector with valid OAuth token.
- **Assertions:**
  1. `{ success: true }` returned
  2. Mock server received JSON payload with event, connectorId, severity, timestamp
  3. Payload includes `message: "Webhook test from ABL Platform"`

#### LLD-W3-27: Backend Webhook Test with Unreachable URL

- **LLD Task:** T-31, AC-03
- **Type:** Integration
- **What to Test:** Unreachable webhook URL returns success: false with error
- **Setup:** Non-existent URL (e.g., `https://nonexistent.example.com/hook`).
- **Assertions:**
  1. `{ success: false, error: '...' }` returned
  2. Error message indicates connection refused or timeout
  3. Does not throw 500 — error is handled gracefully

#### LLD-W3-28: Backend Webhook SSRF Mitigation

- **LLD Task:** T-31, AC-04 (tenant isolation), ST-31.2
- **Type:** Integration
- **What to Test:** Webhook test rejects private/loopback IP addresses
- **Setup:** URLs resolving to 127.0.0.1, 10.0.0.1, 169.254.169.254 (cloud metadata).
- **Assertions:**
  1. `http://127.0.0.1:8080/hook` returns `{ success: false, error: 'URL resolves to a private/loopback address' }`
  2. `http://169.254.169.254/...` similarly rejected
  3. `http://10.0.0.1/hook` rejected
  4. Valid external URL passes through

#### LLD-W3-29: Backend Notification TenantId Isolation

- **LLD Task:** T-31, AC-04
- **Type:** Integration
- **What to Test:** All notification queries include tenantId filter
- **Setup:** Two tenants with connectors.
- **Assertions:**
  1. PUT for tenant A connector with tenant B auth returns 404
  2. GET notification config scoped to tenant
  3. Test webhook uses connector scoped to tenant

#### LLD-W3-30: PermissionSyncStatus Coverage Ratio Display

- **LLD Task:** T-32, AC-01
- **Type:** Component
- **What to Test:** Permission Sync Status renders coverage when mode is enabled
- **Setup:** `mode: 'enabled'`, `coverageMapped: 200`, `coverageTotal: 237`.
- **Assertions:**
  1. "200 of 237 documents have permissions mapped" text visible
  2. Mode shows "Enabled (permission-aware search active)"
  3. Last crawled shows relative time
  4. Next crawl shows scheduled time or "Not scheduled"

#### LLD-W3-31: PermissionSyncStatus Staleness Warning

- **LLD Task:** T-32, AC-02
- **Type:** Component
- **What to Test:** Staleness warning renders when stalenessWarning is true
- **Setup:** `stalenessWarning: true`.
- **Assertions:**
  1. "Permissions may not reflect recent SharePoint changes" warning visible

#### LLD-W3-32: PermissionSyncStatus Crawl Now Disabled During Crawl

- **LLD Task:** T-32, AC-03
- **Type:** Component
- **What to Test:** [Crawl Now] is disabled when crawlInProgress is true
- **Setup:** `crawlInProgress: true`.
- **Assertions:**
  1. [Crawl Now] button disabled
  2. Shows "Crawling..." text instead of "Crawl Now"

#### LLD-W3-33: PermissionSyncStatus Disabled Mode Simplified View

- **LLD Task:** T-32, AC-04
- **Type:** Component
- **What to Test:** Disabled permission mode shows simplified view
- **Setup:** `mode: 'disabled'`.
- **Assertions:**
  1. Only mode indicator shown ("Disabled")
  2. No coverage ratio, crawl details, or action buttons

#### LLD-W3-34: Backend Permission Schedule Daily

- **LLD Task:** T-33, AC-01
- **Type:** Integration
- **What to Test:** PUT with `{ schedule: 'daily' }` updates crawlSchedule to daily cron
- **Setup:** Connector with no schedule configured.
- **Assertions:**
  1. `permissionConfig.crawlSchedule` contains `'0 2 * * *'` (2am daily)
  2. Response includes `nextCrawl` computed value

#### LLD-W3-35: Backend Permission Schedule Custom Cron

- **LLD Task:** T-33, AC-02
- **Type:** Integration
- **What to Test:** Custom cron expression is stored correctly
- **Setup:** PUT with `{ schedule: 'custom', cronExpression: '0 */6 * * *' }`.
- **Assertions:**
  1. `permissionConfig.crawlSchedule` contains `'0 */6 * * *'`

#### LLD-W3-36: Backend Permission Schedule Custom Without Cron Rejects

- **LLD Task:** T-33, AC-03
- **Type:** Integration
- **What to Test:** Custom schedule without cronExpression returns validation error
- **Setup:** PUT with `{ schedule: 'custom' }` (no cronExpression).
- **Assertions:**
  1. Response status 400
  2. Error references missing cronExpression

#### LLD-W3-37: ConnectorErrorState Dispatcher Renders Correct Component

- **LLD Task:** T-34, AC-01
- **Type:** Component
- **What to Test:** Dispatcher renders the correct error component for each of 10 error types
- **Setup:** Render `<ConnectorErrorState>` with each error type in sequence.
- **Assertions:**
  1. `type: 'auth_failed'` renders AuthFailedError
  2. `type: 'discovery_timeout'` renders DiscoveryTimeoutError
  3. `type: 'sync_failed'` renders SyncFailureError
  4. `type: 'token_expired'` renders TokenExpiredError
  5. `type: 'permission_revoked'` renders PermissionRevokedError
  6. `type: 'throttled'` renders ThrottledError
  7. `type: 'partial_failure'` renders PartialSiteFailureError
  8. `type: 'zero_sites'` renders ZeroSitesError
  9. `type: 'popup_blocked'` renders PopupBlockedError
  10. `type: 'all_unsupported'` renders AllUnsupportedError

#### LLD-W3-38: AuthFailedError Shows Error Code and Fix Steps

- **LLD Task:** T-34, AC-02
- **Type:** Component
- **What to Test:** E1 renders error code, human-readable message, and numbered fix steps
- **Setup:** `type: 'auth_failed'`, `errorCode: 'AADSTS7000215'`, `appRegistrationName: 'MyApp'`, `secretCreatedDate: '2025-01-15'`.
- **Assertions:**
  1. Error code "AADSTS7000215" visible
  2. Numbered fix steps shown, interpolating app registration name and secret date
  3. [Open Azure Portal] link functional (external link)
  4. [Retry with New Secret] button present

#### LLD-W3-39: ThrottledError Countdown Timer Decrements

- **LLD Task:** T-34, AC-03
- **Type:** Component
- **What to Test:** E6 countdown timer decrements every second
- **Setup:** `type: 'throttled'`, `retryAfterSeconds: 45`. Use `vi.useFakeTimers()`.
- **Assertions:**
  1. Shows "45" initially
  2. After advancing 1s: shows "44"
  3. After advancing another 1s: shows "43"
  4. When countdown reaches 0: interval cleared, connector status re-fetch triggered
  5. On unmount during countdown: clearInterval called (no leak)

#### LLD-W3-40: PartialSiteFailureError Per-Site List with Badges

- **LLD Task:** T-34, AC-04
- **Type:** Component
- **What to Test:** E7 renders per-site list with OK/FAIL badges and per-site actions
- **Setup:** `type: 'partial_failure'`, `siteStatuses` with 5 sites (4 OK, 1 failed).
- **Assertions:**
  1. 5 site rows rendered
  2. 4 rows show "OK" badge
  3. 1 row shows "FAIL" badge with error reason
  4. Failed site shows [Request Access] and [Remove from Scope] actions
  5. Global actions: [Retry Failed Sites], [Accept Partial], [Re-run Full Sync]

#### LLD-W3-41: EM2 No Documents Empty State Renders

- **LLD Task:** T-35, AC-01
- **Type:** Component
- **What to Test:** EM2 renders when totalDocuments === 0 and lastFullSyncAt is non-null
- **Setup:** `totalDocuments: 0`, `lastFullSyncAt: '2025-03-01'`.
- **Assertions:**
  1. "Sync completed but 0 documents were indexed" text visible
  2. Filter exclusion analysis section present

#### LLD-W3-42: EM2 Filter Exclusion Analysis List

- **LLD Task:** T-35, AC-02
- **Type:** Component
- **What to Test:** EM2 displays filter exclusion breakdown items
- **Setup:** 2 filter exclusions: `{ filterType: 'extension', excludedCount: 150, detail: 'Excluded .exe, .dll files' }`, `{ filterType: 'folder', excludedCount: 30, detail: 'Excluded /node_modules' }`.
- **Assertions:**
  1. 2 bullet items visible
  2. Each shows filter type, count, and detail text
  3. Action buttons: [Adjust Filters], [Select Different Sites], [View All Discovered Files]

#### LLD-W3-43: EM3 No Sites Accessible Inline URL Input

- **LLD Task:** T-35, AC-03
- **Type:** Component
- **What to Test:** EM3 renders inline URL input and [Check Access] button
- **Setup:** `currentPermissionScope: 'Sites.Selected'`, `approvedSiteCount: 0`.
- **Assertions:**
  1. Input field with placeholder visible
  2. [Check Access] button present
  3. [Send Request to Admin] button present
  4. [Upgrade to Sites.Read.All] button with "(requires admin re-consent)" note

#### LLD-W3-44: Backend classifyError Returns auth_failed for AADSTS

- **LLD Task:** T-36, AC-01
- **Type:** Unit
- **What to Test:** `classifyError` pattern matches AADSTS prefix to auth_failed type
- **Setup:** Connector with `errorState.lastErrorMessage: 'AADSTS7000215: Invalid client secret'`.
- **Assertions:**
  1. Returns `{ type: 'auth_failed', data: { errorCode: 'AADSTS7000215', ... } }`
  2. Data includes appRegistrationName from connectionConfig

#### LLD-W3-45: Backend classifyError Returns null for Healthy Connector

- **LLD Task:** T-36, AC-02
- **Type:** Unit
- **What to Test:** `classifyError` returns null when no active error
- **Setup:** Connector with no errors, healthy state.
- **Assertions:**
  1. Returns `null`

#### LLD-W3-46: Backend Retry resume_sync for Paused Connector

- **LLD Task:** T-36, AC-03
- **Type:** Integration
- **What to Test:** `POST /retry` with `action: 'resume_sync'` resumes a paused connector
- **Setup:** Paused connector with checkpoint data.
- **Assertions:**
  1. `{ success: true, message: '...', jobId: '...' }` returned
  2. Connector state transitions from paused to syncing
  3. BullMQ job created with checkpoint data

#### LLD-W3-47: Backend Retry resume_sync on Non-Paused Returns Error

- **LLD Task:** T-36, AC-04
- **Type:** Integration
- **What to Test:** resume_sync on non-paused connector returns 400
- **Setup:** Active (not paused) connector.
- **Assertions:**
  1. Response status 400
  2. Error indicates connector is not paused

#### LLD-W3-48: Backend classifyError Pattern Matching All Types

- **LLD Task:** T-36, AC-01 (extended)
- **Type:** Unit
- **What to Test:** classifyError correctly maps all error patterns to types
- **Setup:** Connectors with various error messages.
- **Assertions:**
  1. `'429 Too Many Requests'` -> `throttled`
  2. `'invalid_grant'` -> `token_expired`
  3. `'revoked'` or `'permission denied'` -> `permission_revoked`
  4. `syncState.failedDocuments > 0 && processedDocuments > 0` -> `partial_failure`
  5. No `oauthTokenId` and not draft -> `auth_failed` or `disconnected` (depending on context)

#### LLD-W3-49: Backend Site Statuses Returns Per-Site Array

- **LLD Task:** T-37, AC-01
- **Type:** Integration
- **What to Test:** `GET /site-statuses` returns per-site array with OK/FAIL statuses
- **Setup:** Connector with perSiteProgress data for 5 sites, 2 failed.
- **Assertions:**
  1. Array of 5 site status objects
  2. 3 sites with `status: 'ok'`, docsSynced > 0
  3. 2 sites with `status: 'failed'`, errorReason non-null

#### LLD-W3-50: Backend Filter Analysis Returns Exclusion Breakdown

- **LLD Task:** T-37, AC-02
- **Type:** Integration
- **What to Test:** Filter analysis returns per-rule exclusion counts
- **Setup:** Connector with filters (extension: exclude .exe, folder: exclude /temp) and discovery data showing 200 total files.
- **Assertions:**
  1. Returns array of FilterExclusion objects
  2. Each has `filterType`, `excludedCount`, `detail`
  3. `totalDiscoveredFiles` count included
  4. With no filters, returns empty exclusions array

#### LLD-W3-51: Backend Check Site Access Accessible URL

- **LLD Task:** T-37, AC-03
- **Type:** Integration
- **What to Test:** Accessible site URL returns success with site name
- **Setup:** Mock Graph API returning 200 with site metadata.
- **Assertions:**
  1. `{ accessible: true, siteName: 'Marketing' }` returned

#### LLD-W3-52: Backend Check Site Access Inaccessible URL

- **LLD Task:** T-37, AC-04
- **Type:** Integration
- **What to Test:** Inaccessible site URL returns failure with error
- **Setup:** Mock Graph API returning 403.
- **Assertions:**
  1. `{ accessible: false, error: '403 Forbidden' }` returned

#### LLD-W3-53: Backend Check Site Access TenantId Isolation

- **LLD Task:** T-37, AC-05
- **Type:** Integration
- **What to Test:** checkSiteAccess queries connector scoped to tenantId
- **Setup:** Connector belongs to tenant A. Request from tenant B context.
- **Assertions:**
  1. Returns 404 (connector not found for this tenant)

#### LLD-W3-54: useConnectorOverview SWR Key Conditional

- **LLD Task:** T-26, ST-26.1
- **Type:** Unit
- **What to Test:** SWR hook only fires when both indexId and connectorId are present
- **Setup:** Call `useConnectorOverview(null, null)`.
- **Assertions:**
  1. SWR key is null — no fetch made
  2. `isLoading: false`, `overview: null`
  3. With valid IDs, SWR key follows `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/overview` pattern

#### LLD-W3-55: NotificationConfig Debounce Flushes on Unmount

- **LLD Task:** T-30, ST-30.1 risk note
- **Type:** Component
- **What to Test:** If user toggles and unmounts before debounce fires, the change is still saved
- **Setup:** Toggle email, then immediately unmount component.
- **Assertions:**
  1. PUT API call fires on unmount (debounce flushed)
  2. Last toggle state persisted

#### LLD-W3-56: SyncProgressView Stop Sync Confirmation and API

- **LLD Task:** T-27, AC-04 (extended — stop action)
- **Type:** Component
- **What to Test:** [Stop Sync] opens ConfirmDialog with different text than Pause, calls stop API
- **Setup:** Render SyncProgressView with active sync.
- **Assertions:**
  1. Click [Stop Sync] — ConfirmDialog opens
  2. Dialog title: "Stop Sync?"
  3. Dialog warns about re-processing
  4. Confirm calls `POST /connectors/:id/sync/stop`
  5. Cancel closes dialog without API call

### LLD-W3 Acceptance Criteria Coverage

| Task | AC    | Test Scenario           | Status      |
| ---- | ----- | ----------------------- | ----------- |
| T-26 | AC-01 | LLD-W3-01               | Covered     |
| T-26 | AC-02 | LLD-W3-02               | Covered     |
| T-26 | AC-03 | LLD-W3-03               | Covered     |
| T-26 | AC-04 | LLD-W3-04               | Covered     |
| T-26 | AC-05 | LLD-W3-05               | Covered     |
| T-26 | AC-06 | LLD-W3-06               | Covered     |
| T-26 | AC-07 | Implementation-verified | Build check |
| T-27 | AC-01 | LLD-W3-07               | Covered     |
| T-27 | AC-02 | LLD-W3-08               | Covered     |
| T-27 | AC-03 | LLD-W3-09               | Covered     |
| T-27 | AC-04 | LLD-W3-10               | Covered     |
| T-27 | AC-05 | LLD-W3-11               | Covered     |
| T-27 | AC-06 | LLD-W3-12               | Covered     |
| T-27 | AC-07 | Implementation-verified | Build check |
| T-28 | AC-01 | LLD-W3-13               | Covered     |
| T-28 | AC-02 | LLD-W3-14               | Covered     |
| T-28 | AC-03 | LLD-W3-15               | Covered     |
| T-28 | AC-04 | LLD-W3-16               | Covered     |
| T-28 | AC-05 | LLD-W3-17               | Covered     |
| T-28 | AC-06 | Implementation-verified | Build check |
| T-29 | AC-01 | LLD-W3-18               | Covered     |
| T-29 | AC-02 | LLD-W3-19               | Covered     |
| T-29 | AC-03 | LLD-W3-20               | Covered     |
| T-29 | AC-04 | LLD-W3-21               | Covered     |
| T-29 | AC-05 | Implementation-verified | Build check |
| T-30 | AC-01 | LLD-W3-22               | Covered     |
| T-30 | AC-02 | LLD-W3-23               | Covered     |
| T-30 | AC-03 | LLD-W3-24               | Covered     |
| T-30 | AC-04 | Implementation-verified | Build check |
| T-31 | AC-01 | LLD-W3-25               | Covered     |
| T-31 | AC-02 | LLD-W3-26               | Covered     |
| T-31 | AC-03 | LLD-W3-27               | Covered     |
| T-31 | AC-04 | LLD-W3-28, LLD-W3-29    | Covered     |
| T-31 | AC-05 | Implementation-verified | Build check |
| T-32 | AC-01 | LLD-W3-30               | Covered     |
| T-32 | AC-02 | LLD-W3-31               | Covered     |
| T-32 | AC-03 | LLD-W3-32               | Covered     |
| T-32 | AC-04 | LLD-W3-33               | Covered     |
| T-32 | AC-05 | Implementation-verified | Build check |
| T-33 | AC-01 | LLD-W3-34               | Covered     |
| T-33 | AC-02 | LLD-W3-35               | Covered     |
| T-33 | AC-03 | LLD-W3-36               | Covered     |
| T-33 | AC-04 | Implementation-verified | Build check |
| T-34 | AC-01 | LLD-W3-37               | Covered     |
| T-34 | AC-02 | LLD-W3-38               | Covered     |
| T-34 | AC-03 | LLD-W3-39               | Covered     |
| T-34 | AC-04 | LLD-W3-40               | Covered     |
| T-34 | AC-05 | Implementation-verified | Build check |
| T-35 | AC-01 | LLD-W3-41               | Covered     |
| T-35 | AC-02 | LLD-W3-42               | Covered     |
| T-35 | AC-03 | LLD-W3-43               | Covered     |
| T-35 | AC-04 | Implementation-verified | Build check |
| T-36 | AC-01 | LLD-W3-44, LLD-W3-48    | Covered     |
| T-36 | AC-02 | LLD-W3-45               | Covered     |
| T-36 | AC-03 | LLD-W3-46               | Covered     |
| T-36 | AC-04 | LLD-W3-47               | Covered     |
| T-36 | AC-05 | Implementation-verified | Build check |
| T-37 | AC-01 | LLD-W3-49               | Covered     |
| T-37 | AC-02 | LLD-W3-50               | Covered     |
| T-37 | AC-03 | LLD-W3-51               | Covered     |
| T-37 | AC-04 | LLD-W3-52               | Covered     |
| T-37 | AC-05 | LLD-W3-53               | Covered     |
| T-37 | AC-06 | Implementation-verified | Build check |

---

## Wave 4: Fleet Ops & Config Management (T-38 to T-57)

**Cards:** C-06 (Security Tab), C-09 (SourcesTable enhancements), C-10 (Multi-Connector), C-12 (Config Management)

### E2E Scenarios

#### E2E-W4-01: SourcesTable Card View (1-6 Sources)

- **User Journey:** User with a few sources sees card view with type-specific secondary info.
- **Design Reference:** §3b-i (lines 382-425), C-09 Card View
- **Preconditions:** KB with 5 sources: 2 SharePoint, 1 Web Crawl, 1 File Upload, 1 API.
- **Steps:**
  1. Navigate to Data tab > Sources segment
  2. Verify card view renders (not table view)
  3. Verify each card shows: type icon, name, status badge, doc count, size
  4. Verify SharePoint cards show: doc libraries, last sync, token health
  5. Verify Web Crawl card shows: URL, last crawl, depth
  6. Verify File Upload card shows: last upload date
  7. Verify API card shows: endpoint URL, poll frequency
  8. Verify dashed-border "+ Add Source" card appears as last card
  9. Verify summary row: total docs, total size, source count by type
  10. Verify header status line: "N active . N warnings . N errors"
- **Expected Outcome:** Card view renders mixed source types with type-specific secondary info.
- **Error Path:** One source fails to load — render remaining cards, show error indicator on failed card.
- **Edge Cases:** [C-09 Edge Case 7: Long source names — truncation with tooltip. C-09 Edge Case 10: Database source card — connection string masked, last query time]

#### E2E-W4-02: SourcesTable Auto-Switch to Table View (7+ Sources)

- **User Journey:** User with many sources sees auto-switch to table view with filtering and grouping.
- **Design Reference:** §3b-ii (lines 427-476), C-09 Table View
- **Preconditions:** KB with 15 sources including 8 SharePoint, 3 Web, 2 File, 2 API.
- **Steps:**
  1. Navigate to Data tab > Sources segment
  2. Verify table view renders (auto-switched because 7+ sources)
  3. Verify toolbar: search input, status filter, type filter, sort dropdown
  4. Verify SP-specific columns (Sites, Token) appear for SharePoint rows, "--" for others
  5. Apply type filter "SharePoint" — verify only SP rows shown
  6. Apply group-by "Type" — verify collapsible groups with aggregate stats
  7. Verify quick filter pills: "Needs Attention (N)", "All Healthy (N)", "Token Warning (N)"
  8. Click "Needs Attention" pill — verify filtered to error + auth_failed + awaiting_auth sources
  9. Verify aggregate summary bar: total sources by status, total docs, tokens expiring
  10. Verify pagination works for 15 sources
- **Expected Outcome:** Table view with search, filter, sort, group-by, conditional columns, and quick filter pills.
- **Error Path:** No sources match filter — show empty table with "No sources match your filters" message.
- **Edge Cases:** [C-09 Edge Case 2: Exactly 7 sources on page load — auto-switches to table. C-09 Edge Case 5: 0 SP sources — Sites/Token columns hidden. C-09 Edge Case 9: Stale localStorage preference honored]

#### E2E-W4-03: SourcesTable Bulk Actions

- **User Journey:** User selects multiple sources and performs bulk operations.
- **Design Reference:** §3b-iii (lines 478-491), C-09 Bulk Actions
- **Preconditions:** Table view with 15 sources including multiple SharePoint sources.
- **Steps:**
  1. Select 3 sources via checkboxes (2 SharePoint, 1 Web)
  2. Verify bulk action bar appears: "3 selected"
  3. Verify generic actions: Pause Selected, Resume Selected, Sync Now, Delete Selected
  4. Verify SP-conditional actions appear (because SP sources selected): Re-auth Selected, Apply Schedule, Export Configs
  5. Click [Sync Now] — verify all 3 sources start syncing
  6. Select 2 non-SP sources only
  7. Verify SP-conditional actions disappear
  8. Click [Select All (15)] — verify all rows selected
  9. Click [Clear Selection] — verify all deselected
- **Expected Outcome:** Bulk actions appear on 2+ selection, SP-specific actions appear conditionally.
- **Error Path:** Mixed bulk action failures — some succeed, some fail. UI shows per-source results. (C-09 Edge Case 4)
- **Edge Cases:** [C-09 Edge Case 6: Token at 0 days — shows "Expired" not "0d left". C-09 Edge Case 3: All sources in error — "All Healthy" shows count 0]

#### E2E-W4-04: Security Tab — Full View

- **User Journey:** User views the Security tab with all sections including scopes, token health, emergency revoke, and audit log.
- **Design Reference:** §4e Security Tab, C-06 UI Behaviors
- **Preconditions:** Active connector with permission-aware search enabled. Simplified View OFF.
- **Steps:**
  1. Navigate to Security tab
  2. Verify Granted OAuth Scopes section: Sites.Read.All, Files.Read.All, offline_access checked; GroupMember.Read.All status
  3. Verify Token Expiry Display: formatted date, days remaining
  4. Verify "What This Connector Accesses": site count, library count, doc count, size
  5. Verify "What This Connector Does NOT Access": static bullet list
  6. Verify Data Residency: storage region, type, encryption
  7. Verify Data Handling: token encryption, discovery cache TTL, retention, cleanup timing, audit status
  8. Verify Emergency Revoke button present
  9. Verify Blast Radius Summary: scope-tier-dependent content
  10. Verify Known Limitations: 5 items
  11. Verify Approval Gate: radio states (none/pending/approved)
  12. Verify Self-Approval Policy display (org-level reference)
  13. Verify Audit Log table: sortable, paginated, with export/subscribe buttons
  14. Verify Security Review Document Export: [Download PDF], [Export JSON/YAML], [Copy as Markdown]
  15. (GroupMember.Read.All scope upgrade) Open a connector where GroupMember.Read.All is NOT granted
  16. Verify GroupMember.Read.All is shown unchecked with accuracy impact explanation (~70-85% without vs ~95%+ with)
  17. Verify [Request GroupMember.Read.All] button appears with inline description "adds group resolution capability"
  18. Click [Request GroupMember.Read.All]
  19. Verify scope upgrade flow initiates (re-auth or admin consent request)
- **Expected Outcome:** Full Security tab with all sections rendered correctly. GroupMember.Read.All scope upgrade flow is accessible when that scope is not yet granted.
- **Error Path:** No discovery data yet (draft state) — "Stats available after first sync" placeholder. (C-06 Edge Case 2)
- **Edge Cases:** [C-06 Edge Case 1: Token already expired — Emergency Revoke still relevant. C-06 Edge Case 5: Audit log empty — empty state, not broken table. C-06 Edge Case 9: Very long audit log — pagination/virtualization]

#### E2E-W4-05: Emergency Revoke with Blast Radius

- **User Journey:** User performs an emergency revoke and reviews the blast radius before confirming.
- **Design Reference:** §4e Emergency Revoke, C-06 Emergency Revoke
- **Preconditions:** Active connector with 237 indexed documents and active sync.
- **Steps:**
  1. Navigate to Security tab
  2. Click "Emergency Revoke — One Click"
  3. Verify confirmation dialog shows blast radius: connector name, active sync doc count, indexed doc count
  4. Verify dialog lists actions: pause syncs, revoke tokens, queue vector cleanup, notify admin
  5. Click [Cancel] — verify dialog closes, no action taken
  6. Click "Emergency Revoke" again, then [Confirm Emergency Revoke]
  7. Verify processing state during revoke
  8. Verify connector transitions to revoked/disconnected state
- **Expected Outcome:** Blast radius dialog shows full impact before execution. Revoke is a single atomic backend operation.
- **Error Path:** Partial failure — backend pauses syncs but fails to revoke token. Show partial success state. (C-06 Edge Case 3)
- **Edge Cases:** [C-06 Edge Case 4: No approvers configured — "Send for Security Approval" shows error or redirects to org settings]

#### E2E-W4-06: Multi-Connector Dialog — Clone Existing

- **User Journey:** User creates a second SharePoint connector by cloning an existing one.
- **Design Reference:** §8 Multi-Connector, C-10 Clone Existing
- **Preconditions:** KB has 1 existing Active SharePoint connector with permission-aware search enabled.
- **Steps:**
  1. Click [+ Add Source] > SharePoint
  2. Verify "How would you like to set up this connector?" dialog appears (not immediate panel open)
  3. Verify options: From Scratch, Clone Existing, From Template, Import Configuration, API/CLI
  4. Click "Clone Existing"
  5. Verify list of existing SharePoint connectors displayed
  6. Select the existing connector
  7. Verify overlap warning displayed
  8. Verify Template Security Gate appears (source has permission-aware search enabled)
  9. Click [Continue with Permissions Enabled]
  10. Verify new connector created in "draft" status
  11. Verify Detail Panel opens with Connect tab active (auth required — never cloned)
- **Expected Outcome:** Clone copies configuration but not auth. Security gate shown for permission-aware connectors.
- **Error Path:** All existing connectors in error state — Clone section disabled with explanation. (C-10 Edge Case 2)
- **Edge Cases:** [C-10 Edge Case 3: Cross-tenant clone — site selections cleared, notice displayed. C-10 Edge Case 7: Concurrent clone attempts — both succeed independently]

#### E2E-W4-07: Config Export Dialog (JSON/YAML)

- **User Journey:** User exports connector configuration with field selection and preview.
- **Design Reference:** §9a JSON/YAML Export, C-12 UI Behaviors 9a
- **Preconditions:** Active connector with configuration history.
- **Steps:**
  1. Open Config Export dialog (via More Actions > Export or History tab)
  2. Verify format selector: JSON (default) and YAML radio buttons
  3. Switch to YAML — verify preview pane updates instantly (client-side transform)
  4. Verify include checkboxes: Scope, Filters, Schedule, Permission mode (checked), OAuth credentials (unchecked)
  5. Uncheck "Filters" — verify preview pane updates in real time
  6. Check "OAuth credentials" — verify warning: "Credentials will be included in plaintext..."
  7. Verify preview pane shows syntax-highlighted config with `version` and `exportedAt`
  8. Click [Download] — verify file downloads
  9. Click [Copy to Clipboard] — verify "Copied" toast
- **Expected Outcome:** Export with format selection, field toggles, live preview, download, and copy.
- **Error Path:** Export with no fields checked — button disabled or shows warning.
- **Edge Cases:** [C-12 Edge Case 1: Export with no config changes yet — shows v1 with defaults. C-12 Edge Case 8: Very large config — preview handles without freezing]

#### E2E-W4-08: Version History with Diff and Restore

- **User Journey:** User views config version history, diffs two versions, and restores an older version.
- **Design Reference:** §9b Version History, C-12 UI Behaviors 9b
- **Preconditions:** Connector with 5+ config versions.
- **Steps:**
  1. Navigate to History tab (Full View)
  2. Verify Version History table: Version, Date, Changed By, Summary columns
  3. Verify "current" badge on latest version
  4. Select v3 row
  5. Click [View Diff: v3 → current]
  6. Verify diff view shows added/removed/changed fields in side-by-side or inline format
  7. Click [Restore v3]
  8. Verify confirmation dialog: "Restore configuration to version 3? This creates a new version..."
  9. Confirm restore
  10. Verify new version created (v6 with restored settings), Version History table updated
- **Expected Outcome:** Version history with one-click diff against current and safe restore (creates new version).
- **Error Path:** Concurrent config edit during restore — version conflict handled gracefully. (C-12 Edge Case 3)
- **Edge Cases:** [C-12 Edge Case 2: Diff between non-adjacent versions (v1 vs v5). C-12 Edge Case 4: Import from different schema version — handle gracefully with defaults]

#### E2E-W4-09: Config Drift Detection

- **User Journey:** User sees config drift from the applied template and takes action.
- **Design Reference:** §9b Config Drift, C-12 UI Behaviors 9b items 4-5
- **Preconditions:** Connector created from a template, with subsequent manual config changes (drift).
- **Steps:**
  1. Navigate to History tab
  2. Verify Config Drift section appears (only for template-based connectors)
  3. Verify displays: template name, applied version, and deviation list
  4. Each deviation shows: field changed, old vs new value, version that introduced deviation
  5. Click [Re-apply Template] — verify confirmation warning that deviations will be overwritten
  6. Alternatively, click [Update Template to Match Current] — verify confirmation about affecting future connectors
  7. Alternatively, click [Ignore Drift] — verify drift notice dismissed, suppressed until next config change
- **Expected Outcome:** Drift detection identifies deviations from template with three remediation options.
- **Error Path:** Template deleted after connector creation — "Template no longer available", Re-apply/Update actions hidden. (C-12 Edge Case 7)
- **Edge Cases:** [C-12 Edge Case 5: Cleanup of connector with zero content — button disabled or "No synced content to delete"]

#### E2E-W4-10: Content Purge (Danger Zone)

- **User Journey:** User purges all synced content from a connector, watching progress for documents, chunks, and vectors.
- **Design Reference:** §9b Danger Zone, C-12 UI Behaviors 9b items 7-9
- **Preconditions:** Active connector with 237 documents, chunks, and vector embeddings.
- **Steps:**
  1. Navigate to History tab > Danger Zone
  2. Click [Delete All Synced Content]
  3. Verify confirmation dialog: document count, note about chunks and vectors removal, config preserved, re-sync can restore
  4. Confirm deletion
  5. Verify cleanup progress: three rows (Documents, Chunks, Vector embeddings) with removed/total counts and progress bars
  6. Verify estimated time remaining
  7. Verify [Cancel Cleanup] button is available
  8. Wait for completion (or click [Cancel Cleanup] mid-way)
  9. If cancelled: verify partial-cleanup state with accurate counts
  10. If completed: verify all counts show 100% removed
- **Expected Outcome:** Content purge shows per-resource-type progress, supports cancellation, and preserves config.
- **Error Path:** Cleanup fails mid-way — show error with counts of removed vs remaining, [Retry Cleanup] and [Contact Support]. (C-12 UI Behavior 9)
- **Edge Cases:** [C-12 Edge Case 10: Cleanup while sync is running — purge rejected with error, button disabled]

#### E2E-W4-11: Security Tab Simplified View vs Full View

- **User Journey:** User verifies the Security tab shows only 4 essentials in Simplified View and reveals advanced content when toggled to Full View.
- **Design Reference:** C-06 Simplified View Behavior, C-06 UI Behaviors
- **Preconditions:** Active connector with full security configuration. Simplified View is ON by default.
- **Steps:**
  1. Open Detail Panel with Simplified View ON
  2. Navigate to Security tab
  3. Verify Simplified View shows only 4 essentials:
     - Permission mode (ENABLED/DISABLED)
     - Required scopes in plain language (not technical scope names)
     - Security Gate status (Approved / Pending / Not required)
     - Known limitations summary
  4. Verify "pipeline" terminology is replaced with "system" in Simplified View text
  5. Verify advanced content is hidden: ACL mode details, CEL/OData references, blast radius, data handling details, audit log, export buttons, emergency revoke
  6. Toggle Simplified View OFF
  7. Verify all advanced sections appear immediately (no additional API fetch required)
  8. Verify: ACL mode, blast radius summary, data handling section, audit log table, emergency revoke button, export buttons are all visible
  9. Toggle Simplified View back ON
  10. Verify advanced content hides again, only 4 essentials remain
- **Expected Outcome:** Simplified View shows exactly 4 essential items. Full View reveals all Security tab content. Toggle is immediate with no extra network requests.
- **Error Path:** Simplified View toggle while data is loading — skeleton placeholders should respect the current view mode.
- **Edge Cases:** [C-06 Edge Case 7: Simplified/Full toggle mid-review — immediate render, no extra fetch]

### Integration Scenarios

#### INT-W4-01: Enhanced List Sources API

- **Components Under Test:** Sources list endpoint with search, filter, group, paginate
- **Design Reference:** C-09 API #1, API Coverage Matrix C-09
- **Setup:** KB with 15 sources (8 SP, 3 Web, 2 File, 2 API) from 2 tenants.
- **Trigger:** GET `/sources` with various query parameters.
- **Assertions:**
  1. `?search=Marketing` returns only sources with "Marketing" in name
  2. `?status=error,auth_failed` returns only error-state sources
  3. `?type=sharepoint` returns only SP sources with SP-specific fields (token health, sites)
  4. `?groupBy=type` returns group metadata with source counts and status breakdown
  5. `?tenantId=xxx` filters SP sources by tenant (conditional feature)
  6. Aggregates returned: totalDocs, totalSizeBytes, sourceCountByType, sourceCountByStatus, tokensExpiringCount
  7. `hasMultipleTenants` is true (2 tenants present)
  8. Pagination: `?page=1&pageSize=10` returns correct slice with total count
- **Failure Modes:** Invalid filter combination — return 400 with description.

#### INT-W4-02: Bulk Actions API

- **Components Under Test:** Bulk actions endpoint, per-source execution
- **Design Reference:** C-09 API #2
- **Setup:** KB with 5 selected sources (3 SP, 2 Web).
- **Trigger:** POST `/sources/bulk` with various actions.
- **Assertions:**
  1. `action: 'sync_now'` triggers sync on all 5, returns per-source success/failure
  2. `action: 'pause'` pauses all 5 (SP sources use fixed B7 pause)
  3. `action: 'reauth'` only valid for SP sources — returns error for non-SP in results array
  4. `action: 'delete'` with confirmation deletes all 5
  5. `action: 'export_configs'` returns downloadable payload for SP sources
  6. Partial failure: 3 succeed, 2 fail — response shows per-source results
- **Failure Modes:** Action on non-existent source — individual error in results array.

#### INT-W4-03: Emergency Revoke Atomic Operation

- **Components Under Test:** Emergency revoke endpoint, token revocation, sync pause, cleanup queue
- **Design Reference:** C-06 API: POST `/emergency-revoke`
- **Setup:** Active connector with running sync and valid token.
- **Trigger:** POST `/emergency-revoke` with `{ confirm: true }`
- **Assertions:**
  1. Sync is paused immediately
  2. OAuth token is revoked with Microsoft
  3. Vector cleanup is queued (within 15 minutes per Known Limitation #2)
  4. Admin notification is sent
  5. Connector transitions to revoked/disconnected state
  6. Audit log entry created for the revoke action
  7. Response includes summary of actions taken and their statuses
- **Failure Modes:** Microsoft token revocation fails (API down) — pauses syncs and queues cleanup but reports partial success. (C-06 Edge Case 3)

#### INT-W4-04: Security Review Document Export

- **Components Under Test:** Security export endpoint, PDF/JSON/YAML/Markdown generation
- **Design Reference:** C-06 API: POST `/security-export`, C-06 Security Review Document Export
- **Setup:** Active connector with full security configuration.
- **Trigger:** POST `/security-export` with each format.
- **Assertions:**
  1. PDF export contains all Security tab sections + User Decisions Log
  2. JSON/YAML export contains structured data for all sections
  3. Markdown export is human-readable
  4. Export includes the 5 "Document states" text blocks verbatim
  5. Export includes data residency, emergency revoke details, and cleanup status
  6. Export is a point-in-time snapshot (consistent even under concurrent edits)
- **Failure Modes:** PDF generation timeout — return error with retry option.

#### INT-W4-05: Clone Connector API

- **Components Under Test:** Clone endpoint, config copy, cross-tenant handling
- **Design Reference:** C-10 API-2, C-10 Clone Existing
- **Setup:** Source connector with full config (scope, filters, schedule, permissions).
- **Trigger:** POST `/connectors/:id/clone`
- **Assertions:**
  1. New connector created with copied scope, filters, schedule, permission mode
  2. New connector status is "draft" (auth never cloned)
  3. Sync history NOT copied
  4. Same-tenant clone: site selections preserved
  5. Cross-tenant clone: site selections cleared, `isCrossTenant: true`
  6. Security decision is recorded (continue_with_permissions or disable_permissions)
  7. Source connector is unaffected by clone operation
- **Failure Modes:** Clone of non-existent connector — 404 error.

#### INT-W4-06: Template CRUD and Apply

- **Components Under Test:** Template list, create, apply endpoints
- **Design Reference:** C-10 API-3/4/5
- **Setup:** Existing connector to create template from.
- **Trigger:** Create template, list templates, create connector from template.
- **Assertions:**
  1. POST `/connector-templates` creates template with config snapshot
  2. GET `/connector-templates` returns list with name, description, permissionMode, usageCount
  3. POST `/connectors/from-template` creates new connector with template config
  4. New connector starts in "draft" status
  5. Template usageCount increments on apply
  6. Template includes scope, filters, schedule, permissionMode — not credentials
- **Failure Modes:** Template deleted between list and apply — 404 with "template no longer available". (C-10 Edge Case 6)

#### INT-W4-07: Config Version History and Diff

- **Components Under Test:** Version endpoints, diff computation
- **Design Reference:** C-12 API Requirements
- **Setup:** Connector with 5 config versions created by various operations.
- **Trigger:** GET `/config/versions`, GET `/config/diff`
- **Assertions:**
  1. Version history returns all 5 versions sorted newest-first
  2. Each version has: version ID, createdAt, changedBy, summary
  3. Latest version has `isCurrent: true`
  4. Diff between v2 and v5 shows structured changes (path, oldValue, newValue, type)
  5. Diff handles nested object comparisons (e.g., filters.folderRules changes)
  6. Restore to v3 creates v6 (immutable history — no overwrite)
- **Failure Modes:** Diff between same version — return empty changes array.

#### INT-W4-08: Config Import with Validation

- **Components Under Test:** Import endpoints (preview + confirm), schema validation
- **Design Reference:** C-12 API: POST `/config/import`
- **Setup:** Valid and invalid config JSON files.
- **Trigger:** POST `/config/import` with various payloads.
- **Assertions:**
  1. Valid config: returns `{ diff, requiresConfirmation: true }` with preview
  2. POST `/config/import/confirm` applies the import as new version
  3. Invalid config (missing required fields): returns `{ success: false, error: { details: [{field, message}] } }`
  4. Config with OAuth credentials: credentials stripped, notice returned
  5. Config from older schema version: migrated with defaults for new fields
  6. Import from different provider type (e.g., Google Drive): rejected
- **Failure Modes:** Malformed JSON/YAML — parse error returned. (C-10 Edge Case 4)

#### INT-W4-09: Content Purge Lifecycle

- **Components Under Test:** Purge initiate, progress, cancel, retry endpoints
- **Design Reference:** C-12 API: purge endpoints
- **Setup:** Connector with 100 documents, associated chunks, and vector embeddings.
- **Trigger:** POST `/content/purge` then poll progress.
- **Assertions:**
  1. Returns cleanupId and status "in_progress"
  2. Progress polling shows documents, chunks, vectors each with removed/total counts
  3. Cancel mid-way: status becomes "cancelled", partial counts accurate
  4. Retry after cancel: resumes from where it left off
  5. On completion: all three resource types show 100% removed
  6. Purge rejected when sync is in progress (precondition check)
  7. Config preserved after purge — GET connector still returns full config
- **Failure Modes:** Purge fails on vector deletion — reports failed status with retry option.

### Wave 4 LLD-Derived Scenarios (Implementation-Level)

These scenarios are derived from the Wave 4 LLD (T-38 to T-57) acceptance criteria,
function signatures, and implementation details. They complement the base E2E/Integration scenarios above.

#### LLD-W4-01: SourcesTable SegmentedControl View Toggle

- **LLD Task:** T-38, AC-01
- **Type:** Component
- **What to Test:** SourcesTable renders SegmentedControl for card/table view toggle
- **Setup:** Render `<SourcesTable>` with 5 sources (auto-card) and 10 sources (auto-table).
- **Assertions:**
  1. With 5 sources: card view renders by default
  2. With 10 sources: table view renders by default
  3. SegmentedControl present in toolbar
  4. Toggling overrides auto-detection
  5. User preference persisted to localStorage key `sp-sources-view-mode`

#### LLD-W4-02: SourceCard in SourcesCardGrid

- **LLD Task:** T-38, AC-02
- **Type:** Component
- **What to Test:** SourceCard renders in grid with type icon, status badge, and secondary info
- **Setup:** Render `<SourcesCardGrid>` with 3 sources (SharePoint, Web, File Upload).
- **Assertions:**
  1. 3 SourceCard components rendered
  2. Each shows type icon, name, status badge with dot/pulse
  3. SharePoint card shows "12 sites, 3,400 docs"
  4. Web card shows "42 pages"
  5. Dashed "+ Add Source" card appears as last card

#### LLD-W4-03: SourcesTable Expanded Status Map

- **LLD Task:** T-38, AC-03
- **Type:** Unit
- **What to Test:** statusVariant map includes all new status values
- **Setup:** Import `statusVariant` from SourcesTable.
- **Assertions:**
  1. `awaiting_auth` maps to `'warning'`
  2. `draft` maps to `'default'`
  3. `partial` maps to `'warning'`
  4. `auth_failed` maps to `'error'`
  5. All existing statuses still mapped correctly

#### LLD-W4-04: SourcesTable Conditional SP Columns

- **LLD Task:** T-38, subtask 5
- **Type:** Component
- **What to Test:** SP-specific columns (Sites, Token Expiry) only render when SharePoint connectors present
- **Setup:** Render with all-Web sources, then with mixed SP+Web sources.
- **Assertions:**
  1. No SP sources: "Sites" and "Token Expiry" columns absent
  2. With SP sources: both columns present, non-SP rows show "--"

#### LLD-W4-05: SourcesAggregateSummary Bar

- **LLD Task:** T-38, subtask 4
- **Type:** Component
- **What to Test:** Aggregate summary bar renders totalDocs, totalSize, sourceCountByType, tokensExpiring
- **Setup:** Render with `aggregates: { totalDocs: 1500, totalSizeBytes: 5242880, sourceCountByType: { sharepoint: 3, web: 2 }, tokensExpiringCount: 1 }`.
- **Assertions:**
  1. "1,500 documents" shown
  2. "5 MB" shown (formatted bytes)
  3. Source type pills: "SharePoint (3)", "Web (2)"
  4. Tokens-expiring warning visible when count > 0

#### LLD-W4-06: BulkActionsToolbar Selection State

- **LLD Task:** T-39, AC-01, AC-02
- **Type:** Component
- **What to Test:** BulkActionsToolbar appears when 1+ rows selected with correct buttons
- **Setup:** Render SourcesTable with 5 sources (3 SP, 2 Web). Select 2 sources.
- **Assertions:**
  1. `selectedIds` Set contains 2 items
  2. BulkActionsToolbar visible with "2 selected" count
  3. Generic actions present: Pause, Resume, Sync Now, Delete
  4. When all selected are SP: SP-conditional actions appear (Re-auth, Apply Schedule, Export Configs)
  5. When mixed types selected: SP-conditional actions hidden
  6. [Clear Selection] resets selectedIds to empty Set

#### LLD-W4-07: BulkActionsToolbar Destructive Action Confirmation

- **LLD Task:** T-39, risk note
- **Type:** Component
- **What to Test:** Delete and Pause show ConfirmDialog; Delete with >5 sources requires TypeToConfirmInput
- **Setup:** Select 6 sources, click Delete.
- **Assertions:**
  1. ConfirmDialog opens with count of affected sources
  2. TypeToConfirmInput required (count > 5)
  3. Confirm fires bulk delete API call
  4. Selection cleared after successful action

#### LLD-W4-08: SourcesToolbar QuickFilterPills

- **LLD Task:** T-40, AC-01
- **Type:** Component
- **What to Test:** QuickFilterPills render status counts and filter on click
- **Setup:** Render with `statusCounts: { active: 5, error: 2, awaiting_auth: 1 }`.
- **Assertions:**
  1. 3 pills rendered with status + count
  2. Click "Error (2)" pill — filters sources to error status
  3. Click again to deselect — filter cleared
  4. Active pill visually highlighted

#### LLD-W4-09: SourcesToolbar GroupBy Rendering

- **LLD Task:** T-40, AC-02
- **Type:** Component
- **What to Test:** Group-by selector renders grouped sections when not 'none'
- **Setup:** Render with 8 sources (5 SP, 3 Web), groupBy set to 'type'.
- **Assertions:**
  1. Two collapsible group sections: "SharePoint (5)" and "Web (3)"
  2. Each group section contains its sources
  3. Collapsing a group hides its sources

#### LLD-W4-10: Backend Enhanced listConnectors with Search Filter

- **LLD Task:** T-41, AC-01
- **Type:** Integration
- **What to Test:** Enhanced `GET /sources` with `?search=Marketing` returns filtered results
- **Setup:** 5 connectors, 2 with "Marketing" in name.
- **Assertions:**
  1. Returns 2 connectors matching search
  2. Case-insensitive search (`$regex`)

#### LLD-W4-11: Backend Enhanced listConnectors Aggregates

- **LLD Task:** T-41, AC-02
- **Type:** Integration
- **What to Test:** Response includes aggregates section with computed totals
- **Setup:** 10 connectors with various types and statuses.
- **Assertions:**
  1. `aggregates.totalDocs` is sum of all connector document counts
  2. `aggregates.sourceCountByType` has correct counts per type
  3. `aggregates.sourceCountByStatus` has correct counts per status
  4. `aggregates.tokensExpiringCount` counts tokens expiring within 7 days

#### LLD-W4-12: Backend Enhanced listConnectors Pagination

- **LLD Task:** T-41, AC-01 (extended)
- **Type:** Integration
- **What to Test:** Pagination with page/limit defaults and overrides
- **Setup:** 15 connectors.
- **Assertions:**
  1. Default `page: 1`, `limit: 50` returns all 15
  2. `?page=1&limit=10` returns 10, `total: 15`
  3. `?page=2&limit=10` returns 5

#### LLD-W4-13: Backend Bulk Actions Partial Success

- **LLD Task:** T-42, AC-01
- **Type:** Integration
- **What to Test:** Bulk action returns per-item results with partial success
- **Setup:** 5 source IDs, 1 non-existent.
- **Assertions:**
  1. `successCount: 4`, `failureCount: 1`
  2. `results` array has 5 entries with per-source success/failure
  3. Failed entry has `error` field
  4. Successful entries have `success: true`

#### LLD-W4-14: Backend Bulk Actions Concurrency Limit

- **LLD Task:** T-42, risk note
- **Type:** Integration
- **What to Test:** Bulk sync_now does not fire all simultaneously (max 5 concurrent)
- **Setup:** 10 source IDs with `action: 'sync_now'`.
- **Assertions:**
  1. Uses `Promise.allSettled` with concurrency limit of 5
  2. No more than 5 concurrent sync operations
  3. All 10 eventually processed

#### LLD-W4-15: Backend Bulk Actions Audit Entries

- **LLD Task:** T-42, subtask 5
- **Type:** Integration
- **What to Test:** Each bulk action item generates an audit entry
- **Setup:** Bulk pause on 3 connectors.
- **Assertions:**
  1. 3 audit entries written via `auditService.writeAuditEntry`
  2. Each entry references the source connector

#### LLD-W4-16: SecurityTab Renders All Sections

- **LLD Task:** T-43, AC-01, AC-02
- **Type:** Component
- **What to Test:** SecurityTab renders 6 sections in order: Scopes, Token, Access Summary, Emergency Revoke, Security Export, Audit Log
- **Setup:** Mock `useSecurityOverview` with full data. Render `<SecurityTab>`.
- **Assertions:**
  1. ScopesSection visible with granted scopes and descriptions
  2. TokenExpirySection shows expiry date and "X days remaining"
  3. AccessSummarySection shows two columns (CAN access / CANNOT access)
  4. EmergencyRevokeSection has danger styling with [Revoke Access] button
  5. SecurityExportSection has PDF, JSON/YAML, Markdown export buttons
  6. AuditLogSection has DataTable with category filter and pagination

#### LLD-W4-17: EmergencyRevokeSection Blast Radius Pre-Check

- **LLD Task:** T-43, AC-01 (extended), risk note
- **Type:** Component
- **What to Test:** Emergency revoke fetches blast radius before showing confirm dialog
- **Setup:** Render EmergencyRevokeSection. Mock blast radius API returning `{ documentCount: 237, chunkCount: 1200 }`.
- **Assertions:**
  1. Click [Revoke Access] — blast radius API called first
  2. ConfirmDialog shows "237 documents and 1,200 chunks will be affected"
  3. TypeToConfirmInput requires connector name
  4. API NOT called until user confirms with correct phrase

#### LLD-W4-18: SecurityTab useSecurityOverview SWR Hook

- **LLD Task:** T-43, AC-03
- **Type:** Unit
- **What to Test:** useSecurityOverview hook fetches from correct endpoint
- **Setup:** Call `useSecurityOverview(indexId, connectorId)`.
- **Assertions:**
  1. SWR key matches `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/overview`
  2. Returns `grantedScopes`, `tokenStatus`, `accessSummary`, `approvalGate`

#### LLD-W4-19: Backend Security Overview Returns Scopes and Token Status

- **LLD Task:** T-44, AC-01
- **Type:** Integration
- **What to Test:** `GET /security/overview` returns scopes, token status, access summary
- **Setup:** Connector with OAuth token expiring in 5 days, 3 granted scopes.
- **Assertions:**
  1. `grantedScopes` array has 3 entries with scope, description, grantedAt
  2. `tokenStatus.daysRemaining` is 5
  3. `tokenStatus.isExpired` is false
  4. `accessSummary.accesses` and `accessSummary.doesNotAccess` populated

#### LLD-W4-20: Backend Blast Radius Counts

- **LLD Task:** T-44, AC-01 (extended)
- **Type:** Integration
- **What to Test:** `GET /security/blast-radius` returns counts of affected resources
- **Setup:** Connector with 100 documents, 500 chunks, 500 embeddings.
- **Assertions:**
  1. `documentCount: 100`
  2. `chunkCount: 500`
  3. `embeddingCount: 500`
  4. `permissionEntriesCount` reflects permission data count

#### LLD-W4-21: Backend Emergency Revoke Atomic Operation

- **LLD Task:** T-44, AC-02
- **Type:** Integration
- **What to Test:** Emergency revoke deletes OAuth token and writes audit entry atomically
- **Setup:** Active connector with valid OAuth token.
- **Assertions:**
  1. OAuth token deleted from DB
  2. Connector `isPaused` set to true
  3. Audit entry with category 'lifecycle', event 'security.emergency_revoke' written
  4. If audit write fails, revoke still succeeds (try/catch per risk note)
  5. Response includes `revokedAt` timestamp

#### LLD-W4-22: Backend Security Export Formats

- **LLD Task:** T-44, AC-03
- **Type:** Integration
- **What to Test:** `GET /security/export` returns formatted document in requested format
- **Setup:** Connector with full security config.
- **Assertions:**
  1. `?format=json` returns valid JSON with connector info, scopes, access summary
  2. `?format=yaml` returns valid YAML
  3. `?format=markdown` returns human-readable Markdown
  4. Response includes correct `contentType` and `filename`

#### LLD-W4-23: Backend Security Routes Registered Before Parameterized

- **LLD Task:** T-44, risk note
- **Type:** Integration
- **What to Test:** Security routes don't collide with `:connectorId` parameterized routes
- **Setup:** Call `GET /security/overview` — should NOT match as `connectorId="security"`.
- **Assertions:**
  1. Returns security overview data (not a 404 or connector lookup)

#### LLD-W4-24: ConfigExportDialog Format Toggle and Download

- **LLD Task:** T-45, AC-01
- **Type:** Component
- **What to Test:** ConfigExportDialog format toggle between JSON and YAML with download
- **Setup:** Render `<ConfigExportDialog open={true}>`. Mock config API.
- **Assertions:**
  1. SegmentedControl shows JSON/YAML options
  2. Default is JSON, preview shows JSON content
  3. Toggle to YAML — preview updates to YAML format
  4. [Download] creates Blob with correct extension (.json or .yaml)
  5. Filename follows `<connectorName>-config-v<N>.<ext>` pattern

#### LLD-W4-25: ConfigExportDialog Copy to Clipboard

- **LLD Task:** T-45, AC-02
- **Type:** Component
- **What to Test:** [Copy to Clipboard] writes preview content and shows toast
- **Setup:** Render dialog with config preview. Mock `navigator.clipboard.writeText`.
- **Assertions:**
  1. Click [Copy to Clipboard]
  2. `navigator.clipboard.writeText` called with preview content
  3. Toast notification appears

#### LLD-W4-26: ConfigExportDialog Credentials Checkbox Warning

- **LLD Task:** T-45, risk note
- **Type:** Component
- **What to Test:** Credentials checkbox is unchecked by default and shows warning when checked
- **Setup:** Render dialog with all checkboxes.
- **Assertions:**
  1. 4 default-checked checkboxes (Scope, Filters, Schedule, Permission mode)
  2. Credentials checkbox unchecked by default
  3. When checked: inline warning "Credentials will be included in plaintext" visible with caution icon
  4. Re-fetch triggers (debounced 300ms) when checkboxes toggle

#### LLD-W4-27: VersionHistoryTab Table with Current Badge

- **LLD Task:** T-46, AC-01
- **Type:** Component
- **What to Test:** Version history table shows versions with "current" badge on latest
- **Setup:** Mock `useConfigVersions` with 5 versions. Render `<VersionHistoryTab>`.
- **Assertions:**
  1. DataTable with 5 rows
  2. Columns: Version, Date, Changed By, Summary
  3. Latest version row has "current" Badge
  4. Other versions do not have the badge

#### LLD-W4-28: VersionHistoryTab Diff View

- **LLD Task:** T-46, AC-02
- **Type:** Component
- **What to Test:** Clicking [View Diff] fetches and renders ConfigDiffViewer
- **Setup:** Mock diff API returning 3 changes (added, removed, changed).
- **Assertions:**
  1. Click [View Diff: v2 -> current]
  2. Diff API called with `from=2&to=5`
  3. ConfigDiffViewer renders with two-column layout
  4. "added" entries show green highlighting
  5. "removed" entries show red highlighting
  6. "changed" entries show both old and new values

#### LLD-W4-29: VersionHistoryTab Restore with Confirmation

- **LLD Task:** T-46, AC-03
- **Type:** Component
- **What to Test:** [Restore vN] shows ConfirmDialog and calls restore API
- **Setup:** Render version history with 5 versions.
- **Assertions:**
  1. Click [Restore v3] button
  2. ConfirmDialog opens with restore warning
  3. Confirm calls `POST .../config/versions/restore` with `{ version: 3 }`
  4. After success, version list refreshes showing v6 (immutable history)

#### LLD-W4-30: Backend Diff Route Before Parameterized Route

- **LLD Task:** T-46, AC-04, risk note
- **Type:** Integration
- **What to Test:** `GET .../config/versions/diff` does not match as `:versionNumber`
- **Setup:** Call diff endpoint.
- **Assertions:**
  1. Returns diff data (not a version lookup treating "diff" as a version number)

#### LLD-W4-31: Backend diffVersions Structural Comparison

- **LLD Task:** T-46, AC-05
- **Type:** Integration
- **What to Test:** diffVersions produces correct change set for nested config objects
- **Setup:** Two config versions: v2 has `filters.extensions: ['.pdf']`, v5 has `filters.extensions: ['.pdf', '.docx']` and removed `schedule.time`.
- **Assertions:**
  1. Returns change `{ path: 'filters.extensions', type: 'changed', oldValue: ['.pdf'], newValue: ['.pdf', '.docx'] }`
  2. Returns change `{ path: 'schedule.time', type: 'removed', ... }`
  3. Diff between same version returns empty changes array

#### LLD-W4-32: Backend restoreVersion Creates New Version

- **LLD Task:** T-46, AC-06
- **Type:** Integration
- **What to Test:** Restore creates a new version (immutable history), not overwrite
- **Setup:** 5 existing versions. Restore v3.
- **Assertions:**
  1. New version v6 created with `changeSource: 'restore'`
  2. v6 configSnapshot matches v3 configSnapshot
  3. v6 `restoredBy` set to actor
  4. Versions 1-5 unchanged

#### LLD-W4-33: ConfigDriftSection Conditional Rendering

- **LLD Task:** T-47, AC-01
- **Type:** Component
- **What to Test:** Drift section only renders when `hasDrift === true`
- **Setup:** Render with `hasDrift: false` then `hasDrift: true`.
- **Assertions:**
  1. When `hasDrift: false`: no drift section in DOM
  2. When `hasDrift: true`: drift section visible with template name and deviation table

#### LLD-W4-34: ConfigDriftSection Deviation Table and Actions

- **LLD Task:** T-47, AC-02
- **Type:** Component
- **What to Test:** Drift deviation table shows field differences and action buttons work
- **Setup:** Mock `useConfigDrift` with 3 deviations. Render `<ConfigDriftSection>`.
- **Assertions:**
  1. DataTable with 3 rows showing path, templateValue, currentValue, version
  2. [Re-apply Template] opens ConfirmDialog warning deviations will be overwritten
  3. [Update Template to Match Current] opens ConfirmDialog warning it affects future connectors
  4. [Ignore Drift] opens ConfirmDialog

#### LLD-W4-35: ConfigDriftSection Template Deleted Edge Case

- **LLD Task:** T-47, subtask 4
- **Type:** Component
- **What to Test:** When template is deleted, show "Template no longer available" and hide reapply/update
- **Setup:** `hasDrift: true`, `templateName: null`.
- **Assertions:**
  1. "Template no longer available" message visible
  2. [Re-apply Template] and [Update Template to Match Current] buttons hidden
  3. [Ignore Drift] still available

#### LLD-W4-36: ContentPurgeDialog Confirm Step with TypeToConfirmInput

- **LLD Task:** T-48, AC-01
- **Type:** Component
- **What to Test:** Confirm step shows doc count, warning, and TypeToConfirmInput
- **Setup:** Render `<ContentPurgeDialog open={true} documentCount={237}>`.
- **Assertions:**
  1. Shows "237 documents" count
  2. Warning about chunks and embeddings
  3. TypeToConfirmInput requires connector name
  4. Confirm button disabled until correct phrase typed
  5. If `syncInProgress === true`: purge button disabled with warning

#### LLD-W4-37: ContentPurgeDialog Progress Step with 3 Bars

- **LLD Task:** T-48, AC-02
- **Type:** Component
- **What to Test:** Progress step shows 3 progress bars polling every 2s
- **Setup:** Mock purge initiate returning `cleanupId`. Mock progress poll.
- **Assertions:**
  1. Documents progress bar with `removed/total` count
  2. Chunks progress bar with `removed/total` count
  3. Embeddings progress bar with `removed/total` count
  4. Estimated time remaining displayed
  5. Polling every 2 seconds (useEffect with setInterval)

#### LLD-W4-38: ContentPurgeDialog Cancel Mid-Purge

- **LLD Task:** T-48, AC-03
- **Type:** Component
- **What to Test:** [Cancel Cleanup] calls cancel API and shows partial state
- **Setup:** Purge in progress at 50%.
- **Assertions:**
  1. Click [Cancel Cleanup]
  2. `POST .../content/purge/:cleanupId/cancel` called
  3. Shows partial counts of removed items
  4. Status shows "cancelled"

#### LLD-W4-39: ContentPurgeDialog Retry After Failure

- **LLD Task:** T-48, AC-04
- **Type:** Component
- **What to Test:** Failed purge shows retry option
- **Setup:** Mock purge status returning `status: 'failed'`, `error: 'Vector deletion timeout'`.
- **Assertions:**
  1. Error message displayed
  2. Counts of removed vs remaining shown
  3. [Retry Cleanup] button calls `POST .../content/purge/:cleanupId/retry`
  4. [Contact Support] link present

#### LLD-W4-40: ContentPurgeDialog Interval Cleanup on Close

- **LLD Task:** T-48, risk note
- **Type:** Component
- **What to Test:** Polling interval cleared when dialog closes or terminal state reached
- **Setup:** Purge in progress, close dialog.
- **Assertions:**
  1. setInterval cleared on unmount
  2. No React state-update warnings after close
  3. Also cleared when status reaches completed/failed/cancelled

#### LLD-W4-41: Backend Config Export with Include Flags

- **LLD Task:** T-49, AC-01
- **Type:** Integration
- **What to Test:** Config export respects include/exclude flags
- **Setup:** Connector with full config.
- **Assertions:**
  1. `?includeScope=true&includeFilters=false` — scope present, filters absent
  2. `?includeCredentials=false` (default) — no credentials in output
  3. `?includeCredentials=true` — credentials included, audit warning logged
  4. JSON format returns valid JSON, YAML format returns valid YAML

#### LLD-W4-42: Backend Config Drift Detection

- **LLD Task:** T-49, AC-02
- **Type:** Integration
- **What to Test:** `GET /config/drift` compares current config to template
- **Setup:** Connector created from template, subsequently modified.
- **Assertions:**
  1. `hasDrift: true`
  2. `templateName` matches source template
  3. `deviations` array lists changed fields with template vs current values
  4. Non-templated connector returns `hasDrift: false`, `templateName: null`

#### LLD-W4-43: Backend Config Drift Reapply Template

- **LLD Task:** T-49, AC-03
- **Type:** Integration
- **What to Test:** `POST /config/drift/reapply-template` restores template values
- **Setup:** Connector with drift (2 deviations).
- **Assertions:**
  1. New config version created with template values
  2. Subsequent `GET /config/drift` returns `hasDrift: false`
  3. Version `changeSource: 'template_reapply'`

#### LLD-W4-44: Backend Config Import Preview and Confirm

- **LLD Task:** T-49, AC-04
- **Type:** Integration
- **What to Test:** Import shows preview diff, confirm applies as new version
- **Setup:** Valid config JSON with changes to 3 fields.
- **Assertions:**
  1. `POST /config/import` returns `{ diff: {...}, requiresConfirmation: true }`
  2. Diff shows 3 changes
  3. `POST /config/import/confirm` creates new version with `changeSource: 'import'`
  4. Credentials stripped from imported config

#### LLD-W4-45: Backend Config Import Invalid Schema Rejected

- **LLD Task:** T-49, AC-05
- **Type:** Integration
- **What to Test:** Invalid config rejected with structured error
- **Setup:** Config with missing required fields, wrong provider type.
- **Assertions:**
  1. Missing fields: 400 error with per-field messages
  2. Wrong provider type: rejected with "incompatible provider" error
  3. Malformed JSON: parse error returned

#### LLD-W4-46: Backend Purge Initiate Checks Sync Status

- **LLD Task:** T-50, AC-01
- **Type:** Integration
- **What to Test:** Purge rejected when sync is in progress
- **Setup:** Connector with `syncInProgress: true`.
- **Assertions:**
  1. `POST /content/purge` returns 409 Conflict
  2. Error message indicates active sync

#### LLD-W4-47: Backend Purge Progress Tracking

- **LLD Task:** T-50, AC-02
- **Type:** Integration
- **What to Test:** Purge progress returns per-resource-type counts
- **Setup:** Initiate purge on connector with 50 docs, 200 chunks, 200 embeddings.
- **Assertions:**
  1. `GET /content/purge/:cleanupId` returns documents, chunks, vectorEmbeddings counts
  2. Counts increment over time (documents first, then chunks, then embeddings)
  3. On completion: status 'completed', all removed counts match totals
  4. Config preserved (connector doc still exists)

#### LLD-W4-48: Backend Purge Cancel via Redis Signal

- **LLD Task:** T-50, AC-03
- **Type:** Integration
- **What to Test:** Cancel publishes Redis signal, sets status to cancelled
- **Setup:** Purge in progress.
- **Assertions:**
  1. `POST .../cancel` sets cleanup job status to 'cancelled'
  2. Partial counts accurate (items removed before cancel retained)

#### LLD-W4-49: Backend Purge Retry from Last Progress

- **LLD Task:** T-50, AC-04
- **Type:** Integration
- **What to Test:** Retry after failure resumes from where it left off
- **Setup:** Failed purge at 50% (25 of 50 docs removed).
- **Assertions:**
  1. `POST .../retry` re-enqueues BullMQ job
  2. Job picks up from doc 26, not doc 1
  3. On completion: all 50 docs removed

#### LLD-W4-50: MultiConnectorDialog Method Selection Steps

- **LLD Task:** T-51, AC-01
- **Type:** Component
- **What to Test:** Multi-step dialog shows method selector with 5 options
- **Setup:** Render `<MultiConnectorDialog open={true}>` with 2 existing SP connectors.
- **Assertions:**
  1. Method selector shows: From Scratch, Clone Existing, From Template, Import Configuration, API/CLI
  2. From Scratch: closes dialog, triggers standard connect flow
  3. Clone: shows list of existing connectors
  4. From Template: shows template list from useConnectorTemplates
  5. Import: shows file picker / paste textarea
  6. API/CLI: shows curl template and CLI command with Copy buttons

#### LLD-W4-51: MultiConnectorDialog Clone with Security Gate

- **LLD Task:** T-51, AC-02
- **Type:** Component
- **What to Test:** Clone of permission-enabled connector shows TemplateSecurityGate
- **Setup:** Select Clone, pick connector with `permissionMode: 'enabled'`.
- **Assertions:**
  1. TemplateSecurityGate renders after connector selection
  2. Shows source name and inherited permission setting
  3. [Continue with Permissions Enabled] proceeds with permissions
  4. [Disable] requires type-to-confirm
  5. Security gate NOT shown for `permissionMode: 'public_access'`

#### LLD-W4-52: MultiConnectorDialog Cross-Tenant Clone Notice

- **LLD Task:** T-51, subtask 10
- **Type:** Component
- **What to Test:** Cross-tenant clone shows cleared fields notice
- **Setup:** Clone connector with different `tenantId` than current user.
- **Assertions:**
  1. Notice about tenant mismatch displayed
  2. Warning that site selections will be cleared

#### LLD-W4-53: Backend Clone Never Copies Auth Tokens

- **LLD Task:** T-52, AC-01
- **Type:** Integration
- **What to Test:** Clone copies config but never copies auth or sync history
- **Setup:** Source connector with OAuth token, sync history, full config.
- **Assertions:**
  1. New connector created with `status: 'draft'`
  2. Scope, filters, schedule, permissionMode copied
  3. No OAuth token on new connector
  4. No sync history on new connector
  5. Source connector unaffected
  6. `clonedFrom` references source ID

#### LLD-W4-54: Backend Clone Cross-Tenant Clears Sites

- **LLD Task:** T-52, AC-02
- **Type:** Integration
- **What to Test:** Cross-tenant clone clears site selections
- **Setup:** Source in tenant A, clone request from tenant B context.
- **Assertions:**
  1. New connector's site selections empty
  2. `isCrossTenant: true` in response

#### LLD-W4-55: Backend Template CRUD Lifecycle

- **LLD Task:** T-52, AC-03
- **Type:** Integration
- **What to Test:** Create template from connector, list templates, apply template
- **Setup:** Source connector with full config.
- **Assertions:**
  1. POST creates template with config snapshot (no credentials)
  2. GET lists template with name, description, permissionMode, usageCount: 0
  3. Apply creates new connector with template config, status 'draft'
  4. usageCount increments to 1 after apply
  5. Duplicate template name in same tenant returns conflict error (unique index)

#### LLD-W4-56: ConnectorTemplate Model Schema

- **LLD Task:** T-53, AC-01
- **Type:** Unit
- **What to Test:** ConnectorTemplate model has correct schema, indexes, and ModelRegistry registration
- **Setup:** Import model from `@agent-platform/database`.
- **Assertions:**
  1. Fields: name, description, connectorType, configSnapshot, permissionMode, createdBy, updatedBy, usageCount
  2. Compound unique index on `{ tenantId: 1, name: 1 }`
  3. Query index on `{ tenantId: 1, connectorType: 1 }`
  4. Registered with ModelRegistry affinity 'platform'

#### LLD-W4-57: NotificationSubscription Model Schema

- **LLD Task:** T-54, AC-01
- **Type:** Unit
- **What to Test:** NotificationSubscription model has correct schema and user isolation indexes
- **Setup:** Import model from `@agent-platform/database`.
- **Assertions:**
  1. Fields: userId, connectorId, eventCategories, channels, webhookUrl, isActive
  2. Compound unique index on `{ tenantId: 1, userId: 1, connectorId: 1 }`
  3. Query index on `{ tenantId: 1, connectorId: 1, isActive: 1 }`
  4. User isolation: queries must include both tenantId and userId

#### LLD-W4-58: Backend Presence Heartbeat Redis TTL

- **LLD Task:** T-55, AC-01
- **Type:** Integration
- **What to Test:** Heartbeat sets Redis key with 30s TTL, refreshed on each beat
- **Setup:** Send heartbeat for user A on connector X.
- **Assertions:**
  1. Redis hash `presence:<tenantId>:<connectorId>` contains user A entry
  2. TTL is 30 seconds
  3. Second heartbeat resets TTL
  4. userId and userName come from `req.tenantContext` (not body — prevents impersonation)
  5. After 30s without heartbeat, entry expires

#### LLD-W4-59: Backend Presence Get Active Editors

- **LLD Task:** T-55, AC-02
- **Type:** Integration
- **What to Test:** Get active editors returns list of currently editing users
- **Setup:** Two users send heartbeats on same connector.
- **Assertions:**
  1. GET returns array of 2 editors
  2. Each has userId, userName, activeTab, lastSeen
  3. After one user stops heartbeating and TTL expires, only 1 editor returned

#### LLD-W4-60: Backend Connector Policy Returns Defaults

- **LLD Task:** T-56, AC-01
- **Type:** Integration
- **What to Test:** Policy endpoint returns defaults when no explicit policy configured
- **Setup:** No policy document for tenant.
- **Assertions:**
  1. `maxConnectorsPerKB: null` (unlimited)
  2. `selfApprovalAllowed: true` (default)
  3. `credentialExportAllowed: true` (default)
  4. `templateSharingScope: 'project'` (default)

#### LLD-W4-61: DraftBanner Step Detection

- **LLD Task:** T-57, AC-01
- **Type:** Component
- **What to Test:** DraftBanner determines currentStep from connector state
- **Setup:** Render with connectors at various setup stages.
- **Assertions:**
  1. No OAuth token -> `currentStep: 'auth'`
  2. Has token, no scope -> `currentStep: 'scope'`
  3. Has scope, no filters -> `currentStep: 'filters'`
  4. Has filters, not previewed -> `currentStep: 'preview'`
  5. All done -> `currentStep: 'ready'`
  6. Resilient to unexpected state (e.g., filters but no token): falls back to earliest incomplete step

#### LLD-W4-62: DraftBanner Renders with Progress and CTA

- **LLD Task:** T-57, AC-02
- **Type:** Component
- **What to Test:** DraftBanner shows info banner, step indicators, and [Complete Setup] CTA
- **Setup:** Render with `currentStep: 'scope'`.
- **Assertions:**
  1. Info banner with blue background visible
  2. "This connector is in draft mode" text
  3. Step indicators show: 1. Connect (done), 2. Configure (current), 3. Preview, 4. Approve
  4. [Complete Setup ->] button present
  5. Banner only rendered when `isDraft === true`

#### LLD-W4-63: DraftBanner Auto-Save Indicator

- **LLD Task:** T-57, subtask 4
- **Type:** Component
- **What to Test:** Auto-save indicator shows "Saved" or "Saving..." in panel header
- **Setup:** Render panel with draft connector during save operation.
- **Assertions:**
  1. "Saving..." shown while draft save is in progress
  2. "Saved" shown after save completes
  3. Indicator only visible for draft connectors

### LLD-W4 Acceptance Criteria Coverage

| Task | AC    | Test Scenario           | Status      |
| ---- | ----- | ----------------------- | ----------- |
| T-38 | AC-01 | LLD-W4-01               | Covered     |
| T-38 | AC-02 | LLD-W4-02               | Covered     |
| T-38 | AC-03 | LLD-W4-03               | Covered     |
| T-38 | AC-04 | Implementation-verified | Build check |
| T-39 | AC-01 | LLD-W4-06               | Covered     |
| T-39 | AC-02 | LLD-W4-06               | Covered     |
| T-39 | AC-03 | Implementation-verified | Build check |
| T-40 | AC-01 | LLD-W4-08               | Covered     |
| T-40 | AC-02 | LLD-W4-09               | Covered     |
| T-40 | AC-03 | Implementation-verified | Build check |
| T-41 | AC-01 | LLD-W4-10               | Covered     |
| T-41 | AC-02 | LLD-W4-11               | Covered     |
| T-41 | AC-03 | Implementation-verified | Build check |
| T-42 | AC-01 | LLD-W4-13               | Covered     |
| T-42 | AC-02 | LLD-W4-14               | Covered     |
| T-42 | AC-03 | Implementation-verified | Build check |
| T-43 | AC-01 | LLD-W4-16               | Covered     |
| T-43 | AC-02 | LLD-W4-17               | Covered     |
| T-43 | AC-03 | LLD-W4-18               | Covered     |
| T-43 | AC-04 | Implementation-verified | Build check |
| T-44 | AC-01 | LLD-W4-19               | Covered     |
| T-44 | AC-02 | LLD-W4-21               | Covered     |
| T-44 | AC-03 | Implementation-verified | Build check |
| T-45 | AC-01 | LLD-W4-24               | Covered     |
| T-45 | AC-02 | LLD-W4-25               | Covered     |
| T-45 | AC-03 | Implementation-verified | Build check |
| T-46 | AC-01 | LLD-W4-27               | Covered     |
| T-46 | AC-02 | LLD-W4-28               | Covered     |
| T-46 | AC-03 | LLD-W4-29               | Covered     |
| T-46 | AC-04 | LLD-W4-31               | Covered     |
| T-46 | AC-05 | Implementation-verified | Build check |
| T-47 | AC-01 | LLD-W4-33               | Covered     |
| T-47 | AC-02 | LLD-W4-34               | Covered     |
| T-47 | AC-03 | Implementation-verified | Build check |
| T-48 | AC-01 | LLD-W4-36               | Covered     |
| T-48 | AC-02 | LLD-W4-37               | Covered     |
| T-48 | AC-03 | Implementation-verified | Build check |
| T-49 | AC-01 | LLD-W4-41               | Covered     |
| T-49 | AC-02 | LLD-W4-42               | Covered     |
| T-49 | AC-03 | LLD-W4-43               | Covered     |
| T-49 | AC-04 | Implementation-verified | Build check |
| T-50 | AC-01 | LLD-W4-46               | Covered     |
| T-50 | AC-02 | LLD-W4-47               | Covered     |
| T-50 | AC-03 | LLD-W4-48               | Covered     |
| T-50 | AC-04 | LLD-W4-49               | Covered     |
| T-50 | AC-05 | Implementation-verified | Build check |
| T-51 | AC-01 | LLD-W4-50               | Covered     |
| T-51 | AC-02 | LLD-W4-51               | Covered     |
| T-51 | AC-03 | Implementation-verified | Build check |
| T-52 | AC-01 | LLD-W4-53               | Covered     |
| T-52 | AC-02 | LLD-W4-54               | Covered     |
| T-52 | AC-03 | LLD-W4-55               | Covered     |
| T-52 | AC-04 | Implementation-verified | Build check |
| T-53 | AC-01 | LLD-W4-56               | Covered     |
| T-53 | AC-02 | LLD-W4-56               | Covered     |
| T-53 | AC-03 | LLD-W4-56               | Covered     |
| T-53 | AC-04 | Implementation-verified | Build check |
| T-54 | AC-01 | LLD-W4-57               | Covered     |
| T-54 | AC-02 | LLD-W4-57               | Covered     |
| T-54 | AC-03 | Implementation-verified | Build check |
| T-55 | AC-01 | LLD-W4-58               | Covered     |
| T-55 | AC-02 | LLD-W4-59               | Covered     |
| T-55 | AC-03 | Implementation-verified | Build check |
| T-56 | AC-01 | LLD-W4-60               | Covered     |
| T-56 | AC-02 | LLD-W4-60               | Covered     |
| T-56 | AC-03 | Implementation-verified | Build check |
| T-57 | AC-01 | LLD-W4-61               | Covered     |
| T-57 | AC-02 | LLD-W4-62               | Covered     |
| T-57 | AC-03 | Implementation-verified | Build check |

---

## Cross-Wave Scenarios

### CW-01: Full Setup-to-Monitoring Journey

- **Waves:** 1 → 2 → 3
- **User Journey:** A new user creates their first SharePoint connector from an empty KB, completes the full setup flow, monitors sync progress, and views the Overview after completion.
- **Steps:**
  1. (Wave 1) Navigate to empty KB Home tab, click "Connect Source", select SharePoint
  2. (Wave 1) Verify Detail Panel opens with Connect tab, other tabs locked with lock icons
  3. (Wave 2) Enter Azure App Registration credentials, initiate auth
  4. (Wave 2) Verify draft auto-saves while auth is pending
  5. (Wave 2) Auth completes → proposal generation begins
  6. (Wave 2) Review each proposal section (Accept, Modify Scope, Accept All Remaining)
  7. (Wave 2) Navigate to Preview tab, review dry-run results
  8. (Wave 2) Approve & Start Sync
  9. (Wave 3) Verify navigation to Data tab > Sources with "Syncing" badge
  10. (Wave 3) Watch sync progress with per-site bars
  11. (Wave 3) Sync completes → "Sync Complete!" banner → auto-transition to Overview
  12. (Wave 3) Verify Overview shows KPIs, content breakdown, sync history with 1 entry
- **Expected Outcome:** End-to-end journey from empty KB to monitored, synced connector works seamlessly across all three waves.

### CW-02: Error → Recovery → Re-Sync Journey

- **Waves:** 2 → 3 → 3
- **User Journey:** A connector encounters a sync failure, user diagnoses the issue, adjusts configuration, and re-syncs successfully.
- **Steps:**
  1. (Wave 2) Active connector syncing
  2. (Wave 3) Sync fails with E3 (Storage Exceeded) — error state shown
  3. (Wave 3) User clicks [Reduce Scope] → navigates to Scope+Filters
  4. (Wave 2) User deselects large sites, adjusts size limits
  5. (Wave 2) Returns to Preview tab → lower document count
  6. (Wave 2) Approves reduced scope
  7. (Wave 3) Sync starts again, completes successfully
  8. (Wave 3) Overview shows updated stats with fewer documents
- **Expected Outcome:** Error recovery flow works across Setup (scope adjustment) and Monitoring (error display + re-sync) waves.

### CW-03: Draft Mode → Auth Complete → Proposal with Pre-Config

- **Waves:** 1 → 2
- **User Journey:** User configures filters and schedule in draft mode before auth completes, then verifies pre-configured settings appear in the proposal.
- **Steps:**
  1. (Wave 1) Create new connector, enter auth details
  2. (Wave 1) While auth is pending, switch to Scope+Filters tab
  3. (Wave 1) Configure filters: "Documents Only", exclude Archives, max 100MB
  4. (Wave 1) Set schedule: "Every 6 hours"
  5. (Wave 1) Close browser, return later, resume draft from SourcesTable
  6. (Wave 2) Auth completes → proposal generation begins
  7. (Wave 2) Verify proposal Filters section shows pre-configured "Documents Only" + exclusions
  8. (Wave 2) Verify proposal Schedule section shows "Every 6 hours"
  9. (Wave 2) Accept the pre-configured sections → proceed to Preview and Approve
- **Expected Outcome:** Pre-configured draft settings are preserved and automatically applied to the generated proposal.

### CW-04: Multi-Connector Clone → Security Tab Review

- **Waves:** 4 → 2 → 4
- **User Journey:** User clones an existing connector, completes auth, then reviews the Security tab for the new connector.
- **Steps:**
  1. (Wave 4) Add second SharePoint connector → multi-connector dialog
  2. (Wave 4) Select "Clone Existing" → Security Gate shown → continue with permissions
  3. (Wave 2) New connector in draft → complete auth → proposal generated
  4. (Wave 2) Review and approve proposal → sync starts
  5. (Wave 3) Sync completes
  6. (Wave 4) Navigate to Security tab
  7. (Wave 4) Verify scopes match the cloned config
  8. (Wave 4) Verify token health shows new token (not cloned token)
  9. (Wave 4) Export security review document as PDF
  10. (Wave 4) Verify SourcesTable now shows 2 SharePoint connectors
- **Expected Outcome:** Cloned connector has independent auth/token but copied config. Security tab accurately reflects the new connector's state.

### CW-05: Config Drift Detection After Template-Based Setup

- **Waves:** 4 → 2 → 3 → 4
- **User Journey:** User creates a connector from a template, modifies config post-setup, and later detects and resolves config drift.
- **Steps:**
  1. (Wave 4) Create second connector via "From Template"
  2. (Wave 2) Complete auth and proposal review, start sync
  3. (Wave 3) Sync completes, connector is active
  4. (Wave 2) User modifies filters (deselects a file type) via Scope+Filters
  5. (Wave 4) Navigate to History tab
  6. (Wave 4) Verify Config Drift section shows: template name, 1 deviation (file type change)
  7. (Wave 4) Click [Ignore Drift] → drift notice dismissed
  8. (Wave 4) Make another config change → drift notice reappears with 2 deviations
  9. (Wave 4) Click [Re-apply Template] → confirm → config reverted to template, new version created
  10. Verify version history shows the restore entry
- **Expected Outcome:** Drift detection accurately tracks deviations from template, with actionable remediation options.

---

## Edge Case Catalog

This catalog maps every edge case from the 12 capability notes to the test scenario that covers it.

### C-01: Panel Shell & Navigation

| Edge Case                        | Description                                         | Covered By           |
| -------------------------------- | --------------------------------------------------- | -------------------- |
| Panel swap                       | Panel already open, user clicks different connector | E2E-W1-02            |
| Connector deleted while open     | GET returns 404                                     | E2E-W1-02            |
| Network failure on panel load    | Error state with retry                              | E2E-W1-07            |
| Simplified View hides active tab | Redirect to nearest tab                             | E2E-W1-04            |
| Browser back/forward             | Panel state not URL-routed                          | E2E-W1-01            |
| Rapid tab switching              | Debounce handlers                                   | E2E-W1-06            |
| Mobile/narrow viewport           | Full-screen panel on small screens                  | E2E-W1-06            |
| Syncing connector opened         | Live sync progress on Overview                      | E2E-W1-03, E2E-W3-02 |
| Scope+Filters collapse timing    | 300ms ease-out consistency                          | E2E-W1-06            |

### C-02: Connect Tab

| Edge Case                      | Description                        | Covered By                |
| ------------------------------ | ---------------------------------- | ------------------------- |
| 1. Duplicate name              | Inline validation with suggestion  | E2E-W2-01, INT-W2-01      |
| 2. Auth timeout                | Device code expiry with regenerate | E2E-W2-03                 |
| 3. Popup blocked               | Fallback instructions              | E2E-W2-02, E2E-W3-06 (E9) |
| 4. UUID format error           | Inline error on blur               | E2E-W2-01                 |
| 5. Browser closed mid-auth     | Draft resumable from Sources       | E2E-W1-05, E2E-W2-03      |
| 6. Re-enable permission search | No re-enable path on Connect tab   | E2E-W2-04                 |
| 7. Rate limit during auth      | Retryable error with delay         | E2E-W2-02                 |
| 8. Multiple concurrent auth    | Invalidate previous state          | INT-W2-02                 |

### C-03: Configuration Proposal

| Edge Case                         | Description                                    | Covered By                  |
| --------------------------------- | ---------------------------------------------- | --------------------------- |
| Pre-configured draft applied      | Filters/schedule from draft mode               | CW-03                       |
| Section-specific buttons          | Different buttons per section                  | E2E-W2-06                   |
| Abandon — Do Not Sync             | Confirmation dialog, connector deleted         | **E2E-W2-15** (dedicated)   |
| Skip Permissions = ENABLED        | Safe default on skip                           | E2E-W2-06                   |
| Accept All Remaining              | All unreviewed → Accepted, Permissions ENABLED | E2E-W2-06                   |
| Simplified View inline editors    | Modify opens inline, not separate tab          | E2E-W2-06, E2E-W1-04        |
| Sites.Selected variant B          | Manual URL entry, admin request                | INT-W2-09                   |
| Health Check scope detection      | Sites.Selected shows 4/7 passed                | INT-W2-09                   |
| Proposal export formats           | PDF, JSON, YAML with decisions log             | E2E-W2-11                   |
| Token expires during review       | Connection degraded, Approve disabled          | **E2E-W2-13**               |
| Sensitive content + public access | Additional warning box with label breakdown    | **E2E-W2-14**               |
| Zero sites (Sites.Read.All)       | Scope shows "No sites found", Approve disabled | **INT-W2-11**               |
| All sites excluded by rec.        | "Excluded" list, re-include prompt             | **INT-W2-11** (step 5)      |
| Browser refresh mid-review        | Server-side state restored on reload           | **E2E-W2-06** (steps 11-12) |
| Rate limit during generation      | WARN, UI polls past 90s                        | **INT-W2-12**               |
| Overlapping webhook subscriptions | Schedule section note, 409 conflict info       | **INT-W2-13**               |

### C-04: Scope+Filters Split-Pane

| Edge Case                    | Description                       | Covered By           |
| ---------------------------- | --------------------------------- | -------------------- |
| 1. Zero sites selected       | 0 docs, prompt to select          | E2E-W2-07            |
| 2. All documents excluded    | Warning with Reset CTA            | E2E-W2-07            |
| 3. CEL syntax error          | Inline error with fix suggestion  | E2E-W2-08            |
| 4. 50+ sites                 | Virtualized scrolling or search   | E2E-W2-07            |
| 5. No metadata fields        | Graceful degradation              | E2E-W2-08            |
| 6. Stale preview             | Debounce, discard stale responses | E2E-W2-07, INT-W2-05 |
| 7. Sites.Selected mode       | No scores, partial data           | E2E-W2-07, INT-W2-09 |
| 8. Template + manual edits   | Badge changes to "Custom"         | E2E-W2-07            |
| 9. OData with CEL override   | Clarify pre-fetch vs post-fetch   | E2E-W2-08            |
| 10. localStorage unavailable | Defaults without persistence      | E2E-W1-04            |
| Simplified View hidden       | Tab invisible when SV ON          | E2E-W1-04            |
| Draft Mode degraded          | Sites disabled, filters editable  | E2E-W1-05            |
| Condition Builder AND/OR     | Grouping, nesting, 15 operators   | **E2E-W2-16**        |

### C-05: Preview & Approve

| Edge Case                        | Description                          | Covered By |
| -------------------------------- | ------------------------------------ | ---------- |
| 1. Zero documents matched        | Empty state, [Approve] disabled      | E2E-W2-09  |
| 2. Zero docs skipped             | Skipped section hidden               | E2E-W2-09  |
| 3. No filter changes             | Delta block hidden                   | E2E-W2-09  |
| 4. Large preview (100k+)         | Loading state with progress          | INT-W2-07  |
| 5. Security gate blocks start    | Button becomes "Submit for Approval" | E2E-W2-10  |
| 6. Token expired before approval | Warning, [Start Sync] disabled       | E2E-W2-10  |
| 7. Concurrent preview requests   | Latest only displayed                | INT-W2-05  |
| 8. Post-approval Flow A nav      | Fetch sources list after navigation  | E2E-W2-12  |
| 9. Sync starts but fails         | Error with [Retry] or [Edit Config]  | E2E-W3-10  |
| 10. All one content type         | Single bar, no "Other"               | E2E-W2-09  |
| 11. Sensitivity "WARN" prefix    | Warning treatment rendering          | E2E-W2-09  |

### C-06: Security Tab

| Edge Case                                      | Description                       | Covered By                  |
| ---------------------------------------------- | --------------------------------- | --------------------------- |
| 1. Token already expired                       | Emergency Revoke still relevant   | E2E-W4-04                   |
| 2. No discovery data (draft)                   | Placeholder text                  | E2E-W4-04                   |
| 3. Emergency revoke partial failure            | Partial success state             | E2E-W4-05, INT-W4-03        |
| 4. No approvers configured                     | Error or redirect to settings     | E2E-W4-05                   |
| 5. Audit log empty                             | Empty state, not broken table     | E2E-W4-04                   |
| 6. Concurrent scope change during export       | Point-in-time snapshot            | INT-W4-04                   |
| 7. Simplified/Full toggle mid-review           | Immediate render, no extra fetch  | E2E-W1-04, **E2E-W4-11**    |
| 8. Disable then re-enable permissions          | Re-enable path verification       | E2E-W2-04                   |
| 9. Very long audit log                         | Pagination/virtualization         | E2E-W4-04                   |
| 10. Self-approval policy changed while pending | Auto-approve or stay pending      | INT-W4-03                   |
| GroupMember.Read.All scope upgrade             | Request button, re-auth flow      | **E2E-W4-04** (steps 15-19) |
| Simplified View vs Full View                   | 4 essentials only, "system" label | **E2E-W4-11**               |

### C-07: Draft Mode

| Edge Case                         | Description                                | Covered By           |
| --------------------------------- | ------------------------------------------ | -------------------- |
| 1. Auth fails, config preserved   | Retry/switch auth methods                  | E2E-W1-05, INT-W2-06 |
| 2. Multiple draft connectors      | Independent configuration                  | E2E-W1-05            |
| 3. Stale draft (7+ days)          | Surface stale draft detection              | E2E-W1-05            |
| 4. Browser refresh during edit    | Rehydrate from last saved state            | INT-W2-06            |
| 5. Auth completes during tab edit | Graceful transition without nav disruption | CW-03                |
| 6. Concurrent edits (two tabs)    | Handle 409 Conflict                        | INT-W2-06            |
| 7. Auth method switching in draft | Preserve all draft config                  | E2E-W2-03            |

### C-08: Monitoring & Sync Progress

| Edge Case                           | Description                        | Covered By                |
| ----------------------------------- | ---------------------------------- | ------------------------- |
| 1. Sync starts while Overview open  | Auto-transition to progress        | E2E-W3-02                 |
| 2. Sync fails mid-progress          | Freeze bars, show error            | E2E-W3-02, E2E-W3-10      |
| 3. Token expires during sync        | Auth error, [Re-auth] primary      | E2E-W3-02                 |
| 4. Zero documents after sync        | Empty state, check filters         | E2E-W3-09                 |
| 5. Permission crawl in progress     | "Crawling..." spinner              | E2E-W3-04                 |
| 6. All sync history failed          | All-red rows, prominent warning    | E2E-W3-03                 |
| 7. Webhook test fails               | Inline error, save still allowed   | E2E-W3-05                 |
| 8. Very large connector             | "Top 5 + Other" grouping           | E2E-W3-01                 |
| 9. Concurrent viewers               | Consistent data                    | E2E-W3-05                 |
| 10. Panel closed during sync        | Sync continues, reopen resumes     | E2E-W3-02                 |
| 11. ETA unreliable                  | "Estimating..." for first 10%      | E2E-W3-02                 |
| 12. Permission crawl + content sync | Both indicators visible            | E2E-W3-04                 |
| [Search Documents] navigation       | Navigates to Documents with filter | **E2E-W3-01** (steps 7-9) |

### C-09: SourcesTable Enhancements

| Edge Case                        | Description                | Covered By           |
| -------------------------------- | -------------------------- | -------------------- |
| 1. 0 sources                     | SourcesTable not rendered  | E2E-W1-01            |
| 2. Exactly 7 sources             | Auto-switch to table       | E2E-W4-02            |
| 3. All sources in error          | "All Healthy" shows 0      | E2E-W4-03            |
| 4. Mixed bulk action failures    | Per-source results         | E2E-W4-03, INT-W4-02 |
| 5. 0 SP sources                  | Sites/Token columns hidden | E2E-W4-02            |
| 6. Token at 0 days               | "Expired" not "0d left"    | E2E-W4-03            |
| 7. Long source names             | Truncation with tooltip    | E2E-W4-01            |
| 8. Rapid status transitions      | No intermediate flashes    | E2E-W1-03            |
| 9. Stale localStorage preference | Honored on reload          | E2E-W4-02            |
| 10. Database source card         | Masked connection string   | E2E-W4-01            |

### C-10: Multi-Connector Management

| Edge Case                              | Description                    | Covered By           |
| -------------------------------------- | ------------------------------ | -------------------- |
| 1. No connectors to clone              | Hidden or empty state          | E2E-W4-06            |
| 2. All connectors in error             | Clone section disabled         | E2E-W4-06            |
| 3. Cross-tenant clone                  | Sites cleared, notice shown    | E2E-W4-06, INT-W4-05 |
| 4. Invalid import file                 | Field-level validation errors  | INT-W4-08            |
| 5. Import with credentials             | Stripped, notice shown         | INT-W4-08            |
| 6. Template deleted between list/apply | 404, refresh list              | INT-W4-06            |
| 7. Concurrent clone attempts           | Both succeed independently     | INT-W4-05            |
| 8. Large template list                 | Pagination/virtual scroll      | INT-W4-06            |
| 9. Import with permission-aware search | Multi-step: parse → gate → API | INT-W4-08            |

### C-11: Error & Empty States

| Edge Case                       | Description                          | Covered By               |
| ------------------------------- | ------------------------------------ | ------------------------ |
| 1. Error during recovery        | New error replaces old               | E2E-W3-06                |
| 2. Rapid error transitions      | Clean transition between types       | E2E-W3-07                |
| 3. Discovery timeout 0 profiled | Hide "Continue with 0"               | E2E-W3-11                |
| 4. Token expiry in the past     | "Already expired" vs "expiring soon" | E2E-W3-10                |
| 5. No filters but 0 docs        | Fallback explanation                 | E2E-W3-09                |
| 6. 50+ failed sites             | Scrolling/truncation                 | E2E-W3-08                |
| 7. Popup blocked false positive | Offer alternatives regardless        | E2E-W2-02 (E9 via popup) |
| 8. Stale error display          | Refresh on focus or intervals        | E2E-W3-07                |

**Error States Coverage (E1-E10):**

| Error | Description                     | Covered By                                              |
| ----- | ------------------------------- | ------------------------------------------------------- |
| E1    | Auth Failed (AADSTS)            | E2E-W3-06                                               |
| E2    | Discovery Timeout (1000+ sites) | **E2E-W3-11** (dedicated), CW-02, INT-W2-03             |
| E3    | Sync Failure (Storage Exceeded) | E2E-W3-10, CW-02                                        |
| E4    | Token Expired (Refresh Failed)  | **E2E-W3-12** (dedicated), E2E-W3-02 (during sync)      |
| E5    | Permission Revoked              | **E2E-W3-13** (dedicated), E2E-W4-05 (emergency revoke) |
| E6    | Graph API Throttled (429)       | E2E-W3-07                                               |
| E7    | Partial Site Failure            | E2E-W3-08                                               |
| E8    | Zero Sites Found                | **E2E-W3-14** (dedicated), INT-W2-09                    |
| E9    | Sign-In Popup Blocked           | E2E-W2-02                                               |
| E10   | All Files Unsupported           | **E2E-W3-15** (dedicated)                               |

**Empty States Coverage (EM1-EM3):**

| Empty State | Description                          | Covered By                 |
| ----------- | ------------------------------------ | -------------------------- |
| EM1         | No Connectors                        | E2E-W1-01 (empty KB entry) |
| EM2         | No Documents (sync 0 indexed)        | E2E-W3-09                  |
| EM3         | No Sites Accessible (Sites.Selected) | INT-W2-09, INT-W3-07       |

### C-12: Config Management & History

| Edge Case                          | Description                | Covered By           |
| ---------------------------------- | -------------------------- | -------------------- |
| 1. Export with no changes          | Shows v1 with defaults     | E2E-W4-07            |
| 2. Diff non-adjacent versions      | Arbitrary pairs supported  | E2E-W4-08, INT-W4-07 |
| 3. Concurrent config edits         | Version conflict detection | INT-W4-07            |
| 4. Import different schema version | Migration with defaults    | INT-W4-08            |
| 5. Cleanup with zero content       | Button disabled            | E2E-W4-10            |
| 6. Cleanup cancelled mid-way       | Partial state + retry      | E2E-W4-10, INT-W4-09 |
| 7. Template deleted after creation | "No longer available"      | E2E-W4-09            |
| 8. Very large config               | Handle without freezing    | E2E-W4-07            |
| 9. Credentials re-import           | Warning about overwrite    | INT-W4-08            |
| 10. Cleanup while sync running     | Rejected, button disabled  | E2E-W4-10, INT-W4-09 |

---

## Status Badge Coverage

All 7 status badges are tested:

| Badge                 | Where Tested                    |
| --------------------- | ------------------------------- |
| Active (green)        | E2E-W1-02, E2E-W4-01, E2E-W3-01 |
| Awaiting Auth (amber) | E2E-W1-03, E2E-W1-05            |
| Draft (gray)          | E2E-W1-03, E2E-W1-05, E2E-W4-06 |
| Syncing (blue)        | E2E-W1-03, E2E-W3-02, E2E-W2-12 |
| Partial (amber)       | E2E-W3-08                       |
| Error (red)           | E2E-W1-03, E2E-W3-06, E2E-W3-10 |
| Auth Failed (red)     | E2E-W3-06, E2E-W4-03            |

---

## Known Backend Bug Regression Tests

| Bug | Description                           | Regression Test        |
| --- | ------------------------------------- | ---------------------- |
| B1  | resolveScopes uses FullControl        | INT-W1-02              |
| B2  | SP group ID != Azure AD group ID      | INT-W1-05              |
| B3  | grantedToV2.group not populated       | INT-W1-05              |
| B4  | getDrivePermissions never called      | INT-W1-05              |
| B5  | Permission modes include "simplified" | INT-W1-05              |
| B6  | Webhook stubs (Phase 2, not tested)   | Out of scope (Phase 2) |
| B7  | pauseSync/resumeSync not implemented  | INT-W1-03, INT-W3-08   |
| B8  | Pod-local OAuth state store           | INT-W1-01              |
| B9  | ConnectorSchema not registered        | INT-W1-04              |
| B10 | FieldMapping not registered           | INT-W1-04              |

---

## Traceability Notes

**API Coverage Matrix:** The Phase 3 API Coverage Matrix identifies 24 "Available" and 14 "Partial" endpoints. These endpoints are tested implicitly through the E2E scenarios that exercise the UI flows powered by those APIs. For example, the connector status endpoint is tested by every error state E2E scenario (E2E-W3-06 through E2E-W3-15), the sync progress endpoint is tested by E2E-W3-02 and INT-W3-02, and the filter preview endpoint is tested by E2E-W2-07 and INT-W2-05. "Partial" endpoints — which may need response shape enhancements — are verified through integration tests that assert the enhanced fields (e.g., INT-W3-02 for per-site breakdown, INT-W3-01 for content freshness and permission sync status). A dedicated API-to-test mapping is deferred until implementation, when the actual endpoint shapes are finalized.
