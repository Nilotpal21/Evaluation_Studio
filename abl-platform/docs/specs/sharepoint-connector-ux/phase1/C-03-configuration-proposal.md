# C-03: Configuration Proposal -- Capability Note

**Status:** Reviewed
**Design Sections:** S4b, Simplified View

## User Intent

The user wants to review, customize, and approve a system-generated configuration before any data is synced. The Configuration Proposal turns connector setup into a guided review process: the system does the research (discovery, health checks, recommendations) and presents findings as a reviewable document. The user walks through each section, accepting defaults or modifying specifics, with full transparency into what will happen when sync starts.

## UI Behaviors

### Proposal Generation (Animated Checklist)

1. After authentication completes, a generation progress screen appears with 9 checklist items: Connection, Scopes, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate.
2. Each item shows a status string that updates in real-time: "Done", "Detecting granted scopes...", "Running checks...", "Discovering sites...", "Waiting for scope", "Analyzing patterns + webhook availability...", "Configuring permissions...", "Waiting for filters", "Waiting for all sections".
3. Items have dependencies (Filters waits for Scope, Sample Preview waits for Filters, Security Gate waits for all). The UI must reflect this dependency order.
4. Sections appear incrementally as they become ready. Estimated total: 30-90 seconds.
5. Pre-configured settings from draft mode are applied automatically during generation.

### Step Progress Indicator (Simplified View Only)

When Simplified View is ON, a 4-step progress bar appears above the proposal:
`1. Connect --> [2. Review Proposal] --> 3. Preview --> 4. Approve`

The current step is highlighted. Steps are not clickable navigation -- they are a read-only indicator.

### Table of Contents

1. Lists all 8 sections (Connection, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate).
2. Each section has a status badge: `[Accepted]`, `[Modified]`, `[Pending]`, `[Skipped]`, `[Reviewed]`, `[Pending Approval]`, `[Needs Your Input]`, `[6/7 passed]`, or a custom status like `[Public Access -- Opted In by user@co on date]`.
3. Badges update in real-time as the user interacts with sections.
4. A progress line shows: "Progress: N of 8 sections reviewed".
5. Clicking a TOC entry scrolls to that section.

### Per-Section Action Buttons

Each section has its own set of action buttons that differ from the generic Accept/Modify/Skip pattern. The section-specific buttons are:

| Section           | Buttons                                                                            | Notes                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connection        | `[Accept]`, `[Re-authenticate]`, `[Skip]`                                          | `[Re-authenticate]` replaces generic `[Modify]` (design line 1075)                                     |
| Health Check      | `[Accept with warnings]`, `[Re-run]`, `[Skip]`                                     | `[Accept with warnings]` replaces `[Accept]`; `[Re-run]` replaces `[Modify]` (design lines 1108, 1139) |
| Scope (Variant A) | `[Accept]`, `[Modify]`, `[Skip]`                                                   | Generic pattern applies                                                                                |
| Scope (Variant B) | `[Accept]`, `[Add More Sites]`, `[Skip]`                                           | `[Add More Sites]` replaces `[Modify]` (design line 1268)                                              |
| Filters           | `[Accept]`, `[Modify]`, `[Skip]`                                                   | Generic pattern applies                                                                                |
| Schedule          | `[Accept]`, `[Modify]`, `[Skip]`                                                   | Generic pattern applies                                                                                |
| Permissions       | `[Accept]`, `[Change Mode]`, `[Skip]`                                              | `[Change Mode]` replaces `[Modify]` (design line 1512)                                                 |
| Sample Preview    | `[Looks Good]`, `[Adjust Filters]`, `[Refresh Sample]`, `[Abandon -- Do Not Sync]` | Completely different button set (design lines 1535-1536)                                               |
| Security Gate     | `[Export PDF for Review]`, `[Request Security Review]`                             | Section-specific export + review request (design line 1569)                                            |

**Common behavior for all sections:**

- **Accept / Looks Good**: Section collapses to a one-line summary. Badge becomes `[Accepted]`.
- **Modify / Re-authenticate / Re-run / Add More Sites / Change Mode / Adjust Filters**: In Simplified View, an inline editor expands within the section. In Full View, the relevant tab is highlighted. After applying changes, badge becomes `[Accepted -- Modified]`. Section collapses back to summary. The button remains for further edits.
- **Skip**: Section collapses with `[Skipped]` badge. Consequences vary by section (see Edge Cases).
- **Abandon -- Do Not Sync**: Cancels the entire connector setup. The connector is deleted or moved to "Cancelled" status, the proposal is discarded, and the panel closes. Requires confirmation dialog before executing (see Edge Cases).
- After any action, the next unreviewed section auto-scrolls into view.

### Section-Specific UI Elements

#### Connection Section

- **Token health display variants** (design lines 1148-1151):
  - With refresh token: `"Connected (auto-renewing) / Refresh token valid until Apr 21"`
  - Without refresh token (client_credentials): `"Expires in 59 min -- no auto-refresh / Re-authenticate before expiry"`

#### Health Check Section

- **Scope detection row**: The Health Check includes a "Scopes detected" row showing exactly which capabilities are available based on granted scopes. Display varies by scope type (design lines 1082, 1093-1098):
  - Sites.Read.All: shows full capability list
  - Sites.Selected: shows reduced capabilities (e.g., `FAIL` on Sites.Read.All, `INFO` on limited scopes, 4/7 passed)

#### Scope Section (Variant B -- Sites.Selected)

