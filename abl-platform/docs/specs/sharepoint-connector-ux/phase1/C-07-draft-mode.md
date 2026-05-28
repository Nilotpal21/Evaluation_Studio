# C-07: Draft Mode (Configure-Before-Auth) — Capability Note

**Status:** Reviewed
**Design Sections:** §5

## User Intent

The user wants to configure as much of the connector as possible (filters, schedule, permissions) while authentication is still pending, so they are not blocked waiting for auth to complete before doing useful setup work.

## UI Behaviors

1. **Panel header** displays the connector name with a "(Draft)" suffix (e.g., "New SharePoint Connector (Draft)"). A `[... More Actions]` menu appears in the panel header; its contents in draft mode are determined by the panel-level menu definition (see C-03 or panel card). If no actions are applicable in draft mode, the menu may be disabled or hidden.
2. **Tab bar** shows an asterisk on the Connect tab label: "Connect\*". A footnote below the tab bar reads: "\* = Awaiting authentication".
3. **Info banner** (persistent, top of content area): "Waiting for authentication. Tabs marked with a lock icon will populate after auth completes. You can configure everything else now."
4. **Scope+Filters tab** operates in a split-availability mode:
   - **Sites section** — disabled/placeholder state: "Will be populated after authentication and discovery." Offers a manual escape hatch: `[Enter Site URLs Manually]` button that opens a text input for pasting known site URLs.
   - **Filters section** — fully editable now: file type checkboxes (Documents, Text, Images), template presets (Documents Only, Technical Docs), folder exclude pattern input (`**/Archive/**`), size limit inputs (min KB / max MB).
   - **Schedule section** — fully editable now: frequency dropdown selector (e.g., "Every 6 hours").
   - **Permissions section** — fully editable now: permission-aware search toggle (default: ENABLED, visually locked). Disable path requires expanding a `[I need to disable this...]` link, which reveals a type-to-confirm flow. Message: "There is no quick path to Public Access."
5. **Persistence confirmation** message at the bottom of Scope+Filters: "These settings will apply automatically when auth completes."
6. **Draft-to-active transition**: When the auth callback fires (device code completes, delegation callback received), the panel transitions automatically:
   - "(Draft)" suffix is removed from the header.
   - "Connect\*" asterisk and footnote are removed.
   - Info banner is dismissed.
   - Sites section populates with discovered sites (proposal generation begins).
   - All pre-configured settings (filters, schedule, permissions, manually entered site URLs) are preserved and applied to the generated proposal.
7. **Tab availability in draft mode**:
   - **Editable**: Scope+Filters (partial — filters/schedule/permissions only), Connect (shows auth status).
   - **Locked/disabled**: Proposal, Preview, Security, History — these depend on discovery data that requires auth. Locked tabs display a **lock icon overlay on their tab labels** (per the banner text: "Tabs marked with a lock icon"). The visual treatment of the lock icon (overlay vs. replacing the tab icon) is an open question.

## Required Data Fields

The UI needs to read and write the following fields on the connector draft object:

| Field                               | Type     | Read/Write | Notes                                                                             |
| ----------------------------------- | -------- | ---------- | --------------------------------------------------------------------------------- |
| `name`                              | string   | R/W        | Connector display name, shown in header                                           |
| `status`                            | enum     | R          | `'draft'`, `'awaiting_auth'`, `'active'`, etc. — drives all conditional rendering |
| `authStatus`                        | enum     | R          | `'pending'`, `'completed'`, `'failed'` — drives banner, tab asterisk, transition  |
| `manualSiteUrls`                    | string[] | R/W        | User-entered site URLs before discovery                                           |
| `filters.fileTypes`                 | string[] | R/W        | Selected file type filters                                                        |
| `filters.templates`                 | string[] | R/W        | Selected template presets                                                         |
| `filters.folderExclude`             | string[] | R/W        | Glob patterns for folder exclusion                                                |
| `filters.sizeMin`                   | number   | R/W        | Minimum file size in KB                                                           |
| `filters.sizeMax`                   | number   | R/W        | Maximum file size in MB                                                           |
| `schedule.frequency`                | string   | R/W        | Sync frequency value (e.g., `"6h"`)                                               |
| `permissions.permissionAwareSearch` | boolean  | R/W        | Whether permission-aware search is enabled                                        |
| `permissions.disableAcknowledged`   | boolean  | R/W        | Whether user completed the type-to-confirm disable flow                           |

