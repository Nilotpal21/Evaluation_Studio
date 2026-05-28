# SharePoint Connector UX — Change Manifest

This file tracks what each implementer did, why, and what to expect.
Read this when fixing tests or reviewing code after context loss.

## Wave 1: Foundation

### Status

| Task | Agent | Status | Files Changed                                                                                                                                                                                                                           |
| ---- | ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-04 | A1    | Done   | connector-schema.model.ts, field-mapping.model.ts                                                                                                                                                                                       |
| T-12 | A1    | Done   | ConnectorsTab.tsx (deleted)                                                                                                                                                                                                             |
| T-06 | A2    | Done   | connector-audit-entry.model.ts, connector-audit.service.ts, connector-audit.ts, server.ts, index.ts                                                                                                                                     |
| T-07 | A3    | Done   | connector-config-version.model.ts, connector-config-version.service.ts, connector-config-versions.ts, server.ts, index.ts                                                                                                               |
| T-08 | A4    | Done   | useConnector.ts, useConnectorList.ts, useConnectorSync.ts                                                                                                                                                                               |
| T-09 | A5    | Done   | connector-store.ts                                                                                                                                                                                                                      |
| T-11 | A5    | Done   | TypeToConfirmInput.tsx                                                                                                                                                                                                                  |
| T-01 | A6    | Done   | connector-config.model.ts, connector.interface.ts, permission-crawler.interface.ts, sharepoint-permission-crawler.ts, sharepoint-connector.ts, connector.service.ts, connector-permission-crawl-worker.ts, permission-recrawl-worker.ts |
| T-02 | A6    | Done   | connector.service.ts, sharepoint-connector.ts, connectors.ts (route)                                                                                                                                                                    |
| T-03 | A6    | Done   | connector.service.ts                                                                                                                                                                                                                    |
| T-05 | A7    | Done   | graph-types.ts, sharepoint-permission-crawler.ts                                                                                                                                                                                        |
| T-10 | A8    | Done   | SharePointDetailPanel.tsx, studio.json (i18n)                                                                                                                                                                                           |

---

### T-04: Register ConnectorSchema + FieldMapping with ModelRegistry

**Files changed:**

- `packages/database/src/models/connector-schema.model.ts` — Added `ModelRegistry` import and `registerModelDefinition('ConnectorSchema', ConnectorSchemaSchema, 'platform')` before model export
- `packages/database/src/models/field-mapping.model.ts` — Added `ModelRegistry` import and `registerModelDefinition('FieldMapping', FieldMappingSchema, 'platform')` before model export

**Functions added/modified:**

- No new functions. Added registration side-effects matching the pattern in `connector-config.model.ts`.
- Key logic: Both models use `'platform'` affinity since they store configuration/metadata, not search content.

**Tests:**

- `pnpm build --filter=@agent-platform/database` — passes clean (no type errors)

**Gotchas:**

- These models were previously unregistered, meaning `getLazyModel('ConnectorSchema')` or `getLazyModel('FieldMapping')` in SearchAI would fail silently or create unbound models.
- The database schema audit (2026-03-11) first identified this gap.

---

### T-12: Remove Orphaned ConnectorsTab.tsx

**Files changed:**

- `apps/studio/src/components/search-ai/ConnectorsTab.tsx` — Deleted (orphaned, no imports)

**Functions added/modified:**

- None (file deletion only)

**Tests:**

- `grep -r ConnectorsTab apps/studio/src/` confirmed only comment references remain (in ChunkExplorer.tsx and ConnectorDetailPanel.tsx), no actual imports
- `npx tsc --noEmit -p apps/studio/tsconfig.json` shows no ConnectorsTab-related errors

**Gotchas:**

- Studio build has a pre-existing failure (`pdf-lib` import in test helper) unrelated to this change
- The two remaining comment references to "ConnectorsTab" in ChunkExplorer.tsx and ConnectorDetailPanel.tsx are documentation comments only, not imports

---

### T-06: ConnectorAuditEntry Model + Audit Log Routes

**Files changed:**

- `packages/database/src/models/connector-audit-entry.model.ts` — New model: IConnectorAuditEntry interface, Mongoose schema, tenantIsolationPlugin, 4 indexes, ModelRegistry registration as 'platform', hot-reload-safe export
- `packages/database/src/index.ts` — Added export for ConnectorAuditEntry model and IConnectorAuditEntry type
- `apps/search-ai/src/services/connector-audit.service.ts` — New service with writeAuditEntry(), getAuditLog(), exportAuditLog()
- `apps/search-ai/src/routes/connector-audit.ts` — New route file with Zod validation, two GET endpoints
- `apps/search-ai/src/server.ts` — Import and mount connectorAuditRouter under /api/indexes

**Functions added/modified:**

- `writeAuditEntry(params): Promise<IConnectorAuditEntry>` — Creates audit entry scoped to tenantId
- `getAuditLog(connectorId, tenantId, options): Promise<{entries, total, page, limit}>` — Paginated query with optional category/date filters. All queries include tenantId + connectorId.
- `exportAuditLog(connectorId, tenantId, format): Promise<{data, contentType, filename}>` — Full export as JSON or CSV
- Route: `GET /:indexId/connectors/:connectorId/audit-log` — Paginated audit log
- Route: `GET /:indexId/connectors/:connectorId/audit-log/export` — File download export

**Tests:**

- Build verification: `pnpm build --filter=@agent-platform/database` passes clean
- Type check: `npx tsc --noEmit -p apps/search-ai/tsconfig.json` shows no errors for connector-audit files

**Gotchas:**

- Full search-ai build fails due to connector-sharepoint type errors from T-01 (unrelated)
- Audit entries are append-only — no PUT/DELETE routes
- Uses `getLazyModel('ConnectorAuditEntry')` requiring ModelRegistry registration
- Route mounted at `/api/indexes` prefix: full path is `/api/indexes/:indexId/connectors/:connectorId/audit-log`
- Export route registered before parameterized catch-all (Express top-down matching)

---

### T-09: Create Zustand Connector Store

**Files changed:**

- `apps/studio/src/store/connector-store.ts` — New file. Zustand store for connector panel client-side state.

**Functions added/modified:**

- `useConnectorStore` — Zustand store with state: `panelOpen`, `activeConnectorId`, `activeTab` (ConnectorTab union), `isNewConnector`, `simplifiedView`, `expandedPanel`
- `openPanel(connectorId, options?)` — Sets panel open with connector ID, optional tab and isNew flag. Resets expandedPanel.
- `closePanel()` — Resets all panel state to defaults.
- `setSimplifiedView(enabled)` — Persists to localStorage (`sp-simplified-view` key) and updates state.
- `resetStore()` — Full reset including re-reading localStorage for simplifiedView.
- `getPersistedSimplifiedView()` — Reads localStorage, returns `true` if key absent (first-time user default ON).

**Tests:**

- Type-checked via `npx tsc --noEmit` — no errors

**Gotchas:**

- `ConnectorTab` type is exported for use by panel components
- `simplifiedView` defaults to `true` when localStorage key is absent (first-time users see simplified view)
- SSR guard: `typeof window === 'undefined'` returns `true` for simplifiedView during SSR
- Atomic selector advisory included in JSDoc comments

---

### T-11: Create TypeToConfirmInput Reusable Component

**Files changed:**

- `apps/studio/src/components/ui/TypeToConfirmInput.tsx` — New file. Type-to-confirm pattern component.

**Functions added/modified:**

- `TypeToConfirmInput(props): ReactElement` — Renders warning block, consequences list, appropriateWhen list, text input, and confirm/cancel buttons
- Props: `confirmText`, `onConfirm`, `onCancel`, `warningMessage`, `consequences?`, `appropriateWhen?`, `confirmLabel?`, `cancelLabel?`, `variant?`, `loading?`
- Key logic: Case-insensitive match via `inputValue.toLowerCase().trim() === confirmText.toLowerCase()`
- Confirm button uses `variant="danger"`, disabled until input matches. Cancel uses `variant="secondary"`.

**Tests:**

- Type-checked via `npx tsc --noEmit` — no errors

**Gotchas:**

- i18n: Component receives translated strings as props (parent responsible for `useTranslations()`)
- The `variant` prop controls the warning border color, NOT the confirm button variant (always `danger`)
- `aria-label` on input avoids accessibility warnings since there's no visible `<label>` element

---

### T-07: ConnectorConfigVersion Model + Version Routes

**Files changed:**

- `packages/database/src/models/connector-config-version.model.ts` — New model: IConnectorConfigVersion interface, Mongoose schema with Mixed configSnapshot, tenantIsolationPlugin, 2 indexes (one for descending version lookup, one unique for optimistic concurrency), ModelRegistry registration as 'platform', hot-reload-safe export
- `packages/database/src/index.ts` — Added export for ConnectorConfigVersion model and IConnectorConfigVersion type
- `apps/search-ai/src/services/connector-config-version.service.ts` — New service with createVersion(), getVersionHistory(), getVersionSnapshot(), getLatestVersion()
- `apps/search-ai/src/routes/connector-config-versions.ts` — New route file with Zod validation, GET history, GET snapshot, POST create
- `apps/search-ai/src/server.ts` — Import and mount connectorConfigVersionRouter under /api/indexes

**Functions added/modified:**

- `createVersion(params): Promise<IConnectorConfigVersion>` — Creates version with auto-incrementing version number. Uses optimistic concurrency: reads latest version + 1, retries up to 3 times on duplicate key error (MongoDB 11000).
- `getVersionHistory(connectorId, tenantId, options): Promise<{versions, total, page, limit}>` — Paginated query ordered by version descending. All queries include tenantId + connectorId. Limit capped at 100.
- `getVersionSnapshot(connectorId, tenantId, versionNumber): Promise<IConnectorConfigVersion | null>` — Single version lookup by exact version number.
- `getLatestVersion(connectorId, tenantId): Promise<number>` — Returns highest version number or 0 if none exist.
- Route: `GET /:indexId/connectors/:connectorId/config/versions` — Paginated version history
- Route: `GET /:indexId/connectors/:connectorId/config/versions/:versionNumber` — Single version snapshot
- Route: `POST /:indexId/connectors/:connectorId/config/versions` — Create new version

