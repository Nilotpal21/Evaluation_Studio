# C-08: Monitoring & Sync Progress — Capability Note

**Status:** Reviewed
**Design Sections:** §7a, §7b

## User Intent

The user has completed connector setup and now needs to:

- Understand the current health and state of the connector at a glance
- Know what content has been indexed, how much, and from where
- Review configuration without leaving the overview
- Be alerted when content is stale or permissions are outdated
- Watch sync progress in real time during active syncs
- Take quick corrective actions (sync now, pause, re-auth, etc.)
- Configure alerting for failures and token expiry

## UI Behaviors

### Overview Tab (default post-setup, §7a)

1. **Progressive loading with skeletons** — KPIs and config summary load first (<500ms), content breakdown next (1-2s), sync history last (1-3s). Each section renders independently with a skeleton placeholder until its data arrives. **Permission Sync Status has independent loading timing** -- may show "Checking..." spinner if Neo4j is slow, and should be listed as a separate loading step in the progressive sequence.
2. **Status badge** — one of: Healthy, Syncing, Error, Paused, Disconnected. Displayed next to connector name.
3. **Content Freshness warning** — conditionally rendered when last successful sync was 3+ days ago. Shows how long ago, how many recent attempts failed, and offers [Sync Now] + [View Sync History].
4. **Permission Sync Status** — may show "Checking..." spinner if the permission data source is slow. Shows coverage ratio, staleness warning, and next crawl time. **Interactive buttons**: `[Crawl Now]` triggers an on-demand permission crawl; `[Set Schedule]` opens permission crawl schedule configuration. **Explanatory note** displayed below: "Note: Search results respect the last-crawled permissions. If a user's access was revoked in SharePoint after the last crawl, they may still see that document in search until the next crawl."
5. **Configuration Summary** — collapsed view of scope, filters, schedule, permissions. [View Full Configuration] opens read-only detail. [Edit Configuration] navigates to the configuration editing flow.
6. **Sync History table** — paginated or scrollable. Columns: Date, Type (Full/Delta), Docs (+added, -removed, ~modified), Duration, Status (Done/Failed/Cancelled).
7. **Issues section** — shows "No issues" when clean; otherwise lists actionable issues.
8. **Notifications section** — two subsections:
   - **Email alerts**: toggle (on/off), event checkboxes. Uses platform email service (AWS SES/Resend/SMTP) -- this detail is shown as informational text in the wireframe.
   - **Webhook alerts**: URL input with [Test] and [Save] buttons, event checkboxes. Payload description shown as informational text: "Payload: JSON with event type, connector ID, severity, timestamp."
   - **Available events across both channels** (4 total): sync failure, token expiry (7d warning), permission crawl fail, sync complete. All 4 events should be available as checkboxes for both email and webhook configuration.
9. **Quick Actions bar** — [Sync Now], [Pause], [Edit Configuration], [Re-auth], [Health Check], [Search Documents], [Configure Alerts].
10. **[Search Documents]** — navigates to Data tab > Documents segment with a pre-applied filter for `connectorId`. The Documents view shows columns: document name, status, connector, and indexed date. No new route; reuses existing Documents view.
11. **Source attribution note** — informational text explaining search results show connector origin. **Note:** The design wireframe includes a "Not yet populated -- requires backend work" caveat with a reference to the "Backend Requirements section." This caveat should be displayed in the UI until the backend work is complete.

### Sync Progress (during active sync, §7b)

1. **Replaces Overview content** when a sync is active. Same panel, same tab — content switches to progress view.
2. **Sync type header** — "Full Sync in Progress" or "Delta Sync in Progress".
3. **Overall progress bar** — shows docs processed / total docs, size processed / total size, ETA.
4. **Current document indicator** — file name and source site of the document being processed right now.
5. **Per-site progress bars** — one per site in scope, showing percentage complete and doc count (e.g., "25% (14/56)").
6. **Action buttons** — [Pause Sync] and [Stop Sync]. Both require confirmation.
7. **Completion transition** — when progress reaches 100%: green checkmarks on all bars, "Sync Complete!" banner for 3 seconds, then auto-transition back to Overview with fresh data.
8. **SourcesTable row update** — upon sync completion, the parent SourcesTable row updates its status badge to "Active" and refreshes the document count. This implies the Overview tab re-fetches data after transition.
9. **Polling or SSE** — progress data must update in near-real-time. UI needs either polling (every 2-5s) or server-sent events for the progress stream.

## Required Data Fields

### Overview KPIs (fast load, <500ms)

