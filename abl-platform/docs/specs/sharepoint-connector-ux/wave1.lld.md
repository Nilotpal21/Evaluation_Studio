# SharePoint Connector UX — Wave 1 LLD (Foundation)

**HLD Reference:** sharepoint-connector-ux.hld.md
**Wave:** 1 of 4 — Foundation (Bug Fixes, Models, SWR, Panel Shell)
**Tasks:** T-01 to T-12

---

## Task T-01: Fix resolveScopes() + Permission Mode "simplified" Bug

### Problem

Two related bugs in `apps/search-ai/src/services/connector.service.ts` (lines 154-165):

1. **Wrong scopes:** `resolveScopes()` returns `Sites.FullControl.All` for both `full` and `simplified` permission modes. The correct scope is `Sites.Read.All` — the platform only needs read access to SharePoint content. `FullControl.All` grants write/delete permissions that violate the principle of least privilege and will fail admin consent in most enterprises.

2. **Invalid permission mode:** The function accepts `"simplified"` as a permission mode (line 161), and the Mongoose schema at `packages/database/src/models/connector-config.model.ts` (line 307) declares `enum: ['full', 'simplified', 'disabled']`. The design specifies only `"enabled"` and `"disabled"` — "simplified" is a leftover from an earlier iteration. The `PermissionCrawlConfig` type in `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` (line 22) also uses `'full' | 'simplified' | 'disabled'`.

Current `resolveScopes()` (line 154):

```ts
function resolveScopes(authMethod: string, permissionMode: string): string[] {
  if (authMethod === 'client_credentials') {
    return ['https://graph.microsoft.com/.default'];
  }
  if (permissionMode === 'full') {
    return ['Sites.FullControl.All', 'Directory.Read.All', 'offline_access'];
  }
  if (permissionMode === 'simplified') {
    return ['Sites.FullControl.All', 'offline_access'];
  }
  return ['Sites.Read.All', 'offline_access'];
}
```

### Files to Modify

- `apps/search-ai/src/services/connector.service.ts` (line 154-165) — Fix `resolveScopes()` return values
- `packages/database/src/models/connector-config.model.ts` (line 307) — Change enum from `['full', 'simplified', 'disabled']` to `['enabled', 'disabled']`
- `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` (line 22) — Change `PermissionCrawlConfig.mode` type from `'full' | 'simplified' | 'disabled'` to `'enabled' | 'disabled'`
- `packages/connectors/sharepoint/src/sharepoint-connector.ts` (line 261) — Update `crawlPermissions()` method signature and logic to use `'enabled' | 'disabled'`

### Files to Create

- None

### Function Signatures

**Before:**

```ts
// connector.service.ts line 154
function resolveScopes(authMethod: string, permissionMode: string): string[]

// connector-config.model.ts line 307
mode: { type: String, enum: ['full', 'simplified', 'disabled'], default: 'disabled' }

// sharepoint-permission-crawler.ts line 22
export interface PermissionCrawlConfig {
  mode: 'full' | 'simplified' | 'disabled';
  ...
}

// sharepoint-connector.ts line 261
async crawlPermissions(mode: 'full' | 'simplified' | 'disabled'): Promise<PermissionCrawlResult>
```

**After:**

```ts
// connector.service.ts
function resolveScopes(authMethod: string, permissionMode: string): string[]
// Returns:
//   client_credentials → ['https://graph.microsoft.com/.default']
//   enabled → ['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access']
//   disabled → ['Sites.Read.All', 'Files.Read.All', 'offline_access']

// connector-config.model.ts
mode: { type: String, enum: ['enabled', 'disabled'], default: 'disabled' }

// sharepoint-permission-crawler.ts
export interface PermissionCrawlConfig {
  mode: 'enabled' | 'disabled';
  ...
}

// sharepoint-connector.ts
async crawlPermissions(mode: 'enabled' | 'disabled'): Promise<PermissionCrawlResult>
```

### Subtasks (execution order)

1. **ST-01.1:** Update `permissionConfig.mode` enum in `connector-config.model.ts` from `['full', 'simplified', 'disabled']` to `['enabled', 'disabled']`. Update the `IConnectorConfig.permissionConfig.mode` type to `'enabled' | 'disabled'`.
2. **ST-01.2:** Update `PermissionCrawlConfig.mode` type in `sharepoint-permission-crawler.ts` to `'enabled' | 'disabled'`. Update `crawlDocuments()` method (line 78): map `'enabled'` to the full resolution behavior (formerly `'full'`), `'disabled'` to the skip behavior.
3. **ST-01.3:** Update `crawlPermissions()` in `sharepoint-connector.ts` (line 261) to accept `'enabled' | 'disabled'`. When `'enabled'`, always use full group member resolution (the "simplified" mode that stored group IDs without expansion was a half-measure that created permission inconsistencies).
4. **ST-01.4:** Fix `resolveScopes()` in `connector.service.ts`: replace `Sites.FullControl.All` with `Sites.Read.All`, add `Files.Read.All`, add `GroupMember.Read.All` when `permissionMode === 'enabled'`, remove the `'simplified'` branch. Update the call site at line 406 to pass the new mode values.
5. **ST-01.5:** Write a data migration script (or document the migration) for existing connectors in MongoDB that have `permissionConfig.mode === 'full'` or `'simplified'` — map `'full'` → `'enabled'`, `'simplified'` → `'enabled'`.

### Acceptance Criteria

- AC-01: Given a connector with `permissionMode: 'enabled'` and `authMethod: 'device_code'`, when `resolveScopes()` is called, then it returns `['Sites.Read.All', 'Files.Read.All', 'GroupMember.Read.All', 'offline_access']`.
  - Verify: Unit test asserting scope array
  - Expected: No `FullControl.All` in any returned scope array
- AC-02: Given a connector with `permissionMode: 'disabled'`, when `resolveScopes()` is called, then it returns `['Sites.Read.All', 'Files.Read.All', 'offline_access']` (no `GroupMember.Read.All`).
  - Verify: Unit test asserting scope array
  - Expected: `GroupMember.Read.All` absent
- AC-03: `pnpm build --filter=@agent-platform/connector-sharepoint --filter=@agent-platform/database` compiles with no type errors.
  - Verify: `pnpm build --filter=@agent-platform/connector-sharepoint --filter=@agent-platform/database`
  - Expected: Exit code 0
- AC-04: The string `"simplified"` does not appear in `connector-config.model.ts` enum or `PermissionCrawlConfig` type.
  - Verify: `grep -r '"simplified"' packages/database/src/models/connector-config.model.ts packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts`
  - Expected: No matches

### Dependencies

- None

### Risk Notes

- Existing connectors in MongoDB may have `mode: 'full'` or `mode: 'simplified'`. The Mongoose enum validation will reject reads of documents with stale values unless a migration runs first. **Mitigation:** Run ST-01.5 migration before deploying the schema change. Alternatively, temporarily keep the old values in the enum during transition and add a migration job.
- Changing scopes from `FullControl.All` to `Read.All` means existing OAuth tokens may have been granted the old scopes. Re-authentication is not required — the narrower scope is a subset. However, if admin consent was granted for `FullControl.All` specifically, the new scope request may trigger a new consent prompt.

---

## Task T-02: Fix pauseSync()/resumeSync() Implementation

### Problem

The `pauseSync()` and `resumeSync()` methods on `SharePointConnector` (at `packages/connectors/sharepoint/src/sharepoint-connector.ts` lines 242-253) throw `'not implemented yet (Phase 2)'`. However, the **service layer** at `apps/search-ai/src/services/connector.service.ts` (lines 981-1029) already has working implementations that set `errorState.isPaused` flags and enqueue BullMQ resume jobs. The disconnect is that the `SharePointConnector` class methods are never called by the service layer — the service operates on the model directly.