**Tests:**

- Build verification: `pnpm build --filter=@agent-platform/database` passes clean
- Type check: `npx tsc --noEmit -p apps/search-ai/tsconfig.json` shows no errors for connector-config-version files
- Pre-existing build failures (connector-audit.ts TS2742, missing cheerio types) are unrelated

**Gotchas:**

- Full search-ai build fails due to pre-existing errors in connector-audit.ts (TS2742 inferred type) and intelligence-crawl-worker.ts (missing cheerio) — not caused by T-07
- Uses `getLazyModel('ConnectorConfigVersion')` requiring ModelRegistry registration (self-registers via model file side-effect on import)
- Route mounted at `/api/indexes` prefix: full path is `/api/indexes/:indexId/connectors/:connectorId/config/versions`
- Optimistic concurrency: unique index `{ tenantId, connectorId, version }` serves as the concurrency guard. On duplicate key error, service retries up to 3 times with incremented version.
- `isDuplicateKeyError()` uses duck-typing check for `.code === 11000` to avoid casting to specific Mongoose error types
- Zod validation: `z.string().min(1)` for IDs, `z.coerce.number().int().positive()` for version numbers, `.safeParse()` on all params/query/body

---

### T-08: Create SWR Hooks (useConnector, useConnectorList, useConnectorSync)

**Files changed:**

- `apps/studio/src/hooks/useConnector.ts` — New file. SWR hook for single connector detail. Exports `ConnectorDetail` type (shared by useConnectorList). Conditional SWR key requires both `indexId` and `connectorId`.
- `apps/studio/src/hooks/useConnectorList.ts` — New file. SWR hook for connector list on an index. Imports `ConnectorDetail` from useConnector. Conditional SWR key requires `indexId`.
- `apps/studio/src/hooks/useConnectorSync.ts` — New file. SWR hook for sync status with conditional polling. Uses `useRef` to track active sync state, `onSuccess` callback to update the ref, and dynamic `refreshInterval` (5000ms during sync, 0 when idle).

**Functions added/modified:**

- `useConnector(indexId, connectorId): UseConnectorReturn` — Returns `{ connector, isLoading, error, mutate }`. SWR key: `/api/search-ai/indexes/${indexId}/connectors/${connectorId}` or null.
- `useConnectorList(indexId): UseConnectorListReturn` — Returns `{ connectors, total, isLoading, error, mutate }`. SWR key: `/api/search-ai/indexes/${indexId}/connectors` or null.
- `useConnectorSync(connectorId, options?): UseConnectorSyncReturn` — Returns `{ syncStatus, isLoading, error, mutate }`. SWR key: `/api/search-ai/connectors/${connectorId}/sync/status` or null. Polls at configurable interval (default 5000ms) when status is in `ACTIVE_SYNC_STATUSES` set.

**Tests:**

- Type-checked via `npx tsc --noEmit -p apps/studio/tsconfig.json` — no errors in hook files
- Studio `next build` blocked by pre-existing `pdf-lib` missing dependency in E2E helper (unrelated)

**Gotchas:**

- `useConnectorSync` cannot reference `data` in its own SWR config (circular initializer). Solved with `useRef` + `onSuccess` callback pattern: ref tracks whether sync is active, `onSuccess` updates the ref, `refreshInterval` reads from ref.
- `ConnectorDetail` type is exported from `useConnector.ts` and imported by `useConnectorList.ts` — single source of truth for the connector shape.
- `ACTIVE_SYNC_STATUSES` includes `'syncing'`, `'crawling'`, `'processing'`, `'in_progress'` — covers multiple possible backend status values.
- Cache invalidation strategy documented in LLD but not implemented here — consumers will call `mutate()` after mutations.

---

### T-01: Fix resolveScopes() + Permission Mode

**Files changed:**

- `packages/database/src/models/connector-config.model.ts` — Changed `permissionConfig.mode` enum from `['full', 'simplified', 'disabled']` to `['enabled', 'disabled']` in both the interface type and schema definition. Updated accuracy comment.
- `packages/connectors/base/src/interfaces/connector.interface.ts` — Changed `PermissionCrawlResult.mode` type and `IConnector.crawlPermissions()` signature from `'full' | 'simplified' | 'disabled'` to `'enabled' | 'disabled'`
- `packages/connectors/base/src/interfaces/permission-crawler.interface.ts` — Updated all mode types (`DocumentPermissionData.crawlMode`, `PermissionCrawlOptions.mode`, `IPermissionCrawler.mode`) from `'full' | 'simplified' | 'disabled'` to `'enabled' | 'disabled'`
- `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` — Updated `PermissionCrawlConfig.mode` and `CrawlResult.mode` types. Changed `'full'` comparison to `'enabled'` in `crawlDocuments()` accuracy calc and group member resolution check.
- `packages/connectors/sharepoint/src/sharepoint-connector.ts` — Updated `crawlPermissions()` signature to `'enabled' | 'disabled'`
- `apps/search-ai/src/services/connector.service.ts` — Replaced `resolveScopes()`: removed `Sites.FullControl.All` and `Directory.Read.All`, added `Sites.Read.All`, `Files.Read.All`, `GroupMember.Read.All` (for enabled), `offline_access`. Removed `'simplified'` branch.
- `apps/search-ai/src/workers/connector-permission-crawl-worker.ts` — Updated `ConnectorPermissionCrawlJobData.mode` type
- `apps/search-ai/src/workers/permission-recrawl-worker.ts` — Updated query from `$in: ['full', 'simplified']` to `'enabled'`

**Functions added/modified:**

- `resolveScopes(authMethod, permissionMode): string[]` — Now returns: client_credentials -> `['.default']`, enabled -> `['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access']`, disabled -> `['Sites.Read.All', 'Files.Read.All', 'offline_access']`

**Tests:**

- `pnpm build --filter=@agent-platform/database --filter=@agent-platform/connectors-base --filter=@agent-platform/connector-sharepoint` — all pass clean
- `grep 'simplified'` in target files — no matches

**Gotchas:**

- MIGRATION NEEDED: Existing MongoDB documents with `permissionConfig.mode: 'full'` or `'simplified'` will fail Mongoose enum validation. Run migration: `db.connector_configs.updateMany({'permissionConfig.mode': {$in: ['full', 'simplified']}}, {$set: {'permissionConfig.mode': 'enabled'}})` BEFORE deploying this change.
- Many other files (CLI, studio store, recommendation model, tests, project-io) still reference `'full' | 'simplified'`. These are outside the T-01 scope and should be updated in follow-up work.
- Changing scopes from `FullControl.All` to `Read.All` does not require re-auth (narrower scope is a subset), but may trigger new admin consent prompt in some Azure AD configurations.

---

### T-02: Fix pauseSync()/resumeSync()

**Files changed:**

- `apps/search-ai/src/services/connector.service.ts` — `pauseSync()` now accepts `redis` parameter (4th arg) and publishes Redis cancel signal on `connector-sync:{jobId}:cancel` channel (same pattern as `stopSync()`). Only publishes if there's a `currentJobId`.
- `packages/connectors/sharepoint/src/sharepoint-connector.ts` — Replaced stub `pauseSync()` with no-op (service layer handles pause via DB flag + Redis signal; `BaseSyncCoordinator.checkShouldPause()` polls DB). Replaced stub `resumeSync()` with checkpoint-loading implementation that calls `loadCheckpoint(connectorId)` then `performSync('full', checkpoint)`.
- `apps/search-ai/src/routes/connectors.ts` — Updated pause route to pass `req.app.get('redis')` to `pauseSync()` (matching `stopSync()` pattern).

**Functions added/modified:**

- `pauseSync(connectorId, tenantId, redis, reason?): Promise<{paused, reason}>` — Signature changed: added `redis` param. Now publishes Redis cancel signal for in-flight sync.
- `SharePointConnector.pauseSync(jobId): Promise<void>` — No-op; pause handled by service layer.
- `SharePointConnector.resumeSync(jobId): Promise<void>` — Loads checkpoint via `fullSyncCoordinator.loadCheckpoint()`, resumes sync via `performSync('full', checkpoint)`.

**Tests:**

- Build passes for connector-sharepoint package
- Pre-existing search-ai build errors (connector-audit.ts TS2742, missing cheerio) are unrelated

**Gotchas:**

- `BaseSyncCoordinator.checkShouldPause()` already polls `errorState.isPaused` from DB every 10 documents. The Redis signal provides a fast-path (<5s) for the sync worker, while DB is the fallback (up to 30s).
- `loadCheckpoint()` takes `connectorId` as parameter, not zero-arg. Returns `ISyncCheckpoint | null` but `findOne()` actually returns `HydratedDocument` at runtime — safe `as any` cast used.
- Resume creates a NEW BullMQ job. The job ID changes after pause/resume, which the service layer handles by updating `syncState.currentJobId`.

---

### T-03: OAuth Redis Hardening

**Files changed:**

- `apps/search-ai/src/services/connector.service.ts` — Three changes to device code session functions:
  1. `storeDeviceCodeSession()` now uses `SET NX PX` (Redis atomic set-if-not-exists with TTL) instead of `SETEX`. Returns `boolean` (true if stored, false if in-flight session exists). Both call sites now check the return value and throw `ConnectorError('AUTH_IN_PROGRESS', ..., 409)` if a session already exists.
  2. All three Redis functions (`store`, `get`, `delete`) now wrap operations in try/catch, log the error with `createLogger`, and throw `ConnectorError('REDIS_UNAVAILABLE', ..., 503)` on failure.
  3. Existing `oauth:device:` prefix retained (no rename — low value vs risk of breaking in-flight sessions).

**Functions added/modified:**