| Field             | Type           | Example                                                     |
| ----------------- | -------------- | ----------------------------------------------------------- |
| `connectorName`   | string         | "Marketing Hub"                                             |
| `status`          | enum           | "healthy" / "syncing" / "error" / "paused" / "disconnected" |
| `connectedDate`   | ISO date       | "2026-03-22T10:15:00Z"                                      |
| `authenticatedBy` | string (email) | "sarah@contoso.com"                                         |
| `totalDocuments`  | number         | 237                                                         |
| `totalSize`       | number (bytes) | 3435973837                                                  |
| `siteCount`       | number         | 2                                                           |
| `libraryCount`    | number         | 8                                                           |

### Content Breakdown (aggregation, 1-2s)

| Field    | Type                                    | Example                                                                 |
| -------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `byType` | array of `{ type, count, percentage }`  | `[{ type: "PDF", count: 142, percentage: 60 }]`                         |
| `bySite` | array of `{ siteName, docCount, size }` | `[{ siteName: "Marketing Hub main", docCount: 185, size: 2254857830 }]` |

### Configuration Summary (loads with KPIs)

| Field            | Type                 | Example                                                     |
| ---------------- | -------------------- | ----------------------------------------------------------- |
| `scope`          | string or structured | "5 sites, 14 document libraries"                            |
| `filters`        | string or structured | "Documents Only template, exclude /Archive/\*\*, max 100MB" |
| `schedule`       | string or structured | "Webhook + delta every 12h fallback"                        |
| `permissionMode` | string               | "Permission-Aware, full accuracy"                           |

### Content Freshness

| Field                  | Type             | Example                |
| ---------------------- | ---------------- | ---------------------- |
| `lastSuccessfulSync`   | ISO date or null | "2026-03-17T08:30:00Z" |
| `scheduledInterval`    | string           | "Every 6 hours"        |
| `recentFailedAttempts` | number           | 3                      |

### Permission Sync Status

| Field              | Type                               | Example                |
| ------------------ | ---------------------------------- | ---------------------- |
| `permissionMode`   | string                             | "enabled"              |
| `lastCrawled`      | ISO date or null                   | "2026-03-22T14:30:00Z" |
| `coverageTotal`    | number                             | 237                    |
| `coverageMapped`   | number                             | 237                    |
| `stalenessWarning` | boolean                            | true                   |
| `nextCrawl`        | ISO date or null / "Not scheduled" | null                   |

### Sync History

| Field                           | Type                        | Example                         |
| ------------------------------- | --------------------------- | ------------------------------- |
| `history`                       | array of `SyncHistoryEntry` | see below                       |
| `SyncHistoryEntry.date`         | ISO date                    | "2026-03-22T14:30:00Z"          |
| `SyncHistoryEntry.type`         | enum                        | "full" / "delta"                |
| `SyncHistoryEntry.docsAdded`    | number                      | 3                               |
| `SyncHistoryEntry.docsRemoved`  | number                      | 1                               |
| `SyncHistoryEntry.docsModified` | number                      | 0                               |
| `SyncHistoryEntry.duration`     | number (seconds)            | 45                              |
| `SyncHistoryEntry.status`       | enum                        | "done" / "failed" / "cancelled" |

### Notifications Config

| Field                | Type           | Example                                                                    |
| -------------------- | -------------- | -------------------------------------------------------------------------- |
| `emailAlertsEnabled` | boolean        | true                                                                       |
| `emailEvents`        | string[]       | ["sync_failure", "token_expiry", "permission_crawl_fail", "sync_complete"] |
| `webhookUrl`         | string or null | "https://hooks.slack.com/..."                                              |
| `webhookEvents`      | string[]       | ["sync_failure", "token_expiry", "permission_crawl_fail", "sync_complete"] |

### Sync Progress (real-time, §7b)

| Field             | Type                                                          | Example                                                           |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `syncType`        | enum                                                          | "full" / "delta"                                                  |
| `isActive`        | boolean                                                       | true                                                              |
| `docsProcessed`   | number                                                        | 78                                                                |
| `docsTotal`       | number                                                        | 252                                                               |
| `sizeProcessed`   | number (bytes)                                                | 3435973837                                                        |
| `sizeTotal`       | number (bytes)                                                | 11068046499                                                       |
| `etaSeconds`      | number or null                                                | 360                                                               |
| `currentDocument` | `{ name, sourceSite }`                                        | `{ name: "API-Reference-v3.md", sourceSite: "Engineering Wiki" }` |
| `perSiteProgress` | array of `{ siteName, percentage, docsProcessed, docsTotal }` | see wireframe                                                     |

