# C-05: Preview & Approve — Capability Note

**Status:** Reviewed
**Design Sections:** §4d, §4f

## User Intent

The user wants to see exactly what WOULD be synced before committing, then approve the configuration and start (or defer) the sync. This is the final checkpoint: verify document counts, catch unexpected inclusions/exclusions, and confirm scope before real data flows.

## UI Behaviors

### Preview/Dry-Run Tab (§4d)

1. **Summary panel** displays four stats: document count, skip count, estimated size, estimated time range. The document count display includes site count context: "~N documents across Y sites."
2. **Filter change tracking** — when filters have changed since the last preview, a delta block appears:
   - Each filter change shown as a line item with the number of documents affected (e.g., "+12 docs skipped").
   - Net change shown as a single summary line ("Net change: -15 documents vs previous preview").
   - Hidden when no previous preview exists for this configuration.
3. **Sample Documents table** — paginated or truncated list showing 25 representative documents out of the total. Columns: Name, Site, Type, Size, Sensitivity. Sensitivity values include warning-level labels (e.g., "WARN Confid.", "Internal", or "--" for none).
4. **Skipped Documents table** — first 10 of N skipped documents. Columns: Name, Reason (human-readable rule that caused exclusion).
5. **Content Type Breakdown** — horizontal bar chart showing top types (PDF, DOCX, PPTX, Other) with counts and percentages. UI renders proportional bars from the data.
6. **Navigation buttons**: [Adjust Filters] navigates back to the Scope+Filters tab; [Approve Sync] navigates forward to the Approve & Start view.

### Approve & Start (§4f)

1. **Configuration Summary** — read-only block showing:
   - Connection: tenant domain, auth method, token days remaining.
   - Scope: site count, library count, document count, total size.
   - Filters: active filter template name + custom rules summary.
   - Schedule: full sync timing + delta frequency.
   - Permissions: permission mode label (e.g., "Public Access (no ACL filtering)" or "Permission-Aware Search").
   - Security: approval status ("Approved", "Pending", "No approval required").
2. **Estimated initial sync time** — displayed as a time range (e.g., "15-25 minutes").
3. **Vector embedding cleanup note** — static informational text about cleanup-on-delete behavior.
4. **Three action buttons** with descriptive help text below each:
   - **[Start Sync]** — Help text: "Begin full sync now. ~N docs, ~M min ETA." Triggers inline confirmation dialog before executing.
   - **[Save as Draft]** — Help text: "Save without syncing. Resume later." Persists current configuration without starting sync.
   - **[Export Template]** — Help text: "Save config as reusable template for future setups."
5. **Inline confirmation dialog** — shown when [Start Sync] is clicked:
   - Text: "This will sync ~N documents (~X GB) from Y SharePoint sites. Sync begins immediately."
   - Buttons: [Confirm & Start Sync], [Cancel].
6. **Security Gate override** — if security approval is pending, the [Start Sync] button text changes to "Submit for Security Approval" and the action submits for review instead of starting sync.

### Post-Approval Transition

1. **Flow A (arrived from Home tab):** Navigate to Data tab > Sources segment. New connector row appears in SourcesTable with "Syncing" status badge. Detail Panel auto-opens to Overview tab showing sync progress (§7b).
2. **Flows B/C (already on Data tab):** Detail Panel switches in-place to Overview tab showing sync progress. No page navigation.
3. **Sync progress view (§7b):** Overall progress bar (docs processed / total, size processed / total, ETA), current document being processed, per-site progress bars with percentage and counts, [Pause Sync] and [Stop Sync] controls.

## Required Data Fields

### From Preview/Dry-Run API