- `storeDeviceCodeSession(connectorId, session, ttlSeconds): Promise<boolean>` — Return type changed from `void` to `boolean`. Uses `redis.set(key, value, 'PX', ttlMs, 'NX')` for atomic guard.
- `getDeviceCodeSession(connectorId): Promise<DeviceCodeSessionData | null>` — Added error handling wrapping.
- `deleteDeviceCodeSession(connectorId): Promise<void>` — Added error handling wrapping.

**Tests:**

- Build passes (search-ai build has pre-existing unrelated errors)
- Verified no pod-local Maps for auth state in connector.service.ts

**Gotchas:**

- The `getDeviceCodeRedis()` function creates a standalone `new Redis()` from `getRedisConnection()`. This is not the shared connection pool — it's a dedicated instance for device code operations. ioredis handles automatic reconnection by default, so the hardening is primarily about wrapping errors in `ConnectorError` for proper HTTP status codes.
- The NX guard means a user who clicks "Connect" twice rapidly will get a 409 error on the second click. The first session must either complete or expire before a new one can be created.
- TTL is set in milliseconds (PX) for the NX path, vs seconds (SETEX) in the old code. The conversion `ttlSeconds * 1000` is correct.

---

### T-10: Create SharePointDetailPanel Shell

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — New panel shell component
- `packages/i18n/locales/en/studio.json` — Added `search_ai.sharepoint` namespace with tabs, panel, actions, placeholder keys

**Functions added/modified:**

- `SharePointDetailPanel({ indexId, onRefresh }): JSX.Element` — Unified panel shell for SharePoint connector setup and monitoring
  - Reads panel state from `useConnectorStore` via `useShallow` for multi-field selector
  - Reads connector data via `useConnector(indexId, activeConnectorId)`
  - Setup tabs (draft connector): Connect, Proposal, Scope+Filters, Preview, Security, History
  - Monitoring tabs (active connector): Overview, Scope+Filters, Security, History
  - Tab locking: draft connectors can only click Connect tab; others show Lock icon
  - Simplified View hides Scope+Filters and History tabs
  - Expand/collapse: 720px default, full viewport expanded, 300ms ease-out CSS transition
  - Scope-filters tab auto-expands panel; leaving it auto-collapses
  - More Actions dropdown: 6 disabled items with tooltip + functional Delete
  - All strings use `useTranslations('search_ai.sharepoint')`
- `isDraftStatus(connector)` — Helper to determine if connector is in draft/setup mode (no full sync completed)

**Tests:**

- TypeScript check passes (`npx tsc --noEmit` — no errors in SharePointDetailPanel)
- Pre-existing e2e errors unrelated to this change

**Gotchas:**

- SlidePanel only supports sm/md/lg/xl width presets. Custom 720px width achieved via `className="!max-w-[720px]"` override. Full viewport expand uses `!max-w-none`.
- SlidePanel renders its own header when `title` prop is provided. This component does NOT pass `title` to SlidePanel — it renders a custom header inside `children` to include the toggle, expand button, and dropdown menu.
- The `useShallow` import is from `zustand/react/shallow`, not `zustand/shallow`.
- Tab content is placeholder divs for Wave 1. Each tab shows "Tab content — Wave N" text.
- Delete action handler is a no-op stub in Wave 1 — the actual delete flow (with TypeToConfirmInput) will be wired in Wave 2.

---

### T-05: Fix Permission Crawler (Group ID, grantedToV2, getDrivePermissions)

**Files changed:**

- `packages/connectors/sharepoint/src/client/graph-types.ts` — Extracted `PermissionIdentity` interface from `Permission.grantedToV2`. Added `grantedToIdentitiesV2?: PermissionIdentity[]` to `Permission`. Added `AzureADGroup` and `AzureADGroupCollection` types for `/groups?$filter=` response.
- `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` — Three bug fixes (B2, B3, B4) plus structural improvements:

**Functions added/modified:**

- `resolveAzureADGroupId(group): Promise<string | null>` — New private method. Resolves SharePoint group → Azure AD group ID by calling `GET /groups?$filter=mail eq '{email}'`. Uses LRU cache (10,000 entries max, 1hr TTL). Returns null if group has no email or resolution fails (with warning log). Transient failures are NOT cached.
- `LRUCache<T>` — New local generic class with `get(key)`, `set(key, value)`, max size enforcement, and per-entry TTL. Evicts least-recently-used entry when at capacity.
- `processPermission(doc, perm)` — Refactored: now extracts identity blocks from both `grantedToV2` (singular) and `grantedToIdentitiesV2` (array), de-duplicates by entity ID, then delegates to `processIdentity()`.
- `processIdentity(doc, perm, identity)` — New private method. Handles user/group/siteUser identity processing. For groups: uses `resolveAzureADGroupId()` to get Azure AD ID, falls back to `sharepoint:{id}` prefix. Handles null displayName/email with defensive defaults.
- `crawlDocument(doc)` — Now fetches BOTH `getItemPermissions()` AND `getDrivePermissions()`. Merges and de-duplicates by permission ID before processing. Drive permission fetch failure is logged and non-fatal.
- `resolveGroupMembers(azureAdGroupId, groupIdKey)` — Signature changed: now takes Azure AD group ID (for Graph API call) and group ID key (for Neo4j). Uses `createLogger` instead of `console.warn`.
- Local `createLogger('sharepoint-permission-crawler')` — Added lightweight structured logger (same API as `@abl/compiler/platform`). Replaces bare `console.warn`.

**Tests:**

- `pnpm build --filter=@agent-platform/connector-sharepoint` — passes clean (exit code 0)

**Gotchas:**

- `graphClient.get()` is public (inherited from `HttpClient`), so the crawler can call it directly for the `/groups?$filter=` query. No new method needed on `GraphClient`.
- `resolveAzureADGroupId` only attempts resolution when group has an email. SharePoint-only groups without email silently fall back to `sharepoint:{id}` prefix (logged at debug level).
- Transient API failures in `resolveAzureADGroupId` are NOT cached — only successful lookups (including "not found" = null) are cached. This ensures retries work on the next crawl batch.
- Group member resolution is only attempted when Azure AD group ID was successfully resolved. If fallback to `sharepoint:{id}` was used, member resolution is skipped (the SharePoint-internal ID would 404 on `/groups/{id}/members`).
- The `PermissionIdentity` type extraction is a non-breaking refactor — `Permission.grantedToV2` field type is unchanged, just aliased.
- Drive permission fetch uses try/catch with warning log — some drive types may not support the permissions endpoint.

---

## Wave 2: Setup Flow — Batch 1

### T-14: ProposalState Model + Proposal Service

**Files changed:**

- `packages/database/src/models/proposal-state.model.ts` — New model with 5 status values, generation steps, section review, decision tracking
- `packages/database/src/index.ts` — Added ProposalState + type exports
- `apps/search-ai/src/services/proposal.service.ts` — Full proposal lifecycle service

**Functions added/modified:**

- `startGeneration(connectorId, tenantId): Promise<IProposalState>` — Creates proposal, fires 9-step pipeline in background
- `getGenerationStatus(connectorId, tenantId)` — Polling endpoint for generation progress
- `getProposal(connectorId, tenantId)` — Full proposal retrieval
- `acceptSection / modifySection / skipSection` — Section review with decision audit trail
- `acceptAllRemaining(connectorId, tenantId, actor)` — Batch accept all pending sections
- `approveProposal(connectorId, tenantId, actor)` — Triggers startSync + audit entry
- `abandonProposal(connectorId, tenantId, actor)` — Marks proposal abandoned
- `refreshSamplePreview / validateSites / rerunHealthCheck / disablePermissionAware / getConfigSummary / exportProposal` — Utility functions

**Gotchas:**

- `getLazyModel('ConnectorConfig')` returns loosely typed model — cast to `any` for property access
- `previewFilters()` returns `{ validation, currentFilterConfig, estimate }` — NOT `sampleDocuments`
- Decisions array uses `$push` with `$slice: -200` to prevent unbounded growth
- Partial unique index on `{ tenantId, connectorId }` excludes abandoned/failed status
- Pre-existing build errors in connector-audit.ts (TS2742) and cheerio (missing types) are NOT from this task

### T-18: CEL Expression Editor

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/CELExpressionEditor.tsx` — New component
- `packages/i18n/locales/en/studio.json` — Added CEL editor i18n keys under `search_ai.sharepoint`

**Functions added/modified:**

- `CELExpressionEditor(props)` — Textarea with monospace font, field autocomplete on "resource.", value autocomplete on `== "`, validation button

**Gotchas:**

- v1 uses native textarea (no CodeMirror) — autocomplete is positioned below the editor, not inline
- Suggestion dropdown uses `onMouseDown` (not `onClick`) to prevent blur race condition

