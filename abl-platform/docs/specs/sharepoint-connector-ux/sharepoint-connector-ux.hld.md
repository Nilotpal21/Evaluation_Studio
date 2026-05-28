# SharePoint Connector UX -- High-Level Design

## 1. What We're Building

We are replacing the current 5-step wizard-based SharePoint connector setup with a unified Detail Panel that serves as both the setup and monitoring interface. The new UX introduces a system-generated Configuration Proposal that turns connector setup into a guided review process, a split-pane Scope+Filters editor with live preview, comprehensive security and audit capabilities, and fleet-level operations for managing multiple connectors. This redesign is driven by the design doc analyzed in the Phase 1 capability notes (C-01 through C-12).

## 2. Scope

### In Scope

- Unified SharePoint Detail Panel (replaces wizard + old detail panel)
- Connect Tab with first-time vs returning user experiences
- Configuration Proposal generation, review, and approval (8 sections)
- Scope+Filters split-pane with live preview, CEL editor, condition builder
- Preview/Dry-Run with content type breakdown and filter change tracking
- Security Tab (scopes, token health, emergency revoke, audit log, compliance export)
- Draft Mode (configure-before-auth for all auth methods)
- Monitoring & Sync Progress (Overview, KPIs, per-site progress, notification config)
- SourcesTable enhancements (card/table toggle, grouping, bulk actions, type-specific columns)
- Multi-Connector Management (clone, template, import, API/CLI reference)
- Error states (10 discriminated types) and empty states (3 types)
- Config Management & History (export, versioning, diff, drift detection, content purge)
- SWR hooks and Zustand store for connector state management
- Backend bug fixes (resolveScopes, pause/resume, permission crawler, OAuth state)

### Out of Scope

- Delegation flow (authentication by another user via invite)
- Email notifications (PDF export is the compliance delivery mechanism)
- Non-SharePoint connector types (they continue using existing SourceDetailPanel)
- Webhook delivery infrastructure (retry, dead letter queues)
- Neo4j/graph database internals for permission storage
- Template CRUD management UI (editing, deleting, versioning templates beyond drift detection)
- CLI/API tool implementation (UI shows reference only)

## 3. What Exists Today (Inventory)

### Backend (37 routes, ~27 service methods)

**Connector CRUD (5 routes) -- Working:**

- List, create, get, update, delete connectors

**Auth (4 routes) -- Working:**

- Initiate, status, callback, revoke
- BUG: Pod-local OAuth state store violates Stateless Distributed invariant

**Filters (4 routes) -- Working:**

- Validate, templates, apply-template, preview

**Sync (8 routes) -- Partial:**

- Start, stop, restart, delta, delta-tokens -- working
- BUG: `pauseSync()`/`resumeSync()` throw "not implemented" on SharePointConnector
- Status endpoint exists but lacks per-site progress, current document, ETA

**Permissions (4 routes) -- Partial:**

- Crawl, status, mode, recrawl -- working
- BUG: `resolveScopes()` uses `Sites.FullControl.All` instead of correct scope
- BUG: SharePoint group ID != Azure AD group ID in permission crawler
- BUG: `grantedToV2.group` often not populated
- BUG: `getDrivePermissions()` defined but never called
- BUG: Permission modes include "simplified" -- should be only "enabled"/"disabled"

**Discovery (8 routes) -- Working:**

- Discover, get discovery, discovered-sites (search/paginate), select-sites
- Recommendations (create, list, accept), quick-setup

**Jobs (1 route) -- Working:**

- Get job status

**Webhook (stubs) -- Not Working:**

- Operations are stub implementations (Phase 2)

### Frontend (5 components, ~3,100 lines)

| Component                       | Lines | Status         | Action                                                 |
| ------------------------------- | ----- | -------------- | ------------------------------------------------------ |
| `EnterpriseConnectorWizard.tsx` | 595   | To be REPLACED | Unified Detail Panel replaces the 5-step wizard        |
| `ConnectorDetailPanel.tsx`      | 765   | To be REPLACED | Monitoring slide-over merged into unified panel        |
| `ConnectorFilterSection.tsx`    | 691   | To be ENHANCED | Add split-pane layout with live preview                |
| `SourcesTable.tsx`              | 457   | To be ENHANCED | Card/table toggle, bulk actions, type-specific columns |
| `AddSourceButton.tsx`           | 543   | To be MODIFIED | Integrate with new panel, add multi-connector dialog   |
| `SetupGuide.tsx`                | 196   | To be MODIFIED | Flow A opens dialog on Home tab directly               |
| `ConnectorsTab.tsx`             | 647   | ORPHANED       | Not in layout; can be removed                          |

**Frontend Infrastructure Gaps:**

- No SWR hooks for connector data -- all imperative fetches
- `ConnectorDetailPanel` does not use `SlidePanel` UI component (inconsistency)
- No CEL editor component
- No split-pane component
- No Zustand store for connector state

### Models (5 registered + 2 unregistered)

| Model                          | Registered | Notes                                          |
| ------------------------------ | ---------- | ---------------------------------------------- |
| `ConnectorConfig`              | Yes        | Main connector configuration                   |
| `ConnectorDiscovery`           | Yes        | Discovery results                              |
| `ConnectorRecommendation`      | Yes        | System recommendations                         |
| `ConnectorSchema`              | **No**     | Known bug -- not registered with ModelRegistry |
| `FieldMapping`                 | **No**     | Known bug -- not registered with ModelRegistry |
| `WebhookSubscriptionConnector` | Yes        | Webhook subscriptions                          |
| `EndUserOAuthToken`            | Yes        | Encrypted OAuth token storage                  |

### Design System Components Available

SlidePanel, DataTable, Card, Badge, SegmentedControl, Dialog, Tabs, Button, Input, Select, Toggle, ConfirmDialog, EmptyState, Progress, Pagination, FilterSelect, SearchableSelect, DropdownMenu, Tooltip, MetricCard, RadioGroup, Textarea, Checkbox

### Known Bugs to Fix

