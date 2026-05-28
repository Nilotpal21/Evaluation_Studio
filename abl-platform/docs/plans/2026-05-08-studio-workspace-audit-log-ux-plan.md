# Implementation Plan: Studio Workspace Audit Log Explorer

**Status**: Draft
**Date**: 2026-05-08
**Related Feature Spec**: [docs/features/audit-logging.md](../features/audit-logging.md)
**Related HLD**: [docs/specs/audit-logging.hld.md](../specs/audit-logging.hld.md)
**Related Test Guide**: [docs/testing/audit-logging.md](../testing/audit-logging.md)
**Motivation**: The current Studio audit surface is hidden under `Admin -> Security -> Audit Logs`, calls `/api/audit` without `scope=workspace`, and therefore behaves like a personal audit view. Workspace admins need a full-screen, tenant-scoped audit explorer with category filters, search, date controls, drilldowns, and exports.

---

## 1. Current State

### Implemented Today

- Studio has a workspace-admin Security page at `/admin/security`.
- `SecurityPage.tsx` renders an `AuditLogsTab` with action/date filters and a basic table.
- That tab calls `GET /api/audit` without `scope=workspace`, so it defaults to personal scope and mainly shows current-user events such as login.
- `GET /api/audit?scope=workspace` already exists and is gated to workspace `OWNER` / `ADMIN` roles.
- `StudioClickHouseAuditQueryOptions` currently supports `scope`, `userId`, `tenantId`, `action`, `from`, `to`, `limit`, and `offset`.
- Shared `ClickHouseAuditReader` can filter by tenant, project, event type, action, actor, actor type, resource type, resource id, environment, and time range, but Studio's API does not expose most of those filters.
- Admin app `/audit` is a separate platform-admin surface and explicitly describes itself as admin UI access history, not the Studio workspace mutation ledger.

### Gap

Workspace admins cannot discover or operate a comprehensive audit log from Studio. The API can query workspace scope, but the UI does not expose workspace scope, rich filters, category taxonomy, search, detail inspection, or robust export workflows.

---

## 2. Product Target

Create a full-screen Studio audit explorer for workspace admins.

### Primary Route

- Add a new Studio workspace-admin route: `/admin/audit-logs`.
- Add a left-nav item under `Workspace Admin -> Team` or `Workspace Admin -> Security` named `Audit Logs`.
- Keep `/admin/security` focused on MFA and SSO.
- Replace the current Security tab's audit table with a compact "Recent audit activity" summary and a clear navigation action to the full explorer, or remove that tab after the new page ships.

### Personas

- **Workspace owner/admin**: investigate who changed workspace, project, agent, auth, or module configuration.
- **Security operator**: filter authentication, access-denied, SSO, MFA, token, KMS, PII, and credential events.
- **Compliance reviewer**: export filtered evidence for a time window.
- **Support engineer**: search by actor, trace/session, project, resource id, or IP address during an incident.

### Non-Goals

- No client-side audit writes.
- No tamper-proof hash chain.
- No cross-tenant view in Studio.
- No replacement for specialized KMS, Arch AI, connector, or Admin app audit screens in this phase.
- No unbounded full-text scan across all history without a date range.

---

## 3. Design Decisions And Module Boundaries

### Decision Log

| #   | Decision                                                                                                                                 | Rationale                                                                                                                                                                                             | Alternatives Rejected                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Build a new full-screen Studio route at `/admin/audit-logs`.                                                                             | The existing Security tab is too constrained and currently reads personal-scope events by default, which is why workspace admins mostly see login events.                                             | Expanding the existing Security tab into a dense investigation workspace.                     |
| D-2 | Default the new page to workspace scope for workspace `OWNER` / `ADMIN` users.                                                           | The user need is tenant/workspace audit investigation, not only "my account activity."                                                                                                                | Keeping personal scope as the default and requiring admins to discover a hidden scope switch. |
| D-3 | Keep the existing `/api/audit` personal behavior compatible, then add explorer filters behind workspace mode and/or companion endpoints. | Current tests and callers depend on the route. Compatibility keeps the change deployable in phases.                                                                                                   | Replacing the route response wholesale in the same phase as the UI.                           |
| D-4 | Use a Studio-specific audit explorer query builder first.                                                                                | Category mapping, global search, metadata search, source filters, cursor pagination, facets, and export behavior are Studio UX concerns; stabilizing them locally limits shared package blast radius. | Immediately extending the shared `ClickHouseAuditReader` for every UX-specific filter.        |
| D-5 | Require bounded date ranges for broad search, metadata search, and all-match exports.                                                    | ClickHouse metadata/global search can become expensive without a time boundary.                                                                                                                       | Allowing unbounded search and relying only on query timeout.                                  |
| D-6 | Treat export as two lanes: synchronous capped export and asynchronous archive export.                                                    | Operators need quick CSV/JSON/NDJSON evidence, while compliance-scale exports should use the existing archive flow.                                                                                   | Making every export synchronous or forcing every export through archive jobs.                 |

