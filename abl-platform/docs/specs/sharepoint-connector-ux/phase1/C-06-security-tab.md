# C-06: Security Tab — Capability Note

**Status:** Reviewed
**Design Sections:** §4e

## User Intent

The Security tab gives users full transparency into what a connector can access, what it cannot, and how data is handled. It serves dual purposes: (1) an operational security dashboard for day-to-day management (scopes, token health, emergency revoke), and (2) a compliance artifact generator (exportable security review document for auditors). In Simplified View, it reduces to four essentials: permission mode, required scopes, security gate status, and limitations summary.

## UI Behaviors

### Granted OAuth Scopes Section

- Display base scopes as a static checklist: `Sites.Read.All`, `Files.Read.All`, `offline_access` — always checked, not toggleable.
- Show permission-aware search toggle status as a labeled indicator: "ENABLED (default)" or "DISABLED (public access)".
- If `GroupMember.Read.All` is not granted, show it unchecked with explanatory text about accuracy impact (~70-85% without vs ~95%+ with).
- Show a "Request GroupMember.Read.All" button when that scope is not yet granted. Inline description next to the button: "adds group resolution capability."
- **Base capabilities summary line** below the scopes: "Base capabilities: Sync, discovery, delta sync, webhooks, read perms."
- Show a collapsible "I need to disable permission-aware search..." trigger that expands the type-to-confirm flow.

### Type-to-Confirm Disable Flow

- Expands inline (not a dialog) when the disable trigger is clicked.
- User must type the exact string "public access" into a text input.
- Confirm button stays disabled until the typed text matches exactly (case-insensitive match is acceptable but the design shows exact case).
- On confirm, permission mode switches to disabled and the scope list updates.

### Token Expiry Display

- Show formatted expiry date and days remaining (e.g., "Apr 19, 2026 (28 days remaining)").
- Visual treatment should shift to warning state as expiry approaches (design does not specify threshold — see Open Questions).

### What This Connector Accesses

- Show aggregated stats: site count, library count, document count (with file type breakdown), total content size.
- Data comes from discovery/sync results, not a separate endpoint.

### What This Connector Does NOT Access

- Static bullet list, but content is conditional on granted scopes (e.g., "Cannot access sites outside the selected scope" changes meaning with `Sites.Selected` vs `Sites.Read.All`).

### Data Residency Section

- Display storage region, storage type, encryption details.
- Static/config-driven — no user interaction.

### Data Handling Section

- Display token encryption method, discovery cache TTL, document retention policy, vector cleanup timing, audit logging status.
- Static/config-driven — no user interaction.

### Emergency Revoke

- Single prominent button: "Emergency Revoke — One Click".
- On click, opens a confirmation dialog showing blast radius: connector name, active sync doc count, indexed doc count, actions that will be taken (pause syncs, revoke tokens, queue vector cleanup, notify admin).
- Dialog has two buttons: "Confirm Emergency Revoke" and "Cancel".
- On confirm, the UI should show a processing state, then transition the connector to a revoked/disconnected state.

### Revocation Manual Steps

- Static instructional text (3 steps) — no interactive elements. Always visible.

### Blast Radius Summary

- Conditional content based on scope tier:
  - `Sites.Selected`: shows limited blast radius (N admin-approved sites).
  - `Sites.Read.All`: shows broader blast radius (any site in tenant).
- Includes recommendation text to use `Sites.Selected`.
- Shows token auto-expiry countdown.

### Known Limitations

- Static list of **5** items (per design wireframe lines 1867-1875):
  1. Webhooks require publicly accessible HTTPS endpoint for callbacks.
  2. Vector cleanup queued on deletion (within 15 minutes).
  3. Group resolution requires permission-aware search enabled (GroupMember.Read.All). Without it, ~15-30% of users may get wrong search results (~70-85% accuracy vs ~95%+ with it).
  4. Sharing links: Documents shared via "Anyone with the link" are detected but specific recipients may not be resolvable.
  5. No auto-pause after consecutive failures.

### Security Review Document Export

- **Three export buttons** matching the wireframe layout: `[Download PDF]`, `[Export JSON/YAML]` (single button with format sub-selection for JSON or YAML), `[Copy as Markdown]`.
- The export contains ALL sections from the Security tab plus the User Decisions Log from the Configuration Proposal.
- Includes data residency, emergency revoke details, and cleanup status.
- **Document states** — the exported security review artifact includes these 5 specific statements:
  1. "Base scopes: Sites.Read.All + Files.Read.All + offline_access (always included). Permission-aware search adds GroupMember.Read.All. Files.Read.All is always included -- webhooks are production-grade, not optional."
  2. "GroupMember.Read.All is included when permission-aware search is enabled. Without it, ~15-30% of users get wrong search results."
  3. "We do NOT request Sites.FullControl.All, Sites.ReadWrite.All, or any write permissions."
  4. "GroupMember.Read.All is targeted -- it only reads group memberships, nothing else (more targeted than Directory.Read.All)."
  5. "Webhooks require a publicly accessible HTTPS notification endpoint. Without this, delta sync runs on schedule as fallback."

