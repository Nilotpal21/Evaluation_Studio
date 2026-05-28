# C-11: Error & Empty States — Capability Note

**Status:** Reviewed
**Design Sections:** §10, §11

## User Intent

Users need clear, actionable feedback when something goes wrong or when there is nothing to show. Each error state must explain what happened, why, and what the user can do next. Each empty state must distinguish "not yet started" from "started but yielded nothing" and guide the user toward a productive next step.

## UI Behaviors

### Error States

**E1 — Auth Failed (Invalid Credentials)**

- Displayed on the Connect tab when OAuth or client-credential auth returns an AADSTS error.
- Shows the raw AADSTS error code and a human-readable explanation.
- Renders numbered how-to-fix steps referencing Azure Portal paths. The steps interpolate contextual details from the connector's auth configuration: the app registration name (e.g., "App Registrations > ABL Platform Prod") and the client secret creation date (e.g., "Check if the secret has expired (created: Jan 15, 2026)").
- Actions: [Open Azure Portal] (external link), [Retry with New Secret] (re-triggers auth flow).

**E2 — Discovery Timeout (1000+ sites)**

- Displayed on the Scope tab when discovery hits a timeout before completing site profiling.
- Shows total sites discovered vs sites fully profiled.
- Three options presented as a numbered list:
  1. Continue with partial data (button with profiled count in label).
  2. Inline search input to find specific sites by name.
  3. Re-run full discovery with estimated time.
- Stats bar at bottom: sites discovered | sites profiled (N/M) | drives found.

**E3 — Sync Failure (Storage Exceeded)**