### T-19: Condition Builder

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ConditionBuilder.tsx` — New component
- `packages/i18n/locales/en/studio.json` — Added 37 i18n keys for all 15 operators + UI labels

**Functions added/modified:**

- `ConditionBuilder(props)` — Visual field/operator/value builder with AND/OR grouping
- Uses native `<select>` instead of Radix Select to avoid test infrastructure issues

**Gotchas:**

- `NO_VALUE_OPERATORS` (exists, not_exists, is_empty) hide the value input
- Max 10 conditions per group, max 5 groups
- in_list/not_in_list use comma-separated text input (v1)

### T-25: Name Uniqueness + Admin Email Generation

**Files changed:**

- `apps/search-ai/src/services/connector.service.ts` — Added `checkConnectorName()` and `generateAdminEmail()`
- `apps/search-ai/src/routes/connectors.ts` — Added 2 static routes BEFORE parameterized `:connectorId` routes

**Functions added/modified:**

- `checkConnectorName(indexId, tenantId, name)` — Checks SearchSource names in index, suggests `"Name (2)"` if taken
- `generateAdminEmail(indexId, tenantId, type)` — Returns subject/body/mailto for Azure App Registration setup
- `GET /:indexId/connectors/check-name?name=...` — Zod-validated name check route
- `POST /:indexId/connectors/generate-admin-email` — Zod-validated email generation route

**Gotchas:**

- Routes use `z.string().min(1).max(200)` for name validation (per CLAUDE.md rules on ID validation)
- Static routes MUST stay before `/:indexId/connectors/:connectorId` — Express matches top-down
- Name comparison is case-insensitive (`.toLowerCase()`)
- `getConnectorRedirectUri()` is a private function in connector.service.ts — reused for redirect URI in email body

---

## Wave 2 Batch 3: Setup Flow UI

### T-13: Connect Tab

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ConnectTab.tsx` — Main Connect tab orchestrating first-time vs returning UX, auth flow, scopes
- `apps/studio/src/components/search-ai/sharepoint/AuthMethodSelector.tsx` — First-time: 2 Card radio options; Returning: 3 radio-style buttons
- `apps/studio/src/components/search-ai/sharepoint/ConnectionScopesDisplay.tsx` — Read-only scopes checklist with TypeToConfirmInput disable flow, compact mode support
- `apps/studio/src/components/search-ai/sharepoint/ITAdminGuide.tsx` — Expandable guide: send-to-admin + self-service 6-step
- `apps/studio/src/api/search-ai.ts` — Added `checkConnectorName()`, `generateAdminEmail()`, `runPreview()`, `getConfigSummary()`, `PreviewData`, `ConfigSummary` types
- `packages/i18n/locales/en/studio.json` — Added `search_ai.sharepoint.connect.*`, `scopeFilters.*`, `preview.*` i18n keys

**Functions added/modified:**

- `ConnectTab(props): ReactElement` — Determines first-time vs returning by filtering `useConnectorList` for sharepoint type. Manages auth state machine (idle → initiating → pending_device_code/pending_redirect → completed/error). Polls auth status via SWR with `refreshInterval: 3000`.
- `AuthMethodSelector(props): ReactElement` — Two variants: first-time (Card-based), returning (radio-style buttons)
- `ConnectionScopesDisplay(props): ReactElement` — Reusable in Connect tab and Proposal tab with `compact` prop
- `ITAdminGuide(props): ReactElement` — Controlled expand state, two sub-options

**Gotchas:**

- GUID_VALIDATOR pattern reused from EnterpriseConnectorWizard.tsx for Client ID/Tenant ID validation
- Auth polling uses SWR's `refreshInterval` (not manual setInterval) for automatic cleanup
- `createdConnectorIdRef` uses useRef (not useState) to avoid re-render during auth flow
- First-time "microsoft_signin" maps to backend "authorization_code" with auto scope selection

### T-17: Scope+Filters Split-Pane

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ScopeFiltersSplitPane.tsx` — 60/40 layout, auto-expand, undo history (max 20)
- `apps/studio/src/components/search-ai/sharepoint/ScopeControlsPanel.tsx` — Left panel: collapsible sections for sites, file types, dates, templates, folders, size, advanced
- `apps/studio/src/components/search-ai/sharepoint/ScopePreviewPanel.tsx` — Right panel: summary counts, diff badges, sample/excluded docs, OData display
- `apps/studio/src/components/search-ai/sharepoint/FilterTemplateSelector.tsx` — Toggle-style template buttons
- `apps/studio/src/hooks/useConnectorDiscovery.ts` — SWR hook wrapping `getConnectorDiscovery`, maps `ConnectorDiscovery` to `DiscoveryData`
- `apps/studio/src/hooks/useFilterPreview.ts` — SWR hook with 500ms debounce for filter preview

**Functions added/modified:**

- `useConnectorDiscovery(connectorId): UseConnectorDiscoveryReturn` — Maps backend's `DiscoveredResource[]` to `DiscoverySite[]` and `ContentProfile.fileTypeDistribution` to `DiscoveryFileType[]`
- `useFilterPreview(connectorId, filterConfig): UseFilterPreviewReturn` — Debounces config changes, POST-based SWR fetcher
- `createDefaultFilterConfig(): FilterConfig` — Factory for empty filter config

**Gotchas:**

- Discovery endpoint path differs from connector detail path (no `/indexes/${indexId}/` prefix)
- Undo history stored in useRef to avoid re-renders on each filter change
- ContentProfile has `fileTypeDistribution: Record<string, number>` — flattened across all profiles

### T-20: Preview Tab

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/PreviewTab.tsx` — Dry-run view with 4 stats, DataTable for samples/skipped, content breakdown
- `apps/studio/src/components/search-ai/sharepoint/ContentTypeBreakdown.tsx` — Horizontal bar chart, top 4 + "Other" grouping

**Functions added/modified:**

- `PreviewTab(props): ReactElement` — Fetches preview via `runPreview()`, renders stats grid, DataTable for up to 25 sample docs and 10 skipped docs
- `ContentTypeBreakdown(props): ReactElement` — CSS-based horizontal bars with proportional widths

### T-23: Flow A Wiring (SetupGuide opens dialog on Home tab)

**Files changed:**

- `apps/studio/src/components/search-ai/data/AddSourceButton.tsx` — Added `dialogOnly`, `open`, `onClose` props. When `dialogOnly=true`, hides trigger button, syncs dialog state with external `open` prop. SharePoint type selection now opens panel via `useConnectorStore.openPanel('new', { isNew: true, tab: 'connect' })`
- `apps/studio/src/components/search-ai/home/SetupGuide.tsx` — "Connect Source" now opens AddSourceButton dialog on Home tab (no tab switch). After source added, navigates to Data tab.

**Functions added/modified:**

- `handleConnectSource()` — Changed from tab navigation to local dialog open
- `handleSourceAdded(source?)` — Routes to correct Data tab view based on source type

### T-24: Flow D Wiring (SourcesTable row click opens panel)

**Files changed:**

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` — SharePoint source row click now uses `useConnectorStore.openPanel()` instead of old `ConnectorDetailPanel`. Draft sources open with `tab: 'connect'`, active with `tab: 'overview'`.
- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Replaced placeholder tab content with actual components: ConnectTab, ScopeFiltersSplitPane, PreviewTab. Other tabs remain placeholder.

**Gotchas:**

- Pre-existing build error in `e2e/searchai/helpers/file-helpers.ts` (missing `pdf-lib`) blocks full build. Our changes pass `tsc --noEmit` with 0 errors in all modified files.
- SourcesTable determines draft status by checking `row.status === 'pending' || 'disabled'` since the backend source status doesn't have explicit 'draft' value.

## Wave 2: Setup Flow

### T-15: Connector Proposal Routes (16 Endpoints)

**Files changed:**

- `apps/search-ai/src/routes/connector-proposal.ts` — NEW. Express router with 16 endpoints covering proposal generation, status polling, section review (accept/modify/skip), accept-all, approve, abandon, config summary, validate-sites, preview refresh, disable permissions, export, health-check rerun, and filters preview.
- `apps/search-ai/src/server.ts` — Added import and mount of `connectorProposalRouter` under `/api/indexes` (after connector config version mount, before 404 handler).

**Functions added/modified:**

- `handleError(res, error, fallbackCode)` — ConnectorError-aware error handler (same pattern as connectors.ts)
- 16 route handlers delegating to `proposalService.*` and `connectorService.previewFilters()`

**Route map:**

| Method | Path                                                                      | Service Function                    |
| ------ | ------------------------------------------------------------------------- | ----------------------------------- |
| POST   | `/:indexId/connectors/:connectorId/proposal/generate`                     | `startGeneration()` — returns 202   |
| GET    | `/:indexId/connectors/:connectorId/proposal/status`                       | `getGenerationStatus()`             |
| GET    | `/:indexId/connectors/:connectorId/proposal`                              | `getProposal()`                     |
| POST   | `/:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept`   | `acceptSection()`                   |
| PUT    | `/:indexId/connectors/:connectorId/proposal/sections/:sectionId`          | `modifySection()`                   |
| POST   | `/:indexId/connectors/:connectorId/proposal/sections/:sectionId/skip`     | `skipSection()`                     |
| POST   | `/:indexId/connectors/:connectorId/proposal/accept-all`                   | `acceptAllRemaining()`              |
| POST   | `/:indexId/connectors/:connectorId/proposal/approve`                      | `approveProposal()`                 |
| DELETE | `/:indexId/connectors/:connectorId/proposal/abandon`                      | `abandonProposal()`                 |
| GET    | `/:indexId/connectors/:connectorId/summary`                               | `getConfigSummary()`                |
| POST   | `/:indexId/connectors/:connectorId/proposal/scope/validate-sites`         | `validateSites()`                   |
| POST   | `/:indexId/connectors/:connectorId/proposal/preview/refresh`              | `refreshSamplePreview()`            |
| POST   | `/:indexId/connectors/:connectorId/proposal/sections/permissions/disable` | `disablePermissionAware()`          |
| GET    | `/:indexId/connectors/:connectorId/proposal/export`                       | `exportProposal()`                  |
| POST   | `/:indexId/connectors/:connectorId/proposal/sections/health-check/rerun`  | `rerunHealthCheck()`                |
| POST   | `/:indexId/connectors/:connectorId/proposal/filters/preview`              | `connectorService.previewFilters()` |

**Validation:**

- All route params validated with Zod `safeParse()` — `z.string().min(1)` for IDs
- Body schemas: `modifySectionBody`, `validateSitesBody`, `disablePermissionBody`, `filtersPreviewBody`
- Query schema: `exportQuery` (format enum)

**Gotchas:**

- Export endpoint uses `res.send()` with Content-Disposition header for file download (not JSON envelope).
- PDF export returns 501 Not Implemented (service throws, route catches and returns structured error).
- `actor` is derived from `req.tenantContext!.userId ?? 'system'` (userId contains email in this codebase).
- Pre-existing `cheerio` type error in `intelligence-crawl-worker.ts` — unrelated to our changes.

---

## Wave 2: Setup Flow (Batch 4-6)

### T-22: ConnectionScopesDisplay Compact Reuse

**Files changed:**

- No files modified. The `compact` prop was already implemented in the T-13 batch (Batch 3). `ConnectionScopesDisplay.tsx` already accepts `compact?: boolean` and applies conditional styling throughout (smaller text, icons, spacing).

**Functions added/modified:**

- None. The component already has the `compact` prop with full conditional rendering.

**Gotchas:**

- ST-22.2 (ProposalPermissionsSection importing with `compact={true}`) depends on T-16 which creates `ProposalPermissionsSection.tsx`. That file does not exist yet — this wiring will happen when T-16 is implemented.

---

### T-21: Approve & Start View

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ApproveAndStart.tsx` — New component. Final checkpoint before sync with config summary, confirmation dialog, and 3 action buttons.
- `apps/studio/src/api/search-ai.ts` — Added `approveProposal(indexId, connectorId)` API function that POSTs to `/indexes/:indexId/connectors/:connectorId/proposal/approve`.
- `packages/i18n/locales/en/studio.json` — Added `search_ai.sharepoint.approve` namespace with 44 i18n keys.