### Approval Gate

- Three radio-button states: "No approval required", "Pending", "Approved".
- Auto-transitions to "Pending" when write scopes (e.g., `Sites.ReadWrite.All`) are detected.
- "Send for Security Approval" button available when not yet approved.
- Gate status is read from connector config; transitions are triggered by scope changes or explicit user action.

### Self-Approval Policy (Org-Level Reference)

- Display-only reference to the org-level setting (Settings > Security > Connector Policy).
- Shows which of three policies is active: allow self-approval for read-only, require separate approver for all, require separate approver + security team.
- The Security tab does NOT allow changing this setting — it only displays the current policy.

### Immutable Audit Log

- Sortable table with columns: Time, Actor, Event.
- Append-only — no edit/delete actions on rows.
- "Download Full Audit Log" button (export).
- "Subscribe to Changes" button (notification subscription).
- Paginated or virtualized for connectors with long histories.

### Simplified View Behavior

- When Simplified View is ON, the Security tab shows only:
  1. Permission mode (ENABLED / Public Access).
  2. Required scopes in plain language (no technical scope strings).
  3. Security Gate status (No approval required / Pending / Approved).
  4. Known limitations summary.
- Hides: ACL mode details, CEL/OData references, blast radius analysis, data handling internals, audit log table, export options, emergency revoke, self-approval policy details.
- All instances of "pipeline" replaced with "system".
- **Note:** The design's Simplified View section (lines 578-598) only enumerates which tabs are hidden (Scope+Filters, History). The specific items shown/hidden within the Security tab in Simplified View are inferred from the tab's content structure and may need design confirmation.

## Required Data Fields

### From Connector Config / State

| Field                   | Type                                   | Purpose                                       |
| ----------------------- | -------------------------------------- | --------------------------------------------- |
| `grantedScopes`         | `string[]`                             | Which OAuth scopes are currently granted      |
| `permissionAwareSearch` | `boolean`                              | Whether permission-aware search is enabled    |
| `tokenExpiresAt`        | `ISO 8601 date`                        | OAuth token expiry timestamp                  |
| `scopeTier`             | `'Sites.Read.All' \| 'Sites.Selected'` | Determines blast radius content               |
| `approvalStatus`        | `'none' \| 'pending' \| 'approved'`    | Current approval gate state                   |
| `connectorName`         | `string`                               | Shown in emergency revoke blast radius dialog |
| `connectorId`           | `string`                               | For all API calls                             |

### From Discovery / Sync Stats

| Field                  | Type     | Purpose                                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------------------ |
| `siteCount`            | `number` | "What This Connector Accesses"                                                 |
| `libraryCount`         | `number` | "What This Connector Accesses"                                                 |
| `documentCount`        | `number` | "What This Connector Accesses"                                                 |
| `fileTypeBreakdown`    | `string` | Human-readable type summary                                                    |
| `totalContentSize`     | `string` | Formatted size (e.g., "4.2 GB")                                                |
| `activeSyncDocCount`   | `number` | Emergency revoke blast radius dialog                                           |
| `indexedDocumentCount` | `number` | Emergency revoke blast radius dialog ("N indexed documents will become stale") |

### From Platform Config (Static / Org-Level)

| Field                | Type                                                                              | Purpose                      |
| -------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| `storageRegion`      | `string`                                                                          | Data Residency display       |
| `storageType`        | `string`                                                                          | Data Residency display       |
| `encryptionDetails`  | `string`                                                                          | Data Residency display       |
| `selfApprovalPolicy` | `'self-approval-readonly' \| 'separate-approver' \| 'separate-approver-security'` | Self-Approval Policy display |

### From Audit Log

| Field            | Type                            | Purpose              |
| ---------------- | ------------------------------- | -------------------- |
| `auditEntries[]` | `{ timestamp, actor, event }[]` | Audit log table rows |

## API Requirements

### GET connector security overview

- **Purpose:** Fetch all data needed to render the Security tab in one call (or composed from existing endpoints).
- **Needs:** granted scopes, permission-aware search status, token expiry, scope tier, approval status, discovery stats (site/library/doc counts, size), blast radius metadata, indexed document count.
- **Note:** May be served by the existing `GET /api/connectors/:id` response if it includes these fields, or may need a dedicated sub-resource.

### POST request scope upgrade

- **Purpose:** "Request GroupMember.Read.All" button.
- **Input:** `{ scope: 'GroupMember.Read.All' }`.
- **Effect:** Triggers re-auth flow or admin consent request.

