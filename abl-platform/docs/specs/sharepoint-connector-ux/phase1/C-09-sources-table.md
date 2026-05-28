# C-09: SourcesTable Enhancements — Capability Note

**Status:** Reviewed
**Design Sections:** §3b (i-iv)

## User Intent

The SourcesTable is the single, shared view of ALL source types within a KB's Data tab (Sources segment). Users need to:

1. Get an at-a-glance health overview of every source (SharePoint, Web Crawl, File Upload, API, Database) in one place.
2. Quickly identify sources that need attention (auth failures, token expiry, sync errors).
3. Scale from a handful of sources (card layout) to fleet-level operations (table with filtering, grouping, bulk actions).
4. Resume in-progress connector setup by clicking a Draft or Awaiting Auth row.
5. Perform bulk operations across selected sources (re-auth, pause, sync, delete).

## UI Behaviors

### View Switching (Card vs. Table)

- **Card view** renders when the KB has 1-6 sources.
- **Table view** renders when the KB has 7+ sources.
- Auto-switch happens on page load only, never mid-interaction (adding a 7th source does not flip the view until the next page load).
- User can manually toggle via [Card] [Table] buttons at any source count.
- User's override preference is persisted per-KB in `localStorage`.

### Header Bar (both views)

- **Status line** at the top: "N active . N warnings . N errors" (e.g., "6 active . 1 warning . 0 errors" in card view, "15 active . 2 warnings . 1 error" in table view). This is a distinct UI element from the aggregate summary bar in table view.
- **Controls**: `[Card]` `[Table]` toggle buttons and `[+ Add]` button appear in the header area for both views.

### Card View (1-6 sources)

- One card per source, showing type icon, name, status badge, doc count, size, and type-specific secondary info.
- A dashed-border "+ Add Source" card always appears as the last card.
- A summary row below cards shows: total doc count, total size, source count breakdown by type.

### Table View (7+ sources)

- Toolbar: search input, status filter dropdown, type filter dropdown, sort dropdown.
- Tenant filter dropdown appears only when SharePoint sources from multiple tenants exist.
- Group-by selector: None | Type | Status | Tenant. When grouped, each group is collapsible and shows aggregate stats (source count, doc count, status breakdown).
- Quick filter pills: "Needs Attention (N)", "All Healthy (N)", "Token Warning (N)" with counts.
- Aggregate summary bar above the table: total sources by status, total docs, tokens expiring count.
- Columns: checkbox, Name, Type (with icon/badge), Status, Docs, Size, Last Sync.
- SP-specific conditional columns (Sites, Token) appear when any SharePoint source exists. Non-SP rows show "--" in those columns.
- **Bottom summary row** below the table: "N docs total . X GB . N sources (N SP, N Web, N File, N API)". This is a separate element from the aggregate summary bar at the top.
- Pagination control below the summary row.

### Row Click Routing

- **Draft** or **Awaiting Auth** status: opens Detail Panel with Connect tab active (resume setup).
- **Active**, **Syncing**, or **Error** status: opens Detail Panel with Overview tab active.

### Status Badges

- Active (green dot): syncing, healthy.
- Awaiting Auth (amber half-dot): configured, waiting for authentication.
- Draft (gray empty dot): created but not configured.
- Syncing (blue dot): sync in progress.
- Partial (amber exclamation): sync completed with errors on some sites (e.g., "! Partial" in table view).
- Error (red dot): sync failed.
- Auth Failed (red dot): token expired or revoked.

### Bulk Actions

- Appear when 2+ rows are selected via checkboxes.
- Selection count displayed (e.g., "3 selected").
- Generic actions (all types): Pause Selected, Resume Selected, Sync Now, Delete Selected.
- SP-conditional actions (appear when any selected row is SharePoint): Re-auth Selected, Apply Schedule, Export Configs.
- Select All / Clear Selection controls.

## Required Data Fields

### Per-Source (all types)

| Field        | Type                  | Notes                                                                                  |
| ------------ | --------------------- | -------------------------------------------------------------------------------------- |
| `id`         | string                | Source identifier                                                                      |
| `name`       | string                | Display name                                                                           |
| `type`       | enum                  | `sharepoint` / `webcrawl` / `fileupload` / `api` / `database`                          |
| `status`     | enum                  | `active` / `awaiting_auth` / `draft` / `syncing` / `partial` / `error` / `auth_failed` |
| `docCount`   | number                | Document count (null/0 for draft)                                                      |
| `sizeBytes`  | number                | Total size in bytes (null for draft)                                                   |
| `lastSyncAt` | ISO timestamp or null | Last successful sync time                                                              |

### SharePoint-Specific Fields