The service-layer `pauseSync()` (line 981) sets the flag but does NOT signal the running sync job to stop. The `stopSync()` (line 960) publishes a Redis signal on channel `connector-sync:{jobId}:cancel`, but `pauseSync()` does not.

The service-layer `resumeSync()` (line 1000) enqueues a new BullMQ job with `resumeFromCheckpoint: true`, but the sync worker may not honor this flag — the `SharePointConnector.performFullSync()` needs to accept a checkpoint and resume from it.

### Files to Modify

- `apps/search-ai/src/services/connector.service.ts` (lines 981-1029) — Add Redis cancel signal to `pauseSync()`, verify `resumeSync()` checkpoint handling
- `packages/connectors/sharepoint/src/sharepoint-connector.ts` (lines 242-253) — Implement real `pauseSync()`/`resumeSync()` that coordinate with the sync coordinator's checkpoint

### Function Signatures

**Before (service layer, line 981):**

```ts
export async function pauseSync(
  connectorId: string,
  tenantId: string,
  reason?: string,
): Promise<{ paused: boolean; reason: string }>;
```

**After (service layer):**

```ts
export async function pauseSync(
  connectorId: string,
  tenantId: string,
  reason?: string,
): Promise<{ paused: boolean; reason: string }>;
// Now also publishes Redis cancel signal to stop in-flight sync
```

**Before (connector class, line 242):**

```ts
async pauseSync(jobId: string): Promise<void> {
  throw new Error('Pause sync not implemented yet (Phase 2)');
}
```

**After (connector class):**

```ts
async pauseSync(jobId: string): Promise<void> {
  // Saves checkpoint via fullSyncCoordinator.saveCheckpoint()
  // Sets a cancellation flag that the sync loop checks
}
```

### Subtasks (execution order)

1. **ST-02.1:** In `connector.service.ts` `pauseSync()` (line 981): after setting `errorState.isPaused`, publish a Redis cancel signal on channel `connector-sync:{currentJobId}:cancel` (same pattern as `stopSync()` at line 975). This tells the running sync worker to stop at the next safe checkpoint.
2. **ST-02.2:** In `SharePointConnector.pauseSync()` (line 242): implement checkpoint saving. Call `this.fullSyncCoordinator.saveCheckpoint()` (if the coordinator exposes this method) or set a cancellation flag that the sync loop checks between document batches.
3. **ST-02.3:** In `SharePointConnector.resumeSync()` (line 250): implement resume by loading the saved checkpoint and delegating to `this.fullSyncCoordinator.performSync('full', checkpoint)`.
4. **ST-02.4:** Verify the sync worker (`apps/search-ai/src/workers/connector-sync-worker.ts`) respects the `resumeFromCheckpoint: true` flag in the job data by loading checkpoint data from `ConnectorConfig.syncState.checkpointData`.

### Acceptance Criteria

- AC-01: Given a connector with an active sync job, when `POST /connectors/:connectorId/sync/pause` is called, then `errorState.isPaused` is set to `true` AND a Redis cancel signal is published.
  - Verify: Integration test hitting the pause route, checking DB state and Redis publish
  - Expected: `isPaused === true`, Redis signal published
- AC-02: Given a paused connector with checkpoint data, when `POST /connectors/:connectorId/sync/resume` is called, then a BullMQ job is enqueued with `resumeFromCheckpoint: true`.
  - Verify: Integration test checking BullMQ queue after resume
  - Expected: Job added with correct data

### Dependencies

- None

### Risk Notes

- The pause/resume mechanism depends on the sync coordinator cooperating with cancellation signals. If the sync coordinator does not check for cancellation between document batches, the pause will only take effect after the current batch completes. This is acceptable for v1.
- Resume creates a new BullMQ job rather than resuming the original. This means the job ID changes after pause/resume, which must be reflected in `syncState.currentJobId`.

---

## Task T-03: Move OAuth State from Pod-Local to Redis

### Problem

The HLD identifies "Pod-local OAuth state store" as bug B8, violating the Stateless Distributed invariant. However, inspecting the actual code at `apps/search-ai/src/services/connector.service.ts` (lines 64-93), the device code sessions are **already stored in Redis** using `DEVICE_CODE_KEY_PREFIX = 'oauth:device:'` with `setex` (TTL-based expiry).

The authorization code flow (line 437-462) also stores its state in Redis via `storeDeviceCodeSession()` (reusing the same Redis-based function for auth code state).

**The actual bug is different from what the HLD describes.** The OAuth state is already in Redis. The real issue is:

1. **The `state` parameter for authorization_code flow** (line 440) is generated as `{connectorId}:{random}` and stored in Redis via the `storeDeviceCodeSession` function, but the key is `oauth:device:{connectorId}` — this is correct since it is keyed by connectorId and uses Redis.
2. **The `getConnectorRedirectUri()` function** (line 97-106) constructs the redirect URI from `process.env.FRONTEND_URL`. If different pods have different values for this env var (unlikely but possible in misconfigured deployments), the callback would fail.
3. **The actual concern** is that the `storeDeviceCodeSession` uses a single lazy Redis instance (`deviceCodeRedis` at line 65) that is initialized once per process. If the Redis connection drops, there is no reconnection logic or health check.

Given the code already uses Redis, this task should be reclassified as a **hardening task** rather than a migration.

### Files to Modify

- `apps/search-ai/src/services/connector.service.ts` (lines 64-93) — Add reconnection handling and key prefix namespacing

### Files to Create

- None

### Subtasks (execution order)

1. **ST-03.1:** Audit the Redis connection at line 65-72. The `getDeviceCodeRedis()` function creates a new `Redis` instance from `getRedisConnection()`. Verify this reuses the shared connection pool rather than creating a standalone connection. If standalone, refactor to use the shared pool.
2. **ST-03.2:** Keep existing `oauth:device:` prefix. Cosmetic rename is low value relative to the risk of breaking in-flight sessions. If rename is desired later, add a transition period that reads from both prefixes.
3. **ST-03.3:** Add a `SET NX PX` guard to `storeDeviceCodeSession()` to prevent overwriting an in-flight auth session for the same connector (race condition if a user clicks "Connect" twice rapidly).
4. **ST-03.4:** Add error handling to `getDeviceCodeSession()` and `storeDeviceCodeSession()` — catch Redis connection errors and throw a `ConnectorError` with code `'REDIS_UNAVAILABLE'` rather than an unhandled promise rejection.

### Acceptance Criteria

- AC-01: OAuth state is stored in Redis (already true; verify no pod-local Maps exist).
  - Verify: `grep -n 'new Map\|Map<string' apps/search-ai/src/services/connector.service.ts | grep -i 'auth\|state\|session'`
  - Expected: No matches (no pod-local Maps for auth state)
- AC-02: The `SET NX PX` guard prevents overwriting an in-flight auth session.
  - Verify: Unit test calling `storeDeviceCodeSession()` twice for the same connectorId — second call should fail or return a conflict indicator
  - Expected: Second call is rejected or warned
- AC-03: Redis connection errors in auth state operations are caught and wrapped in `ConnectorError`.
  - Verify: Unit test with mocked Redis that throws on `setex()`
  - Expected: `ConnectorError` with code `'REDIS_UNAVAILABLE'`

### Dependencies

- None

### Risk Notes

- The scope of this task has been reduced from a "migration" to a "hardening" since OAuth state is already in Redis. The HLD description was based on an assumption that has since been disproven by code inspection.

---

## Task T-04: Register ConnectorSchema + FieldMapping with ModelRegistry

### Problem

`ConnectorSchema` (at `packages/database/src/models/connector-schema.model.ts` lines 84-88) and `FieldMapping` (at `packages/database/src/models/field-mapping.model.ts` lines 95-98) are exported as Mongoose models but are NOT registered with `ModelRegistry`. All other SearchAI models (e.g., `ConnectorConfig` at line 389, `AuditLog` at line 65 of its model file) call `ModelRegistry.registerModelDefinition()`.