- **"Send Access Request to Admin" button** (design line 1244): Generates a pre-written email listing the specific site URLs and the PowerShell command to grant Sites.Selected access.
- **"Or upgrade to discover sites automatically" box** (design lines 1250-1258): Prominent box with `[Upgrade to Sites.Read.All]` button -- requires admin re-consent.
- **"Download Admin Commands (PowerShell)"** (design line 1264): Dynamically generated script with the correct client ID and site URLs filled in (confirmed by design lines 1260-1264: "We can generate the exact commands").
- **Sites.Selected information box** (design lines 1282-1300): 6-point information box explaining Sites.Selected limitations (no auto-discovery, no site search, no recommendations, manual admin grants, no webhooks, no group resolution).

#### Permissions Section

- **"Need Help Getting GroupMember.Read.All?" subsection** (design lines 1418-1431) with two action buttons:
  - `[Download Permission Request Document]` -- Ready-to-send document for security team explaining what GroupMember.Read.All does and the risk assessment.
  - `[Send Request to Security Team]` -- Pre-written email with the permission request attached.
- **Permission Accuracy disclosure** (design lines 1490-1503): Shows accuracy breakdown (direct grants, group grants, sharing links, overall). When GroupMember.Read.All is NOT granted, shows:
  - `[Upgrade to Permission-Aware]` -- raises accuracy to ~95%+ (design line 1500)
  - `[Test Permissions]` -- verify by searching as a specific user to confirm expected results (design line 1502)
- **TRUST NOTE** (design lines 1506-1510): Display element at bottom of Permissions section: "We request Sites.Read.All and Files.Read.All -- both read-only. When permission-aware search is enabled, we also request GroupMember.Read.All to resolve group memberships. No write permissions are ever requested. None of these scopes can modify, delete, or create content in SharePoint."

#### Security Gate Section

- **Section-specific export**: `[Export PDF for Review]` button (design line 1569) alongside `[Request Security Review]`. This is distinct from the global Export buttons (PDF/JSON/YAML) -- it exports only the Security Gate section for external review.

### Accept All Remaining

- Visible at all times in the proposal chrome.
- Sets all unreviewed sections to "Accepted" with system recommendations.
- For Permissions, always sets to ENABLED (safe default) -- never triggers Public Access flow.

### Approve All & Start Sync

- Shows inline confirmation: document count, estimated size, site count, "Sync begins immediately".
- Two buttons: `[Confirm & Start Sync]` and `[Cancel]`.
- If Security Gate is pending, button reads "Submit for Security Approval" instead.

### Export Buttons

- Three export options: PDF, JSON, YAML.
- Exports the full proposal including all sections, their statuses, and the User Decisions Log.

### Simplified View vs Full View

- Simplified View is ON by default (persisted per-user via localStorage).
- Simplified View shows tabs: Connect, Proposal, Preview, Security. Hides Scope+Filters tab and History tab.
- In Simplified View, Modify opens inline editors within the Proposal (Scope, Filters, Schedule).
- Full View shows all tabs. Modify in the Proposal highlights the corresponding tab instead of inline editing.
- The Proposal and Scope+Filters tab (Full View) share the same underlying data -- edits in either surface sync to the other. Cross-reference: Scope+Filters card for the shared data model.

## Required Data Fields

### Generation Progress

| Field                 | Type                                                  | Description           |
| --------------------- | ----------------------------------------------------- | --------------------- | ------ | --------------------------------- | ---------------------------------- |
| `generationSteps`     | `Array<{ id: string, label: string, status: 'pending' | 'in_progress'         | 'done' | 'waiting', statusText: string }>` | 9 checklist items with live status |
| `generationStartedAt` | `string (ISO 8601)`                                   | When generation began |

### Proposal Metadata

| Field           | Type                | Description                 |
| --------------- | ------------------- | --------------------------- |
| `proposalId`    | `string`            | Unique proposal identifier  |
| `generatedAt`   | `string (ISO 8601)` | When proposal was generated |
| `connectorName` | `string`            | e.g., "sp-corp-main"        |

### Section: Connection