### Module Boundaries

| Module                             | Responsibility                                                                                   | Depends On                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `AuditLogsPage`                    | Full-screen route composition, URL state, data loading orchestration, empty/error/loading state. | Filter, summary, table, detail, export components.            |
| `AuditFilterBar` / advanced drawer | All user-facing filter controls, active chips, reset/apply behavior, date presets.               | Audit category catalog and query-state helpers.               |
| `AuditResultsTable`                | Dense, stable audit row display with sortable columns and selection.                             | Normalized API row shape.                                     |
| `AuditDetailPanel`                 | Full event inspection, metadata preview, old/new diff rendering, copyable ids, safe deep links.  | Normalized API row shape and metadata formatting helpers.     |
| `AuditExportDialog`                | Export format/scope/options and archive escalation UX.                                           | Export API and archive export route.                          |
| `audit-explorer-catalog.ts`        | Category taxonomy, labels, severity hints, action/event type mapping.                            | Audit event coverage matrix and known Studio/shared catalogs. |
| `audit-explorer-query.ts`          | Strict query validation, tenant-safe ClickHouse filters, cursor pagination, facets.              | ClickHouse client, authenticated tenant/user context.         |
| `audit-explorer-response.ts`       | Row normalization, metadata preview, export serialization.                                       | Shared audit decoded row shape.                               |

---

## 4. UX Design

### Full-Screen Layout

The page should be a dense operational workspace, not a marketing-style page.

1. **Header band**
   - Title: `Audit Logs`
   - Scope indicator: `Workspace`
   - Timezone label
   - Primary actions: refresh, save view, export
   - Secondary actions: reset filters, copy query link

2. **Summary strip**
   - Total matching events
   - Critical/security events
   - Failed events
   - Unique actors
   - Top event category
   - Last ingested event timestamp

3. **Filter bar**
   - Global search input
   - Date preset control
   - Event category multi-select
   - Actor filter
   - Project/resource filter
   - Export button
   - More filters drawer

4. **Category rail or tabs**
   - All
   - Auth & access
   - Workspace governance
   - Project & agent lifecycle
   - Tools, modules & credentials
   - Runtime interventions
   - Data protection
   - KMS
   - Connectors & crawl
   - System/plugin

5. **Results table**
   - Timestamp
   - Category
   - Action/event type
   - Actor
   - Target/resource
   - Project
   - Source/service
   - Result
   - IP
   - Trace/session
   - Row action: open detail

6. **Detail panel**
   - Opens as right-side full-height panel.
   - Shows canonical fields first, then metadata.
   - Shows old/new value diff where present.
   - Shows copy buttons for event id, trace id, resource id, actor id.
   - Links to project/session/trace where a safe route exists.
   - Redacts or masks values exactly as the backend provides them; no client-side attempt to reconstruct secrets.

### Interaction And State Requirements

- Active filters are visible as removable chips directly above the table.
- Filter changes update the URL query string so an investigation view can be shared.
- Date presets should apply immediately; custom ranges should require explicit Apply.
- Refresh preserves filters and selected page size.
- Loading state uses a table skeleton, not a blank page.
- Empty state distinguishes "no events in this date range" from "filters exclude all events."
- Error state uses sanitized copy and offers retry; raw ClickHouse or tenant details stay in server logs.
- The table remains horizontally scrollable on narrower screens while preserving the header, filter bar, and row action affordance.
- Long action names, resource ids, and metadata values truncate with tooltips and copy controls rather than resizing the table.
- The detail panel is the only place where full metadata/diffs appear.

### Filters

The first release should include these filters.