Without registration, `ModelRegistry.bindModelsForSearchAI()` (which binds models to the correct database connection in the dual-database architecture) does not include these models. They fall back to the default Mongoose connection, which may not be the intended `platform` database in the SearchAI service.

### Files to Modify

- `packages/database/src/models/connector-schema.model.ts` (between lines 82 and 84) — Add `ModelRegistry` import and registration call
- `packages/database/src/models/field-mapping.model.ts` (between lines 93 and 95) — Add `ModelRegistry` import and registration call

### Files to Create

- None

### Subtasks (execution order)

1. **ST-04.1:** In `connector-schema.model.ts`, add `import { ModelRegistry } from '../model-registry.js';` at the top (after line 8, alongside the existing imports). Before the model export (line 84), add: `ModelRegistry.registerModelDefinition('ConnectorSchema', ConnectorSchemaSchema, 'platform');`
2. **ST-04.2:** In `field-mapping.model.ts`, add `import { ModelRegistry } from '../model-registry.js';` at the top. Before the model export (line 95), add: `ModelRegistry.registerModelDefinition('FieldMapping', FieldMappingSchema, 'platform');`
3. **ST-04.3:** Build the database package: `pnpm build --filter=@agent-platform/database`.

### Acceptance Criteria

- AC-01: `ConnectorSchema` appears in `ModelRegistry.getPlatformModels()` output.
  - Verify: Unit test importing `ModelRegistry` and checking `getPlatformModels()` includes `'ConnectorSchema'`
  - Expected: `getPlatformModels().some(m => m.name === 'ConnectorSchema')` is `true`
- AC-02: `FieldMapping` appears in `ModelRegistry.getPlatformModels()` output.
  - Verify: Same pattern as AC-01
  - Expected: `getPlatformModels().some(m => m.name === 'FieldMapping')` is `true`
- AC-03: `pnpm build --filter=@agent-platform/database` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/database`
  - Expected: Exit code 0

### Dependencies

- None

### Risk Notes

- Minimal risk. This is an additive registration that does not change behavior for Runtime or Studio (they use the default Mongoose connection). It only affects SearchAI's dual-database binding.

---

## Task T-05: Fix Permission Crawler (Group ID, grantedToV2, getDrivePermissions)

### Problem

Three bugs in the SharePoint permission crawler at `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts`:

**Bug B2 — SharePoint group ID != Azure AD group ID (line 178):**
The crawler stores group IDs as `sharepoint:{group.id}` where `group.id` comes from `perm.grantedToV2.group.id`. SharePoint permission entries return SharePoint-internal group IDs, NOT Azure AD group IDs. When the crawler calls `getGroupMembers(groupId)` at line 238, it passes this SharePoint group ID to the Microsoft Graph API endpoint `/groups/{groupId}/members`, which expects an Azure AD group ID. This results in 404 errors for all group member resolution.

**Bug B3 — `grantedToV2.group` often not populated (line 172):**
The crawler checks `perm.grantedToV2?.group` but SharePoint permissions often use `grantedToIdentitiesV2` (plural) instead of `grantedToV2`. Additionally, when `grantedToV2.group` is present, the `displayName` and `email` fields may be null for SharePoint groups (as opposed to Azure AD security groups). The crawler does not handle these null cases.

**Bug B4 — `getDrivePermissions()` defined but never called (graph-client.ts line 352):**
The `GraphClient.getDrivePermissions()` method exists but the permission crawler only calls `getItemPermissions()` (line 121). Drive-level permissions (inherited by all items in the drive) are never crawled, meaning some users who have access via drive-level sharing are missed.

### Files to Modify

- `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` (lines 119-231, 236-238) — Fix group ID mapping, handle null grantedToV2 fields, add drive permission crawling
- `packages/connectors/sharepoint/src/client/graph-client.ts` — No changes needed (getDrivePermissions already correct)
- `packages/connectors/sharepoint/src/client/graph-types.ts` (line 96) — Verify `Permission` type includes `grantedToIdentitiesV2` as alternative field

### Subtasks (execution order)

1. **ST-05.1:** In `graph-types.ts`, extend the `Permission` interface (line 93) to include `grantedToIdentitiesV2` as an optional field with the same shape as `grantedToV2`. Microsoft Graph API may return either field depending on the API version.
2. **ST-05.2:** In `sharepoint-permission-crawler.ts`, update `processPermission()` (line 144) to check both `perm.grantedToV2` and `perm.grantedToIdentitiesV2`, preferring `V2` when present.
3. **ST-05.3:** Fix group ID mapping (line 178). When a group permission is found, attempt to resolve the Azure AD group ID by calling `graphClient.getGroupByDisplayName()` or by using the group's email address to look up the Azure AD group via `GET /groups?$filter=mail eq '{email}'`. Store the resolved Azure AD group ID instead of the SharePoint-internal ID. Fall back to `sharepoint:{group.id}` if resolution fails (with a warning log).
4. **ST-05.4:** Handle null `displayName` and `email` on group objects (line 173). Use defensive defaults: `displayName: group.displayName || group.id`, `email: group.email || undefined`.
5. **ST-05.5:** In `crawlDocument()` (line 119), after crawling item permissions, also crawl drive-level permissions using `this.graphClient.getDrivePermissions(doc.driveId)`. Process each drive permission through `processPermission()`. De-duplicate with item-level permissions (a user granted access at both drive and item level should not be double-counted).
6. **ST-05.6:** Add a `resolveAzureADGroupId()` private method that caches SharePoint-to-AzureAD group ID mappings for the duration of the crawl (in-memory Map with max 10,000 entries, 1-hour TTL per entry, LRU eviction).

### Acceptance Criteria

- AC-01: Given a document with a SharePoint group permission where the group has an email, when the crawler processes it, then it resolves the Azure AD group ID and stores it (not the SharePoint-internal ID).
  - Verify: Unit test with mocked Graph API returning a group with email, then a `/groups?$filter=mail eq` call returning the Azure AD group
  - Expected: `upsertGroup()` called with Azure AD group ID
- AC-02: Given a permission entry with `grantedToV2.group` where `displayName` is null, the crawler does not throw.
  - Verify: Unit test with null `displayName`
  - Expected: Falls back to `group.id` as display name
- AC-03: Given a document in a drive with drive-level permissions, both item-level and drive-level permissions are crawled.
  - Verify: Unit test checking both `getItemPermissions()` and `getDrivePermissions()` are called
  - Expected: Both called, results merged without duplicates
- AC-04: `pnpm build --filter=@agent-platform/connector-sharepoint` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/connector-sharepoint`
  - Expected: Exit code 0

### Dependencies

- T-01 (permission mode rename) — T-05 references `PermissionCrawlConfig.mode` which T-01 renames. Execute T-01 first, or coordinate the type change.

### Risk Notes

- The Azure AD group ID resolution adds extra Graph API calls per group. Cache the results within a single crawl run (ST-05.6) to avoid redundant lookups. Rate limiting in `GraphClient` (16.67 req/sec default) applies.
- Some SharePoint groups may not have an `email` field and may not be resolvable to Azure AD groups (e.g., SharePoint-only groups). The fallback to `sharepoint:{id}` ensures these are not silently dropped.

---

## Task T-06: Create ConnectorAuditEntry Model + Audit Log Routes

### Problem

The design requires an immutable audit trail for all connector operations (auth, config changes, sync start/stop, permission changes). No `ConnectorAuditEntry` model or audit log routes exist today. The existing `AuditLog` model at `packages/database/src/models/audit-log.model.ts` is a generic platform audit log, not connector-specific.

### Files to Modify

- `packages/database/src/index.ts` (add export for new model)

