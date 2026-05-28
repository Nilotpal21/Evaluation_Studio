# Wave 1 Production Readiness Audit

**Date:** 2026-03-24
**Auditor:** Claude Opus 4.6 (automated)
**Scope:** All new and modified files in Wave 1 implementation

---

## New Backend Files

### 1. `packages/database/src/models/connector-audit-entry.model.ts`

- **Classification:** COMPLETE
- **Evidence:** Well-structured Mongoose model with typed interface, tenant isolation plugin, ModelRegistry registration, four indexes covering primary query patterns (connector-scoped, tenant-wide, category-filtered, event-type). Uses `uuidv7` IDs, enforces required fields, proper enum constraints on `actorType` and `category`. Append-only design is documented in the header.

### 2. `packages/database/src/models/connector-config-version.model.ts`

- **Classification:** COMPLETE
- **Evidence:** Typed interface with all required fields. Tenant isolation plugin applied. ModelRegistry registration present. Unique compound index on `{ tenantId, connectorId, version }` provides optimistic concurrency guard. Version-descending index for efficient latest-first queries. Uses `uuidv7`, proper enum on `changeSource`.

### 3. `apps/search-ai/src/services/connector-audit.service.ts`

- **Classification:** COMPLETE
- **Evidence:** Three operations: `writeAuditEntry` (append-only create), `getAuditLog` (paginated, tenant+connector scoped, with category/date filters), `exportAuditLog` (JSON/CSV). All queries include both `connectorId` and `tenantId` for tenant isolation. Uses `createLogger` (not console.log). CSV export properly escapes double quotes. Pagination has sensible defaults (page 1, limit 50). Uses `getLazyModel` for dual-database support.

### 4. `apps/search-ai/src/services/connector-config-version.service.ts`

- **Classification:** COMPLETE
- **Evidence:** Implements `createVersion` with optimistic concurrency control (retry loop up to 3 attempts on duplicate key error 11000). `getVersionHistory` has pagination with capped limit (`Math.min(limit, 100)`). `getVersionSnapshot` scoped by `connectorId + tenantId`. `getLatestVersion` returns 0 for no-version case. `isDuplicateKeyError` uses safe type narrowing. All queries tenant-scoped. Structured logging for conflict warnings.

### 5. `apps/search-ai/src/routes/connector-audit.ts`

- **Classification:** COMPLETE
- **Evidence:** Two read-only routes: paginated list and export download. Both use Zod validation on params and query. Auth middleware applied at router level. Tenant ID extracted from `req.tenantContext!.tenantId`. Error handler uses `error instanceof Error ? error.message : String(error)` pattern. Export sets proper `Content-Type` and `Content-Disposition` headers. Returns structured `{ success, error: { code, message } }` on failure.

### 6. `apps/search-ai/src/routes/connector-config-versions.ts`

- **Classification:** PARTIAL
- **Evidence:** GET list, GET snapshot, and POST create are fully implemented with Zod validation, tenant scoping, and structured error responses. Auth middleware applied.
- **Issues:**
  1. **Missing diff endpoint**: Lines 142-147 contain a JSDoc comment for `GET .../config/versions/diff` but the route handler is never implemented -- just a dangling comment block. The `diffQuery` Zod schema is defined (lines 40-43) but never used.
  2. **Route ordering violation**: The comment at line 145 says "Static route must be registered BEFORE the :versionNumber parameterized route" but the GET `/:versionNumber` route is registered at line 108 and the diff comment appears after it at line 142. Even if the diff route were implemented, it would be shadowed by `/:versionNumber` matching "diff" as a version number (though Zod coerce would fail).

### 7. `apps/search-ai/src/services/connector.service.ts` (lines 64-93, 154-165, 981-1029)