| #   | Bug                                                            | Impact                                             | Card             |
| --- | -------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| B1  | `resolveScopes()` uses `Sites.FullControl.All`                 | Wrong scopes requested during auth                 | C-02, C-03, C-06 |
| B2  | SharePoint group ID != Azure AD group ID in permission crawler | Permission resolution fails for group-based access | C-06             |
| B3  | `grantedToV2.group` often not populated                        | Missing group membership data                      | C-06             |
| B4  | `getDrivePermissions()` defined but never called               | Drive-level permissions not resolved               | C-06             |
| B5  | Permission modes include "simplified"                          | Should be only "enabled"/"disabled"                | C-02, C-06       |
| B6  | Webhook operations are stubs                                   | No real-time change detection                      | C-08             |
| B7  | `pauseSync()`/`resumeSync()` throw "not implemented"           | Cannot pause/resume SharePoint syncs               | C-05, C-08       |
| B8  | Pod-local OAuth state store                                    | Violates Stateless Distributed invariant           | C-02             |
| B9  | `ConnectorSchema` not registered with ModelRegistry            | Cannot query via standard patterns                 | C-04             |
| B10 | `FieldMapping` not registered with ModelRegistry               | Cannot query via standard patterns                 | C-04             |

## 4. What Changes

### 4a. Components to REPLACE

**`EnterpriseConnectorWizard.tsx` (595 lines) --> `SharePointDetailPanel.tsx`**

The 5-step wizard is replaced by a tabbed Detail Panel that slides in from the right at 720px. The panel serves dual purposes: setup mode (new connector) and monitoring mode (existing connector). Tab routing is determined by connector status:

- Draft / Awaiting Auth --> Connect tab active, other tabs locked
- Active / Syncing / Error --> Overview tab active

**`ConnectorDetailPanel.tsx` (765 lines) --> merged into `SharePointDetailPanel.tsx`**

The old monitoring slide-over is merged into the unified panel's Overview tab. The new panel uses the `SlidePanel` design system component (fixing the existing inconsistency).

### 4b. Components to ENHANCE

**`SourcesTable.tsx` --> add card view, mixed types, bulk actions**

- Card view for 1-6 sources, table view for 7+, auto-switch on page load
- Card/table toggle persisted per-KB in localStorage
- Header bar with status counts ("N active . N warnings . N errors")
- Table toolbar: search, status filter, type filter, sort, group-by (None/Type/Status/Tenant)
- Quick filter pills: "Needs Attention (N)", "All Healthy (N)", "Token Warning (N)"
- SP-specific conditional columns (Sites, Token) when any SharePoint source exists
- Bulk actions (2+ selected): Pause, Resume, Sync Now, Delete; SP-conditional: Re-auth, Apply Schedule, Export Configs
- Aggregate summary bar with total sources by status, total docs, tokens expiring count

**`ConnectorFilterSection.tsx` --> split-pane with live preview**

- 60/40 split layout: controls left, preview right
- Auto-expand to full viewport on tab activation (300ms ease-out)
- Left panel: sites list, file type checkboxes, date range pickers, filter templates, folder rules, size limits, people/metadata fields, condition builder (15 operators, AND/OR, 1 nesting level)
- Right panel: summary counts, filter diff, undo/reset, sample documents, excluded documents with reasons, exclusion summary by category
- Advanced section: CEL expression editor, OData pre-filter display, filter audit table
- Pre-fetch vs post-fetch indicator per filter

**`AddSourceButton.tsx` --> integrate with new panel + multi-connector dialog**

- First SharePoint connector: type picker --> panel opens directly with Connect tab
- Second+ SharePoint connector: "How would you like to set up?" dialog with From Scratch, Clone Existing, From Template, Import Configuration, API/CLI reference

**`SetupGuide.tsx` --> Flow A redesign**

- "Connect Source" opens Add Source dialog on Home tab (no tab switch)
- After setup completes, navigates to Data tab > Sources with panel auto-opened on Overview

### 4c. Components to CREATE (NEW)

**Panel Infrastructure:**

- `SharePointDetailPanel.tsx` -- unified setup + monitoring panel shell with tab routing, expand/collapse, Simplified View toggle, More Actions menu, concurrent editing banner
- `useConnectorDetail.ts` -- SWR hook for connector data
- `useConnectorSync.ts` -- SWR hook for sync progress (polling)
- `useConnectorDiscovery.ts` -- SWR hook for discovery data
- `connector-store.ts` -- Zustand store for connector client state

**Connect Tab (C-02):**

- `ConnectTab.tsx` -- first-time vs returning experience, auth method selection, connection scopes display, type-to-confirm disable flow
- `AuthMethodSelector.tsx` -- radio cards (first-time) or radio options (returning)
- `ConnectionScopesDisplay.tsx` -- read-only scope checklist with disable trigger

**Configuration Proposal (C-03):**

- `ProposalTab.tsx` -- proposal generation progress, TOC with badges, section review
- `ProposalGenerationProgress.tsx` -- animated 9-item checklist with dependencies
- `ProposalSection.tsx` -- generic section wrapper with Accept/Modify/Skip buttons
- `ProposalScopeSection.tsx` -- Variant A (auto-discovery) and Variant B (Sites.Selected)
- `ProposalFiltersSection.tsx` -- filter summary + inline editor (Simplified View)
- `ProposalScheduleSection.tsx` -- schedule summary + inline editor
- `ProposalPermissionsSection.tsx` -- permission mode, accuracy breakdown, trust note
- `ProposalHealthCheckSection.tsx` -- 7-check validation with scope detection
- `ProposalSamplePreview.tsx` -- 20-document sample table with sensitivity labels
- `ProposalSecurityGate.tsx` -- approval gate with export
- `UserDecisionsLog.tsx` -- append-only decision history display

**Scope+Filters (C-04):**

- `ScopeFiltersSplitPane.tsx` -- 60/40 split layout wrapper
- `ScopeControlsPanel.tsx` -- left panel with all filter controls
- `ScopePreviewPanel.tsx` -- right panel with live preview
- `CELExpressionEditor.tsx` -- syntax-highlighted editor with autocomplete and validation
- `ConditionBuilder.tsx` -- field/operator/value builder with AND/OR grouping
- `FilterTemplateSelector.tsx` -- preset buttons (Documents Only, Tech Docs, Everything, Custom)