### Files to Create

- `packages/database/src/models/connector-audit-entry.model.ts` — Mongoose model
- `apps/search-ai/src/services/connector-audit.service.ts` — Service for writing and querying audit entries
- `apps/search-ai/src/routes/connector-audit.ts` — Express routes

### Model Schema

```ts
// connector-audit-entry.model.ts

export interface IConnectorAuditEntry {
  _id: string;
  connectorId: string;
  tenantId: string;
  timestamp: Date;
  actor: string; // email or "system"
  actorType: 'user' | 'system';
  event: string; // e.g., "auth.initiated", "config.updated", "sync.started", "permission.disabled"
  category: 'auth' | 'config' | 'sync' | 'permission' | 'lifecycle';
  metadata: Record<string, unknown>;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Schema
const ConnectorAuditEntrySchema = new Schema<IConnectorAuditEntry>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    actor: { type: String, required: true },
    actorType: { type: String, enum: ['user', 'system'], required: true, default: 'user' },
    event: { type: String, required: true },
    category: {
      type: String,
      enum: ['auth', 'config', 'sync', 'permission', 'lifecycle'],
      required: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_audit_entries' },
);

// Indexes
ConnectorAuditEntrySchema.index({ tenantId: 1, connectorId: 1, timestamp: -1 }); // Primary query pattern
ConnectorAuditEntrySchema.index({ tenantId: 1, timestamp: -1 }); // Tenant-wide audit
ConnectorAuditEntrySchema.index({ tenantId: 1, connectorId: 1, category: 1, timestamp: -1 }); // Filtered queries
ConnectorAuditEntrySchema.index({ tenantId: 1, event: 1, timestamp: -1 }); // Event-type queries

// Plugins
ConnectorAuditEntrySchema.plugin(tenantIsolationPlugin);

// Registry
ModelRegistry.registerModelDefinition('ConnectorAuditEntry', ConnectorAuditEntrySchema, 'platform');

// Export (hot-reload safe pattern)
export const ConnectorAuditEntry =
  (mongoose.models.ConnectorAuditEntry as mongoose.Model<IConnectorAuditEntry>) ||
  model<IConnectorAuditEntry>('ConnectorAuditEntry', ConnectorAuditEntrySchema);
```

### Service Signatures

```ts
// connector-audit.service.ts

export async function writeAuditEntry(params: {
  connectorId: string;
  tenantId: string;
  actor: string;
  actorType: 'user' | 'system';
  event: string;
  category: 'auth' | 'config' | 'sync' | 'permission' | 'lifecycle';
  metadata?: Record<string, unknown>;
}): Promise<IConnectorAuditEntry>;

export async function getAuditLog(
  connectorId: string,
  tenantId: string,
  options: {
    category?: string;
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  },
): Promise<{ entries: IConnectorAuditEntry[]; total: number; page: number; limit: number }>;

export async function exportAuditLog(
  connectorId: string,
  tenantId: string,
  format: 'json' | 'csv',
): Promise<{ data: string; contentType: string; filename: string }>;
```

### Validation Schemas

```ts
// Zod schemas for route parameter/query validation
const connectorIdParam = z.object({ connectorId: z.string().min(1) });
const auditLogQuery = z.object({
  category: z.enum(['auth', 'config', 'sync', 'permission', 'lifecycle']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});
const exportFormatQuery = z.object({
  format: z.enum(['json', 'csv']),
});
```

### Route Definitions

```
GET  /:indexId/connectors/:connectorId/audit-log
     Query: ?category=auth&page=1&limit=50&startDate=...&endDate=...
     Response: { success: true, data: { entries, total, page, limit } }

GET  /:indexId/connectors/:connectorId/audit-log/export
     Query: ?format=json|csv
     Response: File download (application/json or text/csv)
```

### Subtasks (execution order)

1. **ST-06.1:** Create `connector-audit-entry.model.ts` with schema, indexes, plugin, and ModelRegistry registration. Export from `packages/database/src/index.ts`.
2. **ST-06.2:** Create `connector-audit.service.ts` with `writeAuditEntry()`, `getAuditLog()`, and `exportAuditLog()`. All queries must include `tenantId` in the filter (tenant isolation).
3. **ST-06.3:** Create `connector-audit.ts` routes. Mount under the connector routes. Use `authMiddleware` (already applied on the parent router). Extract `actor` from the authenticated request: `const actor = req.tenantContext?.email ?? req.tenantContext?.userId ?? 'system';` and `actorType` as `req.tenantContext ? 'user' : 'system'`. Follow the `handleError()` pattern from `connectors.ts` (lines 23-37) for error handling — `ConnectorError`-aware handler that returns `{ success: false, error: { code, message } }`.
4. **ST-06.4:** Validate all route params/query with Zod `.safeParse()` — return 400 with validation errors on failure.
5. **ST-06.5:** In `apps/search-ai/src/server.ts`, import `connectorAuditRouter` from `'./routes/connector-audit.js'` and mount with `app.use('/api/indexes', connectorAuditRouter);` after the existing connector route mounts (line ~177).
6. **ST-06.6:** Export `ConnectorAuditEntry` model and `IConnectorAuditEntry` type from `packages/database/src/index.ts`.
7. **ST-06.7:** Build: `pnpm build --filter=@agent-platform/database --filter=search-ai`.

### Acceptance Criteria

- AC-01: `ConnectorAuditEntry` is registered with ModelRegistry as `'platform'` affinity.
  - Verify: `ModelRegistry.getPlatformModels().some(m => m.name === 'ConnectorAuditEntry')`
  - Expected: `true`
- AC-02: `writeAuditEntry()` creates a document with all required fields and scopes it to `tenantId`.
  - Verify: Unit test calling `writeAuditEntry()` and reading back from the collection
  - Expected: Document contains `connectorId`, `tenantId`, `event`, `actor`, `timestamp`
- AC-03: `getAuditLog()` returns paginated results filtered by `connectorId` AND `tenantId`.
  - Verify: Unit test inserting entries for two tenants, querying for one
  - Expected: Only entries for the queried tenant returned
- AC-04: `GET /:indexId/connectors/:connectorId/audit-log` returns paginated audit entries.
  - Verify: Integration test hitting the route
  - Expected: 200 with `{ success: true, data: { entries: [...], total, page, limit } }`

### Dependencies

- None

### Risk Notes

- The audit log is append-only. No delete or update operations are exposed. This is intentional for compliance.
- Consider adding a TTL index or retention policy in a future task to prevent unbounded growth (HLD Risk R6).
- **Scoping note:** Connector scope is defined by tenantId + connectorId. Project-level scoping is not applicable as connectors are tenant-scoped resources accessed via indexId.

---

## Task T-07: Create ConnectorConfigVersion Model + Version Routes

### Problem

The design requires config version history with snapshots, diffs, and restore capability. No `ConnectorConfigVersion` model exists. Every config change should create a new version snapshot.

### Files to Modify

- `packages/database/src/index.ts` (add export for new model)

### Files to Create

- `packages/database/src/models/connector-config-version.model.ts` — Mongoose model
- `apps/search-ai/src/services/connector-config-version.service.ts` — Service for version CRUD
- `apps/search-ai/src/routes/connector-config-versions.ts` — Express routes

### Model Schema