| Field                                | Type      | Description                                                               |
| ------------------------------------ | --------- | ------------------------------------------------------------------------- | --------------------------------- |
| `totalDocCount`                      | `number`  | Total documents that would be synced                                      |
| `siteCount`                          | `number`  | Number of sites represented in the preview (for "across N sites" display) |
| `skipCount`                          | `number`  | Total documents that would be skipped                                     |
| `estimatedSizeBytes`                 | `number`  | Estimated total size in bytes                                             |
| `estimatedTimeMinRange`              | `number`  | Lower bound of estimated sync time (minutes)                              |
| `estimatedTimeMaxRange`              | `number`  | Upper bound of estimated sync time (minutes)                              |
| `filterChanges`                      | `array`   | List of filter changes since last preview                                 |
| `filterChanges[].description`        | `string`  | Human-readable filter change (e.g., "Exclude **/Archive/**")              |
| `filterChanges[].docsDelta`          | `number`  | Signed count of documents affected (+N skipped, -N added back)            |
| `netChange`                          | `number`  | Net document count change vs previous preview                             |
| `hasPreviousPreview`                 | `boolean` | Whether a previous preview exists (controls delta block visibility)       |
| `sampleDocuments`                    | `array`   | Up to 25 representative documents                                         |
| `sampleDocuments[].name`             | `string`  | Document filename                                                         |
| `sampleDocuments[].site`             | `string`  | SharePoint site name                                                      |
| `sampleDocuments[].type`             | `string`  | File extension/type (PDF, DOCX, etc.)                                     |
| `sampleDocuments[].sizeBytes`        | `number`  | File size in bytes                                                        |
| `sampleDocuments[].sensitivityLabel` | `string   | null`                                                                     | Sensitivity label or null if none |
| `sampleDocumentsTotalCount`          | `number`  | Total count (for "25 of ~N" display)                                      |
| `skippedDocuments`                   | `array`   | Up to 10 skipped documents                                                |
| `skippedDocuments[].name`            | `string`  | Document filename                                                         |
| `skippedDocuments[].reason`          | `string`  | Human-readable skip reason                                                |
| `skippedDocumentsTotalCount`         | `number`  | Total skipped count (for "first 10 of ~N" display)                        |
| `contentTypeBreakdown`               | `array`   | Content type distribution                                                 |
| `contentTypeBreakdown[].type`        | `string`  | File type label (PDF, DOCX, PPTX, Other)                                  |
| `contentTypeBreakdown[].count`       | `number`  | Number of documents of this type                                          |
| `contentTypeBreakdown[].percentage`  | `number`  | Percentage of total (0-100)                                               |

### From Configuration Summary (Approve & Start)

| Field                           | Type     | Description                                           |
| ------------------------------- | -------- | ----------------------------------------------------- |
| `connection.tenantDomain`       | `string` | e.g., "contoso.com"                                   |
| `connection.authMethod`         | `string` | e.g., "Client Credentials", "Device Code"             |
| `connection.tokenDaysRemaining` | `number` | Days until token expiry                               |
| `scope.siteCount`               | `number` | Number of selected sites                              |
| `scope.libraryCount`            | `number` | Number of document libraries                          |
| `scope.docCount`                | `number` | Approximate document count                            |
| `scope.totalSizeDisplay`        | `string` | Formatted size (e.g., "~4.2 GB")                      |
| `filters.summary`               | `string` | Human-readable filter summary                         |
| `schedule.fullSyncTiming`       | `string` | e.g., "Full sync now"                                 |
| `schedule.deltaFrequency`       | `string` | e.g., "delta every 4 hours"                           |
| `permissions.mode`              | `string` | "permission_aware" or "public_access"                 |
| `permissions.modeLabel`         | `string` | Display label for permission mode                     |
| `security.status`               | `string` | "approved" \| "pending" \| "not_required"             |
| `security.statusLabel`          | `string` | Display label (e.g., "Approved (no elevated scopes)") |
| `estimatedSyncTimeRange`        | `string` | Formatted time range (e.g., "15-25 minutes")          |

### From Sync Progress (§7b, post-approval)

| Field                             | Type     | Description                                      |
| --------------------------------- | -------- | ------------------------------------------------ |
| `syncStatus`                      | `string` | "syncing" \| "paused" \| "completed" \| "failed" |
| `docsProcessed`                   | `number` | Documents processed so far                       |
| `docsTotal`                       | `number` | Total documents to process                       |
| `sizeProcessedBytes`              | `number` | Bytes processed so far                           |
| `sizeTotalBytes`                  | `number` | Total bytes to process                           |
| `etaMinutes`                      | `number` | Estimated minutes remaining                      |
| `currentDocument`                 | `string` | Name of document currently being processed       |
| `currentDocumentSite`             | `string` | Site of document currently being processed       |
| `perSiteProgress`                 | `array`  | Per-site breakdown                               |
| `perSiteProgress[].siteName`      | `string` | Site display name                                |
| `perSiteProgress[].docsProcessed` | `number` | Docs processed for this site                     |
| `perSiteProgress[].docsTotal`     | `number` | Total docs for this site                         |
| `perSiteProgress[].percentage`    | `number` | Completion percentage (0-100)                    |