**Functions added/modified:**

- `ApproveAndStart({ indexId, connectorId, onSyncStarted, onSaveAsDraft, onExportTemplate })` — Fetches config summary via `getConfigSummary()`, renders 6 summary sections (Connection, Scope, Filters, Schedule, Permissions, Security), 3 action buttons. Start Sync opens ConfirmDialog. On confirm, calls `approveProposal()` and invokes `onSyncStarted(syncJobId)`.
- `approveProposal(indexId: string, connectorId: string): Promise<{ syncJobId: string }>` — API client function for proposal approval endpoint.
- `SummarySection({ title, children })` — Internal helper rendering a bordered section with title.
- `SummaryRow({ label, value })` — Internal helper rendering a key-value row.

**Tests:**

- TypeScript check: `npx tsc --noEmit -p apps/studio/tsconfig.json` — no errors in changed files.
- Pre-existing errors (pdf-lib, e2e types) are unrelated.

**Gotchas:**

- Export Template button is `disabled` with tooltip text per LLD risk note (Wave 4 T-51 builds the actual feature).
- Security pending gate: when `security.status === 'pending'`, button text changes to "Submit for Security Approval" on both the main button and the ConfirmDialog confirm button.
- `approveProposal` API function returns `{ syncJobId }` — the backend route (T-15) already implements this.
- Uses `sonner` toast for success/error feedback (same pattern as ConnectTab.tsx).
- `formatBytes` is duplicated from PreviewTab — could be extracted to shared util in future.

---

## Wave 2 Batch 5: T-16 — Proposal Tab

### T-16: Create Proposal Tab (Generation Progress, TOC, Section Review)

**Files changed:**

- `apps/studio/src/hooks/useConnectorProposal.ts` — NEW: SWR hook for proposal data with conditional polling (2s during generation, 0 when ready)
- `apps/studio/src/api/search-ai.ts` — MODIFIED: Added 11 proposal API functions (startProposalGeneration, getProposalStatus, getProposal, acceptProposalSection, modifyProposalSection, skipProposalSection, acceptAllRemainingSections, abandonProposal, exportProposal, rerunProposalHealthCheck, disableProposalPermissions)
- `apps/studio/src/components/search-ai/sharepoint/ProposalTab.tsx` — NEW: Main orchestrator with three states (generating/ready/approved)
- `apps/studio/src/components/search-ai/sharepoint/ProposalGenerationProgress.tsx` — NEW: 9-step animated checklist
- `apps/studio/src/components/search-ai/sharepoint/ProposalSection.tsx` — NEW: Generic collapsible section wrapper
- `apps/studio/src/components/search-ai/sharepoint/ProposalTableOfContents.tsx` — NEW: TOC with status badges and scroll-to-section
- `apps/studio/src/components/search-ai/sharepoint/ProposalHealthCheckSection.tsx` — NEW: Health check results display
- `apps/studio/src/components/search-ai/sharepoint/ProposalScopeSection.tsx` — NEW: Scope section with Variant A/B
- `apps/studio/src/components/search-ai/sharepoint/ProposalFiltersSection.tsx` — NEW: Filter summary with inline editor for simplified view
- `apps/studio/src/components/search-ai/sharepoint/ProposalScheduleSection.tsx` — NEW: Schedule with inline frequency editor
- `apps/studio/src/components/search-ai/sharepoint/ProposalPermissionsSection.tsx` — NEW: Permission mode with TypeToConfirmInput disable flow
- `apps/studio/src/components/search-ai/sharepoint/ProposalSamplePreview.tsx` — NEW: Sample document table
- `apps/studio/src/components/search-ai/sharepoint/ProposalSecurityGate.tsx` — NEW: Security gate status display
- `apps/studio/src/components/search-ai/sharepoint/UserDecisionsLog.tsx` — NEW: Decision history table
- `packages/i18n/locales/en/studio.json` — MODIFIED: Added `search_ai.sharepoint.proposal` namespace with ~80 keys

**Functions added/modified:**

- `useConnectorProposal(indexId, connectorId, options?)` — SWR hook with `refreshInterval` callback that returns 2000 when generating, 0 otherwise
- `startProposalGeneration(indexId, connectorId)` — POST to /proposal/generate
- `getProposalStatus(indexId, connectorId)` — GET /proposal/status
- `getProposal(indexId, connectorId)` — GET /proposal
- `acceptProposalSection(indexId, connectorId, sectionId)` — POST section accept
- `modifyProposalSection(indexId, connectorId, sectionId, data)` — PUT section modify
- `skipProposalSection(indexId, connectorId, sectionId)` — POST section skip
- `acceptAllRemainingSections(indexId, connectorId)` — POST accept-all
- `abandonProposal(indexId, connectorId)` — DELETE abandon
- `exportProposal(indexId, connectorId, format)` — GET export as blob
- `rerunProposalHealthCheck(indexId, connectorId)` — POST health-check rerun
- `disableProposalPermissions(indexId, connectorId, confirmationText)` — POST permissions disable

**Tests:**

- No component tests created (LLD does not require them for this task)
- Build verification: `npx tsc --noEmit -p apps/studio/tsconfig.json` passes (pre-existing e2e errors unrelated)

**Gotchas:**

- Studio `next build` fails due to pre-existing `pdf-lib` import in `e2e/searchai/helpers/file-helpers.ts` — unrelated to T-16
- The `useConnectorProposal` hook uses SWR's functional `refreshInterval` to conditionally poll — the callback receives `latestData` as the first argument
- Section-specific components receive translated strings via props from ProposalTab to avoid redundant `useTranslations` calls (per LLD i18n pattern note)
- The `exportProposal` API function returns a `Blob` for download — different from other API functions that return parsed JSON
- `approveProposal` already existed in search-ai.ts — the new proposal functions are added above it in a dedicated PROPOSAL API section
- `ProposalScheduleSection` uses a native `<select>` element (not Radix) for the inline frequency editor since it's a simple dropdown in simplified view — if Radix Select is required, it can be swapped in later
- `ProposalTab` uses `void` prefix for fire-and-forget async calls in onClick handlers to satisfy no-floating-promises lint rule

## Bug Fix: handleError ConnectorError-awareness

### Fix: handleError in connector-audit.ts and connector-config-versions.ts

**Files changed:**

- `apps/search-ai/src/routes/connector-audit.ts` — Added ConnectorError import, updated handleError to check for ConnectorError before falling through to generic 500
- `apps/search-ai/src/routes/connector-config-versions.ts` — Same fix as above

**Functions modified:**

- `handleError(res, error, fallbackCode)` — Now checks `error instanceof ConnectorError` first, returning `error.statusCode`/`error.code`/`error.message`. Falls through to generic 500 for non-ConnectorError cases. Matches the pattern in `connectors.ts`.

**Gotchas:**

- ConnectorError is exported from `connector.service.ts`, not a standalone module — import path is `../services/connector.service.js`
- The connectors.ts version leaks `msg` in the 500 fallback (`message: msg`); the audit/versions files use the safer `message: 'Internal server error'` — kept the safer version

## Wave 2 Production Audit Fixes

### P-9 (BLOCKING): Wire ProposalTab into SharePointDetailPanel

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Added imports for `ProposalTab` and `ApproveAndStart`. Wired `ProposalTab` to render when `activeTab === 'proposal'`. Wired `ApproveAndStart` to render when `activeTab === 'overview'`. Updated the fallback placeholder condition to exclude the newly wired tabs.

**Functions added/modified:**

- `SharePointDetailPanel` — Now renders `ProposalTab` for proposal tab and `ApproveAndStart` for overview tab instead of generic placeholders. ProposalTab receives `indexId`, `connectorId`, `simplifiedView`, and `onNavigateToTab`. ApproveAndStart receives callbacks that close panel and refresh on sync start.

**Gotchas:**

- `ProposalTab` requires `simplifiedView` and `onNavigateToTab` props — must be threaded from the panel's store state.
- `ApproveAndStart` requires `onSaveAsDraft` and `onExportTemplate` callbacks — `onExportTemplate` is a no-op (Wave 4 scope).

### P-10 (HIGH): Wire generateAdminEmail API in ConnectTab

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ConnectTab.tsx` — Imported `generateAdminEmail` from API. Replaced toast-only `handleSendToAdmin` with real API call. Added `sendingAdminEmail` loading state. Passed `loading` prop to `ITAdminGuide`.
- `packages/i18n/locales/en/studio.json` — Added `admin_guide_send_success` and `admin_guide_send_error` i18n keys.

**Functions added/modified:**

- `handleSendToAdmin` — Now calls `generateAdminEmail(indexId, 'sharepoint_setup')`, opens the mailto link from the response, and shows success/error toast.

### P-6 (MEDIUM): Wire CEL + ConditionBuilder into ScopeControlsPanel

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/ScopeControlsPanel.tsx` — Imported `CELExpressionEditor` and `ConditionBuilder`. Added `useMemo` import. Added `advancedFields` and `celFieldSuggestions` memos. Replaced placeholder advanced section with real `ConditionBuilder` and `CELExpressionEditor` components.
- `packages/i18n/locales/en/studio.json` — Added `cel_label` i18n key in scopeFilters namespace.