```ts
// connector-config-version.model.ts

export interface IConnectorConfigVersion {
  _id: string;
  connectorId: string;
  tenantId: string;
  version: number; // Auto-incrementing integer (1, 2, 3, ...)
  configSnapshot: Record<string, unknown>; // Full config at this version
  changedFields: string[]; // List of top-level fields that changed (e.g., ["filterConfig", "permissionConfig"])
  changedBy: string; // User email or "system"
  changeSource: 'user' | 'system' | 'import' | 'restore'; // What triggered the change
  summary: string; // Human-readable description (e.g., "Updated file type filters")
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Schema
const ConnectorConfigVersionSchema = new Schema<IConnectorConfigVersion>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    version: { type: Number, required: true },
    configSnapshot: { type: Schema.Types.Mixed, required: true },
    changedFields: { type: [String], default: [] },
    changedBy: { type: String, required: true },
    changeSource: {
      type: String,
      enum: ['user', 'system', 'import', 'restore'],
      default: 'user',
    },
    summary: { type: String, default: '' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_config_versions' },
);

// Indexes
ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: -1 }); // Primary query: latest version first
ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: 1 }, { unique: true }); // Unique version per connector per tenant (optimistic concurrency guard)

// Plugins
ConnectorConfigVersionSchema.plugin(tenantIsolationPlugin);

// Registry
ModelRegistry.registerModelDefinition(
  'ConnectorConfigVersion',
  ConnectorConfigVersionSchema,
  'platform',
);

// Export (hot-reload safe pattern)
export const ConnectorConfigVersion =
  (mongoose.models.ConnectorConfigVersion as mongoose.Model<IConnectorConfigVersion>) ||
  model<IConnectorConfigVersion>('ConnectorConfigVersion', ConnectorConfigVersionSchema);
```

### Service Signatures

```ts
// connector-config-version.service.ts

export async function createVersion(params: {
  connectorId: string;
  tenantId: string;
  configSnapshot: Record<string, unknown>;
  changedFields: string[];
  changedBy: string;
  changeSource: 'user' | 'system' | 'import' | 'restore';
  summary: string;
}): Promise<IConnectorConfigVersion>;

export async function getVersionHistory(
  connectorId: string,
  tenantId: string,
  options: { page?: number; limit?: number },
): Promise<{ versions: IConnectorConfigVersion[]; total: number; page: number; limit: number }>;

export async function getVersionSnapshot(
  connectorId: string,
  tenantId: string,
  versionNumber: number,
): Promise<IConnectorConfigVersion | null>;

export async function getLatestVersion(connectorId: string, tenantId: string): Promise<number>;
```

### Validation Schemas

```ts
// Zod schemas for route parameter/query validation
const versionParams = z.object({
  connectorId: z.string().min(1),
  versionNumber: z.coerce.number().int().positive(),
});
const diffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});
```

### Route Definitions

```
GET  /:indexId/connectors/:connectorId/config/versions
     Query: ?page=1&limit=20
     Response: { success: true, data: { versions, total, page, limit } }

GET  /:indexId/connectors/:connectorId/config/versions/:versionNumber
     Response: { success: true, data: { version } }
```

### Subtasks (execution order)

1. **ST-07.1:** Create `connector-config-version.model.ts` with schema, indexes, plugin, and ModelRegistry registration. Export from `packages/database/src/index.ts`.
2. **ST-07.2:** Create `connector-config-version.service.ts` with `createVersion()`, `getVersionHistory()`, `getVersionSnapshot()`, `getLatestVersion()`. The `createVersion()` auto-increments the version number by reading `getLatestVersion() + 1`.
3. **ST-07.3:** Create `connector-config-versions.ts` routes. Follow the `handleError()` pattern from `connectors.ts` (lines 23-37) for error handling.
4. **ST-07.4:** Validate all route params/query with Zod `.safeParse()` — return 400 with validation errors on failure.
5. **ST-07.5:** In `apps/search-ai/src/server.ts`, import `connectorConfigVersionRouter` from `'./routes/connector-config-versions.js'` and mount with `app.use('/api/indexes', connectorConfigVersionRouter);` after the existing connector route mounts.
6. **ST-07.6:** Export `ConnectorConfigVersion` model and `IConnectorConfigVersion` type from `packages/database/src/index.ts`.
7. **ST-07.7:** Build: `pnpm build --filter=@agent-platform/database --filter=search-ai`.

### Acceptance Criteria

- AC-01: `ConnectorConfigVersion` is registered with ModelRegistry.
  - Verify: `ModelRegistry.getPlatformModels().some(m => m.name === 'ConnectorConfigVersion')`
  - Expected: `true`
- AC-02: `createVersion()` auto-increments the version number.
  - Verify: Unit test creating two versions for the same connector
  - Expected: First version is 1, second is 2
- AC-03: `getVersionHistory()` returns results scoped to `tenantId` AND `connectorId`, ordered by version descending.
  - Verify: Unit test with entries for two connectors, querying for one
  - Expected: Only matching connector's versions returned, newest first
- AC-04: Version number uniqueness constraint prevents duplicate versions for the same connector.
  - Verify: Unit test attempting to create two versions with the same number
  - Expected: Mongoose duplicate key error

### Dependencies

- None

### Risk Notes

- The `configSnapshot` field stores the full connector config. For large configs this could be significant. Consider compressing with gzip if snapshot sizes exceed 100KB in practice (consistent with `CLAUDE.md` compression-before-storing rule). Defer to a future optimization.
- Version numbers use optimistic concurrency control via the unique compound index `{ tenantId, connectorId, version }`. On concurrent writes, the second write receives a duplicate key error and retries with an incremented version (up to 3 attempts). This is a standard MongoDB pattern — the unique index serves as the concurrency guard.
- **Scoping note:** Connector scope is defined by tenantId + connectorId. Project-level scoping is not applicable as connectors are tenant-scoped resources accessed via indexId.

---

## Task T-08: Create SWR Hooks (useConnector, useConnectorList, useConnectorSync)

### Problem

The frontend has no SWR hooks for connector data. All connector data fetching is done via imperative `fetch()`/`apiFetch()` calls. The existing `useKnowledgeBase` hook at `apps/studio/src/hooks/useKnowledgeBase.ts` demonstrates the SWR pattern used in this project: `useSWR<ResponseType>(keyOrNull)` with the global `swrFetcher` from `apps/studio/src/lib/swr-config.ts`.

### Files to Create

- `apps/studio/src/hooks/useConnector.ts` — Single connector detail
- `apps/studio/src/hooks/useConnectorList.ts` — Connector list with filtering
- `apps/studio/src/hooks/useConnectorSync.ts` — Sync status with polling

### Hook Signatures

```ts
// useConnector.ts

interface ConnectorResponse {
  connector: ConnectorDetail;
}

interface ConnectorDetail {
  _id: string;
  tenantId: string;
  sourceId: string;
  connectorType: string;
  connectionConfig: Record<string, unknown>;
  syncState: {
    lastFullSyncAt: string | null;
    lastDeltaSyncAt: string | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
    syncInProgress: boolean;
    currentJobId: string | null;
    lastSyncError: string | null;
  };
  filterConfig: Record<string, unknown>;
  permissionConfig: {
    mode: 'enabled' | 'disabled';
    crawlSchedule: string | null;
    lastCrawlAt: string | null;
    crawlInProgress: boolean;
    documentsProcessed: number;
    averageAccuracy: number;
    lastCrawlError: string | null;
  };
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: string | null;
    pauseReason: string | null;
  };
  oauthTokenId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UseConnectorReturn {
  connector: ConnectorDetail | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnector(
  indexId: string | null,
  connectorId: string | null,
): UseConnectorReturn;
// SWR key: indexId && connectorId ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}` : null
```

```ts
// useConnectorList.ts

interface ConnectorListResponse {
  connectors: ConnectorDetail[];
  total: number;
}