| Field                   | Type                | Description                                               |
| ----------------------- | ------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`                | `string`            | e.g., "contoso.onmicrosoft.com"                           |
| `clientId`              | `string`            | Azure App client ID                                       |
| `authMethod`            | `string`            | "Device Code Flow", "Browser Login", "Client Credentials" |
| `authenticatedUser`     | `string`            | e.g., "maria@contoso.com"                                 |
| `tokenExpiresAt`        | `string (ISO 8601)` | Access token expiry                                       |
| `tokenRemainingMinutes` | `number`            | Minutes until expiry                                      |
| `refreshTokenExpiresAt` | `string (ISO 8601)  | null`                                                     | Refresh token expiry, null if none                                                                                                                                                                        |
| `tokenDisplayVariant`   | `'auto_renewing'    | 'expiring'`                                               | Determines display text: auto_renewing shows "Connected (auto-renewing) / Refresh token valid until {date}"; expiring shows "Expires in {minutes} min -- no auto-refresh / Re-authenticate before expiry" |
| `delegatedBy`           | `string             | null`                                                     | Delegating user if via invitation                                                                                                                                                                         |

### Section: Health Check

| Field          | Type                       | Description                       |
| -------------- | -------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `checks`       | `Array<HealthCheckResult>` | Up to 7 validation checks         |
| `passedCount`  | `number`                   | Number of checks with "ok" status |
| `totalCount`   | `number`                   | Total number of checks            |
| `scopeVariant` | `'sites_read_all'          | 'sites_selected'`                 | Determines which Health Check display variant to render (full vs reduced capabilities) |

**`HealthCheckResult` shape:**

| Field       | Type                                 | Description                 |
| ----------- | ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- | ------------ |
| `status`    | `'ok'                                | 'WARN'                      | 'FAIL'                                                                                                                   | 'INFO'` | Check result |
| `label`     | `string`                             | e.g., "Graph API reachable" |
| `detail`    | `string`                             | e.g., "14ms response"       |
| `subDetail` | `string                              | null`                       | Secondary detail line                                                                                                    |
| `action`    | `{ label: string, actionId: string } | null`                       | Optional action button (e.g., "Request GroupMember.Read.All", "Upgrade to Sites.Read.All", "Continue with manual sites") |

### Section: Scope (Variant A -- Sites.Read.All)

| Field                  | Type                                                                                  | Description                      |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------- | ----------------------- |
| `scopeVariant`         | `'auto_discovery'                                                                     | 'manual_entry'`                  | Which variant to render |
| `totalSitesDiscovered` | `number`                                                                              | Total sites found                |
| `totalLibraries`       | `number`                                                                              | Total document libraries         |
| `recommendedSites`     | `Array<SiteRecommendation>`                                                           | Sites recommended for sync       |
| `excludedSites`        | `Array<SiteExclusion>`                                                                | Sites excluded with reasons      |
| `noLibrarySites`       | `Array<{ name: string, reason: string }>`                                             | Sites with no document libraries |
| `summary`              | `{ siteCount: number, libraryCount: number, docCount: number, sizeEstimate: string }` | Aggregate summary                |

**`SiteRecommendation` shape:**

| Field          | Type      | Description                        |
| -------------- | --------- | ---------------------------------- | ------ | -------------- |
| `siteId`       | `string`  | Site identifier                    |
| `name`         | `string`  | Site display name                  |
| `libraryCount` | `number`  | Number of document libraries       |
| `docCount`     | `number`  | Estimated document count           |
| `sizeEstimate` | `string`  | e.g., "2.1GB"                      |
| `score`        | `number`  | Activity/relevance score           |
| `activity`     | `'High'   | 'Medium'                           | 'Low'` | Activity level |
| `lastModified` | `string`  | Relative time, e.g., "2h ago"      |
| `selected`     | `boolean` | Whether included in recommendation |

**`SiteExclusion` shape:**

| Field          | Type      | Description                            |
| -------------- | --------- | -------------------------------------- |
| `siteId`       | `string`  | Site identifier                        |
| `name`         | `string`  | Site display name                      |
| `libraryCount` | `number`  | Number of document libraries           |
| `docCount`     | `number`  | Estimated document count               |
| `sizeEstimate` | `string`  | e.g., "8.5GB"                          |
| `reason`       | `string`  | Human-readable exclusion reason        |
| `selected`     | `boolean` | false by default (user can re-include) |

### Section: Scope (Variant B -- Sites.Selected)

| Field               | Type                                                            | Description                                           |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `scopeVariant`      | `'manual_entry'`                                                | Variant flag                                          |
| `validationResults` | `Array<SiteValidation>`                                         | Results after URL validation                          |
| `accessibleCount`   | `number`                                                        | Sites that passed validation                          |
| `failedCount`       | `number`                                                        | Sites that need admin approval                        |
| `adminEmailData`    | `{ subject: string, body: string, powershellCommands: string }` | Pre-generated data for "Send Access Request to Admin" |
| `upgradeAvailable`  | `boolean`                                                       | Whether "Upgrade to Sites.Read.All" is offered        |

**`SiteValidation` shape:**

| Field          | Type     | Description      |
| -------------- | -------- | ---------------- | --------------------------------- |
| `url`          | `string` | User-entered URL |
| `status`       | `'OK'    | 'FAIL'`          | Validation result                 |
| `name`         | `string  | null`            | Resolved site name (null if FAIL) |
| `libraryCount` | `number  | null`            | Libraries found                   |
| `docCount`     | `number  | null`            | Estimated documents               |
| `sizeEstimate` | `string  | null`            | Estimated size                    |
| `failReason`   | `string  | null`            | Why validation failed             |

### Section: Filters

| Field              | Type                                            | Description                               |
| ------------------ | ----------------------------------------------- | ----------------------------------------- | -------------------------- | --------------------------- | ------- | ------------------------------------------- |
| `totalDocs`        | `number`                                        | Total before filtering                    |
| `matchedDocs`      | `number`                                        | After filtering                           |
| `exclusions`       | `Array<{ count: number, description: string }>` | Exclusion breakdown                       |
| `dateRange`        | `{ modifiedAfter: string                        | null, modifiedBefore: string              | null, createdAfter: string | null, createdBefore: string | null }` | Applied date filters (design lines 654-657) |
| `appliedTemplates` | `Array<{ name: string, description: string }>`  | e.g., "Office Documents", "Skip Archives" |

**Inline editor (Simplified View) additional fields:**

| Field                      | Type                                                                        | Description                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `availableTemplates`       | `Array<{ id: string, name: string, selected: boolean }>`                    | All filter templates                                                                                                                                                                                                                                             |
| `supportedFileTypes`       | `Array<{ extension: string, count: number }>`                               | File types with doc counts                                                                                                                                                                                                                                       |
| `filterMode`               | `'allowlist'                                                                | 'blocklist'`                                                                                                                                                                                                                                                     | Current filter mode                                                                                 |
| `blockedExtensions`        | `Array<string>`                                                             | Always-blocked extensions (executables, etc.)                                                                                                                                                                                                                    |
| `contentCategories`        | `Array<{ id: string, label: string, selected: boolean }>`                   | e.g., "Files", "SharePoint Pages"                                                                                                                                                                                                                                |
| `sizeLimit`                | `{ min: number, minUnit: string, max: number, maxUnit: string }`            | Size bounds                                                                                                                                                                                                                                                      |
| `folderRules`              | `{ include: string[], exclude: string[] }`                                  | Glob patterns                                                                                                                                                                                                                                                    |
| `peopleFilters`            | `{ createdBy: string                                                        | null, modifiedBy: string                                                                                                                                                                                                                                         | null }`                                                                                             | Built-in people filters (design lines 668-671). Distinct from custom metadata conditions. |
| `metadataConditions`       | `Array<{ field: string, operator: string, value: string, conjunction: 'AND' | 'OR' }>`                                                                                                                                                                                                                                                         | Metadata filters with AND/OR grouping                                                               |
| `conditionBuilder`         | `{ operators: string[], maxNestingLevel: number }`                          | Condition builder config. Operators (15): equals, not equals, contains, starts with, ends with, greater than, less than, in list, not in list, exists, not exists, regex match + 3 contextual. AND/OR grouping with one level of nesting (design lines 677-682). |
| `celExpression`            | `{ value: string                                                            | null, autocompleteFields: string[] }`                                                                                                                                                                                                                            | CEL expression field with autocomplete. Overrides above conditions when set (design lines 684-686). |
| `discoveredMetadataFields` | `Array<string>`                                                             | Available fields from discovery                                                                                                                                                                                                                                  |
| `impactPreview`            | `{ before: number, after: number, excluded: number }`                       | Live impact counts                                                                                                                                                                                                                                               |

### Section: Schedule

| Field             | Type                                                   | Description                |
| ----------------- | ------------------------------------------------------ | -------------------------- | ----------------------------------- |
| `contentVolume`   | `string`                                               | e.g., "~4K docs"           |
| `updateFrequency` | `string`                                               | e.g., "avg 45 changes/day" |
| `initialSync`     | `{ estimatedDuration: string, estimatedSize: string }` | Full sync estimate         |
| `syncMode`        | `'realtime_plus_scheduled'                             | 'scheduled_only'`          | Selected mode                       |
| `deltaFrequency`  | `string`                                               | e.g., "every 12 hours"     |
| `webhookStatus`   | `'ready'                                               | 'not_available'`           | Whether webhooks are possible       |
| `webhookEndpoint` | `string`                                               | Callback URL               |
| `webhookNote`     | `string                                                | null`                      | Overlap/duplicate subscription note |

**Inline editor (Simplified View) additional fields:**

| Field               | Type            | Description                                                                                                                                                                                                                       |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frequencyOptions`  | `Array<string>` | "Every hour", "4 hours", "6 hours", "12 hours", "Daily"                                                                                                                                                                           |
| `webhookToggleable` | `boolean`       | Whether user can enable/disable webhooks. When scopes support it, webhooks show as "Automatically enabled -- your scopes support it" (design line 707) rather than a user toggle. Delta sync runs as fallback when webhooks miss. |

