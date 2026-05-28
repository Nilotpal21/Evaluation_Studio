# C-12: Config Management & History — Capability Note

**Status:** Reviewed
**Design Sections:** §9

## User Intent

Users need to export connector configuration for backup, migration, or sharing across environments. They also need to understand what changed over time, detect drift from organizational templates, and — as a last resort — purge all synced content without destroying the connector setup.

## UI Behaviors

### 9a — JSON/YAML Export

1. **Format selector** — radio button group: JSON (default) or YAML. Switching format re-renders the preview pane instantly (client-side transform; no new API call needed if raw config is already loaded).
2. **Include checkboxes** — four checked by default (Scope, Filters, Schedule, Permission mode) plus one unchecked by default (OAuth credentials). Toggling a checkbox updates the preview pane in real time.
3. **OAuth credentials checkbox** — rendered with a warning style (e.g., caution icon). NEVER pre-checked. When the user checks it, show an inline warning: "Credentials will be included in plaintext. Do not share this export publicly."
4. **Config preview pane** — read-only, syntax-highlighted code block showing the export payload. Includes `version` and `exportedAt` metadata fields injected by the API.
5. **[Download]** — triggers a browser file download. **[Inference]** Filename convention: `<connector-name>-config-v<N>.<json|yaml>`. The design does not specify the filename; this is a reasonable default.
6. **[Copy to Clipboard]** — copies preview content to clipboard with a transient "Copied" toast.

### 9b — Version History with Diff

1. **Version History table** — columns: Version (with "current" badge on latest), Date (formatted locale-relative), Changed By (email or "system"), Summary (one-line text). Sorted newest-first. Paginated or virtualized if versions exceed ~50.
2. **Version diff** — The design wireframe shows a contextual `[View Diff: vN --> vM]` button on a selected row, comparing that version against the current version (one-click diff). The diff view shows a side-by-side or inline view of added/removed/changed fields. The API supports arbitrary `from`/`to` version pairs, but the default UX is: select a row, click [View Diff: vN --> current].
3. **[Restore vN]** — clicking shows a confirmation dialog. **[Inference]** Dialog text: "Restore configuration to version N? This creates a new version (vN+1) with the restored settings." The design wireframe shows `[Restore v4]` without an explicit confirmation step, but a confirmation dialog is added as a safety measure to prevent accidental restores. On confirm, the restored config becomes the new current version.
4. **Config Drift Detection** — shown only when the connector was created from a template. Displays: template name, applied version, and a list of deviations (each with the field changed, old vs new value, and which version introduced the deviation).
5. **Drift actions:**
   - [Re-apply Template] — confirmation dialog warning that deviations will be overwritten. Creates a new version.
   - [Update Template to Match Current] — confirmation dialog noting this affects future connectors created from this template.
   - [Ignore Drift] — dismisses the drift notice. Persisted server-side via the `POST .../drift/ignore` endpoint; suppressed until the next config change.
6. **Raw Configuration** — [Copy JSON], [Copy YAML] copy current config to clipboard. [Export] opens the §9a export dialog. [Import & Replace] opens a file picker (accepts .json/.yaml), parses the file, and applies the imported config as a new version. **[Inference]** The implementation uses a two-step API flow (preview diff, then confirm) for safety, but the design wireframe shows a single `[Import & Replace]` action without an explicit preview step. The diff preview before confirmation is a design decision not present in the wireframe.
7. **Danger Zone — [Delete All Synced Content]:**
   - Button styled as destructive (red outline or similar).
   - Confirmation dialog shows: document count, note that chunks and vector embeddings are also removed, note that config is preserved, and that a full re-sync can restore content. The design wireframe shows `[Confirm Delete] [Cancel]` with descriptive text.
   - **[Inference]** Type-to-confirm (typing the connector name to enable [Confirm Delete]) is not shown in the design wireframe. This is a design decision added as a safety measure for this destructive operation. If implementation wants to match the wireframe exactly, a simple [Confirm Delete] / [Cancel] dialog without type-to-confirm is also acceptable.
8. **Cleanup Progress UI:**
   - Three progress rows: Documents, Chunks, Vector embeddings — each showing `removed/total` count and a percentage progress bar.
   - Estimated time remaining displayed below.
   - [Cancel Cleanup] button available throughout. On cancel, show partial-cleanup state with counts of what was already removed.