| Field                      | Type           | Notes                                               |
| -------------------------- | -------------- | --------------------------------------------------- |
| `docLibraryCount`          | number         | Count of doc libraries being synced                 |
| `tokenHealthDaysRemaining` | number or null | Days until token expiry                             |
| `tokenStatus`              | enum           | `healthy` / `warning` / `expired`                   |
| `tenantId`                 | string         | Azure AD tenant (needed for tenant filter/grouping) |
| `tenantName`               | string         | Display name for tenant filter                      |
| `siteCount`                | number         | Sites column in table view                          |

### Web Crawl-Specific Fields

| Field         | Type                  | Notes           |
| ------------- | --------------------- | --------------- |
| `url`         | string                | Root crawl URL  |
| `lastCrawlAt` | ISO timestamp or null | Last crawl time |
| `depthLevels` | number                | Crawl depth     |

### File Upload-Specific Fields

| Field          | Type                  | Notes                   |
| -------------- | --------------------- | ----------------------- |
| `lastUploadAt` | ISO timestamp or null | Most recent upload time |

### API-Specific Fields

| Field           | Type   | Notes                                      |
| --------------- | ------ | ------------------------------------------ |
| `endpointUrl`   | string | API endpoint                               |
| `pollFrequency` | string | Human-readable interval (e.g., "every 6h") |

### Database-Specific Fields

| Field              | Type                  | Notes                                |
| ------------------ | --------------------- | ------------------------------------ |
| `connectionString` | string                | Masked connection string for display |
| `lastQueryAt`      | ISO timestamp or null | Last query time                      |

### Aggregate/Summary Fields (computed or returned by API)

| Field                 | Type                     | Notes                                             |
| --------------------- | ------------------------ | ------------------------------------------------- |
| `totalDocs`           | number                   | Sum of all source doc counts                      |
| `totalSizeBytes`      | number                   | Sum of all source sizes                           |
| `sourceCountByType`   | `Record<type, number>`   | Breakdown for summary row                         |
| `sourceCountByStatus` | `Record<status, number>` | For aggregate summary bar and quick filter counts |
| `tokensExpiringCount` | number                   | SP sources with token warning/expired             |

## API Requirements

### 1. List Sources (GET)

**Purpose:** Fetch all sources for a KB with filtering, sorting, grouping, and pagination.

**Endpoint pattern:** `GET /api/projects/:projectId/knowledge-bases/:kbId/sources`

**Query parameters the UI needs to send:**

| Param       | Type               | Notes                                 |
| ----------- | ------------------ | ------------------------------------- |
| `search`    | string             | Filter by name (substring match)      |
| `status`    | string or string[] | Filter by status(es)                  |
| `type`      | string or string[] | Filter by source type(s)              |
| `tenantId`  | string             | Filter by SP tenant (conditional)     |
| `sortBy`    | string             | Column name to sort by                |
| `sortOrder` | `asc` / `desc`     | Sort direction                        |
| `groupBy`   | string             | `none` / `type` / `status` / `tenant` |
| `page`      | number             | Page number                           |
| `pageSize`  | number             | Items per page                        |

**Response shape the UI needs:**

```
{
  sources: Source[],          // paginated list with all per-source fields above
  pagination: { page, pageSize, total },
  aggregates: {
    totalDocs: number,
    totalSizeBytes: number,
    sourceCountByType: Record<string, number>,
    sourceCountByStatus: Record<string, number>,
    tokensExpiringCount: number
  },
  groups?: [{                 // present when groupBy != 'none'
    key: string,              // group key (type name, status, or tenant name)
    sourceCount: number,
    docCount: number,
    statusBreakdown: Record<string, number>,
    collapsed: boolean        // default collapse state (UI manages toggle)
  }],
  hasMultipleTenants: boolean // controls tenant filter visibility
}
```

### 2. Bulk Actions (POST)

**Purpose:** Execute an action on multiple selected sources.

**Endpoint pattern:** `POST /api/projects/:projectId/knowledge-bases/:kbId/sources/bulk`

**Request body the UI sends:**

```
{
  sourceIds: string[],
  action: 'reauth' | 'pause' | 'resume' | 'sync_now' | 'apply_schedule' | 'export_configs' | 'delete'
}
```

**Response shape the UI needs:**

```
{
  success: boolean,
  results: [{
    sourceId: string,
    success: boolean,
    error?: { code: string, message: string }
  }]
}
```

- UI needs per-source success/failure to show partial failure states.
- `export_configs` action should return a downloadable payload (or a download URL).

### 3. Quick Filter Counts

The quick filter pills ("Needs Attention (3)", "All Healthy (12)", "Token Warning (2)") need counts. These can be derived from the `aggregates` in the list response, provided the API returns `sourceCountByStatus` and `tokensExpiringCount`. No separate endpoint needed if aggregates are always returned.

- "Needs Attention" = count of `error` + `auth_failed` + `awaiting_auth`
- "All Healthy" = count of `active`
- "Token Warning" = `tokensExpiringCount`

## Assumptions

