# Wave 4 LLD Review — Final (Rounds 1-5 Combined)

**Reviewer:** Architecture compliance + self-review
**Date:** 2026-03-24
**Status:** APPROVED with fixes applied

---

## Round 1: Architecture Compliance Findings (8 findings, all fixed)

### F-1: Wrong handleError pattern reference (CRITICAL — fixed)

- **T-44 subtask 1** referenced `handleError` from `connector-audit.ts`, which is a simple 500-only handler. The correct pattern is from `connectors.ts`, which is ConnectorError-aware (maps domain errors to proper HTTP status codes).
- **T-49 subtask 1** had the same issue — did not specify which handleError.
- **Fix:** Both now explicitly reference `connectors.ts` ConnectorError-aware pattern.

### F-2: Route path inconsistency in T-42 (HIGH — fixed)

- Bulk actions route was `/:indexId/sources/bulk-actions` but all other connector routes use `/:indexId/connectors/...` prefix.
- **Fix:** Changed to `/:indexId/connectors/bulk-actions` with explicit route ordering note (must be in static routes section before `:connectorId` parameterized routes).

### F-3: `any[]` return type in T-41 (HIGH — fixed)

- `listConnectors` return type used `connectors: any[]`, violating the "No `any` where structured types exist" CLAUDE.md invariant.
- **Fix:** Changed to `IConnectorConfig[]` with import note.

### F-4: Heartbeat body impersonation risk in T-55 (CRITICAL — fixed)

- The heartbeat endpoint accepted `userId` and `userName` in the request body, allowing any authenticated user to impersonate another user's presence.
- **Fix:** `userId` and `userName` must come from `req.tenantContext` (auth middleware). Only `activeTab` comes from request body. Added Zod schema `heartbeatBody` validating only `activeTab`.

### F-5: Missing Zod schemas in T-44, T-49, T-55, T-56 (MEDIUM — fixed)

- Several route files lacked explicit Zod validation schemas for route params and query/body, unlike the well-structured patterns in `connectors.ts` and `connector-config-versions.ts`.
- **Fix:** Added `routeParams`, `revokeBody`, `exportQuery`, `heartbeatBody`, `importBody`, and other Zod schemas to each route file's function signature section.

### F-6: Stale line number references in server.ts mounts (LOW — fixed)

- Tasks T-44, T-49, T-50, T-52, T-55, T-56 all referenced "line 180-187" for server.ts mounts, but the actual mount area is lines 182-191 and growing with each wave.
- **Fix:** Changed all to descriptive position references ("after connectorConfigVersionRouter mount, before pipeline routes") with explicit `app.use()` statements.

### F-7: Missing handleError in T-49, T-50 route files (MEDIUM — fixed)

- T-49 config management and T-50 purge route files didn't specify their error handling pattern.
- **Fix:** Added ConnectorError-aware `handleError` pattern reference and Zod schemas to both.

### F-8: T-42 route ordering not explicit enough (LOW — fixed)

- The route was placed "after line 50" but didn't call out that `bulk-actions` is a static route needing to be before `:connectorId` parameterized routes.
- **Fix:** Added explicit comment in code: "MUST be registered in the static routes section (BEFORE /:connectorId routes)".

---

## Rounds 2-5: Self-Review Verification

### HLD Coverage (Round 2)

All 20 HLD Wave 4 tasks (T-38 through T-57) have corresponding LLD sections:

| HLD Task | LLD Section | Status |
| -------- | ----------- | ------ |
| T-38     | Line 9      | OK     |
| T-39     | Line 154    | OK     |
| T-40     | Line 231    | OK     |
| T-41     | Line 309    | OK     |
| T-42     | Line 410    | OK     |
| T-43     | Line 482    | OK     |
| T-44     | Line 591    | OK     |
| T-45     | Line 700    | OK     |
| T-46     | Line 764    | OK     |
| T-47     | Line 905    | OK     |
| T-48     | Line 985    | OK     |
| T-49     | Line 1053   | OK     |
| T-50     | Line 1184   | OK     |
| T-51     | Line 1294   | OK     |
| T-52     | Line 1392   | OK     |
| T-53     | Line 1515   | OK     |
| T-54     | Line 1584   | OK     |
| T-55     | Line 1649   | OK     |
| T-56     | Line 1729   | OK     |
| T-57     | Line 1795   | OK     |

### File Paths Plausibility (Round 3)

- All frontend files under `apps/studio/src/components/search-ai/` and `apps/studio/src/hooks/` -- matches existing conventions.
- All backend route files under `apps/search-ai/src/routes/` -- matches existing `connector-audit.ts`, `connector-config-versions.ts`.
- All backend service files under `apps/search-ai/src/services/` -- matches existing patterns.
- Model files in `packages/database/src/models/` -- matches existing `connector-config-version.model.ts`.
- Security sub-components in `sharepoint/security/` directory -- clean separation.
- Config sub-components in `sharepoint/config/` directory -- clean separation.

### Acceptance Criteria Testability (Round 3)

All ACs use `grep` commands or `pnpm build` -- all are mechanically verifiable. No subjective ACs found.

### Task Independence Matrix (Round 4)

- T-38 -> T-39 -> T-40 serialization on SourcesTable.tsx: **Correct**
- T-46 -> T-47 serialization on VersionHistoryTab.tsx: **Correct**
- T-53 blocking T-47, T-49, T-51, T-52: **Correct** (template model needed for drift)
- T-44 blocking T-43: **Soft dependency** (UI can render without backend) -- matrix correctly lists it
- Batch execution order is optimal and respects all constraints

### Wiring Completeness (Round 5)

- All new route files specify server.ts mount point with explicit `app.use()` line
- All new frontend components specify where they are imported/rendered in parent components
- All new hooks specify the API endpoint they wrap
- All new models specify `packages/database/src/index.ts` export
- i18n namespace specified for every frontend task

### Orphaned References Check (Round 5)

- No references to non-existent tasks
- No references to files outside the repository structure
- All cross-task references (e.g., "T-49 endpoint", "T-42 backend bulk actions") point to valid tasks within Wave 4 or completed Wave 1/2/3 tasks

---

## Summary

| Severity  | Count | Status        |
| --------- | ----- | ------------- |
| CRITICAL  | 2     | All fixed     |
| HIGH      | 2     | All fixed     |
| MEDIUM    | 2     | All fixed     |
| LOW       | 2     | All fixed     |
| **Total** | **8** | **All fixed** |

**Verdict:** LLD is approved. All architecture compliance issues have been resolved. The document is ready for implementation.