| Filter             | UX control                                            | Query field(s)                 | Notes                                                                                                       |
| ------------------ | ----------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Date range         | Preset segmented control plus custom date/time inputs | `from`, `to`                   | Presets: 1h, 24h, 7d, 30d, custom. Require an explicit bounded range for broad searches.                    |
| Event category     | Multi-select chips                                    | `categories`                   | Maps to action/event type groups maintained in a shared Studio catalog.                                     |
| Event type/action  | Searchable multi-select                               | `eventTypes`, `actions`        | Supports exact audit-worthy values such as `login`, `project_created`, and credentialed `tool.executed`.    |
| Search             | Search box                                            | `q`                            | Searches actor, action, resource id, resource type, project id, trace id, IP, and selected metadata fields. |
| Actor              | Combobox/text                                         | `actor`                        | Exact id/email where available; never cross-tenant.                                                         |
| Actor type         | Multi-select                                          | `actorTypes`                   | `user`, `admin`, `agent`, `system`, `unknown`.                                                              |
| Project            | Combobox                                              | `projectId`                    | Workspace-scoped project list.                                                                              |
| Resource type      | Multi-select                                          | `resourceTypes`                | Agent, session, contact, workflow, tool, prompt, KMS key, connector, plugin collection.                     |
| Resource id        | Text                                                  | `resourceId`                   | Exact match.                                                                                                |
| Trace/session      | Text                                                  | `traceId` / `sessionId`        | Search `session_id` and metadata trace id compatibility field.                                              |
| Source/service     | Multi-select                                          | `sources`                      | `studio`, `runtime-store`, `runtime-auth`, `mongoose-plugin`, `admin`, etc.                                 |
| Environment        | Multi-select                                          | `environments`                 | `dev`, `staging`, `production`.                                                                             |
| Result             | Segmented control                                     | `success`                      | All, success, failure.                                                                                      |
| IP address         | Text                                                  | `ipAddress`                    | Exact or prefix only; no fuzzy IP wildcard in first pass.                                                   |
| Metadata key/value | Advanced drawer                                       | `metadataKey`, `metadataValue` | Allow one key/value pair in phase 1; expand later if needed.                                                |

### Event Category Catalog

Create a Studio-side catalog that maps event/action values to stable UX categories.

| Category                     | Examples                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & access                | `login`, `logout`, `login_failed`, `account_locked`, `token_refresh`, `sso_login`, `mfa_failed`, `permission.denied`                        |
| Workspace governance         | `workspace_created`, `workspace_archived`, `member_role_changed`, `invitation_sent`, `organization_created`                                 |
| Project & agent lifecycle    | `project_created`, `project_updated`, `agent.created`, `agent.version_created`, `agent.dsl_updated`, `agent.promoted`                       |
| Tools, modules & credentials | `tool.created`, credentialed/external `tool.executed`, `tool_deleted`, `credential_updated`, `module_published`, `module_promoted`          |
| Runtime interventions        | `session.modified`, `session.context_injected`, `session.tool_mock_set`, `session.test_created`, `handoff.executed`, `escalation.triggered` |

Routine lifecycle/read telemetry such as `session.started`, `session.ended`, `session.accessed`, and `trace.queried` must not be captured as new audit rows because those events already belong to analytics, EventStore, and trace surfaces.

Other operational telemetry is likewise excluded from new audit capture: prompt test runs, deployment cache/status probes, OAuth initiation attempts before provider outcome, scheduled auth-profile token refresh/validation checks, and webhook batch queue receipts.
| Data protection | `pii.accessed`, `gdpr_deletion_completed`, `gdpr_deletion_failed`, `contact.gdpr_erased` |
| KMS | `kms.*` generated event types and KMS operation values |
| Connectors & crawl | connector audit events, crawl events, webhooks, mapping events |
| Archives, retention & Git | `archive_created`, `retention_sweep_completed`, `git_push_completed`, `git_webhook_accepted` |
| System/plugin | Mongoose plugin events such as `<collection>.create`, `<collection>.update`, `<collection>.delete` |

---

## 5. API Design

### Extend Studio Audit Query API

Modify `GET /api/audit` to accept workspace explorer filters.

```typescript
interface StudioAuditExplorerQuery {
  scope: 'personal' | 'workspace';
  from: string;
  to: string;
  limit?: number;
  cursor?: string;
  offset?: number; // compatibility only
  q?: string;
  categories?: string[];
  eventTypes?: string[];
  actions?: string[];
  actor?: string;
  actorTypes?: Array<'user' | 'admin' | 'agent' | 'system' | 'unknown'>;
  projectId?: string;
  resourceTypes?: string[];
  resourceId?: string;
  traceId?: string;
  sources?: string[];
  environments?: Array<'dev' | 'staging' | 'production'>;
  success?: 'success' | 'failure';
  ipAddress?: string;
  metadataKey?: string;
  metadataValue?: string;
}
```

