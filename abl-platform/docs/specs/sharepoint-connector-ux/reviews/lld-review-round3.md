# LLD Review Round 3: Completeness

**Document:** `docs/specs/sharepoint-connector-ux/wave1.lld.md`
**HLD Reference:** `docs/specs/sharepoint-connector-ux/sharepoint-connector-ux.hld.md`
**Reviewer:** lld-reviewer agent
**Date:** 2026-03-24
**Focus:** Completeness — R2 fix verification, HLD coverage, file path validation, orphaned references, gap analysis

---

## Part A: R2 Fix Verification

| R2 ID | Severity | Issue                                         | Fixed? | Notes                                                                                                                                                                                                                            |
| ----- | -------- | --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2-01 | HIGH     | i18n hook pattern incorrect                   | YES    | Line 1083: `const t = useTranslations('search_ai.sharepoint');` — correct namespace, correct non-destructured form. Line 1085 adds note about `next-intl` returning the function directly. Key refs use `t('tabs.connect')` etc. |
| F2-02 | MEDIUM   | Version model indexes missing tenantId prefix | YES    | Lines 592-593: Both indexes now lead with `tenantId: 1`. The third redundant index (`{ tenantId: 1, connectorId: 1 }`) has been removed. Risk notes at line 696 now correctly reference `{ tenantId, connectorId, version }`.    |
| F2-03 | MEDIUM   | Model export pattern missing                  | YES    | Lines 430-433 (T-06) and 605-608 (T-07) both include the hot-reload safe pattern: `(mongoose.models.X as mongoose.Model<IX>) \|\| model<IX>('X', XSchema)`. Comments explicitly label it "hot-reload safe pattern".              |
| F2-04 | MEDIUM   | handleError pattern not specified             | YES    | T-06 ST-06.3 (line 503) and T-07 ST-07.3 (line 670) both specify: "Follow the `handleError()` pattern from `connectors.ts` (lines 23-37)."                                                                                       |
| F2-06 | LOW      | Atomic selector advisory missing              | YES    | T-09 Risk Notes (lines 996-997): "Consumers should use atomic selectors for frequently-changing state: `const panelOpen = useConnectorStore(s => s.panelOpen);`" — advisory added as recommended.                                |

**R2 Fix Verification Summary:** All 5 actionable R2 findings have been addressed. No regressions introduced.

---

## Part B: Completeness Findings

### Finding F3-01: T-06 and T-07 do not specify route mounting in server.ts

- **Tasks:** T-06, T-07
- **Severity:** HIGH
- **Issue:** Both T-06 and T-07 create new route files (`apps/search-ai/src/routes/connector-audit.ts` and `apps/search-ai/src/routes/connector-config-versions.ts`) but neither task specifies the corresponding `import` and `app.use()` lines in `apps/search-ai/src/server.ts`. Without these mount lines, the routes are dead code.
- **Evidence:**
  - `apps/search-ai/src/server.ts` lines 176-179: This is where existing connector routes are mounted. New route files must be imported and mounted here.
  - Grep for `server.ts` in the LLD returns zero matches — the file is never referenced.
  - The routes use the `/:indexId/connectors/:connectorId/` prefix pattern (lines 490, 658), which means they should be mounted at `/api/indexes` like the main connector router.
- **Fix:** Add a subtask to both T-06 and T-07:
  - T-06: "ST-06.6: In `apps/search-ai/src/server.ts`, import `connectorAuditRouter` from `'./routes/connector-audit.js'` and mount with `app.use('/api/indexes', connectorAuditRouter);` after the existing connector route mounts (line 177)."
  - T-07: "ST-07.6: In `apps/search-ai/src/server.ts`, import `connectorConfigVersionRouter` from `'./routes/connector-config-versions.js'` and mount with `app.use('/api/indexes', connectorConfigVersionRouter);` after the existing connector route mounts."
  - Also add `apps/search-ai/src/server.ts` to the File Overlap Check table (both T-06 and T-07 add different import/mount lines, no conflict).

---

### Finding F3-02: T-10 Risk Notes contain stale i18n key prefix