- **Classification:** COMPLETE
- **Evidence:** The reviewed sections show: (a) Device code session storage with `SET NX PX` guard for idempotency (lines 64-99); (b) OAuth redirect URI resolution from `FRONTEND_URL` env var with descriptive error (lines 153-172); (c) Sync trigger with pre-flight checks (sync not in progress, token not revoked, delta requires prior full sync), BullMQ job enqueue with TTL-based cleanup (lines 975-1014); (d) Stop sync with hybrid Redis+DB cancellation (lines 1016-1033). All operations scope queries by `connectorId + tenantId`. Error handling uses domain-specific `ConnectorError` with HTTP status codes.

---

## Modified Backend Files

### 8. `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts`

- **Classification:** PARTIAL
- **Evidence:** Substantial real implementation: LRU cache with max size (10,000) and TTL (1hr) for Azure AD group resolution, batch document crawling, permission merging with dedup, role mapping, Neo4j graph writes via `PermissionGraphService`. Handles both `grantedToV2` and `grantedToIdentitiesV2` identity blocks. Error handling on per-document and per-group basis (logs warning, continues).
- **Issues:**
  1. **TODO at line 519**: `// TODO: Handle nested groups (Group -> Group) if needed` -- nested Azure AD groups are not resolved, which means transitive group memberships are silently dropped. This is a real accuracy gap for enterprises using nested security groups.
  2. **`hasPublicInDomainAccess` always returns false** (line 536): Hardcoded to `false` with comment "SharePoint doesn't have explicit 'public in domain' concept." SharePoint _does_ have organization-wide sharing links (`scope: 'organization'`), so this is a known gap.
  3. **Uses `console.*` via custom logger** (lines 42-55): The connector package defines its own logger using `console.error/warn/info/debug` instead of `createLogger` from `@abl/compiler/platform`. This is noted as acceptable for connector packages (which are standalone), but differs from the platform convention.

### 9. `packages/connectors/sharepoint/src/sharepoint-connector.ts` (pauseSync/resumeSync)

- **Classification:** PARTIAL
- **Evidence:** `pauseSync` (line 250) is a documented no-op -- the service layer handles pause via DB flag + Redis signal. `resumeSync` (line 259) loads a checkpoint and re-invokes `performSync`. Core sync, permission crawling, resource discovery, validation, and connection testing are all implemented.
- **Issues:**
  1. **Webhook methods are stubs** (lines 368-383): `setupWebhook` and `handleWebhookNotification` throw `Error('not implemented yet (Phase 2)')`. These are explicitly scoped to Phase 2 -- acceptable as long as no UI exposes them.
  2. **`any` type on `doclingQueue`** (line 45): `private readonly doclingQueue?: any;` -- should be typed as `Queue` from BullMQ.
  3. **`any` cast in `testConnection` error handler** (line 196): `catch (error: any)` instead of `catch (error: unknown)`.

### 10. `packages/connectors/sharepoint/src/client/graph-types.ts`

- **Classification:** COMPLETE
- **Evidence:** Comprehensive TypeScript type definitions for all Microsoft Graph API resources used by the connector: Site, Drive, DriveItem, Permission (with `grantedToV2`/`grantedToIdentitiesV2`/link), AzureADGroup, GroupMember, GraphList, GraphColumnDefinition, GraphErrorResponse. All collection types include `@odata.nextLink` for pagination. `DriveItemCollection` includes `@odata.deltaLink` for delta sync. Types align with Microsoft Graph API v1.0 schema.

### 11. `packages/database/src/models/connector-config.model.ts` (permission mode enum)

- **Classification:** COMPLETE
- **Evidence:** Full Mongoose schema with typed `IConnectorConfig` interface. Permission mode enum is `['enabled', 'disabled']` (line 307). Comprehensive sub-schemas for `syncState`, `filterConfig` (standard + scope + advancedFilters), `permissionConfig`, `errorState`. Tenant isolation plugin applied. ModelRegistry registered. Four indexes for common query patterns. All fields have sensible defaults.

---

## New Frontend Files

### 12. `apps/studio/src/hooks/useConnector.ts`