Validation rules:

- Use Zod `.string().min(1)` for ids, never CUID/CUID2/ULID validators.
- `scope=workspace` requires workspace `OWNER` or `ADMIN`.
- `scope=personal` remains tenant-safe and includes `tenantId + actor`.
- `from` and `to` are required for `q`, metadata search, or export-all.
- Cap synchronous query `limit` at 200.
- Cap export-all synchronous rows at a low safe value such as 10,000; larger exports use archive export.
- Return 404 for unauthorized workspace-scope access.

### Response Shape

```typescript
interface StudioAuditExplorerResponse {
  logs: StudioAuditExplorerRow[];
  total: number;
  nextCursor?: string;
  facets?: StudioAuditFacets;
  appliedFilters: Record<string, unknown>;
  limit: number;
  scope: 'personal' | 'workspace';
}

interface StudioAuditExplorerRow {
  id: string;
  tenantId: string;
  projectId: string | null;
  timestamp: string;
  category: string;
  eventType: string;
  action: string;
  actor: string | null;
  actorType: string | null;
  resourceType: string | null;
  resourceId: string | null;
  source: string | null;
  environment: string | null;
  success: boolean | null;
  ipAddress: string | null;
  traceId: string | null;
  metadataPreview: Record<string, unknown>;
}
```

### Query Builder

Add a Studio-specific query builder instead of overloading the shared `ClickHouseAuditReader` immediately.

Recommended files:

- `apps/studio/src/lib/audit/audit-explorer-catalog.ts`
- `apps/studio/src/lib/audit/audit-explorer-query.ts`
- `apps/studio/src/lib/audit/audit-explorer-response.ts`

Reasons:

- The shared reader currently covers basic filters, but this UI needs category mapping, search, source filtering, success filtering, cursor pagination, metadata key/value search, and facets.
- A Studio-specific builder limits blast radius and can later be folded into `@abl/compiler/platform/stores` once stable.

SQL safety:

- Use ClickHouse parameter binding for all values.
- Keep table names fixed or validated by the existing table-name regex pattern.
- Whitelist metadata keys for common fields first; arbitrary metadata key search must validate key names with a strict regex.
- Use a bounded date range for metadata and global search.
- Sort by `(timestamp DESC, event_id DESC)` for stable cursor pagination.

### Summary / Facets Endpoint

Add either:

- `GET /api/audit/summary` for counts by category/action/actor/resource, or
- include `facets` in `GET /api/audit` behind `includeFacets=true`.

Prefer a separate endpoint in phase 1 so table fetches stay fast.

---

## 6. Export Design

### Export Options

1. **Export current page**
   - Client-side CSV from currently loaded rows.
   - Useful for small ad hoc sharing.

2. **Export filtered CSV**
   - Server-side `GET /api/audit/export?format=csv&...filters`.
   - Bounded row cap with clear UI messaging.

3. **Export filtered JSON**
   - Server-side `GET /api/audit/export?format=json&...filters`.
   - Preserves metadata/diffs.

4. **Export NDJSON**
   - Server-side `GET /api/audit/export?format=ndjson&...filters`.
   - Better for SIEM or downstream tooling.

5. **Create archive export**
   - Reuse `POST /api/archives/audit-export` for larger or compliance-grade export jobs.
   - UI should route large exports to the archive flow and show job/manifest status.

### Export Modal

Fields:

- Format: CSV, JSON, NDJSON
- Scope: current page, all matching, archive job
- Include metadata: yes/no
- Include old/new diffs: yes/no
- Include internal ids: yes/no
- Timezone: UTC or local display timezone

Security:

- Export uses the same filter authorization path as read.
- Export must not include rows outside `tenantId`.
- Metadata remains sanitized/masked as stored.

---

## 7. File-Level Change Map

### New Files