**Preview & Approve (C-05):**

- `PreviewTab.tsx` -- dry-run results with sample/skipped documents, content type breakdown
- `ApproveAndStart.tsx` -- configuration summary, action buttons, inline confirmation dialog
- `ContentTypeBreakdown.tsx` -- horizontal bar chart component

**Security Tab (C-06):**

- `SecurityTab.tsx` -- all security sections with Simplified View filtering
- `OAuthScopesSection.tsx` -- scope checklist with request/disable flows
- `TokenHealthDisplay.tsx` -- expiry countdown with warning states
- `EmergencyRevokeDialog.tsx` -- blast radius confirmation dialog
- `AuditLogTable.tsx` -- sortable, paginated, append-only audit log
- `SecurityReviewExport.tsx` -- PDF/JSON/YAML/Markdown export triggers
- `TypeToConfirmInput.tsx` -- reusable type-to-confirm component (used by Connect, Security, Multi-connector)

**Draft Mode (C-07):**

- Draft mode is a state of the panel shell + tabs, not a separate component. The panel header shows "(Draft)" suffix, Connect tab shows asterisk, info banner persists, locked tabs show lock icon overlays.

**Monitoring & Sync Progress (C-08):**

- `OverviewTab.tsx` -- KPIs, content freshness, permission sync status, config summary, sync history, issues, notifications, quick actions
- `SyncProgressView.tsx` -- replaces Overview content during active sync, overall + per-site progress bars, current document indicator
- `NotificationConfig.tsx` -- email toggle, webhook URL/test, event checkboxes
- `PermissionSyncStatus.tsx` -- coverage ratio, staleness warning, crawl now/schedule buttons

**Error & Empty States (C-11):**

- `ConnectorErrorState.tsx` -- dispatcher component that renders the correct error template (E1-E10) based on error type discriminator
- `ConnectorEmptyState.tsx` -- dispatcher for empty states (EM1-EM3)
- Per-error components: `AuthFailedError.tsx`, `DiscoveryTimeoutError.tsx`, `SyncFailureError.tsx`, `TokenExpiredError.tsx`, `PermissionRevokedError.tsx`, `ThrottledError.tsx`, `PartialSiteFailureError.tsx`, `ZeroSitesError.tsx`, `PopupBlockedError.tsx`, `AllUnsupportedError.tsx`

**Config Management & History (C-12):**

- `ConfigExportDialog.tsx` -- format selector, include checkboxes, preview pane, download/copy
- `VersionHistoryTab.tsx` -- version table, one-click diff, restore
- `ConfigDiffViewer.tsx` -- side-by-side or inline diff view
- `ConfigDriftSection.tsx` -- template drift detection with re-apply/update/ignore actions
- `ContentPurgeDialog.tsx` -- purge confirmation, progress (docs/chunks/vectors), cancel/retry

### 4d. Backend APIs to CREATE (NEW)

**Proposal Subsystem (20 endpoints):**

| Endpoint                                                     | Method | Purpose                         |
| ------------------------------------------------------------ | ------ | ------------------------------- |
| `/connectors/:id/proposal/status`                            | GET    | Poll generation progress        |
| `/connectors/:id/proposal`                                   | GET    | Get full proposal               |
| `/connectors/:id/proposal/sections/:sectionId/accept`        | POST   | Accept section                  |
| `/connectors/:id/proposal/sections/:sectionId`               | PUT    | Modify section                  |
| `/connectors/:id/proposal/sections/:sectionId/skip`          | POST   | Skip section                    |
| `/connectors/:id/proposal/accept-all`                        | POST   | Accept all remaining            |
| `/connectors/:id/proposal/approve`                           | POST   | Approve and start sync          |
| `/connectors/:id/proposal/scope/validate-sites`              | POST   | Validate Sites.Selected URLs    |
| `/connectors/:id/proposal/preview/refresh`                   | POST   | Refresh sample preview          |
| `/connectors/:id/proposal/sections/permissions/disable`      | POST   | Type-to-confirm disable         |
| `/connectors/:id/proposal/export`                            | GET    | Export proposal (PDF/JSON/YAML) |
| `/connectors/:id/proposal/sections/health-check/rerun`       | POST   | Re-run health check             |
| `/connectors/:id/proposal/security-gate/request-review`      | POST   | Request security review         |
| `/connectors/:id/proposal/security-gate/export`              | GET    | Export Security Gate PDF        |
| `/connectors/:id/proposal/scope/send-admin-request`          | POST   | Send admin access request       |
| `/connectors/:id/proposal/scope/admin-commands`              | GET    | Download PowerShell commands    |
| `/connectors/:id/proposal/scope/upgrade`                     | POST   | Upgrade to Sites.Read.All       |
| `/connectors/:id/proposal/permissions/request-document`      | GET    | Download permission request doc |
| `/connectors/:id/proposal/permissions/send-security-request` | POST   | Send security team request      |
| `/connectors/:id/proposal/permissions/upgrade`               | POST   | Upgrade to Permission-Aware     |
| `/connectors/:id/proposal/permissions/test`                  | POST   | Test permissions as user        |
| `/connectors/:id/proposal/abandon`                           | DELETE | Abandon connector setup         |
| `/connectors/:id/proposal/filters/preview`                   | POST   | Filter impact preview (inline)  |

**Audit & Security (9 endpoints):**

| Endpoint                                | Method | Purpose                         |
| --------------------------------------- | ------ | ------------------------------- |
| `/connectors/:id/audit-log`             | GET    | Paginated audit log             |
| `/connectors/:id/audit-log/export`      | GET    | Download full audit log         |
| `/connectors/:id/audit-log/subscribe`   | POST   | Subscribe to audit changes      |
| `/connectors/:id/emergency-revoke`      | POST   | Emergency token revoke          |
| `/connectors/:id/blast-radius`          | GET    | Blast radius for revoke dialog  |
| `/connectors/:id/security-review`       | POST   | Submit for security approval    |
| `/connectors/:id/security-export`       | POST   | Export security review document |
| `/connectors/:id/request-scope-upgrade` | POST   | Request GroupMember.Read.All    |
| `/org/settings/connector-policy`        | GET    | Get org self-approval policy    |

