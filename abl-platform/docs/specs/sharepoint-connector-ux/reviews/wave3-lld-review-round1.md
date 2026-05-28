# Wave 3 LLD Review -- Round 1: Architecture Compliance

**Reviewer:** LLD Reviewer Agent
**Date:** 2026-03-24
**LLD:** `docs/specs/sharepoint-connector-ux/wave3.lld.md`
**HLD Reference:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md` section 8 (T-26 to T-37)

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

_(none)_

### HIGH

- **[HIGH-01]** T-28 server.ts mount must be BEFORE the 404 handler. The LLD says "after line 185, after connectorConfigVersionRouter" which is correct, but the 404 catch-all handler is at line 202-204. The same applies to T-31, T-36, T-37. All four mount additions must be inserted between line 187 and line 202, not appended after the 404 handler.
  - File: `apps/search-ai/src/server.ts:202-205`
  - Fix: Explicitly state in T-28 ST-28.5, T-31 ST-31.5, T-36 ST-36.4, T-37 ST-37.5 that mounts go **before line 202** (before the `// 404 handler` comment), not just "after line 185".

- **[HIGH-02]** T-36 `classifyError(connector: any)` uses `any` type. The codebase has `IConnectorConfig` from the database package and `findConnectorByIdAndTenantLean` returns `IConnectorConfig | null`. While the existing `connector.service.ts` uses `(connector as any)` extensively, the LLD is creating a **new service file** and should use the proper type.
  - File: LLD T-36, `classifyError` signature
  - Fix: Change signature to `classifyError(connector: IConnectorConfig)`. Import `IConnectorConfig` from the database package.

- **[HIGH-03]** T-28 LLD says "Follow the pattern from `connector-audit.ts` (line 1-50)". The `connector-audit.ts` `handleError` function (line 43-50) always returns 500 and does NOT handle `ConnectorError`. The main `connectors.ts` `handleError` (line 23-37) DOES handle `ConnectorError` with proper status codes (400, 404, etc.). The new monitoring routes will call services that throw `ConnectorError('NOT_FOUND', ...)`, but the audit-style `handleError` would return 500 instead of 404 for not-found cases.
  - File: LLD T-28 ST-28.4, T-31 ST-31.3, T-36 ST-36.3, T-37 ST-37.4
  - Fix: Change all references from "Follow the pattern from `connector-audit.ts`" to "Follow the `handleError` pattern from `connectors.ts` (line 23-37) which handles `ConnectorError` with proper status codes."

### MEDIUM

- **[MEDIUM-01]** T-27 specifies `useConnectorSync(connectorId, { pollInterval: 3000 })` but the SWR key in that hook uses `/api/search-ai/connectors/${connectorId}/sync/status` (no indexId in path). The new overview hooks (T-26) use a key pattern that includes indexId. The LLD should note this asymmetry to avoid confusion during implementation.
  - File: LLD T-27 ST-27.3
  - Fix: Add a note that `useConnectorSync` uses the old route pattern (no indexId prefix), whereas the new overview/monitoring routes include indexId in the path.

- **[MEDIUM-02]** T-29 extends the Mongoose schema with `perSiteProgress` as an embedded array. For connectors with many sites (50+), this array could grow large on a document that is written frequently during sync. The LLD should specify whether progress is stored in MongoDB or Redis.
  - File: LLD T-29 ST-29.2
  - Fix: Recommend Redis for per-site progress and current document data (ephemeral sync runtime data). Keep the syncState subdocument for persistent fields only (syncType, syncStartedAt). `getSyncStatus()` should read progress from Redis first, falling back to MongoDB.

- **[MEDIUM-03]** T-31 webhook test endpoint has SSRF risk. The LLD acknowledges this in risk notes but does not specify any mitigations. At minimum, the implementation should block requests to localhost, 127.0.0.1, 169.254.169.254, and RFC 1918 private ranges.
  - File: LLD T-31 ST-31.2
  - Fix: Add a subtask or note requiring URL validation that blocks private/loopback/link-local addresses before making the HTTP request.

- **[MEDIUM-04]** T-30 `useNotificationConfig` hook has `updateConfig` that does both save and mutate. The LLD specifies debounced auto-save but does not specify SWR optimistic update or revalidation strategy. Without optimistic updates, the UI will briefly flash stale data after each save.
  - File: LLD T-30 ST-30.1
  - Fix: Specify whether `updateConfig` uses SWR `mutate(newData, { revalidate: true })` for optimistic updates, or does a fire-and-forget PUT followed by `mutate()` for revalidation.