| File                                                                    | Purpose                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/studio/src/components/admin/audit/AuditLogsPage.tsx`              | Full-screen workspace audit explorer page.                                      |
| `apps/studio/src/components/admin/audit/AuditFilterBar.tsx`             | Search, category, actor, project, resource, date filters.                       |
| `apps/studio/src/components/admin/audit/AuditAdvancedFiltersDrawer.tsx` | Advanced filters: source, environment, actor type, metadata, IP, trace/session. |
| `apps/studio/src/components/admin/audit/AuditResultsTable.tsx`          | Dense results table with stable columns and row actions.                        |
| `apps/studio/src/components/admin/audit/AuditDetailPanel.tsx`           | Right-side event detail and metadata/diff inspection.                           |
| `apps/studio/src/components/admin/audit/AuditSummaryStrip.tsx`          | Counts and top category/actor/status summaries.                                 |
| `apps/studio/src/components/admin/audit/AuditExportDialog.tsx`          | Export format/scope/options UI.                                                 |
| `apps/studio/src/lib/audit/audit-explorer-catalog.ts`                   | Event category catalog and label helpers.                                       |
| `apps/studio/src/lib/audit/audit-explorer-query.ts`                     | Studio-specific ClickHouse query builder and filter validation helpers.         |
| `apps/studio/src/lib/audit/audit-explorer-response.ts`                  | Row normalization, metadata preview, CSV/JSON/NDJSON serialization helpers.     |
| `apps/studio/src/app/api/audit/export/route.ts`                         | Server-side filtered export endpoint.                                           |
| `apps/studio/src/app/api/audit/summary/route.ts`                        | Facet/summary endpoint.                                                         |
| `apps/studio/src/__tests__/api-routes/api-audit-explorer.test.ts`       | API filter, workspace scope, search, pagination, and export tests.              |
| `apps/studio/src/__tests__/components/audit-logs-page.test.tsx`         | UI filter and rendering tests.                                                  |
| `apps/studio/e2e/audit-logs-explorer.spec.ts`                           | Real browser workflow for workspace audit explorer.                             |

### Modified Files

| File                                                     | Change                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/studio/src/store/navigation-store.ts`              | Add `audit-logs` to `AdminPage` and route parsing.                                           |
| `apps/studio/src/components/navigation/AdminSidebar.tsx` | Add `Audit Logs` nav item.                                                                   |
| `apps/studio/src/components/navigation/AppShell.tsx`     | Render `AuditLogsPage` for `/admin/audit-logs`.                                              |
| `apps/studio/src/components/admin/SecurityPage.tsx`      | Remove or downscope audit tab; add CTA to full explorer.                                     |
| `apps/studio/src/app/api/audit/route.ts`                 | Parse new filter schema and delegate to explorer query for workspace mode.                   |
| `apps/studio/src/lib/studio-clickhouse-audit-reader.ts`  | Either keep for compatibility or delegate to the new explorer query when filters require it. |
| `docs/features/audit-logging.md`                         | Clarify that full workspace audit explorer is the target surface once implemented.           |
| `docs/testing/audit-logging.md`                          | Add UI/API coverage rows for full-screen workspace audit explorer.                           |

---

## 8. Implementation Phases

### Phase 1: Navigation And UX Shell

**Goal**: Introduce a full-screen workspace audit destination without changing query semantics yet.

Tasks:

1. Add `audit-logs` to the Studio admin route model.
2. Add `Audit Logs` to `AdminSidebar`.
3. Create `AuditLogsPage` with header, empty summary strip, filter bar shell, table shell, detail panel shell, and export dialog shell.
4. Update `SecurityPage` audit tab to link to `/admin/audit-logs` or remove it from tabs.

Exit criteria:

- `/admin/audit-logs` renders for workspace admins.
- Non-admin workspace members still cannot access workspace admin routes.
- Existing `/admin/security` MFA/SSO flows remain unchanged.
- `pnpm --filter @agent-platform/studio build` succeeds.

Test strategy:

- Component test for sidebar item visibility.
- Navigation-store route parsing test.
- Component test for page shell and empty states.

Rollback:

- Remove the new route item and page rendering; leave existing Security tab untouched.

### Phase 2: Workspace Query API

**Goal**: Expose tenant-scoped workspace audit filters safely.

Tasks:

1. Add a strict Zod schema for audit explorer query params.
2. Add Studio-specific ClickHouse query builder with tenant filter always present.
3. Implement filters for date, action, event type, actor, actor type, project id, resource type, resource id, environment, source, success, IP, and trace/session.
4. Add global search with date-range guard.
5. Add stable cursor pagination.
6. Preserve existing personal-scope behavior for compatibility.

Exit criteria:

- `GET /api/audit?scope=workspace` returns tenant-scoped rows for OWNER/ADMIN.
- Non-admin workspace-scope requests return non-leaky 404.
- Personal scope still filters to `tenantId + actor`.
- All filters are parameterized and tested.

Test strategy:

- API route tests for every filter family.
- Tenant isolation tests: tenant A never sees tenant B rows.
- Authorization tests for OWNER/ADMIN vs MEMBER.
- Query-builder tests for SQL parameterization.

Rollback:

- Route can fall back to the existing `queryStudioAuditLogsFromClickHouse` path.

### Phase 3: Filters, Search, And Result Table

**Goal**: Make the explorer usable for incident investigation.

Tasks:

1. Wire filter state to URL query params so views are shareable.
2. Implement date presets and custom date/time inputs.
3. Implement event category catalog and multi-select.
4. Implement searchable action/event type selector.
5. Implement actor, project, resource, trace/session, source, environment, result, and IP filters.
6. Implement results table with stable columns, loading state, empty state, and pagination.
7. Implement detail panel with metadata and old/new value diff display.

Exit criteria:

- User can filter from all events to a specific category/action/date/actor without page reload.
- Refresh preserves filter state from URL.
- Detail panel shows canonical fields and metadata for a selected row.
- Long metadata does not break layout on desktop or mobile.

Test strategy:

- Component tests for filter state <-> URL synchronization.
- Component tests for category mapping and table columns.
- Accessibility checks for filter controls and detail panel close/focus behavior.

Rollback:

- Keep route and API but hide advanced filters behind a temporary page flag.

### Phase 4: Summary Facets And Saved Views

**Goal**: Help admins understand volume and quickly return to common investigations.

Tasks:

1. Add `/api/audit/summary` with counts by category, action, actor, resource type, and success/failure.
2. Render summary strip and category counts.
3. Add saved view presets stored in user preferences or local storage:
   - Failed logins
   - Workspace governance
   - KMS failures
   - PII access
   - Project/agent changes
   - Tool/module changes
4. Add copy-link action for current filters.

Exit criteria:

- Summary counts match the current filter set.
- Saved views apply filters deterministically.
- Summary calls do not block table rendering.

Test strategy:

- API tests for summary with same tenant/role enforcement.
- Component tests for saved presets.
- Basic performance assertion for bounded summary queries.

Rollback:

- Hide summary strip and saved views; table search remains available.

### Phase 5: Export Workflows

**Goal**: Support compliance evidence export without unsafe unbounded queries.

Tasks:

1. Add `/api/audit/export`.
2. Support CSV, JSON, and NDJSON.
3. Support current page export client-side.
4. Support all matching export server-side with row cap.
5. Route large export requests to existing archive export flow.
6. Add export audit event so export actions are themselves auditable.

Exit criteria:

- Export respects all active filters.
- Exported rows match visible query results for current page.
- Oversized export offers archive job path instead of timing out.
- Export action emits an audit event.

Test strategy:

- API tests for CSV, JSON, NDJSON.
- Authorization and tenant isolation tests for export.
- Component test for export modal options.

Rollback:

- Disable server-side export route and keep current-page export only.

### Phase 6: E2E, Evidence, And Docs Sync

**Goal**: Lock the new surface with public workflow coverage and update docs honestly.

Tasks:

1. Add Studio E2E test that logs in as workspace admin, navigates to `/admin/audit-logs`, filters workspace events, opens detail, and exports current page.
2. Add negative E2E or API coverage for non-admin workspace scope.
3. Update feature spec and testing guide to distinguish personal audit view from workspace explorer.
4. Capture video evidence using the existing Studio video evidence workflow if required for review.

Exit criteria:

- E2E proves the full-screen explorer is reachable and usable.
- Docs no longer imply the old Security tab is the primary workspace audit surface.
- `pnpm --filter @agent-platform/studio build` succeeds.
- Targeted Studio API and component tests pass.

Rollback:

- Hide `/admin/audit-logs` nav item; keep backend filters available for follow-up.

---

## 9. Wiring Checklist