**Monitoring & Progress (5 endpoints):**

| Endpoint                                     | Method | Purpose                          |
| -------------------------------------------- | ------ | -------------------------------- |
| `/connectors/:id/content-breakdown`          | GET    | By-type and by-site aggregations |
| `/connectors/:id/sync-history`               | GET    | Paginated sync history           |
| `/connectors/:id/notifications`              | PUT    | Save notification preferences    |
| `/connectors/:id/notifications/test-webhook` | POST   | Test webhook URL                 |
| `/connectors/:id/permission-schedule`        | PUT    | Set permission crawl schedule    |

**Config Management (14 endpoints):**

| Endpoint                                          | Method | Purpose                      |
| ------------------------------------------------- | ------ | ---------------------------- |
| `/connectors/:id/config/export`                   | GET    | Export with field selection  |
| `/connectors/:id/config/versions`                 | GET    | Paginated version history    |
| `/connectors/:id/config/versions/:versionId`      | GET    | Version snapshot             |
| `/connectors/:id/config/diff`                     | GET    | Diff between versions        |
| `/connectors/:id/config/restore`                  | POST   | Restore to version           |
| `/connectors/:id/config/drift`                    | GET    | Template drift detection     |
| `/connectors/:id/config/drift/reapply-template`   | POST   | Re-apply template            |
| `/connectors/:id/config/drift/update-template`    | POST   | Update template from current |
| `/connectors/:id/config/drift/ignore`             | POST   | Suppress drift notice        |
| `/connectors/:id/config/import`                   | POST   | Import config (preview)      |
| `/connectors/:id/config/import/confirm`           | POST   | Confirm import               |
| `/connectors/:id/content/purge`                   | POST   | Initiate content purge       |
| `/connectors/:id/content/purge/:cleanupId`        | GET    | Poll purge progress          |
| `/connectors/:id/content/purge/:cleanupId/cancel` | POST   | Cancel purge                 |

**Multi-Connector (5 endpoints):**

| Endpoint                    | Method | Purpose                        |
| --------------------------- | ------ | ------------------------------ |
| `/connectors/:id/clone`     | POST   | Clone connector                |
| `/connector-templates`      | GET    | List templates                 |
| `/connector-templates`      | POST   | Create template from connector |
| `/connectors/from-template` | POST   | Create from template           |
| `/connectors/import`        | POST   | Import configuration           |

**Error Recovery & Misc (7 endpoints):**

| Endpoint                            | Method | Purpose                     |
| ----------------------------------- | ------ | --------------------------- |
| `/connectors/:id/retry`             | POST   | Multi-action retry          |
| `/connectors/:id/check-site-access` | POST   | Check manual site URL       |
| `/connectors/:id/filter-analysis`   | GET    | Filter exclusion breakdown  |
| `/connectors/:id/site-statuses`     | GET    | Per-site sync results       |
| `/connectors/:id/summary`           | GET    | Config summary for approval |
| `/connectors/check-name`            | GET    | Name uniqueness check       |
| `/connectors/generate-admin-email`  | POST   | Generate IT admin email     |
| `/sources/bulk`                     | POST   | Bulk source actions         |
| `/connectors/:id/active-editors`    | GET    | Concurrent editing presence |

### 4e. Backend Code to FIX

| Bug                                                 | File(s)                           | Fix                                                       |
| --------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| B1: `resolveScopes()` uses `Sites.FullControl.All`  | `packages/connectors/sharepoint/` | Replace with `Sites.Read.All` + `Files.Read.All`          |
| B2: SharePoint group ID != Azure AD group ID        | Permission crawler service        | Map SharePoint group IDs to Azure AD via Graph API lookup |
| B3: `grantedToV2.group` not populated               | Permission crawler service        | Handle missing field, fall back to group name resolution  |
| B4: `getDrivePermissions()` never called            | SharePoint connector service      | Wire into the permission crawl flow                       |
| B5: Permission modes include "simplified"           | Connector config model + UI       | Remove "simplified", enforce "enabled"/"disabled" only    |
| B7: `pauseSync()`/`resumeSync()` not implemented    | SharePoint connector              | Implement pause/resume via BullMQ job lifecycle           |
| B8: Pod-local OAuth state store                     | Auth service                      | Move state to Redis (SET NX PX pattern)                   |
| B9/B10: ConnectorSchema/FieldMapping not registered | Model files                       | Add to ModelRegistry                                      |

### 4f. Models to CREATE

**`ConnectorAuditEntry`** -- Immutable audit log for connector operations

```
{
  _id, connectorId, tenantId, projectId,
  timestamp: Date,
  actor: string (email or "system"),
  event: string,
  metadata: Record<string, any>
}
```

**`ConnectorConfigVersion`** -- Config version history with snapshots

```
{
  _id, connectorId, tenantId, projectId,
  version: string (e.g., "v5"),
  config: object (full config snapshot),
  changedBy: string,
  summary: string,
  createdAt: Date
}
```

**`ProposalState`** -- Proposal generation state and section review status

```
{
  _id, connectorId, tenantId, projectId,
  status: "generating" | "ready" | "failed",
  generationSteps: [{ id, label, status, statusText }],
  sections: { [sectionId]: { status, data, reviewedAt, reviewedBy } },
  decisions: [{ timestamp, user, section, decision, detail }],
  generatedAt: Date
}
```

**`ConnectorTemplate`** -- Reusable connector configuration template

```
{
  _id, tenantId, projectId,
  name: string,
  description?: string,
  config: object (scope, filters, schedule, permissionMode),
  createdBy: string,
  usageCount: number,
  createdAt: Date, updatedAt: Date
}
```

**`NotificationSubscription`** -- Per-connector notification preferences

```
{
  _id, connectorId, tenantId, projectId, userId,
  emailEnabled: boolean,
  emailEvents: string[],
  webhookUrl?: string,
  webhookEvents: string[],
  createdAt: Date, updatedAt: Date
}
```

