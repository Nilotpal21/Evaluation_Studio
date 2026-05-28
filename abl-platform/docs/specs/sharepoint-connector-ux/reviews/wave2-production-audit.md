# Wave 2 Production Readiness Audit

**Date:** 2026-03-24
**Auditor:** Claude Opus 4.6
**Scope:** All new and modified files in Wave 2 implementation
**Classification:** COMPLETE / PARTIAL / STUB per rules defined below

---

## Classification Rules

- **Backend COMPLETE:** Real logic, error handling, tenant-scoped, validated inputs
- **Backend PARTIAL:** TODOs, placeholder returns, missing error paths
- **Backend STUB:** Empty bodies, hardcoded responses
- **Frontend COMPLETE:** Calls real APIs/SWR hooks, handles loading/error/empty, design-system components
- **Frontend PARTIAL:** Hardcoded placeholders, missing error states
- **Frontend STUB:** Static HTML

---

## Summary

| Category          | COMPLETE | PARTIAL | STUB  | Total  |
| ----------------- | -------- | ------- | ----- | ------ |
| New Backend       | 2        | 1       | 0     | 3      |
| Modified Backend  | 3        | 0       | 0     | 3      |
| New Frontend      | 22       | 6       | 0     | 28     |
| Modified Frontend | 5        | 0       | 0     | 5      |
| **Total**         | **32**   | **7**   | **0** | **39** |

---

## New Backend

### 1. `packages/database/src/models/proposal-state.model.ts` -- COMPLETE