- **Classification:** COMPLETE
- **Evidence:** SWR hook with proper typed interface matching backend `IConnectorConfig` shape. Conditional fetch key (null when indexId/connectorId missing). Returns `{ connector, isLoading, error, mutate }`. Error coerced to string. Uses `useMemo` to stabilize connector reference.

### 13. `apps/studio/src/hooks/useConnectorList.ts`

- **Classification:** COMPLETE
- **Evidence:** SWR hook for connector list. Conditional key based on `indexId`. Types reuse `ConnectorDetail` from `useConnector`. Returns connectors array with fallback to empty array, total count, loading/error state, and mutate.

### 14. `apps/studio/src/hooks/useConnectorSync.ts`

- **Classification:** COMPLETE
- **Evidence:** SWR hook with conditional polling -- polls at 5s intervals when sync is active (`ACTIVE_SYNC_STATUSES` set), stops when idle. Uses `useRef` to track sync-active state across renders. `onSuccess` callback updates the ref. Returns typed `SyncStatusResponse` with progress info. Configurable poll interval via options.

### 15. `apps/studio/src/store/connector-store.ts`

- **Classification:** COMPLETE
- **Evidence:** Zustand store with typed state and actions. `simplifiedView` persisted to localStorage with SSR-safe default. Seven tab types defined. `openPanel` accepts `connectorId` with optional `isNew` and `tab`. `closePanel` resets all state. `resetStore` re-reads persisted preference. Advisory comment about atomic selectors and `useShallow` for multi-field reads.

### 16. `apps/studio/src/components/ui/TypeToConfirmInput.tsx`

- **Classification:** COMPLETE
- **Evidence:** Reusable confirmation pattern component. Case-insensitive match with trim. Renders warning block with consequences and "appropriate when" lists. Uses design-system `Input` and `Button` components. Supports `danger`/`warning` variants. `loading` prop disables both buttons. Props are i18n-friendly (parent passes translated strings). Proper `aria-label` for accessibility.

### 17. `apps/studio/src/components/search-ai/sharepoint/SharePointDetailPanel.tsx`

- **Classification:** PARTIAL
- **Evidence:** Well-structured panel shell with tab routing, expand/collapse, Simplified View toggle (persisted), More Actions dropdown with i18n labels, draft/monitoring mode detection, auto-expand on scope-filters tab. Uses design-system components (SlidePanel, Tabs, Button, Badge, Toggle, Tooltip, DropdownMenu). Uses `useShallow` correctly per Zustand best practices.
- **Issues:**
  1. **Tab content is placeholder** (lines 348-353): All tab content renders `t('placeholder.tabContent', { wave: activeWave })` -- just a string like "Tab content -- Wave 2". This is by design for Wave 1, but it means the panel has no functional content.
  2. **Delete handler is empty** (lines 193-196): `handleDelete` is an empty callback with comment "Delete logic will be implemented in Wave 2". The Delete menu item is not disabled, so clicking it does nothing.
  3. **Six menu items disabled with "future update" tooltip** (lines 263-320): Clone, Export JSON, Export YAML, Import, Health Check, Diagnostics are all `disabled` with `onSelect={() => {}}`. These are deferred features, but visible disabled items in the UI.

---

## Modified Frontend/Config Files

### 18. `packages/i18n/locales/en/studio.json` (search_ai.sharepoint namespace)

- **Classification:** COMPLETE
- **Evidence:** Full i18n key set covering tabs (7 keys), panel chrome (5 keys), actions menu (8 keys), and placeholder content (1 key). All keys used by `SharePointDetailPanel.tsx` are present. Keys follow the project's flat-namespace convention under `search_ai.sharepoint`.

### 19. `packages/database/src/models/connector-schema.model.ts` (ModelRegistry registration)

- **Classification:** COMPLETE
- **Evidence:** `ModelRegistry.registerModelDefinition('ConnectorSchema', ConnectorSchemaSchema, 'platform')` at line 88. This was previously missing (flagged in database schema audit). Tenant isolation plugin applied. Proper indexes. Typed interface for `IConnectorSchema` and `IConnectorSchemaField`.