interface UseConnectorListReturn {
  connectors: ConnectorDetail[];
  total: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorList(indexId: string | null): UseConnectorListReturn;
// SWR key: indexId ? `/api/search-ai/indexes/${indexId}/connectors` : null
```

```ts
// useConnectorSync.ts

interface SyncStatusResponse {
  status: string;
  progress?: {
    docsProcessed: number;
    docsTotal: number;
    percentage: number;
    currentDocument?: string;
  };
}

interface UseConnectorSyncReturn {
  syncStatus: SyncStatusResponse | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorSync(
  connectorId: string | null,
  options?: { pollInterval?: number },
): UseConnectorSyncReturn;
// SWR key: connectorId ? `/api/search-ai/connectors/${connectorId}/sync/status` : null
// Uses refreshInterval for polling (default 5000ms when sync in progress, 0 otherwise)
```

### Cache Invalidation Strategy

```
After auth completion → mutate useConnector + useConnectorList
After config change → mutate useConnector + useConnectorList
After sync start/stop/pause/resume → mutate useConnectorSync + useConnector
After connector delete → mutate useConnectorList
When useConnectorSync detects sync completed (status transitions from 'syncing' to 'active'/'error') → auto-revalidate useConnector

Pattern: Each mutation-triggering API call should call the relevant `mutate()` functions in the calling component. SWR keys are shared across components, so one mutate() refreshes all consumers.
```

### Subtasks (execution order)

1. **ST-08.1:** Create `useConnector.ts` following the `useKnowledgeBase` pattern. Use conditional SWR key (null when IDs are not available). Return memoized values.
2. **ST-08.2:** Create `useConnectorList.ts`. Same pattern.
3. **ST-08.3:** Create `useConnectorSync.ts` with conditional polling via `refreshInterval`. Only poll when the connector has an active sync (determined by the last response's `status` field). Use `useSWR` with `refreshInterval` set dynamically.
4. **ST-08.4:** Build: `pnpm build --filter=studio`.

### Acceptance Criteria

- AC-01: `useConnector(indexId, connectorId)` returns `{ connector, isLoading, error, mutate }`.
  - Verify: Type check passes; `pnpm build --filter=studio`
  - Expected: No type errors
- AC-02: `useConnector(null, null)` does not make any fetch requests (SWR key is null).
  - Verify: Unit test verifying no network call when IDs are null
  - Expected: `fetch` not called
- AC-03: `useConnectorSync` polls at 5s interval when sync is in progress, stops polling when complete.
  - Verify: Unit test with mocked SWR showing `refreshInterval` changes based on status
  - Expected: `refreshInterval` is 5000 during sync, 0 when idle

### Dependencies

- None

### Risk Notes

- The SWR key paths must match the actual backend route paths. The routes use `/:indexId/connectors` for CRUD and `/connectors/:connectorId/` for auth/sync/permissions. Verify exact paths against `apps/search-ai/src/routes/connectors.ts`.

---

## Task T-09: Create Zustand Connector Store

### Problem

No Zustand store exists for connector client-side state. The existing `data-tab-filter-store.ts` at `apps/studio/src/store/data-tab-filter-store.ts` demonstrates the Zustand pattern: `create<State>((set, get) => ({...}))`.

The panel shell needs client-side state for: panel open/close, active connector ID, active tab, Simplified View toggle, expand state, and filter undo history.

### Files to Create

- `apps/studio/src/store/connector-store.ts`

### Store Interface

```ts
// connector-store.ts

import { create } from 'zustand';

type ConnectorTab =
  | 'connect'
  | 'proposal'
  | 'scope-filters'
  | 'preview'
  | 'security'
  | 'history'
  | 'overview';

interface ConnectorStoreState {
  // Panel state
  panelOpen: boolean;
  activeConnectorId: string | null;
  activeTab: ConnectorTab;
  isNewConnector: boolean;

  // View preferences (also persisted to localStorage)
  simplifiedView: boolean;
  expandedPanel: boolean;

  // Actions
  openPanel: (connectorId: string, options?: { isNew?: boolean; tab?: ConnectorTab }) => void;
  closePanel: () => void;
  setActiveTab: (tab: ConnectorTab) => void;
  setSimplifiedView: (enabled: boolean) => void;
  setExpandedPanel: (expanded: boolean) => void;
  resetStore: () => void;
}

const SIMPLIFIED_VIEW_KEY = 'sp-simplified-view';

function getPersistedSimplifiedView(): boolean {
  if (typeof window === 'undefined') return true; // Default ON for SSR
  const stored = localStorage.getItem(SIMPLIFIED_VIEW_KEY);
  return stored === null ? true : stored === 'true'; // Absence = first-time = ON
}

export const useConnectorStore = create<ConnectorStoreState>((set) => ({
  panelOpen: false,
  activeConnectorId: null,
  activeTab: 'connect',
  isNewConnector: false,
  simplifiedView: getPersistedSimplifiedView(),
  expandedPanel: false,

  openPanel: (connectorId, options) =>
    set({
      panelOpen: true,
      activeConnectorId: connectorId,
      activeTab: options?.tab ?? 'connect',
      isNewConnector: options?.isNew ?? false,
      expandedPanel: false, // Reset on open
    }),

  closePanel: () =>
    set({
      panelOpen: false,
      activeConnectorId: null,
      activeTab: 'connect',
      isNewConnector: false,
      expandedPanel: false,
    }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setSimplifiedView: (enabled) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIMPLIFIED_VIEW_KEY, String(enabled));
    }
    set({ simplifiedView: enabled });
  },

  setExpandedPanel: (expanded) => set({ expandedPanel: expanded }),

  resetStore: () =>
    set({
      panelOpen: false,
      activeConnectorId: null,
      activeTab: 'connect',
      isNewConnector: false,
      simplifiedView: getPersistedSimplifiedView(),
      expandedPanel: false,
    }),
}));
```

### Subtasks (execution order)

1. **ST-09.1:** Create `connector-store.ts` with the interface and implementation above. Follow the `data-tab-filter-store.ts` pattern.
2. **ST-09.2:** Add localStorage persistence for `simplifiedView`. Per the design (C-01): "Defaults ON for first-time users. Toggle at top of panel. Persisted per-user via localStorage." Absence of the key = first-time = defaults ON.
3. **ST-09.3:** Build: `pnpm build --filter=studio`.

### Acceptance Criteria

- AC-01: `openPanel('conn-123', { isNew: true, tab: 'connect' })` sets `panelOpen: true`, `activeConnectorId: 'conn-123'`, `activeTab: 'connect'`, `isNewConnector: true`.
  - Verify: Unit test calling `openPanel` and checking state
  - Expected: All fields set correctly
- AC-02: `closePanel()` resets all panel state fields.
  - Verify: Unit test calling `closePanel` after `openPanel`
  - Expected: `panelOpen: false`, `activeConnectorId: null`
- AC-03: `setSimplifiedView(false)` persists to localStorage and updates state.
  - Verify: Unit test with mocked localStorage
  - Expected: `localStorage.setItem` called with `'sp-simplified-view'`, `'false'`
- AC-04: First-time user (no localStorage key) defaults to `simplifiedView: true`.
  - Verify: Unit test with empty localStorage
  - Expected: `simplifiedView === true`

### Dependencies

- None

### Risk Notes

- The store is intentionally simple for Wave 1. Filter undo history, proposal generation polling state, and concurrent editing presence will be added in later waves as those features are built.
- **Atomic selectors advisory:** Consumers should use atomic selectors for frequently-changing state to avoid unnecessary re-renders: `const panelOpen = useConnectorStore(s => s.panelOpen);` rather than destructuring the whole store. This is especially important for `activeTab` which changes on every tab switch.

---

## Task T-10: Create SharePointDetailPanel Shell

### Problem

The current `ConnectorDetailPanel.tsx` (765 lines) and `EnterpriseConnectorWizard.tsx` (595 lines) are being replaced by a unified `SharePointDetailPanel` that serves as both setup and monitoring interface. The shell manages tab routing, expand/collapse, Simplified View toggle, and More Actions menu.

The shell uses the `SlidePanel` design system component (`apps/studio/src/components/ui/SlidePanel.tsx`) which accepts: `open`, `onClose`, `title`, `description`, `children`, `className`, `width` (sm/md/lg/xl). However, the design requires 720px width and full-viewport expand — the existing `SlidePanel` uses max-width classes (sm/md/lg/xl) which don't map to 720px. The shell will need to extend or override the width.

Available design system components (verified): `Tabs` (with `Tab` interface: `{id, label, icon?, count?}`), `DropdownMenu`/`DropdownMenuItem`/`DropdownMenuSeparator`, `Toggle`, `Badge`, `Button`, `Tooltip`.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx` — Panel shell