- **Task:** T-10
- **Severity:** LOW
- **Location:** Line 1130
- **Issue:** The Risk Notes section uses `t('sharepoint.placeholder.tabContent', { wave: 'N' })` but since the i18n hook is `useTranslations('search_ai.sharepoint')` (line 1083), the key should be `t('placeholder.tabContent', { wave: 'N' })` — the `sharepoint.` prefix is already part of the namespace.
- **Evidence:**
  - Line 1083: `const t = useTranslations('search_ai.sharepoint');`
  - Line 1130: `{t('sharepoint.placeholder.tabContent', { wave: 'N' })}`
  - The i18n key list (lines 1061-1081) correctly lists `placeholder.tabContent` without the `sharepoint.` prefix.
- **Fix:** Change line 1130 from `t('sharepoint.placeholder.tabContent', { wave: 'N' })` to `t('placeholder.tabContent', { wave: 'N' })`.

---

### Finding F3-03: T-07 defines orphaned diffQuery Zod schema with no corresponding route

- **Task:** T-07
- **Severity:** LOW
- **Location:** Lines 649-652
- **Issue:** T-07's Validation Schemas section defines a `diffQuery` Zod schema (`{ from: z.coerce.number(), to: z.coerce.number() }`) but no diff route is defined in T-07's Route Definitions (lines 657-663). The diff endpoint is part of Wave 4 (T-46: Version History tab with diff). The orphaned schema definition will confuse implementers.
- **Evidence:**
  - Lines 649-652: `diffQuery` defined
  - Lines 657-663: Only two routes defined (list versions, get single version) — neither uses `diffQuery`
  - HLD T-46 (Wave 4): "Create Version History tab (table, diff, restore)"
- **Fix:** Remove the `diffQuery` schema from T-07's Validation Schemas section. Add a comment in T-07 noting: "Diff endpoint will be added in Wave 4 (T-46)."

---

### Finding F3-04: T-06 and T-07 export lines in packages/database/src/index.ts should include type exports

- **Task:** T-06, T-07
- **Severity:** LOW
- **Location:** ST-06.1, ST-07.1
- **Issue:** The subtasks say "Export from `packages/database/src/index.ts`" but do not specify that both the model and the interface type should be exported. The existing pattern in `index.ts` exports both:
  ```ts
  export { ConnectorConfig } from './models/connector-config.model.js';
  export type { IConnectorConfig } from './models/connector-config.model.js';
  ```
  Without explicit guidance, the implementer may only export the model and omit the type, causing consumers to import the interface from the model file directly (inconsistent with codebase conventions).
- **Evidence:**
  - `packages/database/src/index.ts` lines 143-158: Every model has paired model + type exports.
