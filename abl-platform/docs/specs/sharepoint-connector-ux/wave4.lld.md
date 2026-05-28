# SharePoint Connector UX — Wave 4 LLD (Fleet Ops & Config Management)

**HLD Reference:** sharepoint-connector-ux.hld.md
**Wave:** 4 of 4 — Fleet Ops & Config Management
**Tasks:** T-38 to T-57

---

## Task T-38: Enhance SourcesTable (Card View, Status Counts, Conditional Columns)

### Problem

`apps/studio/src/components/search-ai/data/SourcesTable.tsx` (457 lines) currently renders a table-only view with fixed columns (name, type, status, docs, lastSync, actions). The design (§3b) requires:

1. **Card view** when sources <= 6, **table view** when sources >= 7, with a SegmentedControl toggle.
2. Cards show type-specific secondary info (e.g., "12 sites, 3,400 docs" for SharePoint, "42 pages" for web).
3. A dashed "+ Add Source" card always appears last in card view.
4. Table view gains conditional SP-specific columns (Sites, Token Expiry) that only render when SharePoint connectors are present.
5. An aggregate summary bar below the toolbar shows totalDocs, totalSize, sourceCountByType, tokensExpiringCount.
6. Status badges use the full set: Active (green), Awaiting Auth (amber), Draft (gray), Syncing (blue), Partial (amber), Error (red), Auth Failed (red).

### Files to Modify

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (line 24-30 — SourcesTableProps, line 32-39 — statusVariant, line 69-460 — main component) — Add view toggle state, card/table conditional rendering, aggregate summary bar, conditional SP columns
- `apps/studio/src/components/ui/SegmentedControl.tsx` (no changes needed — already exists with correct API)

### Files to Create

- `apps/studio/src/components/search-ai/data/SourceCard.tsx` — Individual source card for card view (type icon, name, status badge, secondary info, action menu)
- `apps/studio/src/components/search-ai/data/SourcesCardGrid.tsx` — Card grid layout wrapping SourceCard + dashed add-source card
- `apps/studio/src/components/search-ai/data/SourcesAggregateSummary.tsx` — Aggregate summary bar (totalDocs, totalSize, sourcesByType, tokensExpiring)

### Function Signatures

**Before:**

```ts
// SourcesTable.tsx line 24
interface SourcesTableProps {
  indexId: string;
  sources: SearchAISource[];
  onRefresh: () => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
}

// SourcesTable.tsx line 32
const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  pending: 'default',
  syncing: 'info',
  crawling: 'info',
  disabled: 'default',
  error: 'error',
};
```

**After:**

```ts
// SourcesTable.tsx — expanded props
interface SourcesTableProps {
  indexId: string;
  sources: SearchAISource[];
  onRefresh: () => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
  onAddSource?: () => void; // triggers "+ Add Source" flow
  aggregates?: SourceAggregates | null; // from enhanced list API (T-41)
}

interface SourceAggregates {
  totalDocs: number;
  totalSizeBytes: number;
  sourceCountByType: Record<string, number>;
  sourceCountByStatus: Record<string, number>;
  tokensExpiringCount: number;
}

// SourcesTable.tsx — expanded status map
const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  awaiting_auth: 'warning',
  draft: 'default',
  pending: 'default',
  syncing: 'info',
  crawling: 'info',
  partial: 'warning',
  disabled: 'default',
  error: 'error',
  auth_failed: 'error',
};

// SourceCard.tsx
interface SourceCardProps {
  source: SearchAISource;
  connectorId: string | null;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onViewDocuments: () => void;
  onUploadToSource?: () => void;
}
export function SourceCard(props: SourceCardProps): JSX.Element;

// SourcesCardGrid.tsx
interface SourcesCardGridProps {
  sources: SearchAISource[];
  connectorMap: Record<string, string>;
  onCardClick: (source: SearchAISource) => void;
  onDeleteClick: (source: SearchAISource, e: React.MouseEvent) => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
  onAddSource?: () => void;
}
export function SourcesCardGrid(props: SourcesCardGridProps): JSX.Element;

// SourcesAggregateSummary.tsx
interface SourcesAggregateSummaryProps {
  aggregates: SourceAggregates;
  sourceCount: number;
}
export function SourcesAggregateSummary(props: SourcesAggregateSummaryProps): JSX.Element;
```

### Subtasks

1. Add `viewMode` state (`'card' | 'table'`) to SourcesTable with auto-detection (card when <= 6, table when >= 7), plus SegmentedControl override.
2. Extract card rendering into `SourceCard.tsx` — type icon, name, status badge with dot/pulse, secondary info line, action dropdown.
3. Build `SourcesCardGrid.tsx` — CSS grid (responsive: 1-3 columns), wraps SourceCards, appends dashed "+ Add Source" card.
4. Build `SourcesAggregateSummary.tsx` — horizontal stat row: totalDocs, totalSize (formatted bytes), source count by type pills, tokens-expiring warning.
5. Add conditional SP columns (Sites count, Token Expiry) to the DataTable column array — only included when `sources.some(s => s.sourceType === 'sharepoint')`.
6. Expand `statusVariant` map to include `awaiting_auth`, `draft`, `partial`, `auth_failed`.
7. Add i18n keys under `search_ai.sources_table` namespace for card view labels, aggregate labels, new status labels.

### Acceptance Criteria