9. **Cleanup Failed state:**
   - Error message shown with the specific failure reason.
   - Counts of what was removed vs what remains.
   - [Retry Cleanup] resumes from where it left off. [Contact Support] opens support flow.

## Required Data Fields

### Export Payload (§9a)

| Field            | Type              | Description                                                           |
| ---------------- | ----------------- | --------------------------------------------------------------------- |
| `name`           | string            | Connector display name                                                |
| `provider`       | string            | Always `"sharepoint"` for this connector                              |
| `scope`          | object            | `{ sites: string[], contentTypes: string[] }`                         |
| `filters`        | object            | File type filters, folder rules, metadata conditions, CEL expressions |
| `schedule`       | object            | `{ deltaInterval: string }` and related scheduling config             |
| `permissionMode` | string            | Permission sync mode                                                  |
| `credentials`    | object or null    | OAuth credentials — only present when explicitly opted in             |
| `version`        | string            | Config version identifier (e.g., `"v5"`)                              |
| `exportedAt`     | string (ISO 8601) | Timestamp of export, injected by API                                  |

### Version History Entry (§9b)

| Field       | Type              | Description                          |
| ----------- | ----------------- | ------------------------------------ |
| `version`   | string            | Version identifier (e.g., `"v5"`)    |
| `isCurrent` | boolean           | Whether this is the active version   |
| `createdAt` | string (ISO 8601) | When this version was created        |
| `changedBy` | string            | User email or `"system"`             |
| `summary`   | string            | One-line description of what changed |

### Diff Response

| Field         | Type   | Description                                                          |
| ------------- | ------ | -------------------------------------------------------------------- | --------- | ------------ |
| `fromVersion` | string | Base version for comparison                                          |
| `toVersion`   | string | Target version for comparison                                        |
| `changes`     | array  | List of `{ path: string, oldValue: any, newValue: any, type: 'added' | 'removed' | 'changed' }` |

### Config Drift

| Field                      | Type    | Description                                                                             |
| -------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `templateName`             | string  | Name of the applied template                                                            |
| `templateAppliedAtVersion` | string  | Version when template was applied                                                       |
| `deviations`               | array   | `{ field: string, templateValue: any, currentValue: any, deviatedAtVersion: string }[]` |
| `hasDrift`                 | boolean | Quick check for whether to render drift section                                         |

### Cleanup Status

| Field                    | Type           | Description                              |
| ------------------------ | -------------- | ---------------------------------------- | ------------- | ----------- | -------- | ------------ |
| `status`                 | enum           | `'idle'                                  | 'in_progress' | 'completed' | 'failed' | 'cancelled'` |
| `documents`              | object         | `{ total: number, removed: number }`     |
| `chunks`                 | object         | `{ total: number, removed: number }`     |
| `vectorEmbeddings`       | object         | `{ total: number, removed: number }`     |
| `estimatedTimeRemaining` | number or null | Seconds remaining, null if not estimable |
| `error`                  | string or null | Error message if status is `'failed'`    |

## API Requirements

### GET `/api/projects/:projectId/connectors/:connectorId/config/export`

- **Query params:** `format` (`json` | `yaml`), `includeScope` (bool), `includeFilters` (bool), `includeSchedule` (bool), `includePermissionMode` (bool), `includeCredentials` (bool)
- **Response:** The serialized config object with `version` and `exportedAt` injected
- **Notes:** When `includeCredentials=false` (default), credentials field is omitted entirely. Response Content-Type matches requested format.

### GET `/api/projects/:projectId/connectors/:connectorId/config/versions`

- **Query params:** `page`, `pageSize` (optional, for pagination)
- **Response:** `{ versions: VersionHistoryEntry[], total: number }`

### GET `/api/projects/:projectId/connectors/:connectorId/config/versions/:versionId`

- **Response:** Full config snapshot for that version

### GET `/api/projects/:projectId/connectors/:connectorId/config/diff`

- **Query params:** `from` (version id), `to` (version id)
- **Response:** Diff response with structured change list
- **Notes:** Supports arbitrary version pairs. The default UI usage is `from=<selected version>` and `to=<current version>`, but the API is flexible.