### Section: Permissions

| Field                      | Type                                                                                   | Description                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----- | -------------------- |
| `permissionAwareEnabled`   | `boolean`                                                                              | true by default                                                                                                                                                         |
| `grantedScopes`            | `Array<{ scope: string, description: string, granted: boolean }>`                      | Scope status display                                                                                                                                                    |
| `groupMemberGranted`       | `boolean`                                                                              | Whether GroupMember.Read.All is granted                                                                                                                                 |
| `accuracyEstimate`         | `{ directGrants: string, groupGrants: string, sharingLinks: string, overall: string }` | e.g., "~100%", "~70-85%"                                                                                                                                                |
| `publicAccessOptIn`        | `{ optedIn: boolean, optedInBy: string                                                 | null, optedInAt: string                                                                                                                                                 | null }                                    | null` | Public access status |
| `sensitiveContentDetected` | `{ total: number, breakdown: Array<{ label: string, count: number }> }                 | null`                                                                                                                                                                   | Sensitivity labels found during discovery |
| `trustNote`                | `string`                                                                               | TRUST NOTE text: "We request Sites.Read.All and Files.Read.All -- both read-only..." (design lines 1506-1510). Static display element at bottom of Permissions section. |

### Section: Sample Preview

| Field              | Type                    | Description                   |
| ------------------ | ----------------------- | ----------------------------- |
| `documents`        | `Array<SampleDocument>` | Up to 20 sample documents     |
| `totalMatchedDocs` | `number`                | Total matching current config |

**`SampleDocument` shape:**

| Field              | Type     | Description         |
| ------------------ | -------- | ------------------- | -------------------------------- |
| `name`             | `string` | File name           |
| `site`             | `string` | Source site name    |
| `type`             | `string` | File extension      |
| `size`             | `string` | Human-readable size |
| `sensitivityLabel` | `string  | null`               | e.g., "Confidential", "Internal" |

### Section: Security Gate

| Field                         | Type            | Description                             |
| ----------------------------- | --------------- | --------------------------------------- | ------------------ | ----------- | ----------- |
| `approvalStatus`              | `'approved'     | 'pending'                               | 'self_approved'    | 'rejected'` | Gate status |
| `reviewedAt`                  | `string         | null`                                   | Approval timestamp |
| `approvers`                   | `Array<string>` | Approver emails                         |
| `elevatedScopes`              | `boolean`       | Whether elevated scopes were requested  |
| `knownLimitations`            | `Array<string>` | List of known limitation strings        |
| `orgRequiresSecurityApproval` | `boolean`       | Whether org policy blocks self-approval |

### User Decisions Log

| Field       | Type                   | Description                  |
| ----------- | ---------------------- | ---------------------------- |
| `decisions` | `Array<DecisionEntry>` | Ordered list of user actions |