### Component Interface

```tsx
// SharePointDetailPanel.tsx

interface SharePointDetailPanelProps {
  indexId: string;
  onRefresh: () => void; // Callback to refresh SourcesTable when connector changes
}

// Internal: no props needed, reads from connector store
// Uses: useConnectorStore() for panel state
// Uses: useConnector() for connector data
// Uses: Tabs component for tab bar
// Uses: SlidePanel component as base (extended for custom width)
// Uses: DropdownMenu for More Actions
// Uses: Toggle for Simplified View
```

### Tab Configuration

```ts
const SETUP_TABS: Tab[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'scope-filters', label: 'Scope+Filters' },
  { id: 'preview', label: 'Preview' },
  { id: 'security', label: 'Security' },
  { id: 'history', label: 'History' }, // Full View only
];

const MONITORING_TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'scope-filters', label: 'Scope+Filters' },
  { id: 'security', label: 'Security' },
  { id: 'history', label: 'History' }, // Full View only
];

// Simplified View hides: scope-filters, history
// Tab locking in setup mode: only "connect" is interactive initially
```

### i18n Keys

Namespace: `search_ai.sharepoint` under `packages/i18n/locales/en/studio.json`

Keys (nested under `search_ai.sharepoint`):

- tabs.connect: "Connect"
- tabs.proposal: "Proposal"
- tabs.scopeFilters: "Scope+Filters"
- tabs.preview: "Preview"
- tabs.security: "Security"
- tabs.history: "History"
- tabs.overview: "Overview"
- panel.draft: "(Draft)"
- panel.simplifiedView: "Simplified View"
- panel.expand: "Expand panel"
- panel.collapse: "Collapse panel"
- actions.clone: "Clone"
- actions.exportJson: "Export JSON"
- actions.exportYaml: "Export YAML"
- actions.import: "Import Config"
- actions.healthCheck: "Run Health Check"
- actions.diagnostics: "Diagnostics"
- actions.delete: "Delete"
- placeholder.tabContent: "Tab content — {{wave}}"

Usage: `const t = useTranslations('search_ai.sharepoint');` then `t('tabs.connect')`

Note: Uses `next-intl` — the hook returns the function directly (not destructured `{ t }`).

### Subtasks (execution order)

1. **ST-10.1:** Create `apps/studio/src/components/search-ai/sharepoint/` directory.
2. **ST-10.2:** Create `SharePointDetailPanel.tsx` with the panel shell structure:
   - Render `SlidePanel` with custom width (720px via `className` override or inline style). For the expanded state, use full viewport width with CSS transition (`300ms ease-out`).
   - Header: connector name (from `useConnector`), "(Draft)" suffix when status is draft/awaiting_auth, Simplified View toggle, expand/collapse button, close button.
   - Tab bar: use `Tabs` component. Determine visible tabs based on connector status (setup vs monitoring) and `simplifiedView` state.
   - Tab locking: for setup mode, disabled tabs show a lock icon overlay. Only the `connect` tab is interactive until auth completes.
   - More Actions: `DropdownMenu` with items: Clone, Export JSON/YAML, Import Config, Run Health Check, Diagnostics, Delete. More Actions items for features not yet implemented (Clone, Export, Import, Health Check, Diagnostics) are rendered as disabled menu items with a tooltip: "Available in a future update". Only Delete is functional in Wave 1.
   - Tab content area: renders a placeholder `<div>` per tab (actual tab content components are built in Waves 2-4).
3. **ST-10.3:** Wire the panel to the connector store: read `panelOpen`, `activeConnectorId`, `activeTab`, `simplifiedView`, `expandedPanel` from `useConnectorStore`. Call `closePanel()` on close, `setActiveTab()` on tab change.
4. **ST-10.4:** Implement expand/collapse animation: when `expandedPanel` is true, panel width transitions from 720px to `100vw` with `300ms ease-out`. The `scope-filters` tab auto-expands when activated (per design line 1614). Non-scope-filters tabs collapse back to 720px.
5. **ST-10.5:** Build: `pnpm build --filter=studio`.

### Acceptance Criteria

- AC-01: Panel renders at 720px width when opened, with tab bar and header visible.
  - Verify: Manual visual test or component test checking rendered width
  - Expected: Panel width is 720px
- AC-02: Setup mode (draft connector) shows Connect tab active with other tabs locked.
  - Verify: Component test with connector `status: 'draft'`
  - Expected: Only "Connect" tab is clickable, others show lock icon
- AC-03: Monitoring mode (active connector) shows Overview tab active.
  - Verify: Component test with connector `syncState.syncInProgress: false, errorState.isPaused: false`
  - Expected: "Overview" tab is active
- AC-04: Simplified View toggle hides Scope+Filters and History tabs.
  - Verify: Component test toggling `simplifiedView` to `true`
  - Expected: Only Connect, Proposal, Preview, Security tabs visible
- AC-05: Expand/collapse transitions panel width between 720px and 100vw.
  - Verify: Component test clicking expand button
  - Expected: Width changes, `expandedPanel` state updates
- AC-06: More Actions menu renders all 6 items.
  - Verify: Component test clicking the "..." button
  - Expected: Clone, Export, Import, Health Check, Diagnostics, Delete visible

### Dependencies

- **T-08** (SWR hooks) — `useConnector()` is used to load connector data
- **T-09** (Zustand store) — `useConnectorStore()` is used for panel state

### Risk Notes

- The existing `SlidePanel` component only supports `sm/md/lg/xl` width presets. The 720px requirement may need a custom width prop or CSS override. Preferred approach: pass `className="!max-w-[720px]"` to override. For full-viewport expand, use `className="!max-w-none"` with a CSS transition.
- Tab content is placeholder in Wave 1. Each tab renders a `<div className="p-6 text-muted">{t('placeholder.tabContent', { wave: 'N' })}</div>`.

---

## Task T-11: Create TypeToConfirmInput Reusable Component

### Problem

The design requires a "type to confirm" pattern in multiple places: disabling permission-aware search (type "public access"), deleting connectors, emergency revoke. No reusable component exists.

### Files to Create

- `apps/studio/src/components/ui/TypeToConfirmInput.tsx`

### Component Interface

```tsx
// TypeToConfirmInput.tsx

interface TypeToConfirmInputProps {
  /** The exact text the user must type (case-insensitive match) */
  confirmText: string;
  /** Callback when the user types the correct text */
  onConfirm: () => void;
  /** Callback to cancel */
  onCancel: () => void;
  /** Warning message displayed above the input */
  warningMessage: string;
  /** Bullet list of consequences */
  consequences?: string[];
  /** "Appropriate only when" guidance */
  appropriateWhen?: string[];
  /** Label for the confirm button (default: "Confirm") */
  confirmLabel?: string;
  /** Label for the cancel button (default: "Cancel") */
  cancelLabel?: string;
  /** Variant for styling (default: "danger") */
  variant?: 'danger' | 'warning';
  /** Whether the component is in a loading state */
  loading?: boolean;
}

export function TypeToConfirmInput({
  confirmText,
  onConfirm,
  onCancel,
  warningMessage,
  consequences,
  appropriateWhen,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
}: TypeToConfirmInputProps): React.ReactElement;
```

### Behavior