## API Requirements

### 1. Run Preview (Dry-Run)

```
POST /api/projects/:projectId/connectors/:connectorId/preview
```

- **Trigger:** User navigates to Preview tab (or clicks "Refresh Preview" after filter changes).
- **Input:** Current connector configuration ID (filters, scope, schedule already saved server-side from previous tabs).
- **Returns:** All fields from the "Preview/Dry-Run API" table above, including `siteCount`.
- **Behavior:** Does NOT download or index any content. Queries SharePoint metadata only to produce counts, samples, and type breakdown.
- **Caching:** If no filter/scope changes since last preview, the API may return cached results with a `cachedAt` timestamp so the UI can show "Preview from 2 minutes ago."

### 2. Get Configuration Summary

```
GET /api/projects/:projectId/connectors/:connectorId/summary
```

- **Trigger:** User navigates to Approve & Start view.
- **Returns:** All fields from the "Configuration Summary" table above.
- **Purpose:** Read-only aggregation of the current connector config for final review.

### 3. Start Sync

```
POST /api/projects/:projectId/connectors/:connectorId/sync
```

- **Trigger:** User clicks [Confirm & Start Sync] in the confirmation dialog.
- **Returns:** `{ connectorId, syncJobId, status: "syncing" }` — the UI uses `syncJobId` to poll or subscribe for progress.
- **Precondition:** Security gate must be "approved" or "not_required". If "pending", the API rejects with an error directing the user to submit for approval first.

### 4. Submit for Security Approval

```
POST /api/projects/:projectId/connectors/:connectorId/security-review
```

- **Trigger:** User clicks [Submit for Security Approval] (shown instead of [Start Sync] when security gate is pending).
- **Returns:** `{ status: "pending_review", reviewId }`.
- **Effect:** Connector status changes to awaiting approval. Notifies the designated security reviewer(s).

### 5. Save as Draft

```
PATCH /api/projects/:projectId/connectors/:connectorId
Body: { status: "draft" }
```

- **Trigger:** User clicks [Save as Draft].
- **Returns:** Updated connector with `status: "draft"`.
- **Effect:** Configuration is persisted but no sync starts. User can resume later.

### 6. Export Template

```
POST /api/projects/:projectId/connectors/:connectorId/export-template
```

- **Trigger:** User clicks [Export Template].
- **Returns:** `{ templateId, name }` — template is saved and available for future connector creation.

### 7. Sync Progress (polling or SSE)

```
GET /api/projects/:projectId/connectors/:connectorId/sync/:syncJobId/progress
```

- **Trigger:** After sync starts, UI polls this endpoint (or subscribes via SSE/WebSocket).
- **Returns:** All fields from the "Sync Progress" table above.
- **Polling interval:** Suggested 3-5 seconds during active sync.

### 8. Pause / Stop Sync

```
POST /api/projects/:projectId/connectors/:connectorId/sync/:syncJobId/pause
POST /api/projects/:projectId/connectors/:connectorId/sync/:syncJobId/stop
```

- **Trigger:** User clicks [Pause Sync] or [Stop Sync] on the progress view.
- **Returns:** Updated sync status.

## Assumptions

1. The preview API returns a representative sample (not exhaustive) — the "25 of ~N" framing is intentional; the backend selects documents to show variety across sites, types, and sizes.
2. Filter change tracking requires the backend to store the state of the previous preview so it can compute deltas. The UI does not compute deltas client-side.
3. Sensitivity labels come from SharePoint metadata (Microsoft Information Protection labels). If the tenant does not use sensitivity labels, the column shows "--" for all documents.
4. The confirmation dialog is purely client-side UI — it does not call a separate API. The actual start is the `POST .../sync` call.
5. The [Adjust Filters] button navigates back to the Scope+Filters tab within the same Detail Panel — no data loss, no new API call.
6. Configuration summary data is an aggregation of already-saved connector config — no new user input needed on the Approve & Start view.
7. Sync progress is available immediately after the sync start API returns; the first poll may show 0% progress.

## Open Questions