- `grep -r "SegmentedControl" apps/studio/src/components/search-ai/data/SourcesTable.tsx` returns match
- `grep -r "SourceCard" apps/studio/src/components/search-ai/data/SourcesCardGrid.tsx` returns match
- `grep "awaiting_auth" apps/studio/src/components/search-ai/data/SourcesTable.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-08 (panel shell — already complete in Wave 1)
- T-41 (backend enhanced list) for aggregates — can render without aggregates initially

### Risk Notes

- **SourcesTable is 457 lines already.** Extracting card rendering into separate components keeps the main file manageable. Do NOT inline card JSX into SourcesTable.
- **Auto view detection** should be a default, not forced. Users who toggle SegmentedControl override the auto-detection; persist preference to localStorage key `sp-sources-view-mode`.

---

## Task T-39: SourcesTable Bulk Actions UI

### Problem

The design (§3b) requires a bulk actions toolbar that appears when 1+ rows are selected. Generic actions (Pause, Resume, Sync Now, Delete) apply to all source types. SP-conditional actions (Re-auth, Apply Schedule, Export Configs) appear only when all selected sources are SharePoint connectors.

### Files to Modify

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (line 69 component body) — Add checkbox column, selection state, bulk action toolbar rendering

### Files to Create

- `apps/studio/src/components/search-ai/data/BulkActionsToolbar.tsx` — Floating toolbar with action buttons, selection count, clear selection

### Function Signatures

**Before:**

```ts
// SourcesTable.tsx line 69 — no selection state
export function SourcesTable({ indexId, sources, onRefresh, ... }: SourcesTableProps) {
```

**After:**

```ts
// SourcesTable.tsx — adds selection state
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
const allSelected = filteredSources.length > 0 && selectedIds.size === filteredSources.length;
const someSelected = selectedIds.size > 0;
const allSelectedAreSP = [...selectedIds].every(
  (id) => sources.find((s) => s._id === id)?.sourceType === 'sharepoint',
);

// BulkActionsToolbar.tsx
interface BulkActionsToolbarProps {
  selectedCount: number;
  allAreSP: boolean;
  onPause: () => void;
  onResume: () => void;
  onSyncNow: () => void;
  onDelete: () => void;
  onReAuth?: () => void; // only when allAreSP
  onApplySchedule?: () => void; // only when allAreSP
  onExportConfigs?: () => void; // only when allAreSP
  onClearSelection: () => void;
  loading?: boolean;
}
export function BulkActionsToolbar(props: BulkActionsToolbarProps): JSX.Element;
```

### Subtasks

1. Add checkbox column as first DataTable column with header select-all checkbox.
2. Implement `selectedIds` Set state with toggle/selectAll/clearAll handlers.
3. Build `BulkActionsToolbar.tsx` — positioned sticky bottom or top, shows selection count, action buttons with icons, confirm dialog for destructive actions (Delete, Pause).
4. Wire bulk action handlers to call T-42 backend bulk actions API via `apiFetch`.
5. Add i18n keys under `search_ai.sources_table.bulk` namespace.
6. Clear selection after successful bulk action.

### Acceptance Criteria

- `grep -r "BulkActionsToolbar" apps/studio/src/components/search-ai/data/SourcesTable.tsx` returns match
- `grep "selectedIds" apps/studio/src/components/search-ai/data/SourcesTable.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-38 (SourcesTable enhancements)
- T-42 (backend bulk actions) for actual API calls — UI can render without backend

### Risk Notes

- **Destructive bulk actions** (Delete, Pause) must show ConfirmDialog with count of affected sources. Delete should use TypeToConfirmInput if count > 5.

---

## Task T-40: SourcesTable Grouping + Quick Filter Pills

### Problem

The design (§3b) requires: group-by selector (None/Type/Status/Tenant), quick filter pills for each status showing counts, and tenant filter dropdown when multiple tenants exist. The table view toolbar needs a sort selector and status filter in addition to the existing search.

### Files to Modify

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (line 346 — toolbar area, line 150-155 — filtering logic) — Add grouping, filter pills, sort dropdown

### Files to Create

- `apps/studio/src/components/search-ai/data/SourcesToolbar.tsx` — Extracted toolbar with search, filters, sort, group-by, quick filter pills
- `apps/studio/src/components/search-ai/data/QuickFilterPills.tsx` — Horizontal row of clickable status count pills

### Function Signatures

**After:**

```ts
// SourcesToolbar.tsx
type GroupBy = 'none' | 'type' | 'status' | 'tenant';
type SortField = 'name' | 'status' | 'lastSync' | 'docs';
type SortDir = 'asc' | 'desc';

interface SourcesToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  statusFilter: string | null;
  onStatusFilterChange: (status: string | null) => void;
  typeFilter: string | null;
  onTypeFilterChange: (type: string | null) => void;
  groupBy: GroupBy;
  onGroupByChange: (group: GroupBy) => void;
  sortField: SortField;
  sortDir: SortDir;
  onSortChange: (field: SortField, dir: SortDir) => void;
  showTenantFilter: boolean;
  tenantFilter: string | null;
  onTenantFilterChange: (tenant: string | null) => void;
  statusCounts: Record<string, number>;
}
export function SourcesToolbar(props: SourcesToolbarProps): JSX.Element;

// QuickFilterPills.tsx
interface QuickFilterPillsProps {
  statusCounts: Record<string, number>;
  activeStatus: string | null;
  onStatusClick: (status: string | null) => void;
}
export function QuickFilterPills(props: QuickFilterPillsProps): JSX.Element;
```

### Subtasks

1. Extract toolbar from SourcesTable into `SourcesToolbar.tsx` with search, FilterSelect for status/type, SegmentedControl for group-by.
2. Build `QuickFilterPills.tsx` — horizontal scroll of Badge-like pills, each showing status + count, clickable to filter.
3. Implement group-by logic: when groupBy !== 'none', render grouped sections with collapsible headers and per-group source counts.
4. Add sort state (`sortField`, `sortDir`) with dropdown selector.
5. Add tenant filter — only visible when `sources` contain multiple unique `tenantId` values (from cross-tenant connectors).
6. Add i18n keys under `search_ai.sources_table.toolbar` and `search_ai.sources_table.groups` namespaces.

### Acceptance Criteria

- `grep -r "QuickFilterPills" apps/studio/src/components/search-ai/data/SourcesToolbar.tsx` returns match
- `grep "groupBy" apps/studio/src/components/search-ai/data/SourcesTable.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-38 (SourcesTable enhancements)

### Risk Notes

- **Group-by with DataTable**: DataTable doesn't natively support grouped sections. Implement grouping as multiple DataTable instances with section headers, or render a custom grouped layout. Keep it simple: grouped view replaces the single DataTable with per-group sections.

---

## Task T-41: Backend — Enhanced List Sources (Search, Filters, GroupBy, Aggregates)

### Problem

The current `listConnectors` in `apps/search-ai/src/services/connector.service.ts` (line 241) returns all connectors for an index without search, filtering, sorting, grouping, or aggregates. The C-09 API spec requires `GET /api/indexes/:indexId/sources` with query params: `search`, `status`, `type`, `sortBy`, `sortDir`, `groupBy`, `page`, `limit`, plus an `aggregates` response section.

### Files to Modify

- `apps/search-ai/src/routes/connectors.ts` (line 42 — listConnectors route) — Add Zod schema for enhanced query params, call enhanced service method
- `apps/search-ai/src/services/connector.service.ts` (line 241 — listConnectors) — Add search/filter/sort/paginate/aggregate logic
- `apps/search-ai/src/repos/connector.repository.ts` — Add query builder for filtered/sorted/paginated source listing

### Files to Create

- None (extends existing routes and services)

### Function Signatures

**Before:**

```ts
// connectors.ts line 42
router.get('/:indexId/connectors', async (req: Request, res: Response) => {
  // No query params parsed
  const data = await connectorService.listConnectors(req.params.indexId, req.tenantContext!.tenantId);

// connector.service.ts line 241
export async function listConnectors(indexId: string, tenantId: string) {
  // Returns { connectors, total } — no filtering, no aggregates
```

**After:**

```ts
// connectors.ts — enhanced query schema
const listSourcesQuery = z.object({
  search: z.string().optional(),
  status: z.string().optional(), // comma-separated: "active,syncing"
  type: z.string().optional(), // comma-separated: "sharepoint,web"
  sortBy: z.enum(['name', 'status', 'lastSync', 'documentCount']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  groupBy: z.enum(['none', 'type', 'status', 'tenant']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// connector.service.ts — enhanced signature
export async function listConnectors(
  indexId: string,
  tenantId: string,
  options?: {
    search?: string;
    status?: string[];
    type?: string[];
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    groupBy?: string;
    page?: number;
    limit?: number;
  },
): Promise<{
  connectors: IConnectorConfig[]; // from @agent-platform/database — never use `any[]`
  total: number;
  page: number;
  limit: number;
  aggregates: {
    totalDocs: number;
    totalSizeBytes: number;
    sourceCountByType: Record<string, number>;
    sourceCountByStatus: Record<string, number>;
    tokensExpiringCount: number;
  };
}>;
```

### Subtasks

1. Add `listSourcesQuery` Zod schema to `connectors.ts` and parse `req.query`.
2. Update `listConnectors` service to accept options object and apply MongoDB filters (`$regex` for search, `$in` for status/type).
3. Compute aggregates via MongoDB aggregation pipeline: `$group` for counts by type/status, `$sum` for totalDocs/totalSizeBytes.
4. Compute `tokensExpiringCount` by joining with OAuth token collection and counting tokens expiring within 7 days.
5. Support `groupBy` in response: when set, return `groups: Array<{ key: string, sources: Source[] }>` alongside the flat list.
6. Add pagination with `page`/`limit` defaulting to 1/50.

### Acceptance Criteria

- `grep "listSourcesQuery" apps/search-ai/src/routes/connectors.ts` returns match
- `grep "aggregates" apps/search-ai/src/services/connector.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- None (extends existing route)

### Risk Notes

- **Aggregation performance:** For tenants with 100+ connectors, the aggregation pipeline must use indexes. Ensure the existing `{ tenantId: 1, sourceType: 1 }` index on sources collection covers the group-by queries.
- **Backward compatibility:** Existing callers of `listConnectors` pass no options. The enhanced version must return the same shape when called without options (connectors + total) plus the new aggregates field.

---

## Task T-42: Backend — Bulk Actions Route

### Problem

No bulk action endpoint exists. The design requires `POST /api/indexes/:indexId/connectors/bulk-actions` accepting an action type and array of source/connector IDs. Actions: pause, resume, sync_now, delete, re_auth, apply_schedule, export_configs.

### Files to Modify

- `apps/search-ai/src/routes/connectors.ts` (after line 50) — Add bulk actions route
- `apps/search-ai/src/services/connector.service.ts` — Add `executeBulkAction` function

### Files to Create

- None

### Function Signatures

**After:**

```ts
// connectors.ts — new route
const bulkActionBody = z.object({
  action: z.enum([
    'pause', 'resume', 'sync_now', 'delete',
    're_auth', 'apply_schedule', 'export_configs',
  ]),
  sourceIds: z.array(z.string().min(1)).min(1).max(50),
  params: z.record(z.unknown()).optional(), // action-specific params (e.g., schedule for apply_schedule)
});

// MUST be registered in the static routes section (BEFORE /:indexId/connectors/:connectorId routes)
router.post('/:indexId/connectors/bulk-actions', async (req, res) => { ... });

// connector.service.ts
export async function executeBulkAction(
  indexId: string,
  tenantId: string,
  action: string,
  sourceIds: string[],
  params?: Record<string, unknown>,
): Promise<{
  results: Array<{ sourceId: string; success: boolean; error?: string }>;
  successCount: number;
  failureCount: number;
}>;
```

### Subtasks

1. Add Zod-validated POST route for bulk actions.
2. Implement `executeBulkAction` — iterate sourceIds, call existing service methods per action (pauseSync, resumeSync, startSync, deleteSource), collect per-item results.
3. Use `Promise.allSettled` for concurrent execution with a concurrency limit of 5.
4. Return partial success response: `{ results: [...], successCount, failureCount }`.
5. Write audit entries for each action via `auditService.writeAuditEntry`.

### Acceptance Criteria

- `grep "bulk-actions" apps/search-ai/src/routes/connectors.ts` returns match
- `grep "executeBulkAction" apps/search-ai/src/services/connector.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- None (uses existing service methods)

### Risk Notes

- **Concurrency limit:** Do not fire 50 sync operations simultaneously. Use p-limit or manual batching (5 concurrent max).
- **Partial failures:** The response must indicate per-item success/failure. Never fail the entire request because one item failed.

---

## Task T-43: Create Security Tab (Scopes, Token, Emergency Revoke, Audit Log)

### Problem

The Security tab (§6 of design, C-06 capability note) is currently a placeholder in `SharePointDetailPanel.tsx` (line 71, wave: 'Wave 4'). It must render: granted OAuth scopes, token expiry with renewal countdown, what the connector accesses vs does NOT access, emergency revoke with blast-radius confirmation, security review document export (PDF/JSON/Markdown), and an immutable audit log table.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line 385 — placeholder rendering for non-connect tabs) — Import and render SecurityTab component

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/SecurityTab.tsx` — Main Security tab component
- `apps/studio/src/components/search-ai/sharepoint/security/ScopesSection.tsx` — Granted scopes list with descriptions
- `apps/studio/src/components/search-ai/sharepoint/security/TokenExpirySection.tsx` — Token status, expiry countdown, renewal action
- `apps/studio/src/components/search-ai/sharepoint/security/AccessSummarySection.tsx` — What connector accesses / does not access
- `apps/studio/src/components/search-ai/sharepoint/security/EmergencyRevokeSection.tsx` — Revoke button, blast radius dialog, TypeToConfirmInput
- `apps/studio/src/components/search-ai/sharepoint/security/SecurityExportSection.tsx` — Export as PDF/JSON/Markdown buttons
- `apps/studio/src/components/search-ai/sharepoint/security/AuditLogSection.tsx` — DataTable with category filter, date range, pagination, download
- `apps/studio/src/hooks/useSecurityOverview.ts` — SWR hook for security data
- `apps/studio/src/hooks/useAuditLog.ts` — SWR hook for paginated audit log

### Function Signatures

**After:**

```ts
// SecurityTab.tsx
interface SecurityTabProps {
  indexId: string;
  connectorId: string;
}
export function SecurityTab({ indexId, connectorId }: SecurityTabProps): JSX.Element;

// useSecurityOverview.ts
interface SecurityOverview {
  grantedScopes: Array<{ scope: string; description: string; grantedAt: string }>;
  tokenStatus: { expiresAt: string; isExpired: boolean; daysRemaining: number };
  accessSummary: { accesses: string[]; doesNotAccess: string[] };
  approvalGate: { mode: 'none' | 'pending' | 'approved'; approvedBy?: string };
}
export function useSecurityOverview(
  indexId: string,
  connectorId: string,
): {
  data: SecurityOverview | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
};

// useAuditLog.ts
export function useAuditLog(
  indexId: string,
  connectorId: string,
  options: { category?: string; page?: number; limit?: number },
): {
  entries: AuditLogEntry[];
  total: number;
  isLoading: boolean;
  error: string | null;
};

// EmergencyRevokeSection.tsx
interface EmergencyRevokeSectionProps {
  indexId: string;
  connectorId: string;
  connectorName: string;
  onRevoked: () => void;
}
export function EmergencyRevokeSection(props: EmergencyRevokeSectionProps): JSX.Element;
// Internally calls GET .../security/blast-radius before showing confirm dialog
// Then POST .../security/emergency-revoke with TypeToConfirmInput
```

### Subtasks

1. Create `SecurityTab.tsx` as layout component — renders sections in order: Scopes, Token, Access Summary, Emergency Revoke, Security Export, Audit Log.
2. Build `ScopesSection.tsx` — lists each granted scope with human-readable description, granted date.
3. Build `TokenExpirySection.tsx` — shows expiry date, "X days remaining" countdown, renewal button calling `POST .../auth/refresh`.
4. Build `AccessSummarySection.tsx` — two columns: "This connector CAN access" and "This connector CANNOT access" lists.
5. Build `EmergencyRevokeSection.tsx` — danger zone styling, [Revoke Access] button, blast radius pre-check (fetches affected docs/chunks count), TypeToConfirmInput with connector name.
6. Build `SecurityExportSection.tsx` — three export buttons (PDF, JSON/YAML, Copy Markdown). JSON/YAML uses client-side format toggle.
7. Build `AuditLogSection.tsx` — DataTable with columns (timestamp, actor, event, category, details), category FilterSelect, date range pickers, pagination, [Download] button.
8. Create `useSecurityOverview.ts` — SWR hook for `GET /indexes/:indexId/connectors/:connectorId/security/overview`.
9. Create `useAuditLog.ts` — SWR hook wrapping existing audit-log route with pagination state.
10. Wire SecurityTab into SharePointDetailPanel by replacing the placeholder conditional.
11. Add i18n keys under `search_ai.sharepoint.security` namespace.

### Acceptance Criteria

- `grep -r "SecurityTab" apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` returns match (not placeholder)
- `ls apps/studio/src/components/search-ai/sharepoint/security/` shows 6 section files
- `grep "useSecurityOverview" apps/studio/src/hooks/useSecurityOverview.ts` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-10 (panel shell — Wave 1, complete)
- T-06 (ConnectorAuditEntry model — Wave 1, complete)
- T-44 (backend security routes) for actual API responses

### Risk Notes

- **Emergency revoke is destructive.** The blast-radius pre-check MUST complete before showing the confirm dialog. Show the affected document/chunk count in the dialog text.
- **Audit log pagination:** Use the existing `connector-audit.ts` route (line 59). The hook just wraps SWR with query params.

---

## Task T-44: Backend — Emergency Revoke, Blast Radius, Security Export Routes

### Problem

No security-specific routes exist. C-06 requires: `GET .../security/overview` (scopes, token status, access summary), `GET .../security/blast-radius` (counts of affected resources), `POST .../security/emergency-revoke` (revoke OAuth token + disable connector), and `GET .../security/export` (formatted security review document).

### Files to Modify

- `apps/search-ai/src/server.ts` (after `connectorConfigVersionRouter` mount, before pipeline routes) — Mount new security router: `app.use('/api/indexes', connectorSecurityRouter);`

### Files to Create

- `apps/search-ai/src/routes/connector-security.ts` — Security routes with Zod validation
- `apps/search-ai/src/services/connector-security.service.ts` — Security business logic

### Function Signatures

**After:**

```ts
// connector-security.ts
import { ConnectorError } from '../services/connector.service.js';

const router = Router();
router.use(authMiddleware);

// ─── Zod Validation Schemas ─────────────────────────────────────────────
const routeParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});
const revokeBody = z.object({
  confirmPhrase: z.string().min(1),
});
const exportQuery = z.object({
  format: z.enum(['json', 'yaml', 'markdown']),
});

// ─── handleError (ConnectorError-aware, same pattern as connectors.ts) ──
function handleError(res: Response, error: unknown, fallbackCode: string): void { ... }

// ─── Static routes FIRST (before any :connectorId parameterized routes) ──

// GET /:indexId/connectors/:connectorId/security/overview
// Returns: { grantedScopes, tokenStatus, accessSummary, approvalGate }

// GET /:indexId/connectors/:connectorId/security/blast-radius
// Returns: { documentCount, chunkCount, embeddingCount, permissionEntriesCount }

// POST /:indexId/connectors/:connectorId/security/emergency-revoke
// Body validated with revokeBody: { confirmPhrase: string }
// Side effects: revoke OAuth token, set connector status to disabled, write audit entry
// Returns: { success: true, revokedAt: string }

// GET /:indexId/connectors/:connectorId/security/export
// Query validated with exportQuery: { format: 'json' | 'yaml' | 'markdown' }
// Returns: formatted security review document

// connector-security.service.ts
export async function getSecurityOverview(
  connectorId: string,
  tenantId: string,
): Promise<SecurityOverviewResponse>;

export async function getBlastRadius(
  connectorId: string,
  tenantId: string,
): Promise<BlastRadiusResponse>;

export async function emergencyRevoke(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ revokedAt: string }>;

export async function exportSecurityDocument(
  connectorId: string,
  tenantId: string,
  format: 'json' | 'yaml' | 'markdown',
): Promise<{ contentType: string; data: string; filename: string }>;
```

### Subtasks

1. Create `connector-security.ts` with four routes following the `handleError` pattern from `connectors.ts` (which is ConnectorError-aware, unlike the simpler handler in `connector-audit.ts`).
2. Create `connector-security.service.ts` with security overview aggregation (reads connector config, OAuth token, discovery stats).
3. Implement blast-radius: count documents, chunks, and embeddings associated with the connector's sourceId.
4. Implement emergency-revoke: delete OAuth token from DB, set connector `isPaused: true`, write audit entry with category `'lifecycle'`, event `'security.emergency_revoke'`.
5. Implement security export: build a structured document with connector info, scopes, access summary, approval status. Format as JSON/YAML (using `js-yaml`) or Markdown.
6. Mount router in `server.ts` under `/api/indexes`.
7. Register static routes (`.../security/overview`, `.../security/blast-radius`, `.../security/export`) BEFORE any parameterized routes in the router.

### Acceptance Criteria

- `grep "connector-security" apps/search-ai/src/server.ts` returns match
- `grep "emergencyRevoke" apps/search-ai/src/services/connector-security.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- T-06 (ConnectorAuditEntry model — Wave 1, complete)

### Risk Notes

- **Emergency revoke is irreversible** within a session. The service must delete the OAuth token AND write an audit entry BEFORE returning success. Use a try/catch that logs partial failure if audit write fails (revoke still succeeds).
- **Route ordering:** Security routes must be registered BEFORE `:connectorId` parameterized routes to prevent Express from matching `/security/overview` as `connectorId="security"`.

---

## Task T-45: Create Config Export Dialog (Format, Checkboxes, Preview, Download/Copy)

### Problem

C-12 §9a describes a config export dialog with: format selector (JSON/YAML radio), include checkboxes (Scope, Filters, Schedule, Permission mode — checked by default; Credentials — unchecked with warning), syntax-highlighted preview pane, [Download] and [Copy to Clipboard] buttons. This dialog is triggered from the More Actions menu in SharePointDetailPanel.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line 276-290 — disabled Export JSON/YAML menu items) — Enable and wire to open ConfigExportDialog

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/config/ConfigExportDialog.tsx` — Modal dialog with format selector, checkboxes, preview, download/copy

### Function Signatures

**After:**

```ts
// ConfigExportDialog.tsx
interface ConfigExportDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorId: string;
  connectorName: string;
}
export function ConfigExportDialog(props: ConfigExportDialogProps): JSX.Element;
// Internally:
// - Fetches config via GET .../config/export?format=json&includeScope=true&...
// - Client-side JSON→YAML conversion using js-yaml
// - Download triggers browser file download: <connector-name>-config-v<N>.<json|yaml>
// - Copy writes preview content to clipboard with toast
```

### Subtasks

1. Build `ConfigExportDialog.tsx` with SegmentedControl for JSON/YAML format toggle.
2. Render four default-checked checkboxes (Scope, Filters, Schedule, Permission mode) and one default-unchecked (Credentials) with caution icon and inline warning.
3. Fetch config from T-49 export endpoint. Re-fetch when checkboxes toggle (debounced 300ms).
4. Render syntax-highlighted preview using `<pre>` with Tailwind `font-mono` styling (no external syntax highlight library needed — JSON/YAML are readable as-is).
5. [Download] creates a Blob and triggers `URL.createObjectURL` download with filename `<connectorName>-config-v<N>.<ext>`.
6. [Copy to Clipboard] uses `navigator.clipboard.writeText` with toast.
7. Enable the Export JSON/YAML menu items in SharePointDetailPanel and wire `onClick` to set dialog open state.
8. Add i18n keys under `search_ai.sharepoint.config.export` namespace.

### Acceptance Criteria

- `grep "ConfigExportDialog" apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` returns match
- `grep "navigator.clipboard" apps/studio/src/components/search-ai/sharepoint/config/ConfigExportDialog.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-10 (panel shell)
- T-49 (backend config export route) for actual data

### Risk Notes

- **Client-side YAML conversion:** Use the `js-yaml` library (`pnpm add js-yaml` + `@types/js-yaml` in studio). Keep the dependency in studio only.
- **Credentials checkbox:** NEVER pre-check. When checked, show inline warning: "Credentials will be included in plaintext. Do not share this export publicly."

---

## Task T-46: Create Version History Tab (Table, Diff, Restore)

### Problem

C-12 §9b describes the Version History tab with: version history table (version, date, changedBy, summary, current badge), contextual [View Diff: vN → current] button, side-by-side diff view, and [Restore vN] with confirmation dialog. The existing `connector-config-versions.ts` route (line 67-137) provides list and snapshot endpoints, but the diff route is deferred (line 139-141).

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line 385 — placeholder for history tab) — Import and render VersionHistoryTab
- `apps/search-ai/src/routes/connector-config-versions.ts` (line 139-141 — deferred diff route) — Implement the diff endpoint
- `apps/search-ai/src/services/connector-config-version.service.ts` (line 128 — end of file) — Add `diffVersions` and `restoreVersion` functions

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/config/VersionHistoryTab.tsx` — Version history table + diff viewer + restore
- `apps/studio/src/components/search-ai/sharepoint/config/ConfigDiffViewer.tsx` — Side-by-side or inline diff display
- `apps/studio/src/hooks/useConfigVersions.ts` — SWR hook for version history

### Function Signatures

**Before:**

```ts
// connector-config-versions.ts line 139-141
// Diff route deferred to Wave 4 (config management). When implementing:
// - Register BEFORE :versionNumber route (static before parameterized)
// - Use diffQuery schema: z.object({ from: z.coerce.number(), to: z.coerce.number() })

// connector-config-version.service.ts — no diff or restore function
```

**After:**

```ts
// connector-config-versions.ts — new diff route (before :versionNumber route)
const diffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

router.get(
  '/:indexId/connectors/:connectorId/config/versions/diff',
  async (req, res) => { ... }
);

// connector-config-versions.ts — new restore route
router.post(
  '/:indexId/connectors/:connectorId/config/versions/restore',
  async (req, res) => { ... }
);

// connector-config-version.service.ts — new functions
export async function diffVersions(
  connectorId: string,
  tenantId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{
  fromVersion: number;
  toVersion: number;
  changes: Array<{
    path: string;
    oldValue: unknown;
    newValue: unknown;
    type: 'added' | 'removed' | 'changed';
  }>;
}>;

export async function restoreVersion(
  connectorId: string,
  tenantId: string,
  versionNumber: number,
  restoredBy: string,
): Promise<IConnectorConfigVersion>;

// VersionHistoryTab.tsx
interface VersionHistoryTabProps {
  indexId: string;
  connectorId: string;
}
export function VersionHistoryTab(props: VersionHistoryTabProps): JSX.Element;

// ConfigDiffViewer.tsx
interface ConfigDiffViewerProps {
  fromVersion: number;
  toVersion: number;
  changes: Array<{
    path: string;
    oldValue: unknown;
    newValue: unknown;
    type: 'added' | 'removed' | 'changed';
  }>;
}
export function ConfigDiffViewer(props: ConfigDiffViewerProps): JSX.Element;

// useConfigVersions.ts
export function useConfigVersions(
  indexId: string,
  connectorId: string,
  options?: { page?: number; limit?: number },
): {
  versions: ConfigVersion[];
  total: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
};
```

### Subtasks

1. **Backend — diff endpoint:** Add `diffQuery` Zod schema and `GET .../config/versions/diff` route BEFORE the `:versionNumber` route (per line 140 comment). Register it at the correct position.
2. **Backend — diffVersions service:** Fetch both version snapshots, compute structural diff by deep-comparing config objects. Use recursive key comparison to produce `{ path, oldValue, newValue, type }` entries.
3. **Backend — restore endpoint:** Add `POST .../config/versions/restore` route with body `{ version: number }`. Service fetches the target version's snapshot and creates a new version with `changeSource: 'restore'`.
4. **Frontend — VersionHistoryTab:** DataTable with columns: Version (Badge "current" on latest), Date, Changed By, Summary. Row click or [View Diff] button triggers diff fetch.
5. **Frontend — ConfigDiffViewer:** Two-column layout: left = old value, right = new value. Each change row shows path, type badge (added/removed/changed), and values with color coding (red for removed, green for added).
6. **Frontend — useConfigVersions hook:** SWR with pagination support wrapping existing `GET .../config/versions` endpoint.
7. Wire VersionHistoryTab into SharePointDetailPanel replacing the history tab placeholder.
8. Add [Restore vN] button per row → ConfirmDialog → `POST .../config/versions/restore`.
9. Add i18n keys under `search_ai.sharepoint.config.history` namespace.

### Acceptance Criteria

- `grep "versions/diff" apps/search-ai/src/routes/connector-config-versions.ts` returns match
- `grep "restoreVersion" apps/search-ai/src/services/connector-config-version.service.ts` returns match
- `grep "VersionHistoryTab" apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` returns match
- `pnpm build --filter=search-ai` succeeds
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-07 (ConnectorConfigVersion model — Wave 1, complete)
- T-10 (panel shell — Wave 1, complete)

### Risk Notes

- **Diff route ordering is critical.** The comment at line 139-141 explicitly warns: register BEFORE `:versionNumber` route. If placed after, Express will match `diff` as a version number parameter.
- **Deep diff algorithm:** Keep it simple — iterate top-level keys of configSnapshot, then recursively compare nested objects. Do not pull in a diff library; the config objects are shallow enough (< 10 top-level keys).

---

## Task T-47: Create Config Drift Section

### Problem

C-12 §9b describes config drift detection for connectors created from templates. Shows template name, applied version, deviation list (field, template value, current value, version that introduced deviation). Actions: [Re-apply Template], [Update Template to Match Current], [Ignore Drift].

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/config/VersionHistoryTab.tsx` (after version table) — Add drift section conditionally

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/config/ConfigDriftSection.tsx` — Drift detection display + actions
- `apps/studio/src/hooks/useConfigDrift.ts` — SWR hook for drift data

### Function Signatures

**After:**

```ts
// ConfigDriftSection.tsx
interface ConfigDriftSectionProps {
  indexId: string;
  connectorId: string;
  onDriftResolved: () => void; // refresh parent after action
}
export function ConfigDriftSection(props: ConfigDriftSectionProps): JSX.Element;

// useConfigDrift.ts
interface ConfigDrift {
  hasDrift: boolean;
  templateName: string | null;
  templateAppliedAtVersion: string | null;
  deviations: Array<{
    field: string;
    templateValue: unknown;
    currentValue: unknown;
    deviatedAtVersion: string;
  }>;
}
export function useConfigDrift(
  indexId: string,
  connectorId: string,
): {
  drift: ConfigDrift | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
};
```

### Subtasks

1. Create `useConfigDrift.ts` — SWR hook for `GET .../config/drift` (T-49 endpoint).
2. Build `ConfigDriftSection.tsx` — only renders when `hasDrift === true`. Shows template name, deviation table (DataTable with path/templateValue/currentValue/version columns).
3. Three action buttons with ConfirmDialog:
   - [Re-apply Template] → `POST .../config/drift/reapply-template` — warns deviations will be overwritten
   - [Update Template to Match Current] → `POST .../config/drift/update-template` — warns affects future connectors
   - [Ignore Drift] → `POST .../config/drift/ignore` — dismisses notice
4. Handle "template deleted" edge case: if `templateName` is null but connector was created from a template, show "Template no longer available" and hide Re-apply/Update actions.
5. Add i18n keys under `search_ai.sharepoint.config.drift` namespace.

### Acceptance Criteria

- `grep "ConfigDriftSection" apps/studio/src/components/search-ai/sharepoint/config/VersionHistoryTab.tsx` returns match
- `grep "useConfigDrift" apps/studio/src/hooks/useConfigDrift.ts` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-46 (Version History Tab — renders within it)
- T-49 (backend drift endpoints)
- T-53 (ConnectorTemplate model — for template data)

### Risk Notes

- **Drift section is conditionally rendered.** When `hasDrift: false` or `templateName: null`, the section is completely hidden. Do not render an empty container.

---

## Task T-48: Create Content Purge Dialog (Progress, Cancel, Retry)

### Problem

C-12 §9b Danger Zone describes [Delete All Synced Content] which purges documents, chunks, and vector embeddings while preserving connector config. The dialog shows progress bars per resource type, estimated time remaining, and supports cancel and retry on failure.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line 321-333 — disabled Delete menu item) — Enable and wire to open purge dialog

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/config/ContentPurgeDialog.tsx` — Multi-step dialog: confirm → progress → complete/failed

### Function Signatures

**After:**

```ts
// ContentPurgeDialog.tsx
interface ContentPurgeDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorId: string;
  connectorName: string;
  documentCount: number;
  onPurgeComplete: () => void;
}
export function ContentPurgeDialog(props: ContentPurgeDialogProps): JSX.Element;
// States: 'confirm' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
// Confirm step: shows doc count, chunk/embedding warning, TypeToConfirmInput
// Progress step: 3 progress bars (docs, chunks, embeddings) with percentages
// Poll GET .../content/purge/:cleanupId every 2s for progress
// Cancel: POST .../content/purge/:cleanupId/cancel
// Retry: POST .../content/purge/:cleanupId/retry
```

### Subtasks

1. Build `ContentPurgeDialog.tsx` with state machine: confirm → in_progress → completed/failed/cancelled.
2. Confirm step: show document count, warning text about chunks and embeddings, TypeToConfirmInput with connector name. Check connector sync status — disable purge if syncing.
3. On confirm, call `POST .../content/purge` (T-50 endpoint), receive `cleanupId`.
4. Progress step: poll `GET .../content/purge/:cleanupId` every 2 seconds. Display 3 progress bars (documents, chunks, embeddings) each with `removed/total` count and percentage bar. Show estimated time remaining.
5. [Cancel Cleanup] button available during progress → `POST .../content/purge/:cleanupId/cancel`. On cancel, show partial state with counts of what was removed.
6. Failed step: error message, counts of removed vs remaining, [Retry Cleanup] → `POST .../content/purge/:cleanupId/retry`, [Contact Support] link.
7. Completed step: success message with counts.
8. Enable the Delete menu item in SharePointDetailPanel and wire to dialog.
9. Add i18n keys under `search_ai.sharepoint.config.purge` namespace.

### Acceptance Criteria

- `grep "ContentPurgeDialog" apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` returns match
- `grep "cleanupId" apps/studio/src/components/search-ai/sharepoint/config/ContentPurgeDialog.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-10 (panel shell)
- T-50 (backend purge routes)

### Risk Notes

- **Polling cleanup:** Use `setInterval` with cleanup in `useEffect` return. Clear interval when dialog closes or status reaches terminal state (completed/failed/cancelled).
- **Sync conflict:** Before showing confirm, fetch connector status. If `syncInProgress === true`, show warning and disable the confirm button.

---

## Task T-49: Backend — Config Export, Drift, Import Routes

### Problem

C-12 requires 8 endpoints that do not exist (per API coverage matrix: all 11 C-12 endpoints are "Not Found"): config export, drift detection, drift actions (reapply/update/ignore), and config import (preview + confirm). The existing `connector-config-versions.ts` route handles version CRUD but not export/drift/import.

### Files to Modify

- `apps/search-ai/src/server.ts` (after connector version/security router mounts, before pipeline routes) — Mount new config management router: `app.use('/api/indexes', connectorConfigMgmtRouter);`

### Files to Create

- `apps/search-ai/src/routes/connector-config-mgmt.ts` — Config export, drift, import routes
- `apps/search-ai/src/services/connector-config-mgmt.service.ts` — Export/drift/import business logic

### Function Signatures

**After:**

```ts
// connector-config-mgmt.ts — route file
const router = Router();
router.use(authMiddleware);

// ─── Zod Validation Schemas ─────────────────────────────────────────────
const routeParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const importBody = z.object({
  config: z.record(z.unknown()),
});

// ─── handleError (ConnectorError-aware, same pattern as connectors.ts) ──
function handleError(res: Response, error: unknown, fallbackCode: string): void { ... }

// GET /:indexId/connectors/:connectorId/config/export
// Query: format, includeScope, includeFilters, includeSchedule, includePermissionMode, includeCredentials
const exportQuery = z.object({
  format: z.enum(['json', 'yaml']).default('json'),
  includeScope: z.coerce.boolean().default(true),
  includeFilters: z.coerce.boolean().default(true),
  includeSchedule: z.coerce.boolean().default(true),
  includePermissionMode: z.coerce.boolean().default(true),
  includeCredentials: z.coerce.boolean().default(false),
});

// GET /:indexId/connectors/:connectorId/config/drift
// POST /:indexId/connectors/:connectorId/config/drift/reapply-template
// POST /:indexId/connectors/:connectorId/config/drift/update-template
// POST /:indexId/connectors/:connectorId/config/drift/ignore
// POST /:indexId/connectors/:connectorId/config/import
// POST /:indexId/connectors/:connectorId/config/import/confirm

// connector-config-mgmt.service.ts
export async function exportConfig(
  connectorId: string,
  tenantId: string,
  options: ExportOptions,
): Promise<{ config: Record<string, unknown>; version: string; exportedAt: string }>;

export async function getConfigDrift(
  connectorId: string,
  tenantId: string,
): Promise<ConfigDriftResponse>;

export async function reapplyTemplate(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<IConnectorConfigVersion>;

export async function updateTemplateFromCurrent(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ templateId: string; updatedAt: string }>;

export async function ignoreDrift(
  connectorId: string,
  tenantId: string,
): Promise<{ acknowledged: true }>;

export async function previewImport(
  connectorId: string,
  tenantId: string,
  importedConfig: Record<string, unknown>,
): Promise<{ diff: DiffResponse; requiresConfirmation: true }>;

export async function confirmImport(
  connectorId: string,
  tenantId: string,
  importedConfig: Record<string, unknown>,
  actor: string,
): Promise<IConnectorConfigVersion>;
```

### Subtasks

1. Create `connector-config-mgmt.ts` with 7 routes following the `handleError` pattern from `connectors.ts` (ConnectorError-aware). Import `ConnectorError` and `handleError` from the shared connector routes pattern, or replicate it locally.
2. **Export:** Read connector config, filter fields based on include flags, inject `version` and `exportedAt`, serialize as JSON or YAML (using `js-yaml`).
3. **Drift detection:** Compare current connector config against stored template config (from ConnectorTemplate model). Return `hasDrift: false` with `templateName: null` for non-templated connectors.
4. **Reapply template:** Load template config, create new config version with template values, return new version.
5. **Update template:** Read current connector config, update the template document, return updated metadata.
6. **Ignore drift:** Set `driftIgnoredAt` field on connector config (or a drift-suppression document). Return acknowledgment.
7. **Import preview:** Parse imported config, diff against current config using `diffVersions` from T-46 service.
8. **Import confirm:** Apply imported config as new version with `changeSource: 'import'`. Strip credentials if present.
9. Mount router in `server.ts`.
10. Add `js-yaml` dependency to search-ai: `pnpm add js-yaml` + `pnpm add -D @types/js-yaml` in `apps/search-ai`.

### Acceptance Criteria

- `grep "connector-config-mgmt" apps/search-ai/src/server.ts` returns match
- `grep "exportConfig" apps/search-ai/src/services/connector-config-mgmt.service.ts` returns match
- `grep "drift" apps/search-ai/src/routes/connector-config-mgmt.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- T-07 (ConnectorConfigVersion model — Wave 1, complete)
- T-53 (ConnectorTemplate model — for drift detection)

### Risk Notes

- **Credentials export requires elevated permission check.** The `includeCredentials` option should be gated by a permission check. For now, log a warning in audit when credentials are exported.
- **js-yaml dependency:** Both studio (T-45) and search-ai (T-49) need `js-yaml`. Install separately in each package.
- **Route ordering:** Register `/config/export`, `/config/drift`, `/config/import` as static routes BEFORE any routes with path params.

---

## Task T-50: Backend — Content Purge Routes

### Problem

No content purge endpoints exist. C-12 requires: `POST .../content/purge` (initiate), `GET .../content/purge/:cleanupId` (poll status), `POST .../content/purge/:cleanupId/cancel`, `POST .../content/purge/:cleanupId/retry`.

### Files to Modify

- `apps/search-ai/src/server.ts` (after connector router mounts, before pipeline routes) — Mount purge router: `app.use('/api/indexes', connectorContentPurgeRouter);`

### Files to Create

- `apps/search-ai/src/routes/connector-content-purge.ts` — Purge routes with Zod validation
- `apps/search-ai/src/services/connector-content-purge.service.ts` — Purge business logic with BullMQ job
- `packages/database/src/models/connector-cleanup-job.model.ts` — Model tracking purge job state

### Function Signatures

**After:**

```ts
// connector-content-purge.ts
const router = Router();
router.use(authMiddleware);

// POST /:indexId/connectors/:connectorId/content/purge
// Precondition: sync must not be in progress
// Returns: { cleanupId, status: 'in_progress' }

// GET /:indexId/connectors/:connectorId/content/purge/:cleanupId
// Returns: CleanupStatus object

// POST /:indexId/connectors/:connectorId/content/purge/:cleanupId/cancel
// POST /:indexId/connectors/:connectorId/content/purge/:cleanupId/retry

// connector-content-purge.service.ts
export async function initiatePurge(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ cleanupId: string; status: 'in_progress' }>;

export async function getPurgeStatus(cleanupId: string, tenantId: string): Promise<CleanupStatus>;

export async function cancelPurge(cleanupId: string, tenantId: string): Promise<CleanupStatus>;

export async function retryPurge(cleanupId: string, tenantId: string): Promise<CleanupStatus>;

interface CleanupStatus {
  cleanupId: string;
  status: 'idle' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  documents: { total: number; removed: number };
  chunks: { total: number; removed: number };
  vectorEmbeddings: { total: number; removed: number };
  estimatedTimeRemaining: number | null;
  error: string | null;
}

// connector-cleanup-job.model.ts
export interface IConnectorCleanupJob {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: 'idle' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  documents: { total: number; removed: number };
  chunks: { total: number; removed: number };
  vectorEmbeddings: { total: number; removed: number };
  estimatedTimeRemaining: number | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  initiatedBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Subtasks

1. Create `connector-cleanup-job.model.ts` in `packages/database/src/models/` with Mongoose schema, tenant isolation plugin, and ModelRegistry registration.
2. Export the model and interface from `packages/database/src/index.ts`.
3. Create `connector-content-purge.service.ts` with purge logic: check sync status (reject if syncing), create cleanup job, enqueue BullMQ job for async deletion.
4. Async purge worker: delete documents by `sourceId`, then chunks by `documentId`, then embeddings. Update cleanup job progress after each batch.
5. Cancel: publish Redis signal (same pattern as `stopSync` in `connector.service.ts` line 1020), set status to 'cancelled'.
6. Retry: check status is 'failed', re-enqueue BullMQ job picking up from last progress.
7. Create `connector-content-purge.ts` routes with Zod validation. Add Zod schemas for `routeParams` (indexId, connectorId) and `cleanupIdParam` (cleanupId: `z.string().min(1)`). Use the ConnectorError-aware `handleError` pattern from `connectors.ts`.
8. Mount router in `server.ts`.

### Acceptance Criteria

- `grep "connector-content-purge" apps/search-ai/src/server.ts` returns match
- `grep "initiatePurge" apps/search-ai/src/services/connector-content-purge.service.ts` returns match
- `grep "ConnectorCleanupJob" packages/database/src/models/connector-cleanup-job.model.ts` returns match
- `grep "ConnectorCleanupJob" packages/database/src/index.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- None (new routes and model)

### Risk Notes

- **Dockerfile sync not needed:** The model is added to the existing `packages/database` package which is already in all Dockerfile COPY lists. No Dockerfile changes required.
- **BullMQ job for async purge:** Follow the same pattern as `QUEUE_CONNECTOR_SYNC` in `connector.service.ts`. Create a `QUEUE_CONNECTOR_PURGE` queue with dedicated worker.
- **Batch deletion:** Delete in batches of 100 documents at a time to avoid MongoDB timeouts. Update cleanup job progress after each batch.
- **Sync conflict check:** Before initiating purge, check `syncState.syncInProgress` on the connector. Reject with 409 Conflict if sync is active.

---

## Task T-51: Create Multi-Connector Dialog (Clone, Template, Import)

### Problem

C-10 describes the "How would you like to set up this connector?" dialog that appears when adding a second+ SharePoint connector. It offers: From Scratch, Clone Existing, From Template, Import Configuration, and API/CLI reference. The Clone path requires a Template Security Gate when the source has permission-aware search enabled.

### Files to Modify

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (line 336-343 — empty state, or wherever "+ Add Source" is triggered) — Show multi-connector dialog when SP connectors already exist

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/MultiConnectorDialog.tsx` — Main setup method dialog
- `apps/studio/src/components/search-ai/sharepoint/TemplateSecurityGate.tsx` — Permission acknowledgment gate for clone/template with permission-aware search
- `apps/studio/src/hooks/useConnectorTemplates.ts` — SWR hook for template list

### Function Signatures

**After:**

```ts
// MultiConnectorDialog.tsx
interface MultiConnectorDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  existingConnectors: Array<{
    connectorId: string;
    name: string;
    tenantId: string;
    permissionMode: 'enabled' | 'public_access';
    status: string;
  }>;
  onConnectorCreated: (connectorId: string) => void;
}
export function MultiConnectorDialog(props: MultiConnectorDialogProps): JSX.Element;
// Steps: method_select → (clone_select | template_select | import_upload) → security_gate? → creating

// TemplateSecurityGate.tsx
interface TemplateSecurityGateProps {
  sourceName: string;
  sourcePermissionMode: 'enabled' | 'public_access';
  requiredScopes: string[];
  onContinueWithPermissions: () => void;
  onDisablePermissions: (confirmPhrase: string) => void;
  onCancel: () => void;
}
export function TemplateSecurityGate(props: TemplateSecurityGateProps): JSX.Element;

// useConnectorTemplates.ts
interface ConnectorTemplate {
  templateId: string;
  name: string;
  description?: string;
  permissionMode: 'enabled' | 'public_access';
  createdAt: string;
  usageCount?: number;
}
export function useConnectorTemplates(indexId: string): {
  templates: ConnectorTemplate[];
  isLoading: boolean;
  error: string | null;
};
```

### Subtasks

1. Build `MultiConnectorDialog.tsx` as a multi-step dialog with method selector: From Scratch, Clone Existing, From Template, Import Configuration, API/CLI.
2. **From Scratch:** Closes dialog, opens SharePointDetailPanel with Connect tab (existing flow).
3. **Clone Existing:** Show list of existing SP connectors with selectable items. On select + [Clone →], check permission mode → show TemplateSecurityGate if needed → call `POST .../clone` (T-52).
4. **From Template:** Show template list (from `useConnectorTemplates`). [Browse All Templates] for full list with search. On select, check permission mode → security gate → call `POST .../templates/:id/apply` (T-52).
5. **Import Configuration:** File picker (JSON/YAML) or paste textarea. Parse client-side, detect permission mode, show security gate if needed, call `POST .../import` (T-52).
6. **API/CLI:** Display POST endpoint, cURL template, CLI command. [Copy cURL] and [Copy CLI] buttons.
7. Build `TemplateSecurityGate.tsx` — shows source name, inherited permission setting, required scopes. [Continue with Permissions Enabled] or [Disable → type-to-confirm].
8. Create `useConnectorTemplates.ts` SWR hook.
9. Add overlap warning for Clone: static note about duplicate indexing.
10. Add cross-tenant notice for Clone: detect tenant mismatch, show cleared fields notice.
11. Add i18n keys under `search_ai.sharepoint.multi_connector` namespace.

### Acceptance Criteria

- `grep "MultiConnectorDialog" apps/studio/src/components/search-ai/sharepoint/MultiConnectorDialog.tsx` returns match
- `grep "TemplateSecurityGate" apps/studio/src/components/search-ai/sharepoint/TemplateSecurityGate.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-10 (panel shell)
- T-52 (backend clone/template/import routes)
- T-53 (ConnectorTemplate model)

### Risk Notes

- **Multi-step dialog state management:** Use a `step` state variable with discriminated union types for each step's data. Do not use multiple boolean flags.
- **Security gate is mandatory** for any source with permission-aware search. Never skip it.

---

## Task T-52: Backend — Clone, Template CRUD, Import Routes

### Problem

C-10 API coverage matrix shows: Clone (Not Found), Templates (Not Found), Import (Not Found). Need endpoints for: clone connector, list/create/apply templates, import configuration.

### Files to Modify

- `apps/search-ai/src/server.ts` (after connector router mounts, before pipeline routes) — Mount new multi-connector router: `app.use('/api/indexes', connectorMultiRouter);`
- `apps/search-ai/src/services/connector.service.ts` (after line 251 — createConnector) — Add `cloneConnector` function

### Files to Create

- `apps/search-ai/src/routes/connector-multi.ts` — Clone, template, and import routes
- `apps/search-ai/src/services/connector-template.service.ts` — Template CRUD and apply logic

### Function Signatures

**After:**

```ts
// connector-multi.ts
const router = Router();
router.use(authMiddleware);

// POST /:indexId/connectors/:connectorId/clone
const cloneBody = z.object({
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

// GET /:indexId/connector-templates
// POST /:indexId/connector-templates
const createTemplateBody = z.object({
  sourceConnectorId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

// POST /:indexId/connector-templates/:templateId/apply
const applyTemplateBody = z.object({
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

// POST /:indexId/connectors/import
const importBody = z.object({
  config: z.record(z.unknown()),
  format: z.enum(['json', 'yaml']),
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

// connector.service.ts — new function
export async function cloneConnector(
  indexId: string,
  sourceConnectorId: string,
  tenantId: string,
  securityDecision?: string,
): Promise<{
  connectorId: string;
  name: string;
  status: 'draft';
  permissionMode: string;
  clonedFrom: string;
  isCrossTenant: boolean;
}>;

// connector-template.service.ts
export async function listTemplates(
  indexId: string,
  tenantId: string,
  options?: { search?: string; page?: number; limit?: number },
): Promise<{ templates: IConnectorTemplate[]; total: number }>;

export async function createTemplate(
  sourceConnectorId: string,
  tenantId: string,
  name: string,
  description?: string,
): Promise<IConnectorTemplate>;

export async function applyTemplate(
  templateId: string,
  indexId: string,
  tenantId: string,
  securityDecision?: string,
): Promise<{ connectorId: string; name: string; status: 'draft'; templateId: string }>;

export async function importConnectorConfig(
  indexId: string,
  tenantId: string,
  config: Record<string, unknown>,
  securityDecision?: string,
): Promise<{ connectorId: string; name: string; status: 'draft' }>;
```

### Subtasks

1. Create `connector-multi.ts` with routes for clone, template CRUD, and import.
2. **Clone:** Copy connector config (scope, filters, schedule, permission mode) to new connector. Never copy auth tokens or sync history. Clear site selections for cross-tenant clones.
3. **List templates:** Paginated, searchable list from ConnectorTemplate collection.
4. **Create template:** Snapshot source connector's config into a new ConnectorTemplate document.
5. **Apply template:** Create new connector pre-filled with template's config. Apply security decision if template has permission-aware search.
6. **Import:** Validate imported config against known schema. Strip credentials if present. Create new connector with imported config.
7. Mount router in `server.ts`.
8. Write audit entries for all operations.

### Acceptance Criteria

- `grep "connector-multi" apps/search-ai/src/server.ts` returns match
- `grep "cloneConnector" apps/search-ai/src/services/connector.service.ts` returns match
- `grep "createTemplate" apps/search-ai/src/services/connector-template.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- T-53 (ConnectorTemplate model)

### Risk Notes

- **Auth is NEVER cloned.** The clone operation must explicitly exclude OAuth tokens, client secrets, and sync history. The new connector starts in draft status requiring authentication.
- **Cross-tenant clone detection:** Compare source connector's `tenantId` (from connectionConfig) with the requesting user's tenant context. If different, clear site selections.

---

## Task T-53: Create ConnectorTemplate Model

### Problem

No ConnectorTemplate model exists (confirmed by Glob search). Needed by T-47 (drift detection), T-49 (drift actions), T-51 (template selection), T-52 (template CRUD/apply).

### Files to Modify

- `packages/database/src/index.ts` — Export new model and interface

### Files to Create

- `packages/database/src/models/connector-template.model.ts` — Mongoose model with schema, ModelRegistry registration

### Function Signatures

**After:**

```ts
// connector-template.model.ts
export interface IConnectorTemplate {
  _id: string;
  tenantId: string;
  name: string;
  description: string;
  connectorType: string; // 'sharepoint'
  configSnapshot: Record<string, unknown>; // scope, filters, schedule, permissionMode
  permissionMode: 'enabled' | 'disabled';
  createdBy: string;
  updatedBy: string;
  usageCount: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Schema with indexes:
// { tenantId: 1, name: 1 } — unique per tenant
// { tenantId: 1, connectorType: 1 } — list templates by type

// ModelRegistry registration: affinity 'platform'
```

### Subtasks

1. Create `connector-template.model.ts` following the pattern from `connector-config-version.model.ts`: uuidv7 `_id`, tenant isolation plugin, timestamps.
2. Define schema fields: name, description, connectorType, configSnapshot (Mixed), permissionMode, createdBy, updatedBy, usageCount.
3. Add compound unique index on `{ tenantId: 1, name: 1 }`.
4. Add query index on `{ tenantId: 1, connectorType: 1 }`.
5. Register with `ModelRegistry.registerModelDefinition('ConnectorTemplate', ..., 'platform')`.
6. Export from `packages/database/src/index.ts`.

### Acceptance Criteria

- `grep "ConnectorTemplate" packages/database/src/models/connector-template.model.ts` returns match
- `grep "ConnectorTemplate" packages/database/src/index.ts` returns match
- `grep "ModelRegistry" packages/database/src/models/connector-template.model.ts` returns match
- `pnpm build --filter=@agent-platform/database` succeeds

### Dependencies

- None

### Risk Notes

- **Dockerfile sync:** When adding a new export from `@agent-platform/database`, no Dockerfile changes are needed since the package is already in the COPY list. But verify build succeeds across all consuming apps.

---

## Task T-54: Create NotificationSubscription Model

### Problem

No NotificationSubscription model exists (confirmed by Glob search). Needed for the audit log "Subscribe" feature in C-06 and notification preferences in T-31 (Wave 3). This model tracks per-user subscriptions to connector events.

### Files to Modify

- `packages/database/src/index.ts` — Export new model and interface

### Files to Create

- `packages/database/src/models/notification-subscription.model.ts` — Mongoose model

### Function Signatures

**After:**

```ts
// notification-subscription.model.ts
export interface INotificationSubscription {
  _id: string;
  tenantId: string;
  userId: string;
  connectorId: string;
  eventCategories: Array<'auth' | 'config' | 'sync' | 'permission' | 'lifecycle'>;
  channels: Array<'in_app' | 'email' | 'webhook'>;
  webhookUrl: string | null;
  isActive: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Schema with indexes:
// { tenantId: 1, userId: 1, connectorId: 1 } — unique subscription per user per connector
// { tenantId: 1, connectorId: 1, isActive: 1 } — find active subscribers for a connector

// ModelRegistry registration: affinity 'platform'
```

### Subtasks

1. Create `notification-subscription.model.ts` following existing model patterns.
2. Define schema with tenant isolation, userId, connectorId, eventCategories array, channels array, webhookUrl, isActive.
3. Add compound unique index on `{ tenantId: 1, userId: 1, connectorId: 1 }`.
4. Add query index on `{ tenantId: 1, connectorId: 1, isActive: 1 }`.
5. Register with ModelRegistry, export from index.

### Acceptance Criteria

- `grep "NotificationSubscription" packages/database/src/models/notification-subscription.model.ts` returns match
- `grep "NotificationSubscription" packages/database/src/index.ts` returns match
- `pnpm build --filter=@agent-platform/database` succeeds

### Dependencies

- None

### Risk Notes

- **User isolation:** Queries for subscriptions must always include both `tenantId` AND `userId`. A user must not see or modify another user's subscriptions.

---

## Task T-55: Backend — Concurrent Editing Presence Endpoint

### Problem

When two users edit the same connector simultaneously, they should see each other's presence. This requires a lightweight presence endpoint backed by Redis with short TTLs.

### Files to Modify

- `apps/search-ai/src/server.ts` (after connector router mounts, before pipeline routes) — Mount presence router: `app.use('/api/indexes', connectorPresenceRouter);`

### Files to Create

- `apps/search-ai/src/routes/connector-presence.ts` — Presence heartbeat and query routes
- `apps/search-ai/src/services/connector-presence.service.ts` — Redis-backed presence tracking

### Function Signatures

**After:**

```ts
// connector-presence.ts
const router = Router();
router.use(authMiddleware);

// ─── Zod Validation Schemas ─────────────────────────────────────────────
const routeParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});
const heartbeatBody = z.object({
  activeTab: z.string().min(1),
});
// NOTE: userId and userName MUST come from req.tenantContext (auth middleware) — never from body (prevents impersonation)

// POST /:indexId/connectors/:connectorId/presence/heartbeat
// Sets Redis key with 30s TTL, refreshed on each heartbeat

// GET /:indexId/connectors/:connectorId/presence
// Returns: { editors: Array<{ userId, userName, activeTab, lastSeen }> }

// connector-presence.service.ts
export async function sendHeartbeat(
  connectorId: string,
  tenantId: string,
  userId: string, // from req.tenantContext, NOT request body
  userName: string, // from req.tenantContext, NOT request body
  activeTab: string,
): Promise<void>;

export async function getActiveEditors(
  connectorId: string,
  tenantId: string,
): Promise<Array<{ userId: string; userName: string; activeTab: string; lastSeen: string }>>;
```

### Subtasks

1. Create `connector-presence.service.ts` — store presence in Redis hash `presence:<tenantId>:<connectorId>` with per-user field, TTL 30s. Use `HSET` + `EXPIRE`.
2. Heartbeat: extract `userId` and `userName` from `req.tenantContext` (auth middleware). Only `activeTab` comes from request body. `HSET` user's presence data, reset TTL.
3. Get active editors: `HGETALL`, filter expired entries (Redis TTL handles cleanup), return active list.
4. Create `connector-presence.ts` with two routes.
5. Mount in `server.ts`.

### Acceptance Criteria

- `grep "connector-presence" apps/search-ai/src/server.ts` returns match
- `grep "sendHeartbeat" apps/search-ai/src/services/connector-presence.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- None

### Risk Notes

- **Redis key TTL:** Use 30s TTL on the hash key. The frontend sends heartbeats every 15s. If a user closes the tab, their presence expires within 30s.
- **No MongoDB model needed.** Presence is ephemeral — Redis only.

---

## Task T-56: Backend — Org-Level Connector Policy Endpoint

### Problem

C-06 references org-level policies that affect connector behavior (e.g., self-approval policy, maximum connectors per KB). This endpoint provides read access to applicable policies for the connector UI to display warnings and enforce limits.

### Files to Modify

- `apps/search-ai/src/server.ts` (after connector router mounts, before pipeline routes) — Mount policy router: `app.use('/api/indexes', connectorPolicyRouter);`

### Files to Create

- `apps/search-ai/src/routes/connector-policy.ts` — Policy query routes
- `apps/search-ai/src/services/connector-policy.service.ts` — Policy resolution logic

### Function Signatures

**After:**

```ts
// connector-policy.ts
const router = Router();
router.use(authMiddleware);

// ─── Zod Validation Schemas ─────────────────────────────────────────────
const routeParams = z.object({
  indexId: z.string().min(1),
});

// GET /:indexId/connector-policy
// Returns applicable policies for the current tenant/project

// connector-policy.service.ts
export interface ConnectorPolicy {
  maxConnectorsPerKB: number | null; // null = unlimited
  selfApprovalAllowed: boolean;
  credentialExportAllowed: boolean;
  templateSharingScope: 'project' | 'tenant' | 'global';
  requireApprovalForPermissionAwareSearch: boolean;
}

export async function getConnectorPolicy(tenantId: string): Promise<ConnectorPolicy>;
```

### Subtasks

1. Create `connector-policy.service.ts` — reads org-level policy from a config collection or environment variables. Returns defaults when no explicit policy exists.
2. Create `connector-policy.ts` with one GET route.
3. Mount in `server.ts`.

### Acceptance Criteria

- `grep "connector-policy" apps/search-ai/src/server.ts` returns match
- `grep "ConnectorPolicy" apps/search-ai/src/services/connector-policy.service.ts` returns match
- `pnpm build --filter=search-ai` succeeds

### Dependencies

- None

### Risk Notes

- **This is a read-only endpoint.** Policy CRUD is out of scope for Wave 4 (admin-level feature). The service returns defaults or reads from a simple config document.

---

## Task T-57: Draft Mode Support (Panel Header, Tab Locking, Info Banner, Auto-Save)

### Problem

`SharePointDetailPanel.tsx` (line 101-107) has basic draft detection (`isDraftStatus` checks `lastFullSyncAt === null`), and tab locking (line 162-165 prevents non-connect tab navigation for drafts). Wave 4 needs: a visible info banner explaining draft state, auto-save indicator, and a "complete setup" CTA that guides the user through remaining setup steps.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` (line 219-225 — draft badge area, line 385 — tab content area) — Add DraftBanner, expand draft UX

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/DraftBanner.tsx` — Info banner for draft connectors with progress steps and CTA

### Function Signatures

**After:**

```ts
// DraftBanner.tsx
interface DraftBannerProps {
  connectorId: string;
  currentStep: 'auth' | 'scope' | 'filters' | 'preview' | 'ready';
  onNavigateToStep: (step: string) => void;
}
export function DraftBanner(props: DraftBannerProps): JSX.Element;
// Renders: info icon, "This connector is in draft mode", step progress (1. Connect 2. Configure 3. Preview 4. Approve),
// [Complete Setup →] CTA navigates to the next incomplete step
```

### Subtasks

1. Build `DraftBanner.tsx` — horizontal banner with info styling (blue bg), step indicators, [Complete Setup →] button.
2. Determine `currentStep` from connector state: no OAuth token → 'auth', no scope configured → 'scope', no filters → 'filters', not previewed → 'preview', all done → 'ready'.
3. Add DraftBanner to SharePointDetailPanel above the tab content area, only when `isDraft === true`.
4. Add auto-save indicator: small "Saved" or "Saving..." text in the panel header when draft changes are being persisted.
5. Add i18n keys under `search_ai.sharepoint.draft` namespace.

### Acceptance Criteria

- `grep "DraftBanner" apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` returns match
- `grep "currentStep" apps/studio/src/components/search-ai/sharepoint/DraftBanner.tsx` returns match
- `pnpm build --filter=studio` succeeds

### Dependencies

- T-10 (panel shell — Wave 1, complete)
- T-13 (ConnectTab — Wave 2, complete)

### Risk Notes

- **Step detection logic** must be resilient to connectors in unexpected states (e.g., has filters but no OAuth token). Always fall back to the earliest incomplete step.

---

## Task Independence Matrix

**Note:** T-38, T-39, T-40 all modify `SourcesTable.tsx` at different areas. For safe execution, serialize: T-38 first (structural changes), then T-39 (bulk actions), then T-40 (toolbar/grouping). T-46 and T-47 share `VersionHistoryTab.tsx` — T-46 creates it, T-47 adds drift section.

| Task | Can Parallel With                                                                                                | Blocked By                      | Blocks                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| T-38 | T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57             | —                               | T-39 (file serialization), T-40 (file serialization) |
| T-39 | T-41, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57                   | T-38                            | T-40 (file serialization)                            |
| T-40 | T-41, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57                   | T-39                            | —                                                    |
| T-41 | T-38, T-39, T-40, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | —                               | —                                                    |
| T-42 | T-38, T-39, T-40, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | —                               | —                                                    |
| T-43 | T-38, T-39, T-40, T-41, T-42, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | T-44 (backend routes)           | —                                                    |
| T-44 | T-38, T-39, T-40, T-41, T-42, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | —                               | T-43                                                 |
| T-45 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-46, T-47, T-48, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | T-49 (backend export)           | —                                                    |
| T-46 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-48, T-50, T-51, T-52, T-53, T-54, T-55, T-56, T-57             | —                               | T-47 (drift renders within it)                       |
| T-47 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-48, T-50, T-51, T-52, T-54, T-55, T-56, T-57                   | T-46, T-49, T-53                | —                                                    |
| T-48 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-49, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | T-50 (backend purge)            | —                                                    |
| T-49 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-46, T-48, T-50, T-51, T-52, T-54, T-55, T-56, T-57                   | T-53 (template model for drift) | T-45, T-47                                           |
| T-50 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-49, T-51, T-52, T-53, T-54, T-55, T-56, T-57       | —                               | T-48                                                 |
| T-51 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-54, T-55, T-56, T-57             | T-52, T-53                      | —                                                    |
| T-52 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-54, T-55, T-56, T-57             | T-53                            | T-51                                                 |
| T-53 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-48, T-50, T-54, T-55, T-56, T-57                         | —                               | T-47, T-49, T-51, T-52                               |
| T-54 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-55, T-56, T-57 | —                               | —                                                    |
| T-55 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-56, T-57 | —                               | —                                                    |
| T-56 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-57 | —                               | —                                                    |
| T-57 | T-38, T-39, T-40, T-41, T-42, T-43, T-44, T-45, T-46, T-47, T-48, T-49, T-50, T-51, T-52, T-53, T-54, T-55, T-56 | —                               | —                                                    |

**Recommended execution order:**

- **Batch 1 (parallel):** T-53, T-54, T-41, T-42, T-44, T-50, T-55, T-56, T-57, T-38
- **Batch 2 (after T-53):** T-49, T-52
- **Batch 3 (after T-38):** T-39
- **Batch 4 (after T-39):** T-40
- **Batch 5 (after T-44):** T-43
- **Batch 6 (after T-49):** T-45, T-46
- **Batch 7 (after T-46, T-49, T-53):** T-47
- **Batch 8 (after T-50):** T-48
- **Batch 9 (after T-52, T-53):** T-51

---

## File Overlap Check (CRITICAL)

| File                                                                        | Tasks Touching It                                                                                                                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/data/SourcesTable.tsx`                | T-38 (card/table view, aggregates, status map), T-39 (selection + bulk toolbar), T-40 (toolbar extraction, grouping, filters)                                                           |
| `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` | T-43 (wire SecurityTab), T-45 (enable Export menu items), T-46 (wire VersionHistoryTab), T-48 (enable Delete menu item), T-57 (add DraftBanner)                                         |
| `apps/search-ai/src/server.ts`                                              | T-44 (mount security router), T-49 (mount config-mgmt router), T-50 (mount purge router), T-52 (mount multi-connector router), T-55 (mount presence router), T-56 (mount policy router) |
| `apps/search-ai/src/services/connector.service.ts`                          | T-41 (enhance listConnectors), T-42 (add executeBulkAction), T-52 (add cloneConnector)                                                                                                  |
| `apps/search-ai/src/routes/connectors.ts`                                   | T-41 (enhance list route), T-42 (add bulk-actions route)                                                                                                                                |
| `apps/search-ai/src/routes/connector-config-versions.ts`                    | T-46 (add diff + restore routes)                                                                                                                                                        |
| `apps/search-ai/src/services/connector-config-version.service.ts`           | T-46 (add diffVersions + restoreVersion)                                                                                                                                                |
| `packages/database/src/index.ts`                                            | T-50 (export CleanupJob), T-53 (export ConnectorTemplate), T-54 (export NotificationSubscription)                                                                                       |

**Overlap analysis:**

1. **`SourcesTable.tsx`** is touched by T-38, T-39, T-40 — all modifying different aspects (T-38: view modes + aggregates, T-39: selection/bulk, T-40: toolbar/grouping). **Serialized:** T-38 → T-39 → T-40.

2. **`SharePointDetailPanel.tsx`** is touched by T-43, T-45, T-46, T-48, T-57 — each wiring a different component or enabling a different menu item. These modifications are at different line ranges (T-43: tab rendering area, T-45: export menu items, T-46: history tab, T-48: delete menu item, T-57: draft banner). **Safe to parallel** as long as each task modifies a distinct area. Recommended: serialize T-43/T-46 first (tab content), then T-45/T-48 (menu items), then T-57 (banner).

3. **`server.ts`** is touched by T-44, T-49, T-50, T-52, T-55, T-56 — each adding a different import + mount line. All add to the same area (line 180-187). **Safe to parallel** since each adds a new import + `app.use()` line — no line conflicts, just additions. But recommend serializing to avoid merge conflicts.

4. **`connector.service.ts`** is touched by T-41 (enhance listConnectors at line 241), T-42 (new function after existing), T-52 (new function after existing). Different functions, different line ranges. **Safe to parallel.**

5. **`packages/database/src/index.ts`** is touched by T-50, T-53, T-54 — each adding new exports. No overlap, all additions. **Safe to parallel.**

**File overlap resolution:** T-38 → T-39 → T-40 are serialized on `SourcesTable.tsx`. T-43/T-46 → T-45/T-48 → T-57 are recommended serialization order on `SharePointDetailPanel.tsx`. All `server.ts` mount additions are independent import/mount lines and can parallel. All `index.ts` exports are independent additions.