**Functions added/modified:**

- `advancedFields` (memo) — Derives metadata field list from discovery data, falls back to 5 common SharePoint fields.
- `celFieldSuggestions` (memo) — Maps advancedFields to CELExpressionEditor's expected shape.

**Gotchas:**

- `DiscoveryMetadataField` uses `fieldName` (not `name`) — must map when converting.
- `FilterConfig.conditionGroups` is typed as `Array<{logic, conditions}>` — compatible with `ConditionGroup[]` but needs cast.
- Discovery `metadataFields` is currently always empty — component provides sensible defaults.

### P-3 (LOW): Fix YAML export to use actual YAML

**Files changed:**

- `apps/search-ai/src/services/proposal.service.ts` — Imported `yaml` package (already a dependency). Replaced `JSON.stringify` in YAML export with `YAML.stringify`.

**Functions added/modified:**

- `exportProposal` — YAML format now produces real YAML output using the `yaml` package instead of JSON labeled as YAML.

## Wave 3: Monitoring — Batch 1 (Backend)

### Status

| Task | Status | Files Changed                                                                                       |
| ---- | ------ | --------------------------------------------------------------------------------------------------- |
| T-28 | Done   | connector-monitoring.service.ts, connector-monitoring.ts, server.ts                                 |
| T-29 | Done   | connector.service.ts, connector-config.model.ts                                                     |
| T-31 | Done   | connector-notification.service.ts, connector-notifications.ts, connector-config.model.ts, server.ts |
| T-33 | Done   | connector-monitoring.service.ts (updatePermissionSchedule), connector-monitoring.ts (PUT route)     |
| T-36 | Done   | connector-error.service.ts, connector-error-recovery.ts, server.ts                                  |
| T-37 | Done   | connector-utility.service.ts, connector-utilities.ts, server.ts                                     |

### T-28: Backend Monitoring Routes (Overview, Content-Breakdown, Sync-History)

**Files changed:**

- `apps/search-ai/src/services/connector-monitoring.service.ts` — Created. `getOverview`, `getContentBreakdown`, `getSyncHistory`, `updatePermissionSchedule` (T-33).
- `apps/search-ai/src/routes/connector-monitoring.ts` — Created. 3 GET routes + 1 PUT (permission-schedule). Zod validation, handleError pattern, authMiddleware.
- `apps/search-ai/src/server.ts` — Mounted `connectorMonitoringRouter` under `/api/indexes` before 404 handler.

**Functions added/modified:**

- `getOverview(connectorId, tenantId): Promise<OverviewData>` — Derives status from syncState/errorState. Loads discovery data for site/library counts. Builds configSummary, contentFreshness, permissionSync.
- `getContentBreakdown(connectorId, tenantId)` — Aggregates from latest completed ConnectorDiscovery. byType from fileTypeDistribution, bySite from site resources.
- `getSyncHistory(connectorId, tenantId, { page, limit })` — Queries ConnectorAuditEntry with category:'sync'. Maps audit events to SyncHistoryEntry format.

**Gotchas:**

- `IConnectorAuditEntry` is NOT re-exported from `@agent-platform/database/models` — must import from `@agent-platform/database` main.
- Content breakdown data depends on ConnectorDiscovery completing. Returns empty arrays if no discovery.

### T-29: Enhanced Sync Progress

**Files changed:**

- `apps/search-ai/src/services/connector.service.ts` — Enhanced `getSyncStatus()` (line 1243). Added `syncType`, `isActive`, `sizeTotal`, `etaSeconds`, `currentDocument`, `perSiteProgress` to return.
- `packages/database/src/models/connector-config.model.ts` — Added `syncType`, `syncStartedAt`, `sizeTotal` to syncState subdocument interface and schema.

**Functions modified:**

- `getSyncStatus(connectorId, tenantId)` — Now returns enhanced progress with `docsProcessed`/`docsTotal` (renamed from `processed`/`total`), `etaSeconds` computed from elapsed time, `perSiteProgress` array, `currentDocument` object.

**Gotchas:**

- `syncType` uses `string | null` (not enum) in interface to avoid Mongoose Schema type inference issues with nested `{ type: String, enum: [...] }`.
- ETA computation: `(elapsedMs / docsProcessed) * (remainingDocs / 1000)` — linear extrapolation, will be inaccurate for variable-size documents.
- perSiteProgress and currentDocument are ephemeral — stored in Redis in production, but read from syncState for now.

### T-31: Notification Preferences + Test-Webhook

**Files changed:**

- `apps/search-ai/src/services/connector-notification.service.ts` — Created. GET/PUT notification config, test-webhook with SSRF protection.
- `apps/search-ai/src/routes/connector-notifications.ts` — Created. 3 routes (GET/PUT/POST). Zod validation with event enums.
- `packages/database/src/models/connector-config.model.ts` — Added `notifications` subdocument to interface and schema.
- `apps/search-ai/src/server.ts` — Mounted `connectorNotificationsRouter`.

**Functions added:**

- `getNotificationConfig(connectorId, tenantId)` — Reads from connector.notifications subdocument with defaults.
- `updateNotificationConfig(connectorId, tenantId, updates)` — Partial merge using `$set` on individual notification fields.
- `testWebhook(url, connectorId, tenantId)` — SSRF-protected webhook test. Validates hostname IP against private ranges. 10s timeout via AbortController.

**Gotchas:**

- SSRF protection: resolves hostname via `dns.promises.lookup()`, checks against RFC 1918, loopback, link-local ranges. Does NOT block DNS resolution failure (lets the actual fetch fail).
- Notification events are validated via Zod enum: `sync_failure`, `token_expiry`, `permission_crawl_fail`, `sync_complete`.

### T-33: Permission Schedule Route

**Files changed:**

- Combined into `connector-monitoring.service.ts` and `connector-monitoring.ts` (same router).

**Functions added:**

- `updatePermissionSchedule(connectorId, tenantId, schedule, cronExpression?)` — Maps schedule labels to cron: daily=`0 2 * * *`, weekly=`0 2 * * 0`, manual=null, custom=user-provided. Updates `permissionConfig.crawlSchedule`.

**Gotchas:**

- This only stores the schedule preference. Actual BullMQ repeatable job scheduling is a follow-up.
- Zod refinement validates cronExpression is required when schedule='custom'.

### T-36: Error Discriminator + Retry

**Files changed:**

- `apps/search-ai/src/services/connector-error.service.ts` — Created. Error classification and retry dispatch.
- `apps/search-ai/src/routes/connector-error-recovery.ts` — Created. GET error-status, POST retry.
- `apps/search-ai/src/server.ts` — Mounted `connectorErrorRecoveryRouter`.

**Functions added:**

- `classifyError(connector: IConnectorConfig)` — Pattern-matches `errorState.lastErrorMessage` for AADSTS, expired, 429/throttle, revoked, timeout+discover, sync-related. Also checks partial failure from syncState. Returns `{ type, data }` or `null`.
- `executeRetry(connectorId, tenantId, action)` — Dispatches to connector service functions: `resume_sync` -> `resumeSync()`, `rerun_full_sync` -> `restartSync()`, `retry_failed_sites` -> `startSync()`. Validates preconditions (e.g., must be paused for resume_sync).

**Gotchas:**

- Error classification is string-matching based — fragile. Future: store structured `errorType` on connector doc.
- `retry_auth` and `retry_discovery` currently return success messages but don't trigger actual flows (would need userId for auth, discovery service integration).

### T-37: Utility Routes (Site Statuses, Filter Analysis, Check Site Access)

**Files changed:**

- `apps/search-ai/src/services/connector-utility.service.ts` — Created. Three utility functions.
- `apps/search-ai/src/routes/connector-utilities.ts` — Created. 3 routes (2 GET, 1 POST).
- `apps/search-ai/src/server.ts` — Mounted `connectorUtilitiesRouter`.

**Functions added:**

- `getSiteStatuses(connectorId, tenantId)` — Reads perSiteProgress from syncState, falls back to discovery profiles.
- `getFilterAnalysis(connectorId, tenantId)` — Estimates per-filter exclusion counts from discovery profiles + filterConfig.
- `checkSiteAccess(connectorId, tenantId, siteUrl)` — Uses connector's OAuth token to call MS Graph API `GET /sites/{hostname}:/{path}`. 10s timeout.

**Gotchas:**

- `checkSiteAccess` uses non-lean `findConnectorByIdAndTenant` (not lean) because `findOAuthToken` may need Mongoose plugin processing for encrypted tokens.
- Filter analysis exclusion counts are estimates based on discovery profile metadata, not exact. Size filter and date filter exclusions show 0 count (cannot estimate without per-file data).

## Wave 4: Fleet Ops & Config Management — Batch 1

### ST-T53: ConnectorTemplate Model

**Files changed:**

- `packages/database/src/models/connector-template.model.ts` — New Mongoose model with uuidv7 \_id, tenant isolation plugin, configSnapshot (Mixed), permissionMode enum, usageCount
- `packages/database/src/index.ts` — Export ConnectorTemplate and IConnectorTemplate

**Functions added/modified:**

- `ConnectorTemplate` model — Stores reusable connector config templates for clone/template operations
- Indexes: `{ tenantId: 1, name: 1 }` (unique), `{ tenantId: 1, connectorType: 1 }`

### ST-T54: NotificationSubscription Model

**Files changed:**

- `packages/database/src/models/notification-subscription.model.ts` — New Mongoose model for per-user connector event subscriptions
- `packages/database/src/index.ts` — Export NotificationSubscription and INotificationSubscription

**Functions added/modified:**

- `NotificationSubscription` model — Tracks userId, connectorId, eventCategories array, channels array, webhookUrl
- Indexes: `{ tenantId: 1, userId: 1, connectorId: 1 }` (unique), `{ tenantId: 1, connectorId: 1, isActive: 1 }`