### PATCH disable permission-aware search

- **Purpose:** Type-to-confirm "public access" disable flow.
- **Input:** `{ permissionAwareSearch: false, confirmation: 'public access' }`.
- **Effect:** Updates connector config, recalculates scope set.

### POST emergency revoke

- **Purpose:** One-click emergency revoke.
- **Input:** `{ confirm: true }`.
- **Effect:** Pauses syncs, revokes OAuth tokens, queues vector cleanup, sends admin notification.
- **Response:** Should include a summary of actions taken and their statuses.

### GET blast radius (for confirmation dialog)

- **Purpose:** Populate the emergency revoke confirmation dialog with current blast radius.
- **Response:** Connector name, active sync count, indexed doc count, affected sites, what will happen.
- **Note:** Could be a sub-resource of the connector or computed client-side from existing data.

### POST send for security approval

- **Purpose:** "Send for Security Approval" button.
- **Input:** `{ connectorId }`.
- **Effect:** Transitions approval status to "pending", notifies designated approver(s).

### GET audit log

- **Endpoint:** `GET /api/connectors/:id/audit-log` (already in design's API section).
- **Purpose:** Paginated immutable audit log entries.
- **Query params:** Pagination (offset/limit or cursor), optional date range filter.
- **Response:** `{ entries: [{ timestamp, actor, event }], total, hasMore }`.

### GET audit log export

- **Purpose:** "Download Full Audit Log" button.
- **Response:** Full audit log as downloadable file (CSV or JSON).

### POST subscribe to audit changes

- **Purpose:** "Subscribe to Changes" button.
- **Input:** Notification channel preference (email, webhook).
- **Effect:** Registers the user for change notifications on this connector's audit log.

### POST export security review document

- **Endpoint:** `POST /api/connectors/:id/export` (already in design's API section).
- **Purpose:** Export security review as PDF, JSON, YAML, or Markdown.
- **Input:** `{ format: 'pdf' | 'json' | 'yaml' | 'markdown' }`.
- **Response:** File download or base64-encoded content.
- **Content:** All Security tab sections + User Decisions Log from Configuration Proposal + the 5 "Document states" text blocks.

### GET org-level self-approval policy

- **Purpose:** Display current self-approval policy on Security tab.
- **Endpoint:** Likely an org/tenant settings endpoint, not connector-specific.
- **Response:** `{ policy: 'self-approval-readonly' | 'separate-approver' | 'separate-approver-security' }`.

## Assumptions

1. The existing `GET /api/connectors/:id` response includes (or can be extended to include) granted scopes, token expiry, permission mode, and approval status — avoiding the need for a separate security-specific endpoint.
2. Discovery stats (site count, library count, document count, content size) are available from the discovery/sync results already fetched by other tabs, so the Security tab can reuse cached client-side data rather than making a separate call.
3. The "Request GroupMember.Read.All" flow triggers a re-authentication (possibly redirecting to Microsoft consent), not just a backend flag flip.
4. The type-to-confirm field for disabling permission-aware search performs exact string matching on "public access" — the backend validates this confirmation string.
5. Emergency revoke is a single atomic backend operation that handles all four steps (pause, revoke, queue cleanup, notify) — the UI does not need to orchestrate them individually.
6. The blast radius data for the emergency revoke dialog can be computed from data already present in the connector state (no separate pre-fetch needed).
7. The self-approval policy is an org-level setting fetched once and cached — it does not change per-connector.
8. The audit log model (`ConnectorAuditEntry`) is append-only at the backend level — the UI does not need to enforce immutability, only display it.
9. Simplified View state is stored in `localStorage` per user — no backend persistence needed.
10. "Subscribe to Changes" on the audit log creates a persistent notification subscription, not a WebSocket/SSE live stream.

## Open Questions

1. **Token expiry warning threshold:** At what number of remaining days should the token expiry display shift to a warning visual state? (7 days? 14 days? Configurable?)
2. **Scope upgrade flow:** Does "Request GroupMember.Read.All" trigger an inline re-auth (device code flow within the panel) or redirect to a new Microsoft consent page? What happens to the connector state during re-auth?
3. **Approval gate automation:** When approval auto-transitions to "Pending" on write scope detection, who gets notified? Is the approver list configured at the org level or per-connector?
4. **Audit log pagination:** What is the default page size? Is cursor-based or offset-based pagination preferred? Should the UI support infinite scroll or explicit pagination controls?
5. **Subscribe to Changes:** What notification channels are supported? Email only, or also webhook/in-app? Is this per-user or per-connector?
6. **Security review PDF generation:** Is this generated client-side (from the same data the UI renders) or server-side (dedicated endpoint)? Server-side is implied by the design but has different latency characteristics.
7. **Blast radius for Sites.Selected:** The design says "only N admin-approved sites readable" — does the API return the specific site list and count, or just the total N?
8. **Emergency revoke post-state:** After emergency revoke completes, what state does the connector land in? Can it be reconnected, or must a new connector be created?
9. **"What This Connector Does NOT Access" dynamic content:** The bullet about "Cannot access sites outside the selected scope" varies by scope tier. Are there other conditional bullets, or is the rest always static?

## Edge Cases

1. **Token already expired:** Token expiry displays negative days. The "Emergency Revoke" button may still be relevant (to clean up vectors and pause scheduled syncs) even though the token is already dead. UI should not hide revoke just because the token expired.
2. **No discovery data yet (draft/pre-auth state):** "What This Connector Accesses" section has no stats to show. Display placeholder text like "Stats available after first sync" rather than zeros.
3. **Emergency revoke partial failure:** Backend pauses syncs but fails to revoke the token (Microsoft API down). UI must show partial success state with clear indication of what succeeded and what failed.
4. **Approval gate with no approvers configured:** If the org requires a separate approver but none is configured, "Send for Security Approval" should show an error or redirect to org settings.
5. **Audit log empty:** New connector with no events yet. Show empty state, not a broken table.
6. **Concurrent scope change during security review export:** If someone modifies scopes while another user exports the security document, the export should reflect a consistent snapshot (point-in-time).
7. **Simplified View toggle mid-review:** User switches from Simplified to Full View while reviewing the Security tab. All sections should render immediately without a separate data fetch.
8. **Permission-aware search disable then re-enable:** After typing "public access" and confirming, can the user re-enable permission-aware search without friction? The design shows the disable flow but not the re-enable path.
9. **Very long audit log:** Connector active for months with thousands of entries. Table must handle pagination/virtualization gracefully.
10. **Self-approval policy changed while connector is pending:** If org policy changes from "require separate approver" to "allow self-approval" while a connector is in "Pending" state, does it auto-approve or stay pending?

## Out of Scope

- **Backend implementation** of the audit log model, emergency revoke orchestration, or vector cleanup pipeline.
- **Database schema** for `ConnectorAuditEntry`, `ConnectorConfigVersion`, or approval tracking.
- **Service-level design** for token revocation, notification dispatch, or cleanup queuing.
- **Delegation flow** (excluded per master tracker scope).
- **Email notifications** (excluded per master tracker — PDF export is sufficient).
- **Org-level settings UI** for self-approval policy — this card only displays the current policy, not the settings page to change it.
- **Webhook notification channel configuration** — referenced in design but not part of the Security tab UI itself.
- **Actual PDF rendering engine** selection or implementation — this card covers the UI trigger and expected inputs/outputs only.

## Resolution Log

**Resolved from verification-batch-2 findings:**

| #   | Finding                                                                        | Severity | Resolution                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Known Limitations count wrong -- states "7 items" but design wireframe shows 5 | HIGH     | **Fixed.** Changed from "Static list of 7 items" to "Static list of 5 items" with all 5 items enumerated verbatim from design wireframe lines 1867-1875. Confirmed against Maria's persona walkthrough which also references 5 known limitations.                                  |
| F2  | Security Review Document "Document states" content not captured                | MEDIUM   | **Fixed.** Added all 5 "Document states" text blocks verbatim from the design wireframe (lines 1883-1895) to the Security Review Document Export section. These define the exact content of the exportable security review artifact.                                               |
| F3  | Export format UI layout (3 buttons not 4) does not match wireframe             | MEDIUM   | **Fixed.** Changed from "Four export actions" to "Three export buttons" matching the wireframe layout: `[Download PDF]`, `[Export JSON/YAML]` (single button with format sub-selection), `[Copy as Markdown]`. The API endpoint remains a single endpoint with a format parameter. |
| F4  | "Base capabilities" summary line missing                                       | LOW      | **Fixed.** Added "Base capabilities: Sync, discovery, delta sync, webhooks, read perms" as a summary line in the Granted OAuth Scopes section, per design line 1802.                                                                                                               |
| --  | "Request GroupMember.Read.All" inline description missing                      | --       | **Fixed.** Added inline description "adds group resolution capability" next to the button, per design line 1806.                                                                                                                                                                   |
| --  | `indexedDocumentCount` field missing for blast radius dialog                   | --       | **Fixed.** Added `indexedDocumentCount` to the Discovery / Sync Stats data fields table for the "N indexed documents will become stale" dialog text (design line 1849).                                                                                                            |
| --  | Simplified View content flagged as inferred                                    | --       | **Acknowledged.** Added a note that the specific items shown/hidden within the Security tab in Simplified View are inferred (design only enumerates hidden tabs, not per-tab content). Flagged for design confirmation.                                                            |