1. The existing `SourcesTable` component already handles basic source listing; this card extends it with card view, conditional columns, grouping, bulk actions, and richer status.
2. Source `type` is a fixed enum known at build time. Type-specific fields are returned as a polymorphic union (or as a flat object with nullable type-specific fields).
3. The aggregates (totalDocs, sourceCountByType, etc.) are returned alongside the paginated list, not requiring a separate API call.
4. `hasMultipleTenants` is derived server-side from the actual SP sources in this KB. The UI does not need to query tenants separately.
5. Pagination is server-side. The UI sends page/pageSize and receives the slice plus total count.
6. Group-by is server-side (the API returns group metadata). The UI manages collapse state locally.
7. Card view does not need pagination (max 6 sources).
8. localStorage key for view preference follows a pattern like `sources-view-${kbId}`.

## Open Questions

1. **Polling/realtime for status changes:** Should the SourcesTable poll for status updates (e.g., a source transitioning from Syncing to Active), or rely on manual refresh? If polling, what interval?
2. **Export Configs format:** What format does "Export Configs" produce (JSON, YAML, ZIP)? Is it a direct download or a generated file URL?
3. **Apply Schedule semantics:** Does "Apply Schedule" open a dialog to configure the schedule, or does it apply the KB's default schedule to selected sources?
4. **Grouped pagination:** When grouped by type/status/tenant, is pagination applied globally (across all groups) or per-group?
5. **Search scope:** Does the search box search only source names, or also secondary info (URLs, tenant names)?
6. **Select All scope:** Does "Select All (15)" select all sources in the KB, or only the currently visible page?
7. **"Partial" status semantics:** What exact conditions produce the "Partial" status? Is it when some sites within a SharePoint connector have synced successfully while others failed? Does it apply to other source types?

## Edge Cases

1. **0 sources:** SourcesTable should not render. The Home tab's SetupGuide handles the empty state.
2. **Exactly 7 sources on page load:** Auto-switches to table view. If user deletes one (now 6) and reloads, reverts to card view (unless user previously toggled to table and that preference is in localStorage).
3. **All sources in error/draft:** Quick filter "All Healthy" shows count 0. "Needs Attention" pill should be visually emphasized.
4. **Mixed bulk action failures:** Some sources in a bulk action may succeed while others fail. UI must show per-source results, not just a global success/failure.
5. **SP-specific columns with 0 SP sources:** When no SharePoint sources exist, the Sites and Token columns should not appear at all.
6. **Token expiry at 0 days:** Token with 0 days remaining should show as "Expired" (Auth Failed status), not "0d left".
7. **Long source names:** Card and table views need text truncation with tooltip on hover.
8. **Rapid status transitions:** A source may go from Draft to Awaiting Auth to Active quickly. The UI should not flash intermediate states if it polls.
9. **Stale localStorage preference:** If a KB previously had 10 sources (user on table view) and is now down to 2, the stored "table" preference should still be honored (user explicitly chose it).
10. **Database source card rendering:** All 5 source types (SharePoint, Web Crawl, File Upload, API, Database) should have defined card rendering behavior including type icon, secondary info layout. Database cards show: connection string (masked), last query time.

## Out of Scope

- Detail Panel content (covered by other cards for Connect, Proposal, Scope+Filters, Preview, Security tabs).
- "+ Add Source" dialog/flow (covered by the add-source card).
- Backend implementation of sync, auth, token refresh.
- Database schema or service architecture.
- Actual API endpoint naming conventions or versioning (backend decides).
- Real-time WebSocket subscriptions (may be a future enhancement; polling is sufficient for this card).

## Resolution Log

**Resolved from verification-batch-3 findings:**

| #   | Finding                                           | Severity | Resolution                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Missing bottom summary row in table view          | MEDIUM   | **Fixed.** Added explicit "Bottom summary row" element to the Table View section: "N docs total . X GB . N sources (N SP, N Web, N File, N API)". Distinguished from the aggregate summary bar at the top. Verified against design wireframe 3b-ii line 473-474.                    |
| F2  | Missing header status line as distinct UI element | LOW      | **Fixed.** Added new "Header Bar (both views)" section documenting the status line ("N active . N warnings . N errors") and the [Card] [Table] [+ Add] controls. Verified against design wireframe 3b-i line 395 and 3b-ii line 433.                                                |
| F3  | Missing "Partial" status badge                    | MEDIUM   | **Fixed.** "Partial" badge was already added to Status Badges list in a prior edit. Added `partial` to the `status` enum in Per-Source data fields. Added Open Question 7 about exact conditions that produce the Partial status. Verified against design wireframe 3b-ii line 459. |
| F4  | Missing [+ Add] button in header toolbar          | LOW      | **Fixed.** Included `[+ Add]` button in the new Header Bar section, noting it appears in both card and table views. Verified against design wireframe 3b-i line 395 and 3b-ii line 433.                                                                                             |
| --  | Database source card rendering edge case          | --       | **Added.** New edge case 10 noting all 5 source types should have defined card rendering behavior.                                                                                                                                                                                  |