### 4g. Frontend Infrastructure

**SWR Hooks (replace imperative fetches):**

- `useConnector(connectorId)` -- connector detail with revalidation
- `useConnectorList(kbId, filters)` -- sources list with search/filter/pagination
- `useConnectorSync(connectorId)` -- sync status, polls during active sync
- `useConnectorDiscovery(connectorId)` -- discovery data
- `useConnectorProposal(connectorId)` -- proposal state
- `useConnectorAuditLog(connectorId, pagination)` -- paginated audit entries
- `useConnectorVersions(connectorId, pagination)` -- version history

**Zustand Store:**

- `useConnectorStore` -- panel open/close state, active connector ID, active tab, Simplified View toggle, expand state, filter editor undo history, proposal generation polling state

**WebSocket/SSE (future, polling first):**

- Sync progress real-time updates (polling at 2-5s for v1)
- Concurrent editing presence (polling at 30-60s for v1)

## 5. Architecture Diagram

```
KB Detail Page
  |
  +-- Home Tab
  |     +-- SetupGuide
  |           +-- [Connect Source] --> AddSourceDialog (on Home tab, no tab switch)
  |                                     |
  |                                     +--> SharePointDetailPanel (slides in 720px)
  |
  +-- Data Tab
        +-- Sources Segment
              +-- SourcesTable  ........... ENHANCED (card/table, bulk actions)
              |     |
              |     +-- [+ Add Source] --> AddSourceDialog
              |     |                       |
              |     |                       +--> (1st SP) Direct to panel
              |     |                       +--> (2nd+ SP) Multi-connector dialog
              |     |                             +-- From Scratch
              |     |                             +-- Clone Existing ....... NEW
              |     |                             +-- From Template ........ NEW
              |     |                             +-- Import Config ........ NEW
              |     |                             +-- API/CLI Reference
              |     |
              |     +-- [Row Click] --> SharePointDetailPanel
              |
              +-- SharePointDetailPanel .......................... NEW (replaces Wizard + old DetailPanel)
                    |
                    +-- [Simplified View Toggle] (localStorage)
                    +-- [Expand/Collapse <>]
                    +-- [More Actions: Clone, Export, Import, Health Check, Diagnostics, Delete]
                    +-- [Concurrent Editing Banner] .............. NEW (presence API)
                    |
                    +-- Setup Mode (Draft/Awaiting Auth):
                    |     +-- Connect Tab ........................ NEW
                    |     |     +-- First-time: welcome + 2 radio cards
                    |     |     +-- Returning: compact form + 3 auth methods
                    |     |     +-- Connection scopes + type-to-confirm disable
                    |     |     +-- API: auth/initiate, auth/status
                    |     |
                    |     +-- Proposal Tab ....................... NEW
                    |     |     +-- Generation progress (9-item animated checklist)
                    |     |     +-- TOC with badges (8 sections)
                    |     |     +-- Per-section: Accept/Modify/Skip
                    |     |     +-- Accept All Remaining
                    |     |     +-- API: proposal/* (20 endpoints)
                    |     |
                    |     +-- Scope+Filters Tab .................. ENHANCED
                    |     |     +-- Split-pane 60/40 (auto-expand to full viewport)
                    |     |     +-- Left: sites, types, dates, templates, folders, size, metadata, CEL
                    |     |     +-- Right: counts, diff, samples, excluded, audit
                    |     |     +-- API: discovery, filters/preview
                    |     |
                    |     +-- Preview Tab ........................ NEW
                    |     |     +-- Dry-run: doc count, skip count, size, time range
                    |     |     +-- Sample documents (25), skipped (10), content type chart
                    |     |     +-- Approve & Start: config summary + 3 actions
                    |     |     +-- API: preview, summary, sync/start
                    |     |
                    |     +-- Security Tab ....................... NEW
                    |     |     +-- Scopes, token health, access/no-access, data residency
                    |     |     +-- Emergency revoke, blast radius, audit log
                    |     |     +-- Approval gate, compliance export (PDF/JSON/YAML/MD)
                    |     |     +-- API: audit-log, emergency-revoke, security-export
                    |     |
                    |     +-- History Tab (Full View only) ....... NEW
                    |           +-- Version table, one-click diff, restore
                    |           +-- Config drift detection
                    |           +-- Export/import, content purge (danger zone)
                    |           +-- API: config/versions, config/diff, content/purge
                    |
                    +-- Monitoring Mode (Active/Syncing/Error):
                          +-- Overview Tab ...................... NEW (replaces old DetailPanel)
                          |     +-- KPIs, content freshness, permission sync
                          |     +-- Config summary, sync history, issues, notifications
                          |     +-- Quick actions bar
                          |     +-- API: overview, content-breakdown, sync-history
                          |
                          +-- (Same tabs as Setup for editing)

BACKEND DATA FLOW:

  SharePointDetailPanel
    |
    +-- SWR Hooks ................... NEW
    |     +-- useConnector() -----> GET /connectors/:id
    |     +-- useConnectorSync() -> GET /connectors/:id/sync/status  (poll 2-5s)
    |     +-- useConnectorProposal() -> GET /connectors/:id/proposal
    |
    +-- Zustand Store .............. NEW
    |     +-- panelState, activeTab, simplifiedView, expandState
    |
    +-- REST API
          |
          +-- connectors.ts routes (37 EXISTING + ~60 NEW)
          |     |
          |     +-- ConnectorService (EXISTING, enhanced)
          |     +-- ProposalService ............. NEW
          |     +-- AuditService ................ NEW
          |     +-- ConfigVersionService ........ NEW
          |     +-- TemplateService ............. NEW
          |     +-- NotificationService ......... NEW
          |
          +-- Models
                +-- ConnectorConfig ........... EXISTING
                +-- ConnectorDiscovery ........ EXISTING
                +-- ProposalState ............. NEW
                +-- ConnectorAuditEntry ....... NEW
                +-- ConnectorConfigVersion .... NEW
                +-- ConnectorTemplate ......... NEW
                +-- NotificationSubscription .. NEW
```

## 6. Data Flow

### Setup Flow (new connector)