## API Requirements

### 1. Create Connector in Draft State

- **Purpose**: Create a connector record before auth so that configuration can be persisted server-side.
- **Trigger**: User selects SharePoint from the "Add Source" dialog.
- **Request**: `POST /api/projects/:projectId/kb/:kbId/connectors` with `{ type: 'sharepoint', status: 'draft' }`.
- **Response**: Returns the connector object with an `id`, `status: 'draft'`, and empty configuration fields.

### 2. Update Draft Configuration

- **Purpose**: Save filter, schedule, permission, and manual site URL edits while in draft mode.
- **Trigger**: User changes any editable field (debounced auto-save or explicit save).
- **Request**: `PATCH /api/projects/:projectId/kb/:kbId/connectors/:connectorId` with partial update payload containing changed fields.
- **Response**: Returns updated connector object. UI confirms save via subtle indicator (e.g., "Saved" timestamp or checkmark).

### 3. Poll / Subscribe for Auth Status

- **Purpose**: Detect when authentication completes so the UI can transition from draft to active.
- **Trigger**: Automatic while panel is open in draft/awaiting-auth state.
- **Mechanism**: Either polling (`GET /api/projects/:projectId/kb/:kbId/connectors/:connectorId/status` at ~3s interval) or SSE/WebSocket subscription.
- **Response**: Returns `{ authStatus: 'pending' | 'completed' | 'failed', authenticatedBy?: string, completedAt?: string }`.
- **On `completed`**: UI triggers the draft-to-active transition (remove banner, remove asterisk, begin proposal generation).
- **On `failed`**: UI shows error state with retry options.

### 4. Get Connector (for Resume)

- **Purpose**: When user returns to a draft connector (clicks "Awaiting Auth" or "Draft" row in SourcesTable), load all previously saved configuration.
- **Trigger**: Row click in SourcesTable for a connector with status `draft` or `awaiting_auth`.
- **Request**: `GET /api/projects/:projectId/kb/:kbId/connectors/:connectorId`.
- **Response**: Full connector object including all draft configuration fields. UI hydrates all editable sections from this response.

### 5. Get Schedule Frequency Options

- **Purpose**: Populate the frequency dropdown with valid options.
- **Request**: `GET /api/projects/:projectId/kb/:kbId/connectors/config/schedule-options` (or hardcoded in the UI if the options are static).
- **Response**: `{ frequencies: [{ value: '1h', label: 'Every hour' }, { value: '6h', label: 'Every 6 hours' }, ...] }`.

### 6. Get Filter Presets (Templates)

- **Purpose**: Populate the template preset selector.
- **Request**: `GET /api/projects/:projectId/kb/:kbId/connectors/config/filter-presets` (or hardcoded if static).
- **Response**: `{ presets: [{ id: 'documents-only', label: 'Documents Only', filters: {...} }, ...] }`.

## Assumptions

1. A connector record is created server-side as soon as the user selects SharePoint from the type picker, even before auth begins. This gives the draft a persistent ID for saving configuration.
2. The auth flow (device code, browser login) is initiated from the Connect tab. Draft mode applies to **all** auth methods, not just delegation. Note: the design's primary scenario frames delegation as the trigger for draft mode, but the behavior applies universally.
3. Auto-save (debounced PATCH) is the primary save mechanism. There is no explicit "Save Draft" button on the Scope+Filters tab in draft mode (the "Save as Draft" button in §4h is for the post-proposal approval screen, which is a different context).
4. The frequency dropdown options and filter presets are either static (bundled in the UI) or fetched once and cached. They do not change per-connector.
5. `manualSiteUrls` entered in draft mode are used as seed input for proposal generation — they are not the final site selection (discovery may refine them).
6. The polling interval for auth status (~3 seconds per the design) is acceptable. If the user navigates away and returns, the panel resumes polling.

## Open Questions