1. **Preview staleness policy:** How long is a cached preview valid? Should the UI auto-refresh the preview when the user navigates to the Preview tab after filter changes, or require an explicit "Refresh Preview" click?
2. **Sample selection strategy:** Does the backend guarantee diversity in the sample (spread across sites, types) or is it random? The UI may want to communicate this ("representative sample" vs "random sample").
3. **Sensitivity label availability:** What happens when the SharePoint tenant has no MIP labels configured? Should the Sensitivity column be hidden entirely, or show "--" for all rows?
4. **Export Template permissions:** Can any project member export a template, or only admins? Does the template include sensitive data (tenant domain, site URLs)?
5. **Sync progress transport:** Polling vs SSE vs WebSocket — which is preferred? This affects UI implementation complexity and real-time feel.
6. **Save as Draft from Approve:** Does saving as draft preserve the preview results, or must the user re-run preview when they resume?

## Edge Cases

1. **Zero documents matched:** Preview returns `totalDocCount: 0`. The UI should show an empty state: "No documents match your current filters. [Adjust Filters]" — the [Approve Sync] button should be disabled.
2. **Zero documents skipped:** Skipped Documents section is hidden entirely (not shown as an empty table).
3. **No filter changes:** The filter change tracking block is hidden when `hasPreviousPreview` is false or `filterChanges` is empty.
4. **Very large preview (100k+ docs):** The preview API may take longer. The UI should show a loading state with a progress indicator or "Computing preview..." message.
5. **Security gate blocks start:** When `security.status === "pending"`, the [Start Sync] button is replaced with [Submit for Security Approval]. The confirmation dialog text changes accordingly.
6. **Token expired before approval:** If `connection.tokenDaysRemaining` is 0 or negative, the Approve & Start view should show a warning and disable [Start Sync] with a prompt to re-authenticate.
7. **Concurrent preview requests:** If the user rapidly switches filters and triggers multiple previews, only the latest should be displayed. The UI should cancel or ignore stale responses.
8. **Post-approval navigation (Flow A):** If the user was on the Home tab and the SourcesTable has never been loaded, the UI must fetch the sources list after navigating to the Data tab to show the new connector row.
9. **Sync starts but immediately fails:** The progress view should handle a transition from "syncing" to "failed" gracefully, showing the error reason and offering [Retry] or [Edit Configuration].
10. **Content type breakdown edge case — all one type:** If 100% of documents are PDF, the bar chart shows a single full bar. The "Other" category is omitted when its count is 0.
11. **Sensitivity label "WARN" prefix rendering:** Some sensitivity labels display with a warning indicator (e.g., "WARN Confid.") while others display plain text ("Internal") or "--" for none. The UI should parse a severity prefix if present and render it with appropriate visual treatment (warning icon/color for "WARN" prefix, neutral for others).

## Out of Scope

- Backend implementation of the preview/dry-run engine (how SharePoint is queried for metadata).
- Security Gate approval workflow internals (reviewer assignment, notification delivery, approval persistence).
- Vector embedding cleanup pipeline implementation.
- Template storage schema and management UI.
- The Scope+Filters tab itself (covered by a separate card).
- The Security tab content (covered by a separate card).
- The Connect/Auth tab (covered by a separate card).
- Multi-connector overlap detection logic.
- Sync retry/recovery strategies beyond what the progress UI displays.

## Resolution Log

**Resolved from verification-batch-2 findings:**

| #   | Finding                                                           | Severity | Resolution                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Preview response missing `siteCount` for "across N sites" display | MEDIUM   | **Fixed.** Added `siteCount` field to the Preview/Dry-Run API data fields table. Updated summary panel description (item 1) to include "across Y sites" context. Updated preview API endpoint description to note `siteCount` inclusion. Verified against design line 1740: "~523 documents across 8 sites." |
| F2  | Button help text descriptions not captured from wireframe         | MEDIUM   | **Fixed.** Rewrote item 4 (three action buttons) to include the descriptive help text shown below each button in the wireframe (lines 1949-1952). Each button now lists its help text.                                                                                                                       |
| F3  | Sensitivity label "WARN" prefix rendering behavior not specified  | LOW      | **Fixed.** Added edge case 11 documenting the "WARN" prefix rendering behavior. The UI should parse severity prefixes and render with appropriate visual treatment.                                                                                                                                          |