```
Flow A (Home) / Flow C (Data tab)
  |
  v
AddSourceDialog --> picks SharePoint
  |
  v
POST /connectors (status: "draft") --> connectorId created
  |
  v
SharePointDetailPanel opens --> Connect tab active
  |
  +-- User fills auth details
  +-- POST /auth/initiate --> redirectUrl or deviceCode
  +-- Poll GET /auth/status until "completed"
  |
  v
Auth Complete --> Proposal generation begins
  |
  +-- GET /proposal/status (poll 2-3s, 30-90s total)
  +-- 9 steps: Connection > Scopes > Health > Scope > Filters > Schedule > Permissions > Preview > Security
  |
  v
Proposal Ready --> Review sections
  |
  +-- For each section: POST .../accept or PUT .../modify or POST .../skip
  +-- (Or: POST /proposal/accept-all for quick setup)
  |
  v
All Sections Reviewed --> Preview tab
  |
  +-- POST /preview (dry-run counts, samples)
  +-- User reviews results
  |
  v
Approve & Start
  |
  +-- POST /proposal/approve --> syncJobId
  +-- Panel switches to Overview tab
  +-- GET /sync/progress (poll 2-5s for progress)
  |
  v
Sync Complete --> Overview with fresh data
```

### Monitoring Flow (existing connector)

```
Flow D (Data tab) --> Click row in SourcesTable
  |
  v
GET /connectors/:id --> status determines initial tab
  |
  +-- Active/Healthy --> Overview tab
  |     +-- GET /overview (KPIs, <500ms)
  |     +-- GET /content-breakdown (1-2s)
  |     +-- GET /sync-history (1-3s)
  |
  +-- Syncing --> Overview tab (sync progress view)
  |     +-- GET /sync/progress (poll 2-5s)
  |     +-- Per-site progress, current document, ETA
  |
  +-- Error --> Overview tab (error state)
  |     +-- Error type discriminator determines template (E1-E10)
  |     +-- Action buttons: retry, re-auth, resume, etc.
  |
  +-- Draft/Awaiting Auth --> Connect tab (resume setup)
        +-- All draft config preserved, resume from where left off
```

### Draft Mode Flow (configure-before-auth)

```
Connector created (status: "draft")
  |
  v
Connect tab: auth initiated but not yet complete
  |
  v
User navigates to Scope+Filters tab
  +-- Sites section: disabled ("Will be populated after auth")
  +-- Filters section: fully editable (file types, templates, folders, size)
  +-- Schedule section: fully editable (frequency dropdown)
  +-- Permissions section: fully editable (permission-aware toggle)
  |
  v
PATCH /connectors/:id (auto-save on field change, debounced)
  |
  v
Auth completes (detected via polling)
  +-- "(Draft)" removed from header
  +-- Sites section populates from discovery
  +-- Pre-configured settings applied to proposal generation
  +-- Proposal tab unlocks
```

## 7. Integration Points

### New Detail Panel <-> SourcesTable

- Panel opens via row click in SourcesTable (same `connectorMap` pattern)
- `connectorMap` maps `source._id` to `connectorId` for routing
- SharePoint sources route to `SharePointDetailPanel`; other types to existing `SourceDetailPanel`
- On sync completion inside panel, SourcesTable refreshes (SWR cache invalidation via `mutate`)

### New SWR Hooks <-> Existing Imperative Fetches

- New SWR hooks replace all `fetch()`/`axios` calls for connector data
- Shared SWR cache means multiple components see the same data without redundant fetches
- `mutate()` calls after write operations (accept section, start sync, etc.) trigger revalidation

### New Proposal API <-> Existing Discovery/Recommendation

- Proposal generation orchestrates existing discovery (`POST /discover`) and recommendation (`POST /recommendations`) endpoints
- Proposal Scope section builds on discovery results
- Proposal Filters section reuses filter preview endpoint (`POST /filters/preview`)
- Proposal is a new layer on top of existing backend capabilities

### New Audit Log <-> Existing Operations

- Every existing mutating operation (create, update, delete, auth, sync start/stop) writes an audit entry
- Audit entries are created as side effects in service methods (middleware or event-driven)
- The audit log model is append-only; the UI reads via paginated GET

### Config Versioning <-> Existing Connector Updates

- Every `PUT /connectors/:id` that changes configuration creates a new `ConnectorConfigVersion`
- The existing update flow is wrapped with version creation logic
- Restoring a version calls the same update path, creating a new version (immutable history)

### Simplified View <-> Tab Content

- Panel shell manages `simplifiedView` state (localStorage, per-user)
- Child tab components receive `simplifiedView` as prop/context
- When ON: Security tab hides advanced sections, "pipeline" replaced with "system", CEL/OData hidden
- When ON: Scope+Filters and History tabs hidden from tab bar
- Proposal tab shows inline editors instead of routing to full tabs

## 8. Task Decomposition