- Displayed on the Overview tab with an error severity banner.
- Shows connector name, status badge "Sync Failed", docs processed vs total.
- Displays the specific technical error code and message (e.g., "Error: ENOSPC — Storage quota exceeded on upload destination."). The `errorMessage` field includes both the error code and human-readable description.
- Confirms already-processed docs are indexed and searchable.
- States checkpoint is saved (resume won't re-download).
- Actions: [Resume Sync] (from checkpoint), [Reduce Scope] (navigates to Scope tab), [Keep Partial] (accepts current state).

**E4 — Token Expired (Refresh Failed)**

- Displayed on the Overview tab with a warning severity banner.
- Shows expiry date (absolute), days remaining, and consequence description (delta syncs stop, content goes stale).
- Shows auto-refresh failure details: last attempt timestamp, error code.
- Displays "To fix" guidance text identifying who needs to act: "To fix: Someone with admin access needs to re-authenticate."
- Actions: [Re-authenticate Now] (re-triggers OAuth).
- Note: Delegation flow is out of scope for phase 1. The design shows [Send Delegation Invite] but only [Re-authenticate Now] is implemented.

**E5 — Permission Revoked**

- Displayed on the Overview tab with critical severity banner.
- Names the exact permission that was removed (e.g., "Sites.Read.All").
- Shows bulleted impact list (discovery blocked, sync blocked, indexed doc count going stale).
- States sync schedule was auto-paused.
- Actions: [Share Issue with IT Admin] (generates shareable summary), [Re-authenticate], [Delete Connector].

**E6 — Graph API Throttled (429)**

- Displayed on the Overview tab with a throttle severity banner.
- Informational/passive — no user action required. Sync resumes automatically.
- Shows: retry-after seconds, requests made in window, throttle scope (per-app), sync progress (N of M docs, percentage), and a live countdown timer with progress bar.
- Shows resume detail: "will resume at doc #N" (using `resumeFromDoc` field) so the user knows exactly where sync picks up.
- Reassurance message: "This is normal for large syncs."

**E7 — Partial Site Failure**

- Displayed on the Overview tab with partial-success severity banner.
- Per-site status list: site name, OK/FAIL badge, doc count (synced/total).
- Failed sites show the error reason (e.g., "403 Forbidden") and per-site actions: [Request Access], [Remove from Scope].
- **Per-site action API mapping:**
  - [Request Access] — generates a shareable access request (client-side, similar to E5's [Share Issue with IT Admin]). No dedicated API endpoint; uses client-side email/clipboard generation.
  - [Remove from Scope] — calls the existing connector scope update API (`PATCH /api/projects/:projectId/connectors/:connectorId/scope`) to remove the failed site from the connector's site list. Cross-reference: C-05 (Scope Management) defines the scope update API.
- Summary line: total docs synced of total across all sites.
- Global actions: [Retry Failed Sites], [Accept Partial], [Re-run Full Sync].

**E8 — Zero Sites Found**

- Displayed on the Scope tab when discovery returns 0 sites.
- Shows 3 numbered possible reasons with inline fix guidance.
- Shows current permission scope (e.g., "Sites.Selected").
- Suggests scope upgrade if on a limited scope.
- Actions: [Retry Discovery], [Upgrade Scope] (re-triggers consent with broader scope), [Enter Site URL Manually] (shows inline URL input). The manual URL entry reuses the `POST .../check-site-access` endpoint defined under EM3.

**E9 — Sign-In Popup Blocked**

- Displayed inline on the Connect tab when the OAuth popup fails to open.
- Lists reasons (Conditional Access policies, pop-up blockers).
- Suggests device code flow as alternative.
- Actions: [Switch to Device Code] (changes auth method), [Try Again] (re-attempts popup), [Contact IT Admin].

**E10 — All Files Unsupported**

- Displayed on the Preview tab when all discovered files are non-indexable.
- Shows total file count and a summary of discovered format types.
- Lists supported file types with a [View all N types] expandable link.
- Contextual insight: "This site appears to contain media assets rather than documents."
- Actions: [Select Different Sites] (navigates to Scope tab), [Upload Files Instead] (navigates to upload flow), [Cancel Setup].

### Empty States

**EM1 — No Connectors**

- Redirects conceptually to the Connect tab first-time experience (Section 4a).
- The panel opens with the Connect tab active showing auth method options.
- Conversational tone, time estimate: "~3 minutes for your first connector."

**EM2 — No Documents (sync completed, 0 indexed)**

- Displayed on the Overview tab with connected status but 0 docs.
- Shows filter analysis: for each active filter rule, shows how many files it excluded and why.
- Actions: [Adjust Filters] (navigates to Filters tab), [Select Different Sites] (navigates to Scope tab), [View All Discovered Files] (shows unfiltered file list in Preview tab).

**EM3 — No Sites Accessible (Sites.Selected, 0 approved)**

- Displayed on the Scope tab after auth succeeds but 0 sites are accessible.
- Explains Sites.Selected permission model.
- Three options:
  1. Inline URL input field with [Check Access] button to test a specific site.
  2. [Send Request to Admin] — generates email/message with PowerShell commands for the admin.
  3. [Upgrade to Sites.Read.All] — re-triggers consent flow with broader scope. Notes "requires admin re-consent."

## Required Data Fields

### Error State Data

| Field                        | Type                    | Used In    | Description                                                                                                                                                  |
| ---------------------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `errorCode`                  | `string`                | E1, E4, E7 | Raw error code (AADSTS..., invalid_grant, HTTP status)                                                                                                       |
| `errorMessage`               | `string`                | E1, E3     | Human-readable error description. For E3, includes the technical error code and description (e.g., "ENOSPC — Storage quota exceeded on upload destination.") |
| `appRegistrationName`        | `string`                | E1         | Azure app registration display name — interpolated into fix steps                                                                                            |
| `secretCreatedDate`          | `string (ISO date)`     | E1         | When the client secret was created — interpolated into fix steps                                                                                             |
| `sitesDiscovered`            | `number`                | E2         | Total sites found before timeout                                                                                                                             |
| `sitesProfiled`              | `number`                | E2         | Sites fully profiled before timeout                                                                                                                          |
| `drivesFound`                | `number`                | E2         | Total drives enumerated                                                                                                                                      |
| `estimatedFullDiscoveryTime` | `string`                | E2         | Estimated time for full re-run (e.g., "~5 min")                                                                                                              |
| `docsProcessed`              | `number`                | E3, E6, E7 | Documents successfully synced                                                                                                                                |
| `docsTotal`                  | `number`                | E3, E6, E7 | Total documents in scope                                                                                                                                     |
| `checkpointSaved`            | `boolean`               | E3         | Whether resume checkpoint exists                                                                                                                             |
| `resumeFromDoc`              | `number`                | E3, E6     | Document number to resume from                                                                                                                               |
| `tokenExpiryDate`            | `string (ISO date)`     | E4         | When token expires                                                                                                                                           |
| `daysUntilExpiry`            | `number`                | E4         | Days remaining until expiry                                                                                                                                  |
| `lastRefreshAttempt`         | `string (ISO datetime)` | E4         | Timestamp of last auto-refresh attempt                                                                                                                       |
| `refreshErrorCode`           | `string`                | E4         | Error from refresh attempt                                                                                                                                   |
| `revokedPermission`          | `string`                | E5         | Exact permission scope removed                                                                                                                               |
| `impactList`                 | `string[]`              | E5         | List of capabilities affected                                                                                                                                |
| `indexedDocCount`            | `number`                | E5         | Docs currently indexed (going stale)                                                                                                                         |
| `syncAutoPaused`             | `boolean`               | E5         | Whether sync was auto-paused                                                                                                                                 |
| `retryAfterSeconds`          | `number`                | E6         | Seconds until retry (from 429 header)                                                                                                                        |
| `requestsMade`               | `number`                | E6         | Requests in the throttled window                                                                                                                             |
| `throttleScope`              | `string`                | E6         | Scope of throttle (per-app, per-user, etc.)                                                                                                                  |
| `syncProgressPercent`        | `number`                | E6         | Sync completion percentage                                                                                                                                   |
| `siteStatuses`               | `Array<SiteStatus>`     | E7         | Per-site sync results (see below)                                                                                                                            |
| `currentPermissionScope`     | `string`                | E8, EM3    | Current Graph permission scope                                                                                                                               |
| `possibleReasons`            | `Array<{reason, fix}>`  | E8         | Possible reasons for zero sites                                                                                                                              |
| `totalDiscoveredFiles`       | `number`                | E10        | Files found in non-indexable formats                                                                                                                         |
| `discoveredFileTypes`        | `string[]`              | E10        | List of format types found (PNG, MP4, etc.)                                                                                                                  |
| `supportedFileTypes`         | `string[]`              | E10        | All file types the platform can index                                                                                                                        |
| `popupBlockReason`           | `string`                | E9         | Why the popup was blocked                                                                                                                                    |

**SiteStatus object:**

| Field         | Type               | Description                   |
| ------------- | ------------------ | ----------------------------- |
| `siteName`    | `string`           | Display name of the site      |
| `status`      | `'ok' \| 'failed'` | Sync result for this site     |
| `docsSynced`  | `number`           | Documents successfully synced |
| `docsTotal`   | `number`           | Total documents for this site |
| `errorReason` | `string \| null`   | Error description if failed   |

### Empty State Data

| Field               | Type                     | Used In | Description                                                 |
| ------------------- | ------------------------ | ------- | ----------------------------------------------------------- |
| `connectorCount`    | `number`                 | EM1     | Number of existing connectors (0 triggers empty state)      |
| `filterExclusions`  | `Array<FilterExclusion>` | EM2     | Per-filter breakdown of excluded files                      |
| `approvedSiteCount` | `number`                 | EM3     | Sites approved under Sites.Selected (0 triggers this state) |

**FilterExclusion object:**

| Field           | Type     | Description                                                       |
| --------------- | -------- | ----------------------------------------------------------------- |
| `filterType`    | `string` | Type of filter (file type, folder rule, etc.)                     |
| `excludedCount` | `number` | Number of files excluded by this filter                           |
| `detail`        | `string` | Human-readable explanation (e.g., "only .png, .mp4 on this site") |

## API Requirements

### Error State APIs

**GET `/api/projects/:projectId/connectors/:connectorId/status`**
Returns the current connector status including any active error. The response must include:

- Error type discriminator (auth_failed, discovery_timeout, sync_failed, token_expired, permission_revoked, throttled, partial_failure, zero_sites, popup_blocked, all_unsupported)
- All fields from the corresponding error data table above, nested under the error object
- Connector name, current status badge value

**GET `/api/projects/:projectId/connectors/:connectorId/sync-progress`**
Returns live sync progress for the throttle countdown (E6) and sync failure (E3) states:

- `docsProcessed`, `docsTotal`, `syncProgressPercent`, `checkpointSaved`, `resumeFromDoc`
- For throttle: `retryAfterSeconds`, `requestsMade`, `throttleScope`
- UI polls this endpoint (or receives SSE/WebSocket updates) for the live countdown timer

**GET `/api/projects/:projectId/connectors/:connectorId/site-statuses`**
Returns per-site sync status for partial failure (E7):

- Array of SiteStatus objects with per-site doc counts and error reasons

**POST `/api/projects/:projectId/connectors/:connectorId/retry`**
Triggers retry for various error recovery actions:

- Body: `{ action: 'retry_auth' | 'retry_discovery' | 'resume_sync' | 'retry_failed_sites' | 'rerun_full_sync' | 'rerun_full_discovery' }`

**POST `/api/projects/:projectId/connectors/:connectorId/auth`**
Re-triggers authentication flow (used by E4 Re-authenticate, E5 Re-authenticate, E8 Upgrade Scope):

- Body: `{ method: 'oauth_popup' | 'device_code', scope?: 'Sites.Read.All' | 'Sites.Selected' }`

**POST `/api/projects/:projectId/connectors/:connectorId/check-site-access`**
Used by EM3 inline URL input and E8 [Enter Site URL Manually]:

- Body: `{ siteUrl: string }`
- Returns: `{ accessible: boolean, siteName?: string, error?: string }`

### Empty State APIs

**GET `/api/projects/:projectId/connectors/:connectorId/filter-analysis`**
Returns filter exclusion breakdown for EM2 (No Documents):

- Array of FilterExclusion objects
- Total discovered files count

**GET `/api/projects/:projectId/connectors/:connectorId/discovery-summary`**
Returns discovery results for EM3 (No Sites Accessible):

- `approvedSiteCount`, `currentPermissionScope`

### External Links (generated client-side)

- **Azure Portal link** (E1): `https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/{appId}`
- **Admin email template** (EM3): Client-side generated mailto: or clipboard copy with PowerShell commands

## Assumptions

1. The backend classifies errors into the 10 discriminated types listed above; the UI renders the appropriate template based on the error type discriminator.
2. The connector status endpoint returns all error-related fields in a single response — the UI does not need to call multiple endpoints to assemble an error view (except for live progress polling).
3. Token expiry monitoring happens server-side; the UI receives the warning state via the normal status endpoint before the token actually expires.
4. The "auto-paused" behavior (E5, E6) is a backend concern; the UI only reflects the paused state it receives.
5. The 429 retry-after countdown timer is driven by polling or SSE — the UI needs a real-time update mechanism for the countdown, not just static data.
6. The supported file types list (E10) can be hardcoded or fetched from a static config endpoint; it does not change per-connector.
7. Filter exclusion analysis (EM2) is computed server-side during or after sync; the UI does not compute filter logic.
8. The `appId` needed for the Azure Portal deep link (E1) is available from the connector's auth configuration, which was collected during initial setup on the Connect tab.

## Open Questions

1. **Countdown timer delivery mechanism (E6):** Should the throttle countdown use polling (GET sync-progress every N seconds), SSE, or WebSocket? Polling is simplest but creates load; SSE is more efficient for this use case.
2. **"Share Issue with IT Admin" format (E5):** Does this generate an email (mailto:), copy to clipboard, or open a dialog to compose a message? What information is included?
3. **"Send Request to Admin" format (EM3):** Same question — what is the delivery mechanism and content template for the PowerShell commands?
4. **Error persistence:** Are errors cleared automatically when the underlying issue is resolved (e.g., token refreshed successfully), or does the user need to explicitly dismiss/retry?
5. **Multiple simultaneous errors:** Can a connector have more than one active error? If so, how are they prioritized/stacked in the UI?

## Edge Cases

1. **Error during error recovery:** User clicks [Resume Sync] but a new error occurs (e.g., permission revoked while resuming). The UI must handle error state transitions without stale data.
2. **Rapid error state changes:** Throttle (E6) resolves into partial failure (E7) — the UI must transition cleanly between error types.
3. **Discovery timeout with 0 profiled sites:** E2 assumes some sites were profiled. If `sitesProfiled` is 0, the "Continue with 0" option is meaningless — UI should hide it or show a different message.
4. **Token expiry in the past:** If the UI loads and the token is already expired (not just expiring), the warning copy ("expires in 3 days") is wrong. UI needs to handle both "expiring soon" and "already expired" states.
5. **Filter analysis with no filters applied (EM2):** If sync returns 0 docs but no filters are active, the exclusion analysis is empty. The UI needs a fallback explanation (e.g., "sites contained no indexable files").
6. **Multiple failed sites (E7):** The per-site list could be long. If a connector has 50+ sites, the UI needs scrolling or truncation with "Show all N sites."
7. **Popup blocked detection (E9):** Browser popup blocking is detected heuristically. False positives are possible — the error should offer alternatives regardless of the actual cause.
8. **Stale error display:** User leaves the panel open for hours. The error state may have resolved server-side. The UI should refresh status on panel focus or at intervals.

## Out of Scope

- Backend error detection, classification, or recovery logic
- Database schema for error storage
- Actual Graph API throttling strategy or retry algorithms
- [Send Delegation Invite] functionality (E4) — delegation flow is out of scope; only [Re-authenticate Now] is implemented in phase 1
- Admin consent flow implementation details
- Email/notification delivery infrastructure for "Share Issue with IT Admin" and "Send Request to Admin"
- Sync checkpoint storage mechanism
- Auto-pause scheduling logic

## Resolution Log

**Resolved from verification-batch-4 findings (2026-03-24):**

| #   | Finding                                                                                             | Severity | Resolution                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | E3 UI behavior does not mention displaying the specific error code/message (ENOSPC)                 | MEDIUM   | **Fixed.** Added explicit mention of technical error code display to E3 UI behavior. Updated `errorMessage` field description in data table to clarify it includes both the error code and human-readable description.          |
| 2   | E4 UI behavior missing "To fix: Someone with admin access needs to re-authenticate" guidance text   | MEDIUM   | **Fixed.** Added "To fix" guidance text to E4 UI behavior. Updated E4 note to clarify delegation is out of scope and only [Re-authenticate Now] is implemented.                                                                 |
| 3   | E1 UI behavior should clarify app registration name and secret date are interpolated into fix steps | LOW      | **Fixed.** Added clarification that fix steps interpolate `appRegistrationName` and `secretCreatedDate` with examples from the wireframe. Updated data table descriptions to note these fields are interpolated into fix steps. |
| 4   | E6 UI behavior does not mention "will resume at doc #N" detail despite having the data field        | LOW      | **Fixed.** Added "will resume at doc #N" detail to E6 UI behavior, referencing the `resumeFromDoc` field.                                                                                                                       |
| 5   | E7 per-site actions (Request Access, Remove from Scope) have no corresponding API endpoints         | MEDIUM   | **Fixed.** Added per-site action API mapping under E7: [Request Access] uses client-side generation (like E5), [Remove from Scope] uses existing scope update API with cross-reference to C-05.                                 |
| 6   | E8 manual URL entry should cross-reference the check-site-access endpoint defined under EM3         | LOW      | **Fixed.** Added explicit cross-reference noting E8's [Enter Site URL Manually] reuses the `POST .../check-site-access` endpoint from EM3. Updated the API description to note both EM3 and E8 usage.                           |
| 7   | OQ #6 (appId availability) partially answered by auth flow design                                   | LOW      | **Fixed.** Removed OQ #6 and converted to Assumption #8: "The appId is available from the connector's auth configuration collected during initial setup."                                                                       |