**`DecisionEntry` shape:**

| Field       | Type                | Description                |
| ----------- | ------------------- | -------------------------- | --------- | ---------- | --------------------------- | ------------ | ------------- |
| `timestamp` | `string (ISO 8601)` | When the decision was made |
| `user`      | `string`            | Who made the decision      |
| `section`   | `string`            | Which section              |
| `decision`  | `'Accepted'         | 'Modified'                 | 'Skipped' | 'Reviewed' | 'Public Access -- Opted In' | 'Abandoned'` | Decision type |
| `detail`    | `string`            | Human-readable detail      |

## API Requirements

### 1. Get Proposal Generation Status (polling during generation)

```
GET /api/projects/:projectId/connectors/:connectorId/proposal/status
```

**Response:** Generation checklist with per-step status. UI polls this until all steps are "done". Returns `generationSteps` array and overall `status: 'generating' | 'ready' | 'failed'`.

### 2. Get Full Proposal

```
GET /api/projects/:projectId/connectors/:connectorId/proposal
```

**Response:** Complete proposal with all sections, their current review statuses, TOC badges, and the User Decisions Log. Includes `proposalId`, `generatedAt`, `connectorName`, and all section data.

**Query param:** `?simplified=true` -- controls which fields are included in the response. When true, the API omits advanced fields (ACL modes, CEL expressions, OData queries, raw metadata conditions) to reduce payload size and simplify the client rendering path. When false, the full data set is returned. See Assumption #6 for details.

### 3. Accept Section

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/sections/:sectionId/accept
```

**Body:** `{}` (no modifications, accept as-is)
**Response:** Updated section status, updated TOC, updated decisions log entry.

### 4. Modify Section

```
PUT /api/projects/:projectId/connectors/:connectorId/proposal/sections/:sectionId
```

**Body:** Section-specific modification payload (e.g., selected site IDs for Scope, template selections for Filters, frequency for Schedule).
**Response:** Updated section with recalculated values (e.g., new doc count after scope change), updated badge to `[Accepted -- Modified]`, new decisions log entry.

### 5. Skip Section

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/sections/:sectionId/skip
```

**Response:** Updated section with `[Skipped]` badge. For Permissions, server enforces ENABLED as the skip default.

### 6. Accept All Remaining

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/accept-all
```

**Response:** All unreviewed sections set to Accepted with defaults. Permissions set to ENABLED. Returns full updated proposal state.

### 7. Approve and Start Sync

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/approve
```

**Response:** Confirmation with sync job ID, estimated duration, document count, size. If Security Gate requires external approval, returns `{ requiresApproval: true, approvalRequestId: string }`.

### 8. Validate Sites (Sites.Selected only)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/scope/validate-sites
```

**Body:** `{ urls: string[] }`
**Response:** Array of `SiteValidation` results.

### 9. Refresh Sample Preview

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/preview/refresh
```

**Response:** New set of 20 sample documents based on current scope and filter config.

### 10. Disable Permission-Aware Search (type-to-confirm)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/sections/permissions/disable
```

**Body:** `{ confirmationText: "public access" }`
**Response:** Server validates exact text match. If valid, updates permission mode to disabled. Records opt-in with actor, timestamp. Returns `publicAccessOptIn` object.

### 11. Export Proposal

```
GET /api/projects/:projectId/connectors/:connectorId/proposal/export?format=pdf|json|yaml
```

**Response:** Binary (PDF) or structured (JSON/YAML) export of the full proposal including all sections and the User Decisions Log.

### 12. Re-run Health Check

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/sections/health-check/rerun
```

**Response:** Fresh health check results (same shape as original).

### 13. Request Security Review

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/security-gate/request-review
```

**Response:** `{ requestId: string, sentTo: string[] }` -- triggers notification to security team.

### 14. Get Filter Impact Preview (for inline editor changes)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/filters/preview
```

**Body:** Proposed filter configuration.
**Response:** `{ before: number, after: number, excluded: number }` -- live impact counts without persisting.

### 15. Abandon Connector (Do Not Sync)

```
DELETE /api/projects/:projectId/connectors/:connectorId/proposal/abandon
```

**Purpose:** Triggered by the "Abandon -- Do Not Sync" button in the Sample Preview section (design line 1536). Cancels the connector setup entirely.
**Response:** `{ success: boolean, connectorStatus: 'cancelled' | 'deleted' }`. On success, the panel closes and SourcesTable refreshes. Draft configuration is discarded.
**Note:** This is distinct from "Delete Connector" in More Actions (C-01 API-3) because it operates on a connector that has a proposal in progress but has never synced.

### 16. Send Access Request to Admin (Sites.Selected)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/scope/send-admin-request
```

**Purpose:** Triggered by "Send Access Request to Admin" in Scope Variant B (design line 1244). Generates a pre-written email listing specific site URLs and PowerShell commands for granting Sites.Selected access.
**Response:** `{ subject: string, body: string, mailto: string, powershellCommands: string }`

### 17. Download Admin Commands (PowerShell)

```
GET /api/projects/:projectId/connectors/:connectorId/proposal/scope/admin-commands?format=ps1
```

**Purpose:** Triggered by "Download Admin Commands (PowerShell)" in Scope Variant B (design line 1264). Dynamically generated with the correct client ID and site URLs filled in (confirmed: design says "We can generate the exact commands").
**Response:** PowerShell script file (binary download).

### 18. Download Permission Request Document

```
GET /api/projects/:projectId/connectors/:connectorId/proposal/permissions/request-document
```

**Purpose:** Triggered by "Download Permission Request Document" in the Permissions section (design line 1423). Generates a document for the security team explaining what GroupMember.Read.All does and the risk assessment, customized with tenant-specific details.
**Response:** PDF or DOCX binary download.

### 19. Send Request to Security Team (Permissions)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/permissions/send-security-request
```