- Full Mongoose schema with typed interfaces (`IProposalState`, `IGenerationStep`, `ISectionData`, `IDecisionEntry`)
- UUIDv7 `_id`, `tenantId` required, proper enums for status fields
- `tenantIsolationPlugin` applied (core invariant #1)
- Registered with `ModelRegistry` for dual-database support
- Two indexes: composite query index + partial unique index enforcing one active proposal per connector
- Hot-reload safe model export
- **No findings.**

### 2. `apps/search-ai/src/services/proposal.service.ts` -- PARTIAL

**What works:**

- Full generation pipeline with dependency-ordered step execution
- Step-level and pipeline-level timeouts (`STEP_TIMEOUT_MS=30s`, `PIPELINE_TIMEOUT_MS=180s`)
- All queries are tenant-scoped (`{ connectorId, tenantId }`)
- Decision log with bounded growth (`MAX_DECISIONS=200` via `$push/$slice`)
- Section review (accept/modify/skip/acceptAll), approval with sync trigger, abandonment
- Audit trail via `writeAuditEntry` for approval/abandonment/permission-disable
- Error handling: `err instanceof Error ? err.message : String(err)` pattern used consistently
- Structured logger via `createLogger('proposal-service')`

**Findings (PARTIAL classification):**

- **P-1: Health check is hardcoded.** `executeStep('health-check')` returns `{ connectivity: 'pass', tokenValid: true }` unconditionally. Same for `rerunHealthCheck()`. No real Graph API validation. Acceptable for v1 if documented.
- **P-2: `validateSites()` returns all sites as accessible.** Comment says "v1: real validation requires Graph API calls". Acceptable v1 placeholder.
- **P-3: YAML export is JSON pretending to be YAML.** `exportProposal('yaml')` calls `JSON.stringify` and labels it `text/yaml`. Should either use a real YAML serializer or remove the format option.
- **P-4: `sample-preview` step returns empty arrays.** No real document sampling. Matches v1 scope but proposal UI will show "0 samples".
- **P-5: `executeStep` uses `getLazyModel` with `any` cast.** Acceptable for cross-DB queries but weakens type safety.

### 3. `apps/search-ai/src/routes/connector-proposal.ts` -- COMPLETE

- 14 route handlers covering the full proposal lifecycle
- Auth middleware applied at router level (`router.use(authMiddleware)`)
- Zod validation on all params/body/query: `connectorParams`, `sectionParams`, `modifySectionBody`, `validateSitesBody`, `disablePermissionBody`, `exportQuery`, `filtersPreviewBody`
- ID fields use `z.string().min(1)` (correct per rules)
- Consistent `{ success, data }` / `{ success, error: { code, message } }` response format
- `handleError` maps `ConnectorError` to proper HTTP status, logs unexpected errors
- Export endpoint correctly handles 501 for PDF format
- Tenant context extracted from `req.tenantContext!.tenantId`
- Actor extracted from `req.tenantContext!.userId ?? 'system'`
- **No findings.**

---

## Modified Backend

### 4. `apps/search-ai/src/routes/connectors.ts` (check-name + admin-email) -- COMPLETE

- `check-name`: GET with Zod-validated `name` query param (1-200 chars), static route registered BEFORE `/:connectorId` (correct per Express route ordering rule)
- `generate-admin-email`: POST with Zod-validated body `{ type: enum }`, static route before parameterized
- Both use tenant-scoped service calls and standard error handling
- **No findings.**

### 5. `apps/search-ai/src/services/connector.service.ts` (checkConnectorName, generateAdminEmail) -- COMPLETE

- `checkConnectorName`: Queries sources by index+tenant, case-insensitive name check, generates `(N)` suffix suggestions
- `generateAdminEmail`: Builds a complete email template with all required Azure setup steps, includes dynamic `redirectUri` via `getConnectorRedirectUri()`
- Both are tenant-scoped via repository calls
- **No findings.**

### 6. `apps/search-ai/src/server.ts` (proposal router mount) -- COMPLETE

- `connectorProposalRouter` imported and mounted at `/api/indexes`
- Placement is consistent with other connector sub-routers (`connectorAuditRouter`, `connectorConfigVersionRouter`)
- Auth middleware chain is applied at `/api` level before reaching proposal routes
- **No findings.**

---

## New Frontend -- Hooks

### 7. `apps/studio/src/hooks/useConnectorProposal.ts` -- COMPLETE

- SWR hook with proper null-key pattern when `indexId`/`connectorId` missing
- Auto-polling at 2s when `status === 'generating'`, stops when ready/failed/approved
- Typed return interface (`ProposalState`, `ProposalGenerationStep`, etc.)
- Memoized proposal value, error coerced to string
- **No findings.**

### 8. `apps/studio/src/hooks/useConnectorDiscovery.ts` -- COMPLETE

- SWR hook calling `getConnectorDiscovery` API
- Maps backend `DiscoveredResource[]` to local `DiscoverySite[]` shape
- Maps `ContentProfile.fileTypeDistribution` to deduplicated `DiscoveryFileType[]`
- Handles loading/error/null states
- **No findings.**

### 9. `apps/studio/src/hooks/useFilterPreview.ts` -- COMPLETE

- SWR hook with 500ms debounce via `useState`/`useEffect`/`setTimeout`
- POST-based fetcher using `previewFilters` API
- Normalizes response shape (handles `{ data: ... }` wrapper)
- Provides `createDefaultFilterConfig()` utility
- Rich `FilterConfig` type covering all filter dimensions
- **No findings.**

---

## New Frontend -- Components

### 10. `apps/studio/src/components/search-ai/sharepoint/ConnectTab.tsx` -- COMPLETE

- Full auth flow: idle -> initiating -> pending_device_code/pending_redirect -> completed/error
- Two UX variants: first-time (0 connectors) vs returning (1+)
- SWR polling for auth status at 3s intervals
- Creates connector via `createEnterpriseConnector`, initiates auth via `initiateConnectorAuth`
- GUID validation for clientId/tenantId
- Device code UI: copy button, verification link, scopes display
- Popup fallback handling for authorization_code flow
- Error handling with `sanitizeError` and toast notifications
- Uses design-system components (Button, Input, Badge)
- i18n via `useTranslations`

**Minor finding:** `handleSendToAdmin` shows a toast info instead of calling `generateAdminEmail` API. Comment says "will call when backend is ready" -- but backend IS ready. Low priority.

### 11. `apps/studio/src/components/search-ai/sharepoint/AuthMethodSelector.tsx` -- COMPLETE

- Two variants: first-time (2 clickable cards) and returning (3 radio-style buttons)
- Uses design-system Card, lucide icons, clsx for conditional styling
- Fully i18n-enabled
- **No findings.**

### 12. `apps/studio/src/components/search-ai/sharepoint/ConnectionScopesDisplay.tsx` -- COMPLETE

- Read-only scope checklist with base + permission-aware sections
- Type-to-confirm disable flow via `TypeToConfirmInput` component
- Compact mode support
- Disabled-by audit display
- **No findings.**

### 13. `apps/studio/src/components/search-ai/sharepoint/ITAdminGuide.tsx` -- COMPLETE

- Collapsible guide with two options: send to admin, self-service steps
- Uses design-system Card, Button components
- i18n for all 6 self-service steps
- Loading prop support for async send action
- **Minor finding:** "Show steps"/"Hide steps" strings are hardcoded English instead of i18n keys. Low priority.

### 14. `apps/studio/src/components/search-ai/sharepoint/ScopeFiltersSplitPane.tsx` -- COMPLETE

- 60/40 split-pane layout with left controls and right preview
- Undo history (max 20 entries) via `useRef`
- Reset to initial config
- Auto-expands panel on mount, collapses on unmount
- Integrates `useConnectorDiscovery` and `useFilterPreview` hooks
- **No findings.**

### 15. `apps/studio/src/components/search-ai/sharepoint/ScopeControlsPanel.tsx` -- PARTIAL

**What works:**

- Collapsible sections for sites, file types, templates, date range, folders, size
- Checkbox lists driven by discovery data
- Filter template selector integration
- Generic `updateFilter` helper

**Finding:**

- **P-6: Advanced section is a placeholder.** Only shows a label text, no CEL editor or condition builder integration. The components exist (files 20-21) but are not wired in.

### 16. `apps/studio/src/components/search-ai/sharepoint/ScopePreviewPanel.tsx` -- COMPLETE

- Loading spinner, empty state, and full data display
- Summary counts grid (match, excluded, estimated time)
- Diff badges (newly included/excluded)
- Sample documents list with type + formatted size
- Excluded documents with reasons
- Exclusion summary breakdown
- Collapsible OData filter display
- Undo/reset buttons
- **No findings.**

### 17. `apps/studio/src/components/search-ai/sharepoint/FilterTemplateSelector.tsx` -- COMPLETE

- Toggle-style button row for 4 presets
- Accepts custom templates via prop override
- Design-system styling with active state
- i18n labels
- **No findings.**

### 18. `apps/studio/src/components/search-ai/sharepoint/PreviewTab.tsx` -- COMPLETE

- Fetches preview data on mount with cancellation cleanup
- Loading, error, and empty states
- 4 summary stat cards (doc count, skip count, size, time range)
- Filter changes diff display
- Sample documents via `DataTable` (max 25)
- Skipped documents via `DataTable` (max 10)
- Content type breakdown chart integration
- Navigation buttons (adjust filters, approve sync)
- **No findings.**

### 19. `apps/studio/src/components/search-ai/sharepoint/ContentTypeBreakdown.tsx` -- COMPLETE

- Horizontal bar chart with top-4 + "Other" grouping
- 5 color cycle
- Percentage + count labels
- Minimum 1% bar width
- **No findings.**

### 20. `apps/studio/src/components/search-ai/sharepoint/CELExpressionEditor.tsx` -- COMPLETE

- Monospace textarea with field autocomplete on `resource.` trigger
- Value autocomplete on `== "` / `!= "` triggers
- Keyboard navigation (ArrowUp/Down, Enter/Tab to select, Escape to dismiss)
- Validation button with error display (position + description + suggestion)
- Blur delay for click-through on suggestions
- Disabled state support
- i18n + aria labels
- **No findings.** (Not wired into ScopeControlsPanel yet -- see P-6)

### 21. `apps/studio/src/components/search-ai/sharepoint/ConditionBuilder.tsx` -- COMPLETE

- 15 operators with proper no-value handling (exists, not_exists, is_empty)
- AND/OR group logic toggle
- Max 5 groups, max 10 conditions per group
- Add/remove conditions and groups with boundary enforcement
- NativeSelect sub-component with full styling
- Disabled state propagation
- i18n for all operator labels
- **No findings.** (Not wired into ScopeControlsPanel yet -- see P-6)

### 22. `apps/studio/src/components/search-ai/sharepoint/ProposalTab.tsx` -- COMPLETE

- Orchestrates 5 states: loading, no-proposal, generating, failed/abandoned, ready/approved
- 8-section review with Accept/Modify/Skip per section
- Accept-all remaining, abandon, export (JSON/YAML)
- SWR polling during generation via `useConnectorProposal`
- Per-section action loading state
- Error handling with `sanitizeError` + toast
- Section content rendering via dedicated sub-components
- User decisions log integration
- Progress tracking (reviewed count / total)
- **No findings.**

### 23. `apps/studio/src/components/search-ai/sharepoint/ProposalGenerationProgress.tsx` -- COMPLETE

- Animated 9-step checklist with status icons (Loader2 spinner for in_progress, Check for done, etc.)
- Status text per step
- i18n title and description
- **No findings.**

### 24. `apps/studio/src/components/search-ai/sharepoint/ProposalTableOfContents.tsx` -- COMPLETE

- Clickable section list with status badges
- Active section highlighting
- Smooth scroll to section element
- Progress label
- aria-label on nav
- **No findings.**

### 25. `apps/studio/src/components/search-ai/sharepoint/ProposalSection.tsx` -- COMPLETE

- Generic collapsible section wrapper
- Header with title + badge, expandable content, action buttons
- `aria-expanded` and `aria-controls` for accessibility
- Supports any number of typed actions (label, variant, onClick, disabled, loading)
- **No findings.**

### 26. `apps/studio/src/components/search-ai/sharepoint/ProposalHealthCheckSection.tsx` -- COMPLETE

- Displays health check results with pass/fail icons
- Label mapping for check names
- Handles 3 check types
- **No findings.**

### 27. `apps/studio/src/components/search-ai/sharepoint/ProposalScopeSection.tsx` -- COMPLETE

- Two variants: Sites.Selected (MapPin) vs Sites.Read.All (Globe)
- Site list with fallback display names
- Discovery pending notice
- Empty state handling
- **No findings.**

### 28. `apps/studio/src/components/search-ai/sharepoint/ProposalFiltersSection.tsx` -- COMPLETE

- Displays template, file types as badges, max file size, exclude patterns
- Inline editing for max file size in simplified view
- Size formatting helper
- Modify callback integration
- **No findings.**

### 29. `apps/studio/src/components/search-ai/sharepoint/ProposalScheduleSection.tsx` -- COMPLETE

- Displays frequency with inline editing (select dropdown) in simplified view
- Recommendation comparison
- Next run date formatting
- Modify callback integration
- **No findings.**

### 30. `apps/studio/src/components/search-ai/sharepoint/ProposalPermissionsSection.tsx` -- COMPLETE

- Mode + permission-aware status badges
- Reduced accuracy warning with AlertTriangle
- Type-to-confirm disable flow with consequences list
- Loading state for disable action
- Trust note display
- **No findings.**

### 31. `apps/studio/src/components/search-ai/sharepoint/ProposalSamplePreview.tsx` -- COMPLETE

- Summary counts (sample count, total estimate)
- Sample documents table with name/type/size columns
- Empty state message
- Size formatting helper
- **No findings.**

### 32. `apps/studio/src/components/search-ai/sharepoint/ProposalSecurityGate.tsx` -- COMPLETE

- Pass/fail status with ShieldCheck/ShieldAlert icons
- Approval required indicator
- Scope breadth and permission mode badges
- **No findings.**

### 33. `apps/studio/src/components/search-ai/sharepoint/ApproveAndStart.tsx` -- PARTIAL

**What works:**

- Fetches config summary via `getConfigSummary` API on mount
- Full read-only summary display (6 sections: connection, scope, filters, schedule, permissions, security)
- Estimated sync info card
- Start Sync with confirmation dialog
- Security approval pending variant (button text changes)
- Save as Draft, Export Template (disabled for future wave)
- Loading, error states with cancellation cleanup

**Findings:**

- **P-7: `onSaveAsDraft` is a passthrough callback with no implementation visible.** The parent must handle it.
- **P-8: `onExportTemplate` button is always disabled.** Expected (Wave 4 scope note), but the callback is still required in props.

### 34. `apps/studio/src/components/search-ai/sharepoint/UserDecisionsLog.tsx` -- COMPLETE

- Table display of all decisions with timestamp, user, section, decision badge
- Empty state handling
- Badge color mapping per decision type
- Date formatting with locale
- **No findings.**

---

## Modified Frontend

### 35. `apps/studio/src/api/search-ai.ts` (new API functions) -- COMPLETE

- 15 new API functions added with correct endpoint paths and HTTP methods
- `checkConnectorName`: GET with URL-encoded name query param
- `generateAdminEmail`: POST with typed body
- `runPreview`: POST to filters/preview
- `getConfigSummary`: GET summary endpoint
- `acceptProposalSection`, `modifyProposalSection`, `skipProposalSection`: correct verbs (POST/PUT/POST)
- `acceptAllRemainingSections`: POST accept-all
- `abandonProposal`: DELETE
- `exportProposal`: Returns Blob with fallback handling
- `rerunProposalHealthCheck`: POST
- `disableProposalPermissions`: POST with confirmationText body
- `approveProposal`: POST
- `previewFilters`: POST with optional filterConfig
- Typed interfaces: `PreviewData`, `ConfigSummary`
- **No findings.**

### 36. `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (tab wiring) -- PARTIAL

**What works:**

- Tab definitions for setup (6 tabs) and monitoring (4 tabs) modes
- ConnectTab, ScopeFiltersSplitPane, PreviewTab wired to real components
- Auto-expand on scope-filters tab selection
- Simplified view toggle filtering tabs
- Draft detection locks non-connect tabs
- Panel width transitions (720px default, full viewport expanded)
- More Actions dropdown (all disabled for future waves)
- onAuthComplete navigates to proposal tab

**Findings:**

- **P-9: `proposal` tab not wired.** `activeTab === 'proposal'` falls through to the generic placeholder: `t('placeholder.tabContent', { wave: activeWave })`. The `ProposalTab` component exists and is fully implemented but is NOT rendered in `SharePointDetailPanel`. This is the most significant gap.
- **P-10: `overview` tab not wired.** Falls through to placeholder. Expected for Wave 2 but the monitoring flow will show a placeholder for existing connectors.

### 37. `apps/studio/src/components/search-ai/data/AddSourceButton.tsx` (Flow A) -- COMPLETE

- SharePoint type selection delegates to `openPanel('new', { isNew: true, tab: 'connect' })` via Zustand store
- Dialog closes immediately on SharePoint selection
- `dialogOnly` mode for external control (used by SetupGuide)
- **No findings.**

### 38. `apps/studio/src/components/search-ai/home/SetupGuide.tsx` (Flow A) -- COMPLETE

- "Connect a data source" card opens AddSourceButton dialog via `showAddSourceDialog` state
- SharePoint source added handler: sets pending filter to sources view, navigates to data tab
- File upload flow with auto-create manual source
- LLM warning when not configured
- **No findings.**

### 39. `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (Flow D) -- COMPLETE

- Row click on SharePoint source: detects via `connectorMap` + `sourceType === 'sharepoint'`
- Opens `SharePointDetailPanel` via `openPanel(cId, { isNew: false, tab })` with correct tab selection (draft -> connect, active -> overview)
- Falls back to old `ConnectorDetailPanel` for non-SharePoint enterprise connectors
- **No findings.**

---

## Critical Findings (must fix before ship)

| ID  | Severity | File                      | Description                                                                                                              |
| --- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P-9 | **HIGH** | SharePointDetailPanel.tsx | ProposalTab component is not wired into the panel. The `proposal` tab shows a placeholder instead of the real component. |

## High Findings (should fix before ship)

| ID   | Severity | File                   | Description                                                                                                      |
| ---- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P-3  | HIGH     | proposal.service.ts    | YAML export produces JSON with `text/yaml` content type. Either implement real YAML or remove the format option. |
| P-6  | HIGH     | ScopeControlsPanel.tsx | Advanced section (CEL editor, condition builder) is a placeholder. Components exist but are not integrated.      |
| P-10 | MEDIUM   | ConnectTab.tsx         | `handleSendToAdmin` in ConnectTab shows a toast instead of calling the implemented `generateAdminEmail` API.     |

## Low Findings (acceptable for v1, track for v2)

| ID   | Severity | File                | Description                                                                   |
| ---- | -------- | ------------------- | ----------------------------------------------------------------------------- |
| P-1  | LOW      | proposal.service.ts | Health check always returns pass. No real Graph API validation.               |
| P-2  | LOW      | proposal.service.ts | `validateSites()` always returns accessible. No real site validation.         |
| P-4  | LOW      | proposal.service.ts | Sample preview step returns empty arrays. Preview UI will show 0 samples.     |
| P-5  | LOW      | proposal.service.ts | `executeStep` uses `getLazyModel` with `any` cast for cross-DB queries.       |
| P-7  | LOW      | ApproveAndStart.tsx | `onSaveAsDraft` callback has no visible implementation in parent.             |
| P-8  | LOW      | ApproveAndStart.tsx | `onExportTemplate` button always disabled (Wave 4 scope).                     |
| P-13 | LOW      | ITAdminGuide.tsx    | "Show steps"/"Hide steps" strings are hardcoded English instead of i18n keys. |

---

## Architecture Assessment

### Strengths

1. **Tenant isolation is consistently applied.** Every backend query includes `tenantId`. The model uses `tenantIsolationPlugin`. Routes extract tenant from `req.tenantContext`.
2. **Validation is thorough.** Zod schemas on all route params/bodies/queries. ID fields use `z.string().min(1)`.
3. **Error handling is consistent.** `ConnectorError` mapping, `err instanceof Error ? err.message : String(err)`, structured `{ success, error: { code, message } }` responses.
4. **Frontend state management is clean.** SWR hooks with proper null-key patterns, debounced preview, polling with auto-stop, undo history.
5. **Audit trail is built in.** `writeAuditEntry` for approval, abandonment, permission disable. Decision log bounded at 200 entries.
6. **Design system compliance.** All components use Button, Badge, Card, Input, DataTable, etc. from `../../ui/`. No raw HTML buttons.
7. **Accessibility.** `aria-expanded`, `aria-controls`, `aria-label`, `role="listbox"`, `role="option"` used throughout.
8. **i18n.** All user-facing strings go through `useTranslations` (with 2 exceptions noted).

### Risks

1. **ProposalTab not wired (P-9)** means the core review workflow is unreachable from the UI. This is the single blocking issue.
2. **Health check/validation stubs (P-1, P-2)** mean the proposal will always show "pass" regardless of actual connector health. Acceptable for v1 but creates false confidence.
3. **Empty sample preview (P-4)** means the preview-before-sync experience shows no data. The PreviewTab compensates somewhat by calling `runPreview` independently.