1. Renders a warning block with `warningMessage`, optional `consequences` list, optional `appropriateWhen` list.
2. Text input with placeholder: `Type "${confirmText}" to confirm`.
3. Confirm button is disabled until the input matches `confirmText` (case-insensitive). The button uses `variant="danger"` styling.
4. Cancel button is always enabled.
5. Uses existing `Input` and `Button` design system components.

### i18n Keys

Keys:

Namespace: `search_ai.type_to_confirm` under `packages/i18n/locales/en/studio.json`

- placeholder: "Type \"{{text}}\" to confirm"
- confirm: "Confirm"
- cancel: "Cancel"

Note: T-11 receives these as props with English defaults. Parent components use `const t = useTranslations('search_ai.type_to_confirm');` and pass `confirmLabel={t('confirm')}` etc.

### Subtasks (execution order)

1. **ST-11.1:** Create `TypeToConfirmInput.tsx` with the interface above. Use `Input` from `../ui/Input` and `Button` from `../ui/Button`.
2. **ST-11.2:** Implement case-insensitive matching: `inputValue.toLowerCase().trim() === confirmText.toLowerCase()`.
3. **ST-11.3:** Build: `pnpm build --filter=studio`.

### Acceptance Criteria

- AC-01: Confirm button is disabled when input does not match `confirmText`.
  - Verify: Component test rendering with `confirmText="public access"`, typing "wrong text"
  - Expected: Button is disabled (has `disabled` attribute)
- AC-02: Confirm button is enabled when input matches `confirmText` (case-insensitive).
  - Verify: Component test typing "Public Access" (mixed case)
  - Expected: Button is enabled, clicking it calls `onConfirm`
- AC-03: `onCancel` is called when Cancel button is clicked.
  - Verify: Component test clicking Cancel
  - Expected: `onCancel` callback invoked
- AC-04: Consequences list renders as bullet points when provided.
  - Verify: Component test with `consequences={['Risk 1', 'Risk 2']}`
  - Expected: Two `<li>` elements in the DOM

### Dependencies

- None

### Risk Notes

- None. This is a self-contained UI component with no backend dependencies.

---

## Task T-12: Remove Orphaned ConnectorsTab.tsx

### Problem

`ConnectorsTab.tsx` at `apps/studio/src/components/search-ai/ConnectorsTab.tsx` (647 lines) is not used in any layout or routing. The HLD inventory marks it as "ORPHANED — Not in layout; can be removed." It imports `EnterpriseConnectorWizard` and `ConnectorDetailPanel` which are being replaced, making it a source of confusion.

### Files to Modify

- `apps/studio/src/components/search-ai/ConnectorsTab.tsx` — DELETE this file

### Subtasks (execution order)

1. **ST-12.1:** Verify no imports reference `ConnectorsTab`:
   ```
   grep -r 'ConnectorsTab' apps/studio/src/ --include='*.ts' --include='*.tsx'
   ```
   Expected: Only the file itself and possibly this LLD or design docs.
2. **ST-12.2:** Delete `apps/studio/src/components/search-ai/ConnectorsTab.tsx`.
3. **ST-12.3:** Build: `pnpm build --filter=studio` to confirm no broken imports.

### Acceptance Criteria

- AC-01: `ConnectorsTab.tsx` no longer exists in the codebase.
  - Verify: `ls apps/studio/src/components/search-ai/ConnectorsTab.tsx`
  - Expected: "No such file or directory"
- AC-02: `pnpm build --filter=studio` succeeds (no broken imports).
  - Verify: `pnpm build --filter=studio`
  - Expected: Exit code 0

### Dependencies

- None

### Risk Notes

- Minimal risk. The file is confirmed orphaned. However, verify with `grep` before deleting to catch any dynamic imports or string references.

---

## Task Independence Matrix

**Note:** T-01, T-02, T-03 all modify `connector.service.ts` at different line ranges. For safe parallel execution, serialize writes to this file: T-01 first (lines 154-165), then T-02 (lines 981-1029), then T-03 (lines 64-93).

| Task | Can Parallel With                                                | Blocked By                | Blocks                                                        |
| ---- | ---------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| T-01 | T-04, T-06, T-07, T-08, T-09, T-11, T-12                         | —                         | T-02 (file serialization), T-05 (permission mode type change) |
| T-02 | T-04, T-05, T-06, T-07, T-08, T-09, T-11, T-12                   | T-01 (file serialization) | T-03 (file serialization)                                     |
| T-03 | T-04, T-05, T-06, T-07, T-08, T-09, T-11, T-12                   | T-02 (file serialization) | —                                                             |
| T-04 | T-01, T-02, T-03, T-05, T-06, T-07, T-08, T-09, T-11, T-12       | —                         | —                                                             |
| T-05 | T-02, T-03, T-04, T-06, T-07, T-08, T-09, T-11, T-12             | T-01                      | —                                                             |
| T-06 | T-01, T-02, T-03, T-04, T-05, T-07, T-08, T-09, T-11, T-12       | —                         | —                                                             |
| T-07 | T-01, T-02, T-03, T-04, T-05, T-06, T-08, T-09, T-11, T-12       | —                         | —                                                             |
| T-08 | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-09, T-11, T-12       | —                         | T-10                                                          |
| T-09 | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-11, T-12       | —                         | T-10                                                          |
| T-10 | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-11, T-12             | T-08, T-09                | —                                                             |
| T-11 | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-09, T-10, T-12 | —                         | —                                                             |
| T-12 | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-09, T-10, T-11 | —                         | —                                                             |

**Recommended execution order:**

- **Batch 1 (parallel):** T-01, T-04, T-06, T-07, T-08, T-09, T-11, T-12
- **Batch 2 (after T-01):** T-02, T-05
- **Batch 3 (after T-02):** T-03
- **Batch 4 (after T-08, T-09):** T-10

---

## File Overlap Check (CRITICAL)

| File                                                                              | Tasks Touching It                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/services/connector.service.ts`                                | T-01 (resolveScopes lines 154-165), T-02 (pauseSync lines 981-998), T-03 (Redis lines 64-93) |
| `packages/database/src/models/connector-config.model.ts`                          | T-01 (permissionConfig.mode enum line 307)                                                   |
| `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts` | T-01 (mode type line 22), T-05 (group ID, grantedToV2, drive permissions)                    |
| `packages/connectors/sharepoint/src/sharepoint-connector.ts`                      | T-01 (crawlPermissions signature line 261), T-02 (pauseSync/resumeSync lines 242-253)        |
| `packages/database/src/index.ts`                                                  | T-06, T-07 (add exports — different lines, no conflict)                                      |
| `apps/search-ai/src/routes/connectors.ts`                                         | (No changes needed — routes are correct)                                                     |
| `apps/search-ai/src/server.ts`                                                    | T-06, T-07 (add import + mount lines — different imports, no conflict)                       |

**Overlap analysis:**

1. **`connector.service.ts`** is touched by T-01, T-02, T-03 at different line ranges (T-01: 154-165, T-02: 981-1029, T-03: 64-93). **Serialized:** T-01 first, then T-02, then T-03 (reflected in Task Independence Matrix).

2. **`sharepoint-permission-crawler.ts`** is touched by T-01 (mode type) and T-05 (full rewrite of processPermission). **T-05 depends on T-01** already. Execute T-01 first, then T-05.

3. **`sharepoint-connector.ts`** is touched by T-01 (line 261) and T-02 (lines 242-253). Different line ranges, but same file. **Recommendation:** Execute T-01 before T-02 for this file, or coordinate changes.

4. **`packages/database/src/index.ts`** is touched by T-06 and T-07 — adding different exports. No functional overlap. Can be parallel.

**File overlap resolution:** T-01→T-02→T-03 are serialized on `connector.service.ts`. T-05→T-01 handles `sharepoint-permission-crawler.ts`. T-06/T-07 on `packages/database/src/index.ts` add different exports and can safely parallel.