**Purpose:** Triggered by "Send Request to Security Team" in the Permissions section (design line 1427). Pre-written email with the permission request document attached.
**Response:** `{ subject: string, body: string, mailto: string, attachmentGenerated: boolean }`

### 20. Upgrade to Sites.Read.All (Scope Upgrade)

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/scope/upgrade
```

**Purpose:** Triggered by "Upgrade to Sites.Read.All" in Scope Variant B (design line 1257) or the Health Check scope detection action. Initiates re-consent flow with broader scope.
**Response:** `{ redirectUrl: string, state: string }` -- redirects to Microsoft consent page. After consent, the proposal Scope section regenerates with auto-discovery.

### 21. Upgrade to Permission-Aware

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/permissions/upgrade
```

**Purpose:** Triggered by "Upgrade to Permission-Aware" in the Permission Accuracy section (design line 1500). Initiates re-consent for GroupMember.Read.All scope.
**Response:** `{ redirectUrl: string, state: string }` -- redirects to Microsoft consent page.

### 22. Test Permissions

```
POST /api/projects/:projectId/connectors/:connectorId/proposal/permissions/test
```

**Purpose:** Triggered by "Test Permissions" in the Permission Accuracy section (design line 1502). Allows searching as a specific user to verify they see (or don't see) expected documents.
**Body:** `{ testAsUser: string }` -- email of the user to test as.
**Response:** `{ results: Array<{ docName: string, accessible: boolean }>, summary: string }`

### 23. Export Security Gate PDF

```
GET /api/projects/:projectId/connectors/:connectorId/proposal/security-gate/export?format=pdf
```

**Purpose:** Triggered by "Export PDF for Review" in the Security Gate section (design line 1569). Distinct from the global proposal export (API-11) -- this exports only the Security Gate section for external review.
**Response:** PDF binary download containing Security Gate findings, known limitations, and approval status.

## Assumptions

1. The proposal is generated once after authentication and persisted server-side. Re-generation happens only on explicit re-authentication or scope change.
2. Section review state (Accepted/Modified/Skipped/Pending) is persisted server-side, not just in UI state. Multiple users or sessions see the same proposal state.
3. The generation status endpoint supports polling (not SSE/WebSocket) -- the UI polls every 2-3 seconds during the 30-90 second generation window.
4. "Accept All Remaining" is a single API call, not N individual accept calls.
5. The User Decisions Log is append-only and maintained server-side. The UI reads it, never writes individual entries directly.
6. **Simplified View and API response:** The `?simplified=true` query param on API-2 controls which fields are returned. When `simplified=true`, the API omits advanced fields (ACL modes, CEL expressions, OData queries, raw metadata conditions) to reduce payload size. The client also applies display-level filtering (hiding advanced UI elements). Both the API and the client participate in simplification -- the API for payload efficiency, the client for display logic. The Simplified View toggle state is still persisted in localStorage (client-side).
7. Draft mode settings (pre-configured before auth) are passed to the proposal generation endpoint automatically.
8. The `connectorId` exists before the proposal is generated (created during the Connect step).

## Open Questions

1. **Polling vs streaming for generation progress:** The design says "sections appear as they are ready." Should the UI poll a status endpoint, or should the backend push updates via SSE/WebSocket? Polling is simpler but introduces latency; SSE gives real-time updates for the animated checklist.
2. **Concurrent editors:** If two users open the same connector's proposal, do modifications conflict? Is there optimistic locking on section edits?
3. **Proposal expiry:** Does a proposal expire if the token expires before approval? Does the user need to re-authenticate and re-generate?
4. **Security Gate org policy source:** Where does `orgRequiresSecurityApproval` come from? Is it a tenant-level setting, project-level, or KB-level?
5. **Permission request document format:** "Download Permission Request Document" for GroupMember.Read.All -- is this PDF or DOCX? Does it include tenant-specific details (tenant name, app registration ID, requested scopes)?
6. **Sample Preview selection:** Are the 20 documents a random sample, or weighted by diversity (different sites, types, sizes)?
7. **"Abandon -- Do Not Sync" consequences:** When the user clicks this button, is the connector deleted entirely, or moved to a "Cancelled" status where the draft config persists? Can the user resume from a cancelled state?

## Edge Cases

### Skip Consequences Table

| Section       | Skip Default                       | Consequence                                                                 |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Connection    | Cannot skip (button disabled)      | Tooltip: "Connection is required to proceed."                               |
| Health Check  | Accept with warnings               | Warnings logged to audit trail, do not block sync                           |
| Scope         | Accept system recommendation as-is | No changes to recommended site selection                                    |
| Filters       | Accept default filters             | All document types, no size limit, no folder exclusions                     |
| Schedule      | Accept recommended schedule        | Real-time + scheduled backup                                                |
| Permissions   | Keep ENABLED (safe default)        | Public Access requires explicit type-to-confirm; cannot be reached via Skip |
| Preview       | Warn then proceed                  | "Recommended to preview before syncing" warning shown                       |
| Security Gate | Only if org allows self-approval   | Blocked if org requires security team approval                              |

### Other Edge Cases

- **Token expires during proposal review:** The Connection section should show a degraded state with a `[Re-authenticate]` action. Other sections remain viewable but "Approve All & Start Sync" should be disabled until token is refreshed.
- **Rate limit exhausted during generation:** The Health Check step surfaces a WARN. Generation continues but may be slower. The UI should not time out -- it should keep polling even if generation takes longer than 90 seconds.
- **Zero sites discovered (Sites.Read.All):** Scope section shows "No SharePoint sites found" with troubleshooting guidance. The proposal cannot be approved without at least one site.
- **All sites excluded by recommendation:** Scope section shows all sites in the "Excluded" list with a prompt to re-include at least one.
- **Sensitive content detected + Public Access opt-in:** The disable flow shows an additional "Sensitive Content Detected" box with label breakdown (Confidential, Internal Only, Restricted counts).
- **Modify after Accept:** A section that was previously Accepted can be re-opened via Modify. Badge changes from `[Accepted]` to `[Accepted -- Modified]` after applying changes.
- **Browser refresh mid-review:** Since proposal state is server-side, refreshing the page should restore the exact review state (which sections are accepted, modified, skipped).
- **Simplified View toggle mid-review:** Toggling does not reset review progress. All section statuses are preserved. Only the display changes (inline editors vs tab navigation).
- **Overlapping webhook subscriptions:** When multiple connectors share the same Azure AD app and sync overlapping libraries, the Schedule section shows a note about 409 conflicts and scheduled delta sync fallback.
- **Health Check variant for Sites.Selected:** The Health Check displays differently for Sites.Selected scopes (design lines 1116-1141): shows reduced capabilities (e.g., 4/7 passed, FAIL on Sites.Read.All, INFO on available scopes). The `scopeVariant` field in Health Check data determines which variant to render.
- **"Abandon -- Do Not Sync" confirmation:** This action should show a confirmation dialog before executing, since it discards all proposal work. The dialog should state what will be lost (discovery results, configuration, review progress).

## Out of Scope

- **Scope+Filters split-pane tab (4c):** Covered by a separate card. This card covers only the Proposal tab's inline editors for Simplified View and the proposal section for Filters/Scope. The filter inline editor data model (condition builder, CEL, people filters) should be shared with the Scope+Filters card to avoid duplication -- cross-reference that card for the shared data model.
- **Preview/Dry-Run tab (4d):** Separate card. The Sample Preview section within the Proposal is in scope; the full Preview tab is not.
- **Connect tab (4a):** Authentication flow and initial connection are a separate card.
- **History tab:** Not visible in Simplified View. Separate concern.
- **Backend implementation:** No discussion of database schema, service architecture, or worker design.
- **OData query construction, CEL expression validation, or filter engine internals** -- these are backend concerns. The UI only needs the impact preview results.
- **SourcesTable token column display logic** -- separate card for the dashboard/sources view.
- **Webhook registration mechanics** -- the UI only needs to display webhook status and endpoint; registration is backend-only.

## Resolution Log

| Finding                                                     | Disposition               | Action Taken                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FINDING-24 (Scopes checklist item)                          | NO FINDING (verified)     | Capability note already lists all 9 items correctly.                                                                                                                                                                                                                                                                                                                                                                                 |
| FINDING-25 (Sample Preview buttons)                         | VALID (CRITICAL) -- fixed | Added Sample Preview row to Per-Section Action Buttons table with all 4 buttons: `[Looks Good]`, `[Adjust Filters]`, `[Refresh Sample]`, `[Abandon -- Do Not Sync]`. Added API-15 for Abandon. Added edge case for Abandon confirmation.                                                                                                                                                                                             |
| FINDING-26 (Connection section buttons)                     | VALID -- fixed            | Added Connection row to Per-Section Action Buttons table: `[Accept]`, `[Re-authenticate]`, `[Skip]`.                                                                                                                                                                                                                                                                                                                                 |
| FINDING-27 (Health Check section buttons)                   | VALID -- fixed            | Added Health Check row: `[Accept with warnings]`, `[Re-run]`, `[Skip]`.                                                                                                                                                                                                                                                                                                                                                              |
| FINDING-28 (Health Check scope detection)                   | VALID -- fixed            | Added `scopeVariant` field to Health Check data. Documented scope detection display variants in Section-Specific UI Elements.                                                                                                                                                                                                                                                                                                        |
| FINDING-29 (Token health display variants)                  | VALID -- fixed            | Added `tokenDisplayVariant` field and documented both display variants in Section-Specific UI Elements.                                                                                                                                                                                                                                                                                                                              |
| FINDING-30 (Scope Variant B buttons)                        | VALID -- fixed            | Added Scope (Variant B) row: `[Accept]`, `[Add More Sites]`, `[Skip]`.                                                                                                                                                                                                                                                                                                                                                               |
| FINDING-31 (Send Access Request to Admin)                   | VALID -- fixed            | Documented in Section-Specific UI Elements. Added API-16.                                                                                                                                                                                                                                                                                                                                                                            |
| FINDING-32 (Download Admin Commands)                        | VALID -- fixed            | Documented in Section-Specific UI Elements. Added API-17. Resolved Open Question #5: commands are dynamically generated.                                                                                                                                                                                                                                                                                                             |
| FINDING-33 (Download Permission Request Document)           | VALID -- fixed            | Documented in Section-Specific UI Elements. Added API-18. Updated Open Question #6 to focus on format.                                                                                                                                                                                                                                                                                                                               |
| FINDING-34 (Upgrade to Permission-Aware / Test Permissions) | VALID -- fixed            | Documented in Section-Specific UI Elements. Added API-21 and API-22.                                                                                                                                                                                                                                                                                                                                                                 |
| FINDING-35 (TRUST NOTE)                                     | VALID -- fixed            | Added `trustNote` field to Permissions data. Documented as display element in Section-Specific UI Elements.                                                                                                                                                                                                                                                                                                                          |
| FINDING-36 (Permissions buttons)                            | VALID -- fixed            | Added Permissions row: `[Accept]`, `[Change Mode]`, `[Skip]`.                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-37 (Need Help Getting GroupMember.Read.All?)        | VALID -- fixed            | Documented as subsection in Permissions Section-Specific UI Elements with both action buttons.                                                                                                                                                                                                                                                                                                                                       |
| FINDING-38 (Upgrade to Sites.Read.All box)                  | VALID -- fixed            | Documented in Scope Variant B Section-Specific UI Elements. Added API-20.                                                                                                                                                                                                                                                                                                                                                            |
| FINDING-39 (Sites.Selected information box)                 | VALID -- fixed            | Documented in Scope Variant B Section-Specific UI Elements.                                                                                                                                                                                                                                                                                                                                                                          |
| FINDING-40 (Security Gate Export PDF)                       | VALID -- fixed            | Added Security Gate row to Per-Section Action Buttons table. Added API-23 for section-specific PDF export.                                                                                                                                                                                                                                                                                                                           |
| FINDING-41 (Scope inline editor -- file type/size)          | COUNTER-NOTE              | The Scope inline editor (design lines 620-627) shows checkboxes for sites, file type dropdown, and size dropdown. These are simplified controls that map to the same data as the Filters inline editor. The Scope inline editor is intentionally simpler than the Filters editor -- file type and size are "quick controls" that write to the same filter config. No new data fields needed; the existing filter fields cover these. |
| FINDING-42 (Filter inline editor under-specified)           | VALID (CRITICAL) -- fixed | Added `peopleFilters` (createdBy/modifiedBy), `conditionBuilder` (15 operators, nesting), and `celExpression` (autocomplete, override behavior) fields to the inline editor data model. Updated `dateRange` to include all 4 date fields.                                                                                                                                                                                            |
| FINDING-43 (Schedule inline editor webhook display)         | VALID -- fixed            | Updated `webhookToggleable` field description to note that when scopes support it, webhooks show as "Automatically enabled" rather than a user toggle.                                                                                                                                                                                                                                                                               |
| FINDING-44 (Created before/after date fields)               | VALID (CRITICAL) -- fixed | Updated `dateRange` field to include `modifiedBefore`, `createdAfter`, `createdBefore` in addition to existing `modifiedAfter`.                                                                                                                                                                                                                                                                                                      |
| FINDING-45 (Condition Builder fields)                       | VALID (CRITICAL) -- fixed | Added `conditionBuilder` field with full operator list (15 operators enumerated), AND/OR grouping, and one-level nesting support.                                                                                                                                                                                                                                                                                                    |
| FINDING-46 (CEL expression field)                           | VALID (CRITICAL) -- fixed | Added `celExpression` field with autocomplete fields list and override-when-set behavior.                                                                                                                                                                                                                                                                                                                                            |
| FINDING-47 (People & Metadata fields)                       | VALID -- fixed            | Added `peopleFilters` field to distinguish built-in createdBy/modifiedBy from custom metadata conditions.                                                                                                                                                                                                                                                                                                                            |
| FINDING-48 (No document library sites)                      | NO FINDING (verified)     | `noLibrarySites` field already exists.                                                                                                                                                                                                                                                                                                                                                                                               |
| FINDING-49 (Scope Variant B admin email data)               | VALID -- fixed            | Added `adminEmailData` to Scope Variant B data fields. Added API-16 for generating the email.                                                                                                                                                                                                                                                                                                                                        |
| FINDING-50 (No API for Abandon)                             | VALID (CRITICAL) -- fixed | Added API-15: DELETE abandon endpoint.                                                                                                                                                                                                                                                                                                                                                                                               |
| FINDING-51 (No API for Send Access Request)                 | VALID -- fixed            | Added API-16.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-52 (No API for Download Admin Commands)             | VALID -- fixed            | Added API-17.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-53 (No API for Download Permission Request)         | VALID -- fixed            | Added API-18.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-54 (No API for Send Request to Security Team)       | VALID -- fixed            | Added API-19.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-55 (No API for Upgrade to Sites.Read.All)           | VALID -- fixed            | Added API-20.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-56 (No API for Upgrade to Permission-Aware)         | VALID -- fixed            | Added API-21.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-57 (No API for Test Permissions)                    | VALID -- fixed            | Added API-22.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FINDING-58 (Assumption #6 contradicts API)                  | VALID (CRITICAL) -- fixed | Rewrote Assumption #6 to resolve the contradiction: `?simplified=true` controls API response (omits advanced fields for payload efficiency), while the client also applies display-level filtering. Both participate in simplification.                                                                                                                                                                                              |
| FINDING-59 (Abandon consequences)                           | VALID -- fixed            | Added Open Question #7 for the specific consequences. Added edge case for confirmation dialog.                                                                                                                                                                                                                                                                                                                                       |
| FINDING-60 (Health Check Sites.Selected variant)            | VALID -- fixed            | Added `scopeVariant` to Health Check data. Added edge case documenting the display variant.                                                                                                                                                                                                                                                                                                                                          |
| FINDING-61 (Open Question #5 answered)                      | VALID -- resolved         | Design confirms commands are dynamically generated. Removed old Open Question #5. Answer incorporated into API-17 description.                                                                                                                                                                                                                                                                                                       |
| FINDING-62 (Filter inline editor cross-reference)           | VALID -- informational    | Added explicit cross-reference in Out of Scope noting that the filter data model should be shared with the Scope+Filters card.                                                                                                                                                                                                                                                                                                       |