## API Requirements

### GET `/connectors/:connectorId/overview`

Returns KPIs, config summary, content freshness, permission sync status. This is the fast-loading first call (<500ms target).

### GET `/connectors/:connectorId/content-breakdown`

Returns `byType` and `bySite` aggregations. Separate endpoint because it involves heavier aggregation (1-2s).

### GET `/connectors/:connectorId/sync-history`

Returns paginated sync history entries. Supports `?page=1&limit=20` or equivalent cursor. Loads last (1-3s).

### GET `/connectors/:connectorId/sync-progress`

Returns current sync progress data. Polled every 2-5 seconds during active sync, OR replaced by an SSE/WebSocket stream endpoint if available. Must include per-site breakdown.

### POST `/connectors/:connectorId/sync`

Triggers an on-demand sync. Body: `{ type: "full" | "delta" }`. Returns sync job ID.

### POST `/connectors/:connectorId/pause`

Pauses the connector (stops scheduled syncs).

### POST `/connectors/:connectorId/stop-sync`

Stops an in-progress sync.

### POST `/connectors/:connectorId/health-check`

Triggers a health check (validates auth token, connectivity to SharePoint).

### POST `/connectors/:connectorId/re-auth`

Initiates re-authentication flow (likely opens OAuth popup).

### POST `/connectors/:connectorId/permission-crawl`

Triggers an on-demand permission crawl ([Crawl Now] button).

### PUT `/connectors/:connectorId/notifications`

Saves notification preferences (email toggle, webhook URL, event selections for all 4 events).

### POST `/connectors/:connectorId/notifications/test-webhook`

Sends a test payload to the configured webhook URL. Returns success/failure.

### PUT `/connectors/:connectorId/permission-schedule`

Sets the permission crawl schedule ([Set Schedule] button).

## Assumptions

1. **Status enum is finite** — the UI maps status strings to badge colors/icons. The set of possible statuses is fixed and known at build time (healthy, syncing, error, paused, disconnected).
2. **Sync progress polling is sufficient** — 2-5 second polling interval provides acceptable UX for progress updates. SSE/WebSocket is preferred but not strictly required.
3. **Content breakdown is computed server-side** — the UI does not aggregate raw document lists. The API returns pre-computed type/site breakdowns.
4. **Configuration summary is a read-only projection** — the overview endpoint returns a display-friendly summary, not the full editable config object.
5. **SourcesTable update on sync completion** — the parent component (SourcesTable) either polls for changes or listens for an event/callback when the detail panel detects sync completion.
6. **Permission Sync Status is a separate subsystem** — permission crawl and content sync are independent operations with separate schedules and status.
7. **Webhook test is synchronous** — the test-webhook endpoint makes the HTTP call and returns the result within a single request/response cycle.
8. **Size values are in bytes** — the UI formats them for display (e.g., "3.2 GB"). The API returns raw byte counts.

## Open Questions

1. **Polling vs SSE for sync progress** — Is there an existing real-time channel (WebSocket, SSE) in the platform, or does the UI need to implement polling? Polling is simpler but adds load during sync.
2. **Sync history pagination** — How deep should history go? Is infinite scroll preferred, or a fixed page size with "Load more"?
3. **Permission staleness threshold** — What time delta triggers the staleness warning? Is it configurable or hardcoded (e.g., 24 hours)?
4. **Content freshness threshold** — The design says "3+ days". Is this configurable per connector, or a platform-wide constant?
5. **Webhook payload schema** — Is the webhook payload format documented? The UI shows event checkboxes but the user may want to preview what gets sent.
6. **Auto-transition timing** — The 3-second "Sync Complete!" banner before auto-transitioning back to Overview — should the user be able to dismiss it early?
7. **SourcesTable refresh mechanism** — When sync completes inside the detail panel, how does the parent SourcesTable know to refresh? Event bus, callback prop, or shared SWR cache invalidation?
8. **Health check response** — What does the health-check endpoint return? Just pass/fail, or detailed diagnostics (token validity, connectivity, API version)?
9. **Email alert recipients** — Are email alerts sent to the authenticated user, or is there a configurable recipient list?

## Edge Cases