| Task                                      | Description                                                                        | Package(s)                           | Independent?    | Est. Files | Priority |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | --------------- | ---------- | -------- |
| **Wave 1: Foundation**                    |                                                                                    |                                      |                 |            |          |
| T-01                                      | Fix `resolveScopes()` + permission mode "simplified" bug                           | `connectors/sharepoint`, `search-ai` | Yes             | 3-4        | P0       |
| T-02                                      | Fix `pauseSync()`/`resumeSync()` implementation                                    | `connectors/sharepoint`              | Yes             | 2-3        | P0       |
| T-03                                      | Move OAuth state from pod-local to Redis                                           | `search-ai` (auth service)           | Yes             | 2-3        | P0       |
| T-04                                      | Register `ConnectorSchema` + `FieldMapping` with ModelRegistry                     | `search-ai` (models)                 | Yes             | 2          | P0       |
| T-05                                      | Fix permission crawler (group ID, grantedToV2, getDrivePermissions)                | `connectors/sharepoint`              | Yes             | 3-4        | P0       |
| T-06                                      | Create `ConnectorAuditEntry` model + audit log routes                              | `search-ai`                          | Yes             | 5-6        | P0       |
| T-07                                      | Create `ConnectorConfigVersion` model + version routes                             | `search-ai`                          | Yes             | 5-6        | P0       |
| T-08                                      | Create SWR hooks (`useConnector`, `useConnectorList`, `useConnectorSync`)          | `studio`                             | Yes             | 4-5        | P0       |
| T-09                                      | Create Zustand connector store                                                     | `studio`                             | Yes             | 2-3        | P0       |
| T-10                                      | Create `SharePointDetailPanel` shell (tabs, expand, Simplified View, More Actions) | `studio`                             | Dep: T-08, T-09 | 4-5        | P0       |
| T-11                                      | Create `TypeToConfirmInput` reusable component                                     | `studio`                             | Yes             | 1-2        | P0       |
| T-12                                      | Remove orphaned `ConnectorsTab.tsx`                                                | `studio`                             | Yes             | 1          | P1       |
| **Wave 2: Setup Flow**                    |                                                                                    |                                      |                 |            |          |
| T-13                                      | Create Connect Tab (first-time + returning UX, auth method selection)              | `studio`                             | Dep: T-10       | 3-4        | P0       |
| T-14                                      | Create `ProposalState` model + proposal generation service                         | `search-ai`                          | Yes             | 8-10       | P0       |
| T-15                                      | Create proposal routes (20 endpoints)                                              | `search-ai`                          | Dep: T-14       | 6-8        | P0       |
| T-16                                      | Create Proposal Tab (generation progress, TOC, section review)                     | `studio`                             | Dep: T-10, T-15 | 8-10       | P0       |
| T-17                                      | Create Scope+Filters split-pane (controls + preview panels)                        | `studio`                             | Dep: T-10, T-08 | 8-10       | P0       |
| T-18                                      | Create `CELExpressionEditor` with autocomplete + validation                        | `studio`                             | Yes             | 3-4        | P1       |
| T-19                                      | Create `ConditionBuilder` with 15 operators + AND/OR                               | `studio`                             | Yes             | 3-4        | P1       |
| T-20                                      | Create Preview Tab (dry-run, content type breakdown)                               | `studio`                             | Dep: T-10       | 4-5        | P0       |
| T-21                                      | Create Approve & Start view (summary, 3 actions, confirmation dialog)              | `studio`                             | Dep: T-20       | 3-4        | P0       |
| T-22                                      | Create Connection scopes display + disable flow                                    | `studio`                             | Dep: T-11, T-13 | 2-3        | P0       |
| T-23                                      | Wire Flow A (SetupGuide opens dialog on Home tab)                                  | `studio`                             | Dep: T-10       | 2-3        | P0       |
| T-24                                      | Wire Flow D (SourcesTable row click opens panel with correct tab)                  | `studio`                             | Dep: T-10       | 2-3        | P0       |
| T-25                                      | Backend: name uniqueness check + admin email generation                            | `search-ai`                          | Yes             | 2-3        | P1       |
| **Wave 3: Monitoring**                    |                                                                                    |                                      |                 |            |          |
| T-26                                      | Create Overview Tab (KPIs, config summary, sync history)                           | `studio`                             | Dep: T-10       | 6-8        | P0       |
| T-27                                      | Create Sync Progress view (overall + per-site bars, current doc)                   | `studio`                             | Dep: T-26       | 4-5        | P0       |
| T-28                                      | Backend: overview, content-breakdown, sync-history routes                          | `search-ai`                          | Yes             | 5-6        | P0       |
| T-29                                      | Backend: enhanced sync-progress with per-site data                                 | `search-ai`                          | Dep: T-02       | 3-4        | P0       |
| T-30                                      | Create Notification config (email toggle, webhook, events)                         | `studio`                             | Dep: T-26       | 3-4        | P1       |
| T-31                                      | Backend: notification preferences + test-webhook routes                            | `search-ai`                          | Yes             | 4-5        | P1       |
| T-32                                      | Create Permission Sync Status section (crawl now, schedule)                        | `studio`                             | Dep: T-26       | 2-3        | P1       |
| T-33                                      | Backend: permission-schedule route                                                 | `search-ai`                          | Yes             | 2-3        | P1       |
| T-34                                      | Create error state components (E1-E10)                                             | `studio`                             | Dep: T-26       | 6-8        | P0       |
| T-35                                      | Create empty state components (EM1-EM3)                                            | `studio`                             | Dep: T-26       | 3-4        | P0       |
| T-36                                      | Backend: error discriminator enrichment + retry routes                             | `search-ai`                          | Yes             | 4-5        | P0       |
| T-37                                      | Backend: site-statuses, filter-analysis, check-site-access routes                  | `search-ai`                          | Yes             | 3-4        | P0       |
| **Wave 4: Fleet Ops & Config Management** |                                                                                    |                                      |                 |            |          |
| T-38                                      | Enhance SourcesTable (card view, status counts, conditional columns)               | `studio`                             | Dep: T-08       | 6-8        | P0       |
| T-39                                      | SourcesTable bulk actions UI                                                       | `studio`                             | Dep: T-38       | 3-4        | P1       |
| T-40                                      | SourcesTable grouping + quick filter pills                                         | `studio`                             | Dep: T-38       | 3-4        | P1       |
| T-41                                      | Backend: enhanced list sources (search, filters, groupBy, aggregates)              | `search-ai`                          | Yes             | 4-5        | P0       |
| T-42                                      | Backend: bulk actions route                                                        | `search-ai`                          | Yes             | 3-4        | P1       |
| T-43                                      | Create Security Tab (scopes, token, emergency revoke, audit log)                   | `studio`                             | Dep: T-10, T-06 | 8-10       | P0       |
| T-44                                      | Backend: emergency-revoke, blast-radius, security-export routes                    | `search-ai`                          | Dep: T-06       | 4-5        | P0       |
| T-45                                      | Create Config Export dialog (format, checkboxes, preview, download/copy)           | `studio`                             | Dep: T-10       | 3-4        | P1       |
| T-46                                      | Create Version History tab (table, diff, restore)                                  | `studio`                             | Dep: T-10, T-07 | 5-6        | P1       |
| T-47                                      | Create Config Drift section                                                        | `studio`                             | Dep: T-46       | 3-4        | P2       |
| T-48                                      | Create Content Purge dialog (progress, cancel, retry)                              | `studio`                             | Dep: T-10       | 3-4        | P1       |
| T-49                                      | Backend: config export, drift, import routes                                       | `search-ai`                          | Dep: T-07       | 4-5        | P1       |
| T-50                                      | Backend: content purge routes                                                      | `search-ai`                          | Yes             | 4-5        | P1       |
| T-51                                      | Create multi-connector dialog (clone, template, import)                            | `studio`                             | Dep: T-10       | 5-6        | P1       |
| T-52                                      | Backend: clone, template CRUD, import routes                                       | `search-ai`                          | Yes             | 6-8        | P1       |
| T-53                                      | Create `ConnectorTemplate` model                                                   | `search-ai`                          | Yes             | 2-3        | P1       |
| T-54                                      | Create `NotificationSubscription` model                                            | `search-ai`                          | Yes             | 2-3        | P1       |
| T-55                                      | Backend: concurrent editing presence endpoint                                      | `search-ai`                          | Yes             | 2-3        | P2       |
| T-56                                      | Backend: org-level connector policy endpoint                                       | `search-ai`                          | Yes             | 2-3        | P2       |
| T-57                                      | Draft mode support (panel header, tab locking, info banner, auto-save)             | `studio`                             | Dep: T-10, T-13 | 3-4        | P0       |