- **[MEDIUM-05]** T-33 Zod schema for `permissionScheduleBody` does not validate the `cronExpression` format when `schedule === 'custom'`. The LLD mentions validation in ST-33.2 text but does not show it in the Zod schema definition.
  - File: LLD T-33, Zod Validation Schema
  - Fix: Add `.refine()` to the Zod schema to enforce that `cronExpression` is present and non-empty when `schedule === 'custom'`.

### LOW

- **[LOW-01]** T-34 E6 ThrottledError uses `setInterval` for a live countdown. The LLD correctly notes cleanup in risk notes but should specify `useEffect` cleanup pattern in ST-34.7 subtask description.
  - File: LLD T-34 ST-34.7
  - Fix: Add to ST-34.7: "Use `useEffect` with cleanup function that calls `clearInterval` on unmount."

- **[LOW-02]** The File Overlap Check correctly identifies `server.ts` overlap between T-28, T-31, T-36, T-37. But Batch 1 in the execution order lists all 6 backend tasks as parallel, which contradicts the serialization recommendation for server.ts edits.
  - File: LLD Task Independence Matrix, Batch 1
  - Fix: Add explicit note that server.ts mount edits must be serialized, or create a final "mount all new routers" step after all backend tasks complete.

- **[LOW-03]** T-26 SWR key uses `/api/search-ai/indexes/...` prefix. T-28 mounts the route under `/api/indexes`. Verify the Studio SWR fetcher base URL configuration to confirm these match.
  - File: LLD T-26 SWR Hook Signatures, T-28 Route Signatures
  - Fix: Verify and document the Studio-to-search-ai proxy/base-URL configuration.

---

## VERIFIED

- [x] **Architecture compliance -- tenant isolation**: All service signatures include `tenantId`. All routes extract from `req.tenantContext!.tenantId`. Cross-scope access returns 404 via `ConnectorError('NOT_FOUND', ..., 404)`.
- [x] **Architecture compliance -- auth**: All new route files use `router.use(authMiddleware)` which wraps `createUnifiedAuthMiddleware`.
- [x] **Architecture compliance -- stateless**: No pod-local state introduced.
- [x] **Zod validation**: All backend routes include Zod schemas with `z.string().min(1)` for IDs. Query params use `z.coerce.number()` for pagination.
- [x] **Error handling**: Service files use `createLogger('module')` and `ConnectorError` class.
- [x] **Standard response envelope**: All routes return `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- [x] **i18n**: All frontend components specify namespace (`search_ai.sharepoint.*`). Correct hook pattern: `useTranslations('search_ai.sharepoint.overview')`.
- [x] **SWR/Zustand patterns**: SWR hooks follow `useConnector.ts` pattern. Zustand uses atomic selectors. `useShallow` used where multiple fields needed.
- [x] **HLD coverage**: All 12 tasks (T-26 through T-37) from HLD section 8 have corresponding LLD tasks.
- [x] **UI component references verified**: `Progress.tsx`, `DataTable.tsx`, `EmptyState.tsx`, `ConfirmDialog.tsx` all exist. Props match LLD descriptions.
- [x] **Function signatures verified**: `getSyncStatus()` at line 1145, `SyncStatusResponse` at line 11-19, `findConnectorByIdAndTenantLean` all match LLD references.
- [x] **Task independence**: File overlap correctly identified. OverviewTab.tsx creation/modification chain correctly ordered.
- [x] **Express route ordering**: New routes use different sub-paths under `/api/indexes`. No static-vs-parameterized conflicts.

---

## NOTES

1. The `connector.service.ts` codebase uses `(connector as any)` extensively (35+ occurrences). HIGH-02 flags this only for the new file; existing code should not be refactored in this wave.

2. Four new route files all mount under `/api/indexes` in `server.ts`. No route ordering conflicts between them.

3. The LLD correctly notes the sync worker must write per-site progress for T-29 data to appear. This cross-task dependency is out of scope for Wave 3.

4. T-34 creates 11 files in `errors/`. Implementation should batch by tab context: Overview errors (E3-E7) first, then Connect tab (E1/E9), Scope tab (E2/E8), Preview tab (E10).

5. The `handleError` divergence (HIGH-03) is the most likely implementation bug. The `connector-audit.ts` pattern is referenced 4 times in the LLD but its `handleError` swallows `ConnectorError` status codes.

---

## Summary

| Severity  | Count  |
| --------- | ------ |
| CRITICAL  | 0      |
| HIGH      | 3      |
| MEDIUM    | 5      |
| LOW       | 3      |
| **Total** | **11** |

All 3 HIGH issues are straightforward LLD text fixes. No architectural redesign needed. After fixes, the LLD is ready for Round 2 (pattern consistency and completeness).