- **Fix:** Update ST-06.1 and ST-07.1 to specify: "Add both model and interface type exports to `packages/database/src/index.ts`:
  ````ts
  export { ConnectorAuditEntry } from './models/connector-audit-entry.model.js';
  export type { IConnectorAuditEntry } from './models/connector-audit-entry.model.js';
  ```"
  ````

---

## Part C: Systematic Completeness Check

### HLD Task Coverage (T-01 through T-12)

| HLD Task | HLD Description                                                                  | LLD Coverage                                           | Complete? |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | --------- |
| T-01     | Fix `resolveScopes()` + permission mode "simplified" bug                         | Full                                                   | YES       |
| T-02     | Fix `pauseSync()`/`resumeSync()` implementation                                  | Full                                                   | YES       |
| T-03     | Move OAuth state from pod-local to Redis                                         | Reclassified as hardening (justified by code evidence) | YES       |
| T-04     | Register `ConnectorSchema` + `FieldMapping` with ModelRegistry                   | Full                                                   | YES       |
| T-05     | Fix permission crawler (group ID, grantedToV2, getDrivePermissions)              | Full                                                   | YES       |
| T-06     | Create `ConnectorAuditEntry` model + audit log routes                            | Full (minus server.ts mount — F3-01)                   | PARTIAL   |
| T-07     | Create `ConnectorConfigVersion` model + version routes                           | Full (minus server.ts mount — F3-01)                   | PARTIAL   |
| T-08     | Create SWR hooks (useConnector, useConnectorList, useConnectorSync)              | Full                                                   | YES       |
| T-09     | Create Zustand connector store                                                   | Full                                                   | YES       |
| T-10     | Create SharePointDetailPanel shell (tabs, expand, Simplified View, More Actions) | Full                                                   | YES       |
| T-11     | Create TypeToConfirmInput reusable component                                     | Full                                                   | YES       |
| T-12     | Remove orphaned ConnectorsTab.tsx                                                | Full                                                   | YES       |

### File Path Verification

| File Path                                                                         | Exists? | Referenced By                              |
| --------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| `apps/search-ai/src/services/connector.service.ts`                                | YES     | T-01, T-02, T-03                           |
| `packages/database/src/models/connector-config.model.ts`                          | YES     | T-01                                       |
| `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` | YES     | T-01, T-05                                 |
| `packages/connectors/sharepoint/src/sharepoint-connector.ts`                      | YES     | T-01, T-02                                 |
| `packages/database/src/models/connector-schema.model.ts`                          | YES     | T-04                                       |
| `packages/database/src/models/field-mapping.model.ts`                             | YES     | T-04                                       |
| `packages/connectors/sharepoint/src/client/graph-client.ts`                       | YES     | T-05                                       |
| `packages/connectors/sharepoint/src/client/graph-types.ts`                        | YES     | T-05                                       |
| `packages/database/src/index.ts`                                                  | YES     | T-06, T-07                                 |
| `apps/search-ai/src/routes/connectors.ts`                                         | YES     | T-06, T-07 (handleError pattern reference) |
| `apps/studio/src/hooks/useKnowledgeBase.ts`                                       | YES     | T-08 (reference pattern)                   |
| `apps/studio/src/store/data-tab-filter-store.ts`                                  | YES     | T-09 (reference pattern)                   |
| `apps/studio/src/components/ui/SlidePanel.tsx`                                    | YES     | T-10                                       |
| `apps/studio/src/components/search-ai/ConnectorsTab.tsx`                          | YES     | T-12 (delete target)                       |
| `packages/i18n/locales/en/studio.json`                                            | YES     | T-10, T-11 (i18n keys)                     |
| `apps/search-ai/src/workers/connector-sync-worker.ts`                             | YES     | T-02 (verify checkpoint flag)              |

All 16 referenced file paths verified.

### Function Signature Verification

| Function                                                                   | LLD Line Ref                        | Matches Codebase? |
| -------------------------------------------------------------------------- | ----------------------------------- | ----------------- |
| `resolveScopes(authMethod, permissionMode)`                                | connector.service.ts:154            | YES               |
| `storeDeviceCodeSession(connectorId, session, ttl)`                        | connector.service.ts:74             | YES               |
| `pauseSync(connectorId, tenantId, reason?)`                                | connector.service.ts:981            | YES               |
| `resumeSync(connectorId, tenantId)`                                        | connector.service.ts:1000           | YES               |
| `SharePointConnector.pauseSync(jobId)`                                     | sharepoint-connector.ts:242         | YES               |
| `SharePointConnector.resumeSync(jobId)`                                    | sharepoint-connector.ts:250         | YES               |
| `PermissionCrawlConfig.mode: 'full' \| 'simplified' \| 'disabled'`         | sharepoint-permission-crawler.ts:22 | YES               |
| `connector-config.model.ts` mode enum `['full', 'simplified', 'disabled']` | connector-config.model.ts:307       | YES               |
| `handleError(res, error, fallbackCode)`                                    | connectors.ts:23-37                 | YES               |

All function signatures verified.

### SWR Key Path Verification

| Hook               | SWR Key                                                       | Backend Route                                                     | Proxy Mapping                                   | Correct? |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- | -------- |
| `useConnector`     | `/api/search-ai/indexes/${indexId}/connectors/${connectorId}` | `GET /:indexId/connectors/:connectorId` mounted at `/api/indexes` | Studio `/api/search-ai/X` -> search-ai `/api/X` | YES      |
| `useConnectorList` | `/api/search-ai/indexes/${indexId}/connectors`                | `GET /:indexId/connectors` mounted at `/api/indexes`              | Same proxy                                      | YES      |
| `useConnectorSync` | `/api/search-ai/connectors/${connectorId}/sync/status`        | `GET /connectors/:connectorId/sync/status` mounted at `/api`      | Same proxy                                      | YES      |

All SWR key paths verified against proxy.ts (line 172: strips `/api/search-ai/` prefix and forwards to search-ai service at `/api/`).

### Acceptance Criteria Testability

All 36 acceptance criteria across T-01 through T-12 have:

- Concrete verify commands (grep, build, unit test, or component test)
- Clear expected outcomes
- No ambiguous "should work" criteria

### Numbering Consistency

- Subtasks: No gaps or duplicates across all tasks
- Acceptance criteria: Sequential within each task, no gaps
- Task Independence Matrix: All 12 tasks present, consistent with dependency descriptions

### Dependency Graph

Verified no cycles:

- T-01 -> T-02 -> T-03 (serial chain on connector.service.ts)
- T-01 -> T-05 (permission mode type dependency)
- T-08, T-09 -> T-10 (SWR hooks + store -> panel shell)
- All other tasks are independent

No implicit undocumented dependencies found.

---

## Summary

| Severity | Count |
| -------- | ----- |
| HIGH     | 1     |
| LOW      | 3     |

**VERDICT: NEEDS_CHANGES**

### Must fix before implementation

1. **F3-01 (HIGH):** Add route mounting subtasks to T-06 and T-07. Without `import` and `app.use()` in `server.ts`, the new audit log and version routes are unreachable dead code. Add `server.ts` to the File Overlap Check table.

### Should fix

2. **F3-02 (LOW):** Fix stale `sharepoint.` prefix in T-10 Risk Notes placeholder key. Change `t('sharepoint.placeholder.tabContent')` to `t('placeholder.tabContent')`.
3. **F3-03 (LOW):** Remove orphaned `diffQuery` Zod schema from T-07 — no route uses it in Wave 1. Add a note that the diff endpoint is deferred to Wave 4 (T-46).
4. **F3-04 (LOW):** Specify paired model + type exports for T-06 and T-07 in `packages/database/src/index.ts` (matching existing `export { Model }` + `export type { IModel }` pattern).

### Verified complete

- [x] **R2 fix verification:** All 5 actionable findings resolved, no regressions
- [x] **HLD coverage:** All 12 Wave 1 tasks (T-01 through T-12) are present with adequate detail
- [x] **File paths:** All 16 referenced file paths exist in codebase
- [x] **Function signatures:** All 9 verified signatures match actual code
- [x] **SWR key paths:** All 3 hook keys verified against backend routes and Studio proxy mapping
- [x] **Acceptance criteria:** All 36 ACs have concrete verify commands and expected outcomes
- [x] **Numbering:** No gaps, duplicates, or orphaned subtask references
- [x] **Dependencies:** Acyclic graph, all implicit dependencies documented
- [x] **Task independence:** Matrix consistent with overlap analysis and recommended batches

### Notes for implementation

- T-03's reclassification from "migration" to "hardening" is well-justified — the code evidence at lines 63-93 confirms OAuth state is already in Redis. The LLD's corrected scope is appropriate.
- The new route files (T-06, T-07) should be mounted AFTER the main connector router in `server.ts` to avoid route ordering issues. Since the audit/version routes use more specific paths (`/:indexId/connectors/:connectorId/audit-log` and `/:indexId/connectors/:connectorId/config/versions`), they won't conflict with the existing `/:indexId/connectors/:connectorId` route.
- The T-07 `createVersion()` auto-increment pattern (read latest + 1 with unique index retry) is a standard optimistic concurrency approach. The unique index `{ tenantId, connectorId, version }` serves as the guard. Implementers should add retry logic (up to 3 attempts) on duplicate key errors.