1. **Sync starts while Overview is open** — UI must detect status change from "healthy" to "syncing" and transition to the progress view without user action. Requires polling or push notification.
2. **Sync fails mid-progress** — Progress bars freeze, status changes to error, error message appears, [Retry] button replaces [Pause Sync].
3. **Token expires during sync** — Sync fails with auth error. Status becomes "disconnected". [Re-auth] becomes primary action.
4. **Zero documents after sync** — Content breakdown shows empty state, not broken charts. "No documents indexed" message with suggestion to check filters.
5. **Permission crawl in progress** — Permission Sync Status shows "Crawling..." with a spinner. [Crawl Now] is disabled.
6. **All sync history entries failed** — Sync history table shows all-red rows. Content Freshness warning is prominent. Quick actions emphasize [Sync Now] and [Health Check].
7. **Webhook test fails** — Inline error message next to [Test] button: "Failed: Connection refused" or "Failed: 403 Forbidden". Save is still allowed (user may fix the endpoint later).
8. **Very large connector (10k+ docs)** — Content breakdown by-type chart must handle many file types. Consider "Top 5 + Other" grouping. By-site list may need scrolling/truncation.
9. **Concurrent viewers** — Two users viewing the same connector's sync progress. Both should see consistent data (no client-side-only state for progress).
10. **Panel closed during sync** — Sync continues in background. Re-opening the panel should resume showing progress (not restart from Overview).
11. **ETA becomes unreliable** — If processing speed varies wildly, ETA may jump. Consider showing "Estimating..." for the first 10% of sync, then stabilize.
12. **Permission crawl concurrent with content sync** — Both Permission Sync Status and Sync Progress may be active simultaneously. The UI must handle showing sync progress view while also updating permission status independently (e.g., a non-modal status indicator for permission crawl while the main view shows content sync progress).

## Out of Scope

- Backend implementation of sync engine, progress tracking, or aggregation queries
- Database schema for sync history, notification preferences, or permission mappings
- Webhook delivery infrastructure (retry logic, dead letter queues)
- Email alerting service implementation
- Permission crawl engine internals
- Search result rendering with source attribution (separate card)
- Edit Configuration flow (covered by setup/config cards)
- Neo4j or graph database specifics for permission storage
- Multi-connector comparison views (covered in §8)

## Resolution Log

**Resolved from verification-batch-3 findings:**

| #   | Finding                                                           | Severity | Resolution                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Missing "Crawl Now" and "Set Schedule" as explicit UI elements    | MEDIUM   | **Fixed.** Added `[Crawl Now]` and `[Set Schedule]` as explicit interactive buttons in item 4 (Permission Sync Status) with descriptions of their actions. These were only referenced implicitly via API endpoints before.                                                                                                          |
| F2  | Missing permission sync explanatory note (last-crawled caveat)    | LOW      | **Fixed.** Added the full explanatory note text to item 4: "Search results respect the last-crawled permissions. If a user's access was revoked in SharePoint after the last crawl, they may still see that document in search until the next crawl." Verified against design lines 2426-2428.                                      |
| F3  | Missing "not yet populated" caveat for source attribution         | LOW      | **Fixed.** Updated item 11 to note the design wireframe includes a "Not yet populated -- requires backend work" caveat that should be displayed until backend work is complete. Verified against design lines 2396-2399.                                                                                                            |
| F4  | Missing specific columns for Search Documents view                | LOW      | **Fixed.** Updated item 10 to specify the columns shown: document name, status, connector, and indexed date. Verified against design lines 2462-2464.                                                                                                                                                                               |
| F5  | Missing webhook payload schema description as UI text             | LOW      | **Fixed.** Added webhook payload description ("JSON with event type, connector ID, severity, timestamp") as informational text in the Notifications section (item 8). Verified against design line 2455.                                                                                                                            |
| F6  | Missing platform email service info text                          | LOW      | **Countered as false positive.** The platform email service detail (AWS SES/Resend/SMTP) is shown in the design wireframe (line 2449) as informational text. Added it to item 8 as informational text. However, this is an implementation detail that may or may not be appropriate to show end users -- flagged for design review. |
| F7  | Incomplete event list -- "sync complete" and cross-channel events | MEDIUM   | **Fixed.** Updated Notifications Config data fields to include all 4 events (sync_failure, token_expiry, permission_crawl_fail, sync_complete) in both `emailEvents` and `webhookEvents` examples. Updated item 8 to list all 4 events as available for both channels. Verified against design lines 2448 and 2453.                 |
| --  | Permission crawl concurrent with content sync edge case           | --       | **Added.** New edge case 12 covering simultaneous permission crawl and content sync.                                                                                                                                                                                                                                                |
| --  | Permission Sync Status independent loading timing                 | --       | **Fixed.** Added note to item 1 (Progressive loading) that Permission Sync Status has independent loading timing.                                                                                                                                                                                                                   |