1. **Auto-save vs. explicit save**: Should draft configuration auto-save on field change (debounced), or require the user to click a save button? The design implies auto-save ("These settings will apply automatically when auth completes"), but this is not explicitly stated.
2. **Offline draft**: If the user closes the panel mid-edit without any server round-trip, are unsaved field values lost? Should the UI persist draft edits to localStorage as a fallback?
3. **Lock icon specifics**: The banner mentions "Tabs marked with a lock icon" — which tabs show the lock icon? Answer: Proposal, Preview, Security, and History (per item 7 above). Remaining question: should the lock icon be a visual overlay on the tab label, or replace the tab icon?
4. **Manual site URLs validation**: When the user enters site URLs manually, should the UI validate URL format client-side? Should it attempt a reachability check, or defer all validation to post-auth discovery?
5. **Auth status polling vs. push**: The design mentions polling at ~3s. Is there a plan for SSE or WebSocket to avoid polling overhead, especially if the user leaves the panel open for hours?

## Edge Cases

1. **User configures draft, then auth fails**: All draft configuration must be preserved. The user should be able to retry auth or switch auth methods without losing filter/schedule/permission settings.
2. **Multiple draft connectors**: A user could create multiple SharePoint connectors in draft state (e.g., one per site collection). Each must maintain independent configuration. The SourcesTable must show all drafts distinctly.
3. **Stale draft**: A draft connector is created but never authenticated. There should be a way to detect and surface stale drafts (e.g., "Created 7 days ago, still awaiting auth").
4. **Browser refresh during draft edit**: If the user refreshes the page while editing draft configuration, the panel should rehydrate from the last saved server state. Any unsaved in-flight edits are lost unless auto-save has committed them.
5. **Auth completes while user is on a different tab**: If the user is editing Scope+Filters and auth completes in the background, the UI must handle the transition gracefully — update the header and banner without disrupting the current editing context (no navigation away from Scope+Filters).
6. **Concurrent edits**: If the same connector is open in two browser tabs, PATCH conflicts could arise. The API should return a version/ETag and the UI should handle 409 Conflict.
7. **Auth method switching in draft mode**: User starts with one auth method (e.g., device code), it stalls, and they want to switch to a different method while preserving draft configuration. The design does not explicitly cover this; the UI should preserve all draft config when the auth method changes on the Connect tab.

## Out of Scope

- **Delegation flow details** — intentionally excluded per master tracker scope. Delegation is NOT covered by C-08 (which covers Monitoring & Sync Progress).
- **Proposal generation and review** — covered in C-03/C-04 (proposal is generated after auth, not during draft mode).
- **Sync execution and monitoring** — covered in C-08.
- **Backend implementation** of draft persistence, auth callback handling, or proposal generation pipeline.
- **Admin consent flow** specifics (Azure AD consent screens) — these are external to the ABL Platform UI.
- **"Save as Draft" on the approval screen** (§4h) — that is a different save action for a fully configured connector that the user chooses not to sync yet. It is not related to configure-before-auth draft mode.

## Resolution Log

**Resolved from verification-batch-3 findings:**

| #   | Finding                                                       | Severity | Resolution                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Missing lock icon visual treatment on individual tab labels   | LOW      | **Fixed.** Updated item 7 (Tab availability) to explicitly state that locked tabs display a lock icon overlay on their tab labels, per the banner text. Noted the visual treatment question (overlay vs. replace) remains open per OQ 3.                                           |
| F2  | Missing acknowledgment of "More Actions" menu in panel header | LOW      | **Fixed.** Updated item 1 (Panel header) to acknowledge the `[... More Actions]` menu shown in the wireframe, noting its contents in draft mode are determined by the panel-level definition.                                                                                      |
| F3  | Out of Scope incorrectly attributes delegation flow to C-08   | MEDIUM   | **Fixed.** Corrected the Out of Scope section. Delegation flow is intentionally excluded per master tracker scope (not covered by any card). Updated C-08 reference to correctly state it covers Monitoring & Sync Progress. Also corrected the C-06 reference for sync execution. |
| --  | Assumption 2 nuance about delegation as primary trigger       | --       | **Acknowledged.** Updated Assumption 2 to note that while draft mode applies to all auth methods, the design's primary scenario frames delegation as the trigger.                                                                                                                  |
| --  | Auth method switching edge case                               | --       | **Added.** New edge case 7 covering the scenario where a user switches auth methods mid-draft while wanting to preserve configuration.                                                                                                                                             |