### 20. `packages/database/src/models/field-mapping.model.ts` (ModelRegistry registration)

- **Classification:** COMPLETE
- **Evidence:** `ModelRegistry.registerModelDefinition('FieldMapping', FieldMappingSchema, 'platform')` at line 99. This was previously missing (flagged in database schema audit). Tenant isolation plugin applied. Unique compound index on `{ canonicalSchemaId, canonicalField, connectorId }`. Typed interfaces for `IFieldMapping` and `IFieldTransform`.

---

## Summary Table

| #   | File                                   | Classification | Issues                                                                      |
| --- | -------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| 1   | `connector-audit-entry.model.ts`       | COMPLETE       | --                                                                          |
| 2   | `connector-config-version.model.ts`    | COMPLETE       | --                                                                          |
| 3   | `connector-audit.service.ts`           | COMPLETE       | --                                                                          |
| 4   | `connector-config-version.service.ts`  | COMPLETE       | --                                                                          |
| 5   | `connector-audit.ts` (route)           | COMPLETE       | --                                                                          |
| 6   | `connector-config-versions.ts` (route) | PARTIAL        | Diff endpoint declared but not implemented; route ordering comment is stale |
| 7   | `connector.service.ts` (modified)      | COMPLETE       | --                                                                          |
| 8   | `sharepoint-permission-crawler.ts`     | PARTIAL        | TODO: nested groups; `hasPublicInDomainAccess` always false                 |
| 9   | `sharepoint-connector.ts`              | PARTIAL        | Webhook stubs (Phase 2); `any` types on doclingQueue and catch              |
| 10  | `graph-types.ts`                       | COMPLETE       | --                                                                          |
| 11  | `connector-config.model.ts`            | COMPLETE       | --                                                                          |
| 12  | `useConnector.ts`                      | COMPLETE       | --                                                                          |
| 13  | `useConnectorList.ts`                  | COMPLETE       | --                                                                          |
| 14  | `useConnectorSync.ts`                  | COMPLETE       | --                                                                          |
| 15  | `connector-store.ts`                   | COMPLETE       | --                                                                          |
| 16  | `TypeToConfirmInput.tsx`               | COMPLETE       | --                                                                          |
| 17  | `SharePointDetailPanel.tsx`            | PARTIAL        | Placeholder tab content; empty delete handler; 6 disabled menu items        |
| 18  | `studio.json` (i18n)                   | COMPLETE       | --                                                                          |
| 19  | `connector-schema.model.ts`            | COMPLETE       | --                                                                          |
| 20  | `field-mapping.model.ts`               | COMPLETE       | --                                                                          |

**Totals:** 15 COMPLETE, 4 PARTIAL, 0 STUB

---

## Fix List (PARTIAL files)

### connector-config-versions.ts (route)

1. **Implement the diff endpoint** or remove the dangling JSDoc comment and unused `diffQuery` schema. If implementing, register the `GET .../diff` route BEFORE the `GET .../:versionNumber` route.

### sharepoint-permission-crawler.ts

1. **Nested group resolution** (line 519 TODO): Implement recursive group-in-group membership resolution, or document this as a known limitation with a tracking ticket.
2. **`hasPublicInDomainAccess`**: Check for `perm.link?.scope === 'organization'` instead of returning hardcoded `false`.

### sharepoint-connector.ts

1. **Webhook stubs**: Acceptable for Phase 2 deferral -- ensure no UI path can trigger these methods.
2. **Type safety**: Replace `any` on `doclingQueue` (line 45) with `Queue` from BullMQ. Replace `catch (error: any)` (line 196) with `catch (error: unknown)`.

### SharePointDetailPanel.tsx

1. **Empty delete handler**: Either disable the Delete menu item (like the other deferred items) or implement the delete action.
2. **Placeholder tab content**: Expected for Wave 1 -- no fix needed, but ensure Wave 2 replaces all placeholders.