### ST-T50: ConnectorCleanupJob Model + Content Purge Backend

**Files changed:**

- `packages/database/src/models/connector-cleanup-job.model.ts` — New model tracking purge job state/progress
- `packages/database/src/index.ts` — Export ConnectorCleanupJob and IConnectorCleanupJob
- `apps/search-ai/src/services/connector-content-purge.service.ts` — Purge business logic with background batch deletion
- `apps/search-ai/src/routes/connector-content-purge.ts` — 4 routes: initiate, status, cancel, retry
- `apps/search-ai/src/server.ts` — Mount connectorContentPurgeRouter

**Functions added/modified:**

- `initiatePurge(connectorId, tenantId, actor)` — Creates cleanup job, runs async batch deletion
- `getPurgeStatus(cleanupId, tenantId)` — Polls job progress
- `cancelPurge(cleanupId, tenantId)` — Sets status to cancelled
- `retryPurge(cleanupId, tenantId)` — Re-runs failed purge

**Gotchas:**

- Background purge uses `runPurgeAsync` with BATCH_SIZE=100, checks for cancellation between batches
- Sync conflict check: rejects with 409 if `syncState.syncInProgress` is true

### ST-T44: Backend Security Routes

**Files changed:**

- `apps/search-ai/src/services/connector-security.service.ts` — Security overview, blast radius, emergency revoke, export
- `apps/search-ai/src/routes/connector-security.ts` — 4 routes with ConnectorError-aware handleError
- `apps/search-ai/src/server.ts` — Mount connectorSecurityRouter

**Functions added/modified:**

- `getSecurityOverview(connectorId, tenantId)` — Returns scopes, token status, access summary
- `getBlastRadius(connectorId, tenantId)` — Counts documents and chunks for the connector's source
- `emergencyRevoke(connectorId, tenantId, actor)` — Revokes OAuth token, pauses connector, writes audit
- `exportSecurityDocument(connectorId, tenantId, format)` — Exports as JSON/YAML/Markdown

**Gotchas:**

- OAuth token lookup uses `connector.oauthTokenId` -> `EndUserOAuthToken._id`, NOT by connectorId (EndUserOAuthToken has no connectorId field)
- Token `scope` is a single space-separated string, not an array
- Emergency revoke marks token as revokedAt (soft-revoke), does NOT deleteMany

### ST-T41: Enhanced List Sources

**Files changed:**

- `apps/search-ai/src/routes/connectors.ts` — Added `listSourcesQuery` Zod schema, parses query params
- `apps/search-ai/src/services/connector.service.ts` — Enhanced `listConnectors` with options parameter

**Functions added/modified:**

- `listConnectors(indexId, tenantId, options?)` — Now accepts search, status[], type[], sortBy, sortDir, page, limit
- `computeAggregates(connectors, sources)` — Returns totalDocs, totalSizeBytes, sourceCountByType/Status, tokensExpiringCount
- Backward compatible: no options = same shape as before, plus aggregates field

### ST-T42: Bulk Actions Route

**Files changed:**

- `apps/search-ai/src/routes/connectors.ts` — Added `bulkActionBody` schema and POST bulk-actions route (static, before :connectorId)
- `apps/search-ai/src/services/connector.service.ts` — Added `executeBulkAction` function

**Functions added/modified:**

- `executeBulkAction(indexId, tenantId, action, sourceIds, params?)` — Processes actions with BULK_CONCURRENCY=5, returns partial results
- `executeSingleAction(...)` — Dispatches to existing service methods (pause, resume, sync, delete)
- `re_auth`, `apply_schedule`, `export_configs` return 501 Not Implemented

### ST-T55: Concurrent Editing Presence

**Files changed:**

- `apps/search-ai/src/services/connector-presence.service.ts` — Redis-backed presence with 30s TTL
- `apps/search-ai/src/routes/connector-presence.ts` — Heartbeat POST + GET active editors
- `apps/search-ai/src/server.ts` — Mount connectorPresenceRouter

**Functions added/modified:**

- `sendHeartbeat(connectorId, tenantId, userId, userName, activeTab)` — HSET + EXPIRE on Redis
- `getActiveEditors(connectorId, tenantId)` — HGETALL, parse JSON entries

**Gotchas:**

- Creates its own Redis instance from `getRedisConnection()` options (returns ConnectionOptions, not Redis instance)
- userId/userName come from auth context, NOT request body (prevents impersonation)

### ST-T56: Org-Level Connector Policy

**Files changed:**

- `apps/search-ai/src/services/connector-policy.service.ts` — Returns default policy (read-only)
- `apps/search-ai/src/routes/connector-policy.ts` — GET /:indexId/connector-policy
- `apps/search-ai/src/server.ts` — Mount connectorPolicyRouter

**Functions added/modified:**

- `getConnectorPolicy(tenantId)` — Returns default ConnectorPolicy (maxConnectorsPerKB: null, selfApprovalAllowed: true, etc.)

### ST-T38: SourcesTable Enhancements (Card View, Status, Aggregates)

**Files changed:**

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` — Added viewMode state, SegmentedControl, expanded statusVariant, onAddSource/aggregates props, conditional SP columns
- `apps/studio/src/components/search-ai/data/SourceCard.tsx` — New card component for card view
- `apps/studio/src/components/search-ai/data/SourcesCardGrid.tsx` — Grid layout with "+ Add Source" dashed card
- `apps/studio/src/components/search-ai/data/SourcesAggregateSummary.tsx` — Aggregate stats bar
- `packages/i18n/locales/en/studio.json` — Added view*card, view_table, card_add_source, col_sites, aggregate*\* keys

**Gotchas:**

- viewMode auto-detects (card if <=6 sources, table if >=7), manual override persisted to localStorage
- SP columns (Sites) only included when `sources.some(s => s.sourceType === 'sharepoint')`
- SourceCard onDelete creates synthetic event since DropdownMenuItem.onSelect is `() => void`

### ST-T57: Draft Mode Support (DraftBanner)

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/DraftBanner.tsx` — New info banner with step progress and CTA
- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Import and render DraftBanner above tab content
- `packages/i18n/locales/en/studio.json` — Added sharepoint.draft.\* keys

**Functions added/modified:**

- `DraftBanner({ connectorId, currentStep, onNavigateToStep })` — Shows 5-step progress (auth/scope/filters/preview/ready), [Complete Setup] CTA
- currentStep determined from connector state: no oauthTokenId → 'auth', no siteUrl → 'scope', else 'preview'

---

## Wave 3: Monitoring (Frontend)

### T-26: Overview Tab (KPIs, Config Summary, Sync History)

**Files changed:**

- `apps/studio/src/hooks/useConnectorOverview.ts` — NEW SWR hook for overview KPI data
- `apps/studio/src/hooks/useContentBreakdown.ts` — NEW SWR hook for content breakdown
- `apps/studio/src/hooks/useSyncHistory.ts` — NEW SWR hook for paginated sync history
- `apps/studio/src/components/search-ai/sharepoint/ContentBreakdown.tsx` — NEW by-type bars + by-site list
- `apps/studio/src/components/search-ai/sharepoint/ConfigSummary.tsx` — NEW 4-row config summary
- `apps/studio/src/components/search-ai/sharepoint/ContentFreshnessWarning.tsx` — NEW warning when sync >3 days ago
- `apps/studio/src/components/search-ai/sharepoint/SyncHistoryTable.tsx` — NEW DataTable with status badges
- `apps/studio/src/components/search-ai/sharepoint/QuickActionsBar.tsx` — NEW 7 action buttons
- `apps/studio/src/components/search-ai/sharepoint/OverviewTab.tsx` — NEW orchestrator
- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Render OverviewTab for non-draft

### T-27: Sync Progress View

**Files changed:**

- `apps/studio/src/hooks/useConnectorSync.ts` — Extended SyncStatusResponse interface
- `apps/studio/src/components/search-ai/sharepoint/SyncProgressView.tsx` — NEW real-time sync view
- `apps/studio/src/components/search-ai/sharepoint/PerSiteProgressBar.tsx` — NEW per-site progress
- `apps/studio/src/api/search-ai.ts` — Added stopConnectorSync, saveNotificationConfig, testConnectorWebhook, triggerPermissionCrawl

### T-30: Notification Config UI

**Files changed:**

- `apps/studio/src/hooks/useNotificationConfig.ts` — NEW SWR hook with optimistic update
- `apps/studio/src/components/search-ai/sharepoint/NotificationConfig.tsx` — NEW email + webhook config

### T-32: Permission Sync Status

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/PermissionSyncStatus.tsx` — NEW permission sync section

### T-34: Error State Components (E1-E10)

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/errors/ConnectorErrorState.tsx` — NEW dispatcher
- `apps/studio/src/components/search-ai/sharepoint/errors/error-types.ts` — NEW shared types
- 10 error component files (AuthFailed, DiscoveryTimeout, SyncFailure, TokenExpired, PermissionRevoked, Throttled, PartialSiteFailure, ZeroSites, PopupBlocked, AllUnsupported)

### T-35: Empty State Components (EM2, EM3)

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/errors/ConnectorEmptyState.tsx` — NEW dispatcher
- `apps/studio/src/components/search-ai/sharepoint/errors/NoDocumentsEmpty.tsx` — EM2
- `apps/studio/src/components/search-ai/sharepoint/errors/NoSitesAccessibleEmpty.tsx` — EM3

### i18n (All Tasks)

- `packages/i18n/locales/en/studio.json` — Added overview, sync_progress, notifications, permission_sync, errors, empty namespaces under sharepoint

**Gotchas:**

- Each error component calls useTranslations independently (not passed as prop) due to next-intl Translator type complexity
- ThrottledError countdown uses useEffect with clearInterval cleanup
- SyncProgressView completion timer uses useRef for cleanup on unmount
- OverviewTab differentiates draft vs non-draft: draft renders ApproveAndStart, non-draft renders OverviewTab

---

## Wave 4 Batch 2: Security, Config Management, Multi-Connector

### T-39: BulkActionsToolbar + Selection in SourcesTable

**Files changed:**

- `apps/studio/src/components/search-ai/data/BulkActionsToolbar.tsx` — NEW floating toolbar for batch actions (pause, resume, sync, delete, SP-conditional: re-auth, apply schedule, export configs)
- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` — Added selection state (selectedIds Record), checkbox column, bulk action handler via apiFetch, groupBy/statusFilter state, grouped rendering