### Implementation Waves

**Wave 1: Foundation (T-01 to T-12) -- ~15-20 files**
Backend bug fixes, new models, SWR hooks, Zustand store, panel shell. All tasks are independent except T-10 which depends on T-08 and T-09. This wave makes the codebase ready for feature work.

**Wave 2: Setup Flow (T-13 to T-25) -- ~40-55 files**
The complete new connector setup experience: Connect, Proposal, Scope+Filters, Preview, Approve. The proposal subsystem (T-14, T-15, T-16) is the largest single effort. T-17 (split-pane) is the most complex frontend component.

**Wave 3: Monitoring (T-26 to T-37) -- ~35-50 files**
Post-setup experience: Overview with KPIs, sync progress with per-site bars, notifications, permission sync, error/empty states. T-34 (10 error state components) is the most breadth.

**Wave 4: Fleet Ops & Config Management (T-38 to T-57) -- ~45-60 files**
SourcesTable enhancements, bulk actions, Security tab, config versioning/export/drift, multi-connector management, content purge. Most tasks are P1/P2 and can be delivered incrementally.

## 9. Risks & Mitigations

| #   | Risk                                                                               | Impact                                          | Mitigation                                                                                                                       |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Proposal generation takes 30-90s, requires orchestrating 9 dependent steps         | UX feels slow, complexity in step dependencies  | Animated progress checklist shows real-time status; sections appear incrementally; draft mode lets users configure while waiting |
| R2  | 46 "Not Found" API endpoints represent significant backend effort                  | Scope creep, delayed delivery                   | Prioritize P0 endpoints (proposal, overview, sync progress); stub P1/P2 endpoints; implement waves sequentially                  |
| R3  | CEL expression editor needs syntax highlighting, autocomplete, and validation      | Custom editor is complex to build               | Consider integrating Monaco Editor or CodeMirror with CEL grammar; start with basic textarea + validate button                   |
| R4  | Real-time sync progress polling at 2-5s creates server load                        | API load during concurrent syncs                | Use SWR with `refreshInterval`; consider SSE for sync progress in a later phase; backend should cache progress data              |
| R5  | Concurrent editing detection requires presence infrastructure                      | False positives/negatives in the editing banner | Start with simple polling (30-60s) using a last-active timestamp; defer WebSocket presence to Phase 2                            |
| R6  | Config version history grows indefinitely                                          | Storage growth, slow queries                    | Add configurable retention policy (e.g., keep last 100 versions); pagination on all history queries                              |
| R7  | Emergency revoke is a complex atomic operation (pause + revoke + cleanup + notify) | Partial failures leave inconsistent state       | Implement as a saga pattern with compensating actions; record each step in audit log; show partial success state in UI           |
| R8  | Content purge deletes docs, chunks, and vector embeddings                          | Accidental data loss                            | Confirmation dialog with document count; optional type-to-confirm; purge rejected while sync is running                          |
| R9  | Panel at 720px + full-viewport expand creates responsive layout challenges         | Broken layouts on small screens                 | Full-screen panel on viewports < 768px; test expand animation on various screen sizes                                            |
| R10 | Existing OAuth state is pod-local; migration to Redis could break in-flight auths  | Auth failures during migration                  | Deploy Redis-based store alongside pod-local; feature flag to switch; drain in-flight auths before cutover                       |

## 10. Out of Scope

- **Delegation flow** -- The design wireframes include a "Someone else will authenticate" radio card, delegation invite generation, countdown timer, and resume state. All intentionally excluded per user scope decision. Can be added as a separate feature later.
- **Email notifications** -- The design mentions email alerts for sync failure, token expiry, etc. PDF export is the compliance delivery mechanism for v1. Email infrastructure (AWS SES/Resend/SMTP) is a separate concern.
- **Non-SharePoint connector types** -- This panel is exclusively for SharePoint connectors. Other source types (Web Crawl, File Upload, API, Database) continue using the existing `SourceDetailPanel`.
- **Webhook delivery infrastructure** -- Retry logic, dead letter queues, and delivery guarantees for webhook notifications are backend infrastructure concerns beyond the UX scope.
- **Template CRUD management UI** -- Creating templates from connectors and applying templates during setup is in scope. A dedicated template management page (editing, deleting, versioning templates) is not.
- **Graph API throttling strategy** -- The error state E6 shows throttle countdown, but the actual retry algorithm and backoff strategy are backend concerns.
- **Admin consent flow internals** -- Azure AD consent screens are external to the platform UI.
- **Config scheduling/automation** -- Automated config changes based on rules or triggers are deferred.
- **Items explicitly marked P2 in design** -- Config drift detection (P2), concurrent editing presence (P2), org-level connector policy (P2) are deferred but included in the task list for planning purposes.