### POST `/api/projects/:projectId/connectors/:connectorId/config/restore`

- **Body:** `{ version: string }` — version to restore
- **Response:** The newly created version entry
- **Side effect:** Creates a new version with the restored config

### GET `/api/projects/:projectId/connectors/:connectorId/config/drift`

- **Response:** Config drift object (template name, deviations, hasDrift flag)
- **Response (no template):** `{ hasDrift: false, templateName: null }` — UI hides drift section

### POST `/api/projects/:projectId/connectors/:connectorId/config/drift/reapply-template`

- **Response:** New version entry with template re-applied

### POST `/api/projects/:projectId/connectors/:connectorId/config/drift/update-template`

- **Response:** Updated template metadata

### POST `/api/projects/:projectId/connectors/:connectorId/config/drift/ignore`

- **Response:** Acknowledgment; drift notice suppressed server-side until next config change

### POST `/api/projects/:projectId/connectors/:connectorId/config/import`

- **Body:** Parsed config object (from uploaded JSON/YAML file)
- **Response:** `{ diff: DiffResponse, requiresConfirmation: true }` on first call
- Follow-up: `POST .../config/import/confirm` to apply
- **Note:** [Inference] The two-step import flow (preview + confirm) is a design decision not shown in the wireframe. The wireframe shows a single [Import & Replace] action. The two-step API is a safety measure.

### POST `/api/projects/:projectId/connectors/:connectorId/content/purge`

- **Response:** `{ cleanupId: string, status: 'in_progress' }` — initiates async cleanup
- **Precondition:** If a sync is currently running, the API should reject the purge request with an error (e.g., "Cannot purge while sync is in progress. Pause or wait for sync to complete."). The UI should check connector status and disable the purge button or show a warning when sync is active.

### GET `/api/projects/:projectId/connectors/:connectorId/content/purge/:cleanupId`

- **Response:** Cleanup status object (polled by UI for progress)

### POST `/api/projects/:projectId/connectors/:connectorId/content/purge/:cleanupId/cancel`

- **Response:** Updated cleanup status with `status: 'cancelled'`

### POST `/api/projects/:projectId/connectors/:connectorId/content/purge/:cleanupId/retry`

- **Response:** Updated cleanup status with `status: 'in_progress'`

## Assumptions

1. **Client-side format conversion** — The API returns a structured config object. JSON-to-YAML conversion for the preview pane and Copy buttons is done client-side (using a library like `js-yaml`) to avoid redundant API calls when toggling format.
2. **Version history is immutable** — Every change (including restores and template re-applies) creates a new version. No version is ever deleted or mutated.
3. **Diff is computed server-side** — Structured diffs are computed by the API rather than client-side, to ensure consistency and handle nested object comparisons correctly.
4. **Cleanup is async** — The purge operation returns immediately with a cleanup ID. The UI polls for progress (or uses SSE/WebSocket if available).
5. **Template drift is optional** — The drift section only renders when the connector was created from a template. The API returns `hasDrift: false` with null template name for non-templated connectors.
6. **Credentials export requires elevated permission** — The `includeCredentials` option may require an additional permission check server-side. The UI should disable the checkbox if the user lacks this permission.
7. **Ignore Drift is persisted server-side** — The `POST .../drift/ignore` endpoint stores the suppression. Drift notice is suppressed until the next config change triggers a re-evaluation.

## Open Questions

1. **Poll interval for cleanup progress** — What interval should the UI poll cleanup status? 2 seconds? Or should the backend support SSE/WebSocket for real-time updates?
2. **Import validation** — Should the API validate the imported config against the current connector's provider type and reject mismatches (e.g., importing a Google Drive config into a SharePoint connector)? Or is that a client-side guard?
3. **Update Template permissions** — "Update Template to Match Current Config" modifies a shared template. Should this require an admin-level permission? Is there a confirmation showing how many other connectors use this template?
4. **Partial cleanup resume** — When retrying a failed cleanup, does the API resume from the last successful point, or does it restart the failed resource type from scratch?
5. **Version history depth** — Is there a maximum number of versions retained? If config changes frequently (e.g., automated schedule adjustments), the history could grow indefinitely.

## Edge Cases