- [ ] `apps/studio/src/store/navigation-store.ts` recognizes `/admin/audit-logs` and exposes `page === 'audit-logs'`.
- [ ] `apps/studio/src/components/navigation/AdminSidebar.tsx` renders the `Audit Logs` item for workspace admin users.
- [ ] `apps/studio/src/components/navigation/AppShell.tsx` imports and renders `AuditLogsPage`.
- [ ] `apps/studio/src/components/admin/SecurityPage.tsx` no longer presents the small personal table as the primary workspace audit log.
- [ ] `apps/studio/src/app/api/audit/route.ts` parses the strict explorer schema and still supports existing personal-scope callers.
- [ ] `apps/studio/src/app/api/audit/summary/route.ts` uses the same auth/scope resolver as the table route.
- [ ] `apps/studio/src/app/api/audit/export/route.ts` uses the same auth/scope resolver and emits an audit event for export attempts.
- [ ] `apps/studio/src/app/api/archives/audit-export/route.ts` remains the large-export escalation path and accepts the explorer filter envelope.
- [ ] Studio translations contain all new visible strings.
- [ ] The category catalog is tested against known finite audit catalogs from `docs/features/audit-logging.md`.
- [ ] Component tests cover filter controls, URL state, table rendering, detail panel, and export dialog.
- [ ] API tests cover workspace scope, personal compatibility, tenant isolation, admin gating, parameter validation, filters, search, facets, and exports.
- [ ] E2E/workflow tests read `apps/studio/e2e/workflows/agents.md` before adding or changing workflow coverage.

### Production Wiring Verification

Before marking implementation complete, verify these traces rather than only checking file existence:

- Sidebar click navigates to `/admin/audit-logs` and `AppShell` renders `AuditLogsPage`.
- `AuditLogsPage` sends `scope=workspace` by default for workspace admins.
- `GET /api/audit?scope=workspace` reaches the explorer query path and includes `tenant_id = authenticatedUser.tenantId`.
- Date, category, actor, project, resource, source, result, trace/session, IP, and metadata filters are represented in ClickHouse query parameters.
- Export calls reuse the exact filter envelope shown in the UI.
- The archive export path can receive the same filter envelope for large exports.
- The old Security page either links to the explorer or clearly scopes itself as personal/recent account activity.

---

## 10. Cross-Cutting Requirements

### Authorization And Isolation

- Workspace explorer always uses `tenantId` from authenticated user context.
- Workspace scope requires `OWNER` or `ADMIN`.
- Project filters are additional filters inside the same tenant, not a replacement for tenant filtering.
- Unauthorized workspace access returns 404.
- Export and summary endpoints share the same authorization path as read.

### Performance

- Default date range: last 24 hours.
- Require bounded date range for global search, metadata search, and export-all.
- Prefer cursor pagination over offset for deep paging.
- Avoid rendering full metadata in table cells; use previews and detail panel.
- Summary facets should run separately from table fetches.

### Observability

- Record structured logs for failed query/export attempts with sanitized error context.
- Emit audit event for export initiation/completion/failure.
- Include trace id where available for route-level errors.

### Accessibility

- All filters keyboard reachable.
- Detail panel traps focus while open and restores focus on close.
- Tables use semantic headers.
- Filter chips and category tabs expose labels and selected state.

### Internationalization

- Add all visible text to Studio translations.
- Do not hardcode English labels inside reusable components.

---

## 11. Acceptance Criteria

- [ ] Workspace admins can open a full-screen audit explorer at `/admin/audit-logs`.
- [ ] The explorer defaults to workspace scope and no longer only shows current-user login events.
- [ ] Users can filter by date, category, action/event type, actor, project, resource, trace/session, source, environment, result, IP, and metadata key/value.
- [ ] Users can search across common audit fields within a bounded date range.
- [ ] Users can open a detail panel for full event metadata and diffs.
- [ ] Users can export current page, filtered CSV, filtered JSON, filtered NDJSON, or create an archive export for large result sets.
- [ ] Non-admin users cannot access workspace audit rows.
- [ ] Tenant isolation is covered by API tests.
- [ ] Docs and testing guide reflect the new workspace explorer and the old personal Security tab behavior.

---

## 12. Open Questions

1. Should the new navigation label be `Audit Logs`, `Security Audit`, or `Activity Log`?
2. Should `/admin/security` keep a compact audit summary or remove audit entirely after `/admin/audit-logs` ships?
3. What is the maximum synchronous export row cap product wants: 5,000, 10,000, or 25,000?
4. Should saved views persist per user in backend preferences, or is local storage enough for phase 1?
5. Should connector, KMS, Arch AI, and omnichannel dedicated tables be federated into this explorer in phase 1, or should phase 1 only cover the shared `audit_events` table and deep-link to specialized tabs?