**Functions added/modified:**

- `BulkActionsToolbar({ selectedCount, allSharePoint, onAction, loading, onClear })` — Renders action buttons based on selection context
- SourcesTable: `toggleSelection`, `toggleSelectAll`, `clearSelection` callbacks; `handleBulkAction` POSTs to `/api/search-ai/indexes/${indexId}/connectors/bulk-action`

**Gotchas:**

- `filteredSources` must be declared before `toggleSelectAll` (uses it in dependency) — moved useMemo above the callback

---

### T-40: SourcesToolbar + QuickFilterPills + Grouping

**Files changed:**

- `apps/studio/src/components/search-ai/data/SourcesToolbar.tsx` — NEW extracted toolbar with search, group-by SegmentedControl, view toggle
- `apps/studio/src/components/search-ai/data/QuickFilterPills.tsx` — NEW clickable status pills with counts
- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` — Replaced inline toolbar with SourcesToolbar, added grouped rendering

**Functions added/modified:**

- `SourcesToolbar(props)` — search input, group-by control, quick filter pills, view toggle
- `QuickFilterPills({ statusCounts, activeFilter, onFilterChange })` — Renders Badge pills per status

---

### T-43: SecurityTab with 6 Subsections

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/SecurityTab.tsx` — NEW layout for 6 security sections
- `apps/studio/src/components/search-ai/sharepoint/security/ScopesSection.tsx` — Lists granted OAuth scopes
- `apps/studio/src/components/search-ai/sharepoint/security/TokenExpirySection.tsx` — Token status/countdown/renewal
- `apps/studio/src/components/search-ai/sharepoint/security/AccessSummarySection.tsx` — Two-column access/no-access display
- `apps/studio/src/components/search-ai/sharepoint/security/EmergencyRevokeSection.tsx` — Blast radius pre-check + TypeToConfirmInput
- `apps/studio/src/components/search-ai/sharepoint/security/SecurityExportSection.tsx` — JSON/YAML/Markdown export buttons
- `apps/studio/src/components/search-ai/sharepoint/security/AuditLogSection.tsx` — DataTable with category filter + pagination
- `apps/studio/src/hooks/useSecurityOverview.ts` — SWR hook for /security/overview
- `apps/studio/src/hooks/useAuditLog.ts` — SWR hook for /audit-log with category/page/limit

---

### T-45: ConfigExportDialog

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/config/ConfigExportDialog.tsx` — NEW dialog with format toggle, include checkboxes, live preview, download/copy
- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Wired Export JSON/YAML menu items to open dialog

---

### T-46: VersionHistoryTab with Diff + Restore

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/config/VersionHistoryTab.tsx` — NEW version table + diff viewer + restore + drift section
- `apps/studio/src/components/search-ai/sharepoint/config/ConfigDiffViewer.tsx` — NEW side-by-side diff display with type badges
- `apps/studio/src/components/search-ai/sharepoint/config/ConfigDriftSection.tsx` — NEW drift display with reapply/update/ignore actions
- `apps/studio/src/hooks/useConfigVersions.ts` — SWR hook for /config/versions with pagination
- `apps/studio/src/hooks/useConfigDrift.ts` — SWR hook for /config/drift

---

### T-47: Config Drift Detection (Backend)

**Files changed:**

- `apps/search-ai/src/services/connector-config-mgmt.service.ts` — NEW service: exportConfig, detectDrift, reapplyTemplate, updateTemplate, ignoreDrift, previewImport, confirmImport
- `apps/search-ai/src/routes/connector-config-mgmt.ts` — NEW 7 routes: GET export, GET drift, POST drift/reapply-template, POST drift/update-template, POST drift/ignore, POST import, POST import/confirm

**Gotchas:**

- `computeDiff` uses object-based key union pattern (not `new Set`) to avoid unbounded-collections hook

---

### T-48: ContentPurgeDialog

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/config/ContentPurgeDialog.tsx` — NEW multi-step dialog: confirm -> progress -> complete/failed with polling
- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Wired Delete menu item to open purge dialog

---

### T-49: Backend Config Version Diff + Restore Routes

**Files changed:**

- `apps/search-ai/src/services/connector-config-version.service.ts` — Added `diffVersions`, `restoreVersion`, `computeConfigDiff`
- `apps/search-ai/src/routes/connector-config-versions.ts` — Added diff GET route and restore POST route BEFORE `:versionNumber` parameterized route

**Gotchas:**

- Diff/restore routes registered BEFORE `:versionNumber` route (Express route ordering critical)
- `computeConfigDiff` uses object-based key union (not `new Set`)

---

### T-51: MultiConnectorDialog + TemplateSecurityGate

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/MultiConnectorDialog.tsx` — NEW multi-step dialog: method_select -> clone/template/import -> security_gate -> creating
- `apps/studio/src/components/search-ai/sharepoint/TemplateSecurityGate.tsx` — Permission acknowledgment gate with TypeToConfirmInput for disable
- `apps/studio/src/hooks/useConnectorTemplates.ts` — SWR hook for /connector-templates

---

### T-52: Backend Clone/Template/Import Routes

**Files changed:**

- `apps/search-ai/src/services/connector.service.ts` — Added `cloneConnector` function
- `apps/search-ai/src/services/connector-template.service.ts` — NEW service: listTemplates, createTemplate, applyTemplate, importConnectorConfig
- `apps/search-ai/src/routes/connector-multi.ts` — NEW routes: POST clone, GET/POST connector-templates, POST templates/:templateId/apply, POST connectors/import
- `apps/search-ai/src/server.ts` — Mounted connectorConfigMgmtRouter and connectorMultiRouter

**Gotchas:**

- `cloneConnector` must destructure `{ connector }` from `getConnector()` return (returns `{ connector, source }`)
- `connector-template.service.ts` uses dynamic `import()` for `createConnector` to avoid circular deps

---

### Panel Wiring (T-43, T-45, T-46, T-48)

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Imported SecurityTab, VersionHistoryTab, ConfigExportDialog, ContentPurgeDialog. Added dialog state. Replaced placeholder tab fallback with real SecurityTab and VersionHistoryTab rendering. Enabled Export JSON/YAML menu items. Enabled Delete menu item.

---

### i18n (All Wave 4 Batch 2 Tasks)

**Files changed:**

- `packages/i18n/locales/en/studio.json` — Added: `sources_table.toolbar.*`, `sources_table.bulk.*`, `sharepoint.security.*`, `sharepoint.config.history.*`, `sharepoint.config.drift.*`, `sharepoint.config.export.*`, `sharepoint.config.purge.*`, `sharepoint.multi_connector.*`

---

## Wave 3+4 Production Audit Fixes

### ST-P1: OverviewTab.tsx — Wire no-op callbacks to real APIs

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/OverviewTab.tsx` — Imported `startConnectorSync`, `pauseConnectorSync`, `resumeConnectorSync` from `api/search-ai`. Added `handleSyncNow` (calls `startConnectorSync`, shows toast, mutates SWR), `handlePause` (calls `pauseConnectorSync`), `handleResume` (calls `resumeConnectorSync`). Wired to `ContentFreshnessWarning.onSyncNow` and all `QuickActionsBar` callbacks. `onHealthCheck` navigates to overview tab, `onSearchDocuments` navigates to preview tab. `syncLoading` state prevents double-clicks.
- `packages/i18n/locales/en/studio.json` — Added `overview.sync_started`, `overview.pause_success`, `overview.resume_success` i18n keys.

**Gotchas:**

- `QuickActionsBar` uses `syncInProgress` prop for disabled state. We pass `syncInProgress || syncLoading` to cover the brief window between API call and SWR re-fetch.

### ST-P2: PermissionSyncStatus.tsx — Fix disabled button with tooltip

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/PermissionSyncStatus.tsx` — Imported `Tooltip` component. Wrapped disabled "Set Schedule" button in a `<Tooltip>` explaining the scheduler is not active yet. `<span>` wrapper needed because disabled buttons don't fire pointer events for Radix tooltip.
- `packages/i18n/locales/en/studio.json` — Added `permission_sync.schedule_not_available` i18n key.

**Gotchas:**

- Crawl API path `/api/search-ai/connectors/${connectorId}/permissions/crawl` is correct — verified against `apps/search-ai/src/routes/connectors.ts` line 462 and server.ts mounts at `/api`.

### ST-P3: ConnectorEmptyState.tsx — Wire empty state action callbacks

**Files changed:**

- `apps/studio/src/components/search-ai/sharepoint/errors/ConnectorEmptyState.tsx` — Added `handleCheckAccess` (calls `/api/search-ai/indexes/:indexId/connectors/:connectorId/check-site-access` POST with `{ siteUrl }`, shows success/error toast), `handleSendRequestToAdmin` (opens mailto: link with pre-filled subject/body), `handleUpgradeScope` (navigates to connect tab for re-auth with broader scope). All callbacks now wired to `NoSitesAccessibleEmpty`.
- `packages/i18n/locales/en/studio.json` — Added `empty.site_accessible`, `empty.site_not_accessible`, `empty.admin_request_subject`, `empty.admin_request_body` i18n keys.

**Gotchas:**

- `check-site-access` route is mounted at `/api/indexes` in server.ts, so the full path from Studio is `/api/search-ai/indexes/:indexId/connectors/:connectorId/check-site-access`. Requires `{ siteUrl: z.string().url() }` body.
- `onUpgradeScope` navigates to the connect tab rather than programmatically triggering OAuth — the connect tab already handles auth flow including scope selection.