1. **Export with no config changes yet** — Connector just created with defaults. Export should still work, showing v1 with all default values.
2. **Diff between non-adjacent versions** — User selects v1 and v5 for diff. API must handle arbitrary version pairs, not just consecutive ones.
3. **Concurrent config edits** — Two users modify config simultaneously. The version that saves second must create v(N+1), not overwrite vN. Optimistic concurrency or last-write-wins with version conflict detection.
4. **Import of config from different connector version** — Imported config may have fields that don't exist in the current schema version (forward migration) or be missing new fields (backward migration). API should handle gracefully with defaults.
5. **Cleanup of connector with zero content** — [Delete All Synced Content] when there is nothing to delete. Button should be disabled or show "No synced content to delete."
6. **Cleanup cancelled mid-way** — Some resources are deleted, others are not. The UI must accurately reflect partial state and allow retry to clean up the remainder.
7. **Template deleted after connector creation** — Drift detection references a template that no longer exists. UI should show "Template no longer available" and hide Re-apply/Update actions, keeping only Ignore.
8. **Very large config** — If the connector has hundreds of sites or complex CEL expressions, the preview pane and diff view must handle large payloads without freezing (virtualization or truncation with "show all" toggle).
9. **OAuth credentials re-import** — Importing a config that includes credentials into a connector that already has different credentials. Should warn that existing credentials will be overwritten.
10. **Cleanup while sync is running** — If the user clicks [Delete All Synced Content] while a sync is in progress, the cleanup and sync would conflict. The purge API should reject the request when sync is active, and the UI should disable the button or show a warning when the connector status is "syncing".

## Out of Scope

- **Backend implementation** of the ConnectorConfigVersion model, diff engine, or cleanup workers
- **Template CRUD management** — creating, editing, or deleting templates is a separate feature; this card only covers drift detection from an already-applied template
- **Config validation rules** — what constitutes a valid config is a backend concern; the UI trusts the API's validation response
- **Audit log integration** — version history serves as the config audit trail; integration with a broader platform audit log system is separate
- **Bulk config operations** — exporting/importing configs across multiple connectors simultaneously
- **Config scheduling/automation** — automated config changes based on rules or triggers

## Resolution Log

**Resolved from verification-batch-4 findings (2026-03-24):**

| #   | Finding                                                                                                                  | Severity | Resolution                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Version diff UX over-generalized — design shows one-click diff against current version, not arbitrary two-version picker | MEDIUM   | **Fixed.** Rewrote UI Behavior #2 to describe the wireframe's contextual `[View Diff: vN --> current]` model as the default UX. The API still supports arbitrary pairs, but the UI defaults to selected-vs-current. Added clarifying note to the diff API description.            |
| 2   | Type-to-confirm for Delete All Synced Content is not in the design wireframe                                             | MEDIUM   | **Fixed.** Marked type-to-confirm as `[Inference]` in UI Behavior #7 and noted the wireframe shows a simple `[Confirm Delete] [Cancel]` dialog. Implementers can choose either approach.                                                                                          |
| 3   | Import & Replace diff preview step is an inference not shown in wireframe                                                | MEDIUM   | **Fixed.** Marked the two-step import flow as `[Inference]` in both UI Behavior #6 and the import API endpoint. Noted the wireframe shows a single [Import & Replace] action.                                                                                                     |
| 4   | Restore confirmation dialog is an inference not shown in wireframe                                                       | LOW      | **Fixed.** Marked the confirmation dialog as `[Inference]` in UI Behavior #3, noting the wireframe shows `[Restore v4]` without an explicit confirmation step.                                                                                                                    |
| 5   | Edge case gap: cleanup while sync is running (conflict not addressed)                                                    | LOW      | **Fixed.** Added Edge Case #10 documenting the sync-vs-cleanup conflict. Added a precondition note to the purge API endpoint requiring sync to be inactive.                                                                                                                       |
| 6   | OQ #3 (Drift ignore scope) partially self-answered by the card's own API definition                                      | LOW      | **Fixed.** Removed OQ #3 and converted to Assumption #7: "Ignore Drift is persisted server-side via the drift/ignore endpoint, suppressed until the next config change." Updated the drift/ignore API description and UI Behavior #5 to state server-side persistence explicitly. |
