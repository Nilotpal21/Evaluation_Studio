# LLD + Implementation Plan: Configuration Management

- **Feature ID**: #45
- **Feature Spec**: `docs/features/configuration-management.md`
- **Test Spec**: `docs/testing/configuration-management.md`
- **HLD**: `docs/specs/configuration-management.hld.md`
- **Status**: PLANNED
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22

---

## Implementation Phases

The implementation follows the HLD migration strategy: Foundation -> Dual-Write -> Migration -> Cleanup. Each phase has exit criteria that must be met before proceeding.

---

## Phase 1: Data Models and Repository Layer

**Duration**: 3-4 days
**Risk**: Low (additive, no existing code changes)

### 1.1 Tasks

#### Task 1.1.1: ConfigEntry Model

**File**: `packages/database/src/models/config-entry.model.ts`

Create the `ConfigEntry` Mongoose model following the pattern in `project-config-variable.model.ts`:

- Interface `IConfigEntry` with fields: `_id` (UUIDv7), `tenantId`, `projectId` (optional), `scope` ('platform'|'tenant'|'project'), `environment`, `key`, `value` (Schema.Types.Mixed), `valueType` ('string'|'number'|'boolean'|'json'), `description`, `createdBy`, `updatedBy`, `_v`.
- Apply `tenantIsolationPlugin` and `auditTrailPlugin`.
- Unique compound index: `{ tenantId: 1, scope: 1, key: 1, environment: 1 }`.
- Secondary index: `{ tenantId: 1, projectId: 1 }`.
- Collection name: `config_entries`.

#### Task 1.1.2: ConfigVersion Model

**File**: `packages/database/src/models/config-version.model.ts`

Create the `ConfigVersion` Mongoose model:

- Interface `IConfigVersion` with fields: `_id` (UUIDv7), `configEntryId`, `tenantId`, `version` (Number), `snapshot` (Mixed), `diff` (Mixed, optional), `rollbackMeta` (optional subdocument with `rollbackFrom`, `rollbackTo`), `actorId`, `schemaVersion`, `createdAt`, `expiresAt`.
- Apply `tenantIsolationPlugin`.
- Index: `{ configEntryId: 1, version: -1 }`.
- Index: `{ tenantId: 1, createdAt: -1 }`.
- TTL Index: `{ expiresAt: 1 }` with `expireAfterSeconds: 0`.
- Collection name: `config_versions`.

#### Task 1.1.3: FeatureFlag Model

**File**: `packages/database/src/models/feature-flag.model.ts`

Create the `FeatureFlag` Mongoose model:

- Interface `IFeatureFlag` with fields: `_id` (UUIDv7), `tenantId`, `key`, `type` ('boolean'|'string'|'number'|'json'), `defaultValue` (Mixed), `description`, `enabled` (Boolean, default true), `killSwitch` (Boolean, default false), `targetingRules` (Array of embedded subdocuments), `createdBy`, `updatedBy`, `_v`.
- Embedded `ITargetingRule`: `type`, `priority`, `tenantIds`, `projectIds`, `percentage`, `cohortId`, `value`.
- Apply `tenantIsolationPlugin`.
- Unique index: `{ tenantId: 1, key: 1 }`.
- Index: `{ key: 1 }` (for platform-wide lookups).
- Collection name: `feature_flags`.

#### Task 1.1.4: Export Models from Database Package

**File**: `packages/database/src/models/index.ts`

Add exports for `ConfigEntry`, `ConfigVersion`, `FeatureFlag` to the models barrel export.

#### Task 1.1.5: Config Repository Functions

**File**: `apps/runtime/src/repos/config-repo.ts`

Create repository functions following the pattern in `security-repo.ts`:

- `createConfigEntry(data)` -- insert with tenant isolation.
- `findConfigEntries(filter, options)` -- paginated list.
- `findConfigEntryById(id, tenantId, projectId?)` -- single by ID with tenant scope.
- `findConfigEntryByKey(tenantId, scope, key, environment)` -- lookup by key.
- `updateConfigEntry(id, tenantId, projectId, data, expectedVersion)` -- optimistic update with `_v` check.
- `deleteConfigEntry(id, tenantId, projectId)` -- soft or hard delete.
- `countConfigEntries(filter)` -- count for pagination.

#### Task 1.1.6: ConfigVersion Repository Functions

**File**: `apps/runtime/src/repos/config-version-repo.ts`

- `createConfigVersion(data)` -- insert immutable snapshot.
- `findConfigVersions(configEntryId, tenantId, options)` -- paginated history.
- `findConfigVersionById(id, tenantId)` -- single snapshot.
- `getLatestVersion(configEntryId, tenantId)` -- latest version number.

#### Task 1.1.7: FeatureFlag Repository Functions

**File**: `apps/runtime/src/repos/feature-flag-repo.ts`

- `createFeatureFlag(data)` -- insert with tenant isolation.
- `findFeatureFlags(filter, options)` -- paginated list.
- `findFeatureFlagByKey(tenantId, key)` -- lookup by key.
- `updateFeatureFlag(key, tenantId, data, expectedVersion)` -- optimistic update.
- `deleteFeatureFlag(key, tenantId)` -- delete flag.

### 1.2 Exit Criteria

- [ ] All three models compile (`pnpm build --filter=@agent-platform/database`).
- [ ] Models are exported from `packages/database/src/models/index.ts`.
- [ ] Repository functions compile (`pnpm build --filter=@agent-platform/runtime`).
- [ ] Unit tests for model schema validation pass (min 3 per model: valid doc, missing required field, unique constraint violation).
- [ ] Indexes are correctly defined (verified by inspecting schema output).

---

## Phase 2: Service Layer

**Duration**: 4-5 days
**Risk**: Medium (new logic, but no existing code changes)

### 2.1 Tasks

#### Task 2.1.1: ConfigEntryService

**File**: `apps/runtime/src/services/config-entry.service.ts`

Service class with dependency injection (repos, logger, propagation service):

- `create(tenantId, projectId, data)`: Validate with Zod schema, check plan limits, create entry, create version snapshot, trigger propagation. Returns entry with version.
- `update(id, tenantId, projectId, data, expectedVersion)`: Validate, update with optimistic lock, create version snapshot, trigger propagation. Returns updated entry.
- `delete(id, tenantId, projectId)`: Delete entry, create "deleted" version snapshot.
- `getById(id, tenantId, projectId)`: Read with tenant isolation.
- `list(tenantId, projectId, filter, pagination)`: Paginated list with scope/env filters.
- `validateDryRun(tenantId, data)`: Validate without persisting.

#### Task 2.1.2: ConfigResolutionService

**File**: `apps/runtime/src/services/config-resolution.service.ts`

Service that merges config across the hierarchy:

- `resolve(tenantId, projectId, environment)`:
  1. Load platform defaults from Zod schema `.default()` values.
  2. Load tenant overrides from `config_entries` where `scope='tenant'`.
  3. Load project overrides from `config_entries` where `scope='project'`.
  4. Merge with precedence: platform < tenant < project.
  5. Return resolved config with source attribution for each value.
- `resolveKey(tenantId, projectId, environment, key)`: Resolve a single key.

Wraps existing `TenantConfigService.getConfig()` and `resolveEffectiveLimits()` for backward compatibility.

#### Task 2.1.3: ConfigVersionService

**File**: `apps/runtime/src/services/config-version.service.ts`

- `createVersion(configEntryId, tenantId, snapshot, actorId, diff?, rollbackMeta?)`: Create immutable version.
- `getHistory(configEntryId, tenantId, pagination)`: Paginated history sorted by version desc.
- `getVersion(versionId, tenantId)`: Single version snapshot.
- `rollback(configEntryId, tenantId, targetVersionId, actorId)`:
  1. Load target version snapshot.
  2. Validate snapshot against current Zod schema.
  3. Update config entry with snapshot values.
  4. Create new version with `rollbackMeta`.
  5. Trigger propagation.
- `diff(versionAId, versionBId, tenantId)`: Use `diffConfigs()` from `packages/config/src/validation/config-diff.ts`.

#### Task 2.1.4: FeatureFlagService

**File**: `apps/runtime/src/services/feature-flag.service.ts`

- `create(tenantId, data)`: Validate, insert, return flag.
- `update(key, tenantId, data, expectedVersion)`: Validate, update with optimistic lock.
- `delete(key, tenantId)`: Delete flag.
- `getByKey(tenantId, key)`: Read flag definition.
- `list(tenantId, pagination)`: Paginated list.
- `evaluate(key, context: { tenantId, projectId?, userId? })`: Pure evaluation function:
  1. Load flag (from L1 cache if warm, else DB).
  2. If `killSwitch` true or `enabled` false: return `defaultValue`.
  3. Sort `targetingRules` by `priority` ascending.
  4. For each rule, check if context matches (tenant match, project match, percentage hash).
  5. Return first match's `value`, or `defaultValue` if no match.
- `setKillSwitch(key, tenantId, active)`: Toggle kill switch.
- `updateTargeting(key, tenantId, rules, expectedVersion)`: Replace targeting rules.

Percentage evaluation uses a deterministic hash of `key + tenantId` to ensure consistent assignment.

#### Task 2.1.5: ConfigPropagationService

**File**: `apps/runtime/src/services/config-propagation.service.ts`

- `notifyChange(tenantId, key, scope, environment)`:
  1. Invalidate Redis L2 cache (`DEL cfg:{tenantId}:{scope}:{key}`).
  2. Publish to Redis `config:changes` channel: `{ tenantId, key, scope, environment, timestamp }`.
- `subscribe(callback)`: Subscribe to `config:changes` channel, invoke callback on each message.
- `invalidateLocalCache(tenantId, key?)`: Clear L1 in-memory cache for the tenant (or specific key).

Integrates with existing `ConfigWatcher` from `packages/config/src/watcher.ts` as polling fallback.

#### Task 2.1.6: ConfigValidationService

**File**: `apps/runtime/src/services/config-validation.service.ts`

- `validate(tenantId, data)`: Run Zod schema validation on proposed config change. Returns `{ valid: boolean, errors?: { path, expected, received, message }[] }`.
- `validatePlanLimits(tenantId, plan, key, value)`: Check if value exceeds plan limits. Uses `PLAN_LIMITS` from existing `TenantConfigService`.
- `validateSchema(data, schema)`: Generic Zod validation wrapper.

### 2.2 Exit Criteria

- [ ] All services compile (`pnpm build --filter=@agent-platform/runtime`).
- [ ] Unit tests for each service (min 5 per service):
  - ConfigEntryService: create, update with version conflict, delete, list, dry-run.
  - ConfigResolutionService: resolve with all three layers, resolve single key, fallback on missing layer.
  - ConfigVersionService: create version, history pagination, rollback, diff.
  - FeatureFlagService: evaluate with kill switch, tenant targeting, percentage, default fallback, JSON value type.
  - ConfigPropagationService: notify publishes to Redis, subscribe receives message.
  - ConfigValidationService: valid input, wrong type, plan limit exceeded, unknown key.
- [ ] Integration test for Redis pub/sub propagation (INT-005 from test spec).
- [ ] Feature flag evaluation benchmark: < 1ms p99 for 1000 evaluations.

---

## Phase 3: API Routes

**Duration**: 3-4 days
**Risk**: Medium (new endpoints, but follows existing route patterns)

### 3.1 Tasks

#### Task 3.1.1: Config Entry Routes

**File**: `apps/runtime/src/routes/config-entries.ts`

Create routes mounted at `/api/projects/:projectId/config/entries`:

- `POST /` -- Create config entry. Auth: `config:create`.
- `GET /` -- List config entries with query params: `scope`, `environment`, `page`, `limit`. Auth: `config:read`.
- `GET /:id` -- Get config entry. Auth: `config:read`.
- `PUT /:id` -- Update config entry. Requires `_v` in body. Auth: `config:update`.
- `DELETE /:id` -- Delete config entry. Auth: `config:delete`.
- `GET /resolved` -- Get fully resolved config for the project. Auth: `config:read`.
- `GET /:id/history` -- Get version history. Auth: `config:read`.
- `POST /:id/rollback` -- Rollback to version. Body: `{ targetVersionId }`. Auth: `config:update`.

All routes use `openapi.route()` pattern from `createOpenAPIRouter` (matching `environment-variables.ts` pattern).

Middleware chain: `authMiddleware`, `requireProjectScope('projectId')`, `tenantRateLimit('request')`.

#### Task 3.1.2: Feature Flag Routes

**File**: `apps/runtime/src/routes/feature-flags.ts`

Create routes mounted at `/api/config/flags`:

- `POST /` -- Create flag. Auth: ADMIN role.
- `GET /` -- List flags. Auth: authenticated.
- `GET /:key` -- Get flag definition. Auth: authenticated.
- `PUT /:key` -- Update flag. Auth: ADMIN role.
- `DELETE /:key` -- Delete flag. Auth: ADMIN role.
- `GET /:key/evaluate` -- Evaluate flag. Query: `tenantId`, `projectId`. Auth: authenticated.
- `PUT /:key/targeting` -- Update targeting rules. Auth: ADMIN role.
- `POST /:key/kill` -- Activate kill switch. Auth: ADMIN role.
- `DELETE /:key/kill` -- Deactivate kill switch. Auth: ADMIN role.

Static routes (`/evaluate`, `/targeting`, `/kill`) registered BEFORE `/:key` parameterized route (Express route ordering rule).

#### Task 3.1.3: Environment Promotion Routes

**File**: `apps/runtime/src/routes/config-promotion.ts`

Create routes mounted at `/api/config/promote`:

- `POST /dry-run` -- Preview promotion diff. Body: `{ source, target, keys? }`. Auth: `config:update`.
- `POST /` -- Execute promotion. Body: `{ source, target, keys?, overwrite? }`. Auth: `config:update`.

#### Task 3.1.4: Config Import/Export Routes

**File**: `apps/runtime/src/routes/config-io.ts`

- `GET /api/config/export` -- Export config snapshot. Query: `format=json|yaml`, `scope`, `environment`. Auth: ADMIN role.
- `POST /api/config/import` -- Import config snapshot. Body: JSON config snapshot. Auth: ADMIN role.

#### Task 3.1.5: Register Routes in Server

**File**: `apps/runtime/src/server.ts` (or route registration file)

Register all new routes:

- `/api/projects/:projectId/config/entries` -> `config-entries.ts`
- `/api/config/flags` -> `feature-flags.ts`
- `/api/config/promote` -> `config-promotion.ts`
- `/api/config/export` and `/api/config/import` -> `config-io.ts`

Ensure static routes are registered before parameterized routes.

### 3.2 Exit Criteria

- [ ] All routes compile and register without errors.
- [ ] OpenAPI spec generated for all endpoints.
- [ ] E2E test for config CRUD with tenant isolation passes (E2E-001).
- [ ] E2E test for feature flag lifecycle passes (E2E-003).
- [ ] E2E test for config versioning and rollback passes (E2E-004).
- [ ] E2E test for environment promotion passes (E2E-005).
- [ ] All endpoints return standard `{ success, data/error }` envelope.
- [ ] Audit log entries are created for all write operations.

---

## Phase 4: Real-Time Propagation

**Duration**: 2-3 days
**Risk**: Medium (Redis pub/sub integration)

### 4.1 Tasks

#### Task 4.1.1: Redis Pub/Sub Integration

**File**: `apps/runtime/src/services/config-propagation.service.ts` (extend from Phase 2)

Wire the `ConfigPropagationService` into the runtime startup:

1. On server start: subscribe to `config:changes` Redis channel.
2. On message received: parse event, invalidate L1 cache for affected tenant.
3. On server shutdown: unsubscribe.

Use existing Redis connection from `packages/redis/src/connection.ts`.

#### Task 4.1.2: L1 Cache for Feature Flags

**File**: `apps/runtime/src/services/feature-flag.service.ts` (extend)

Add in-memory LRU cache for flag evaluations:

- Max entries: 1000.
- TTL: 30 seconds.
- Eviction: LRU (least recently used).
- Key: `{tenantId}:{flagKey}`.
- Invalidation: on `config:changes` pub/sub message with scope `feature_flag`.

#### Task 4.1.3: ConfigWatcher Integration

**File**: `apps/runtime/src/services/config-propagation.service.ts` (extend)

Integrate with existing `ConfigWatcher` from `packages/config/src/watcher.ts`:

- Start `ConfigWatcher` with `intervalMs: 60000` as fallback.
- On change detected: reload config from DB, invalidate L1 and L2 caches.
- `ConfigWatcher.getConfigHash()` computes hash of config version numbers for change detection.

### 4.2 Exit Criteria

- [ ] Redis pub/sub subscription active on server start.
- [ ] Config change propagates to subscribed instance within 1 second (INT-005).
- [ ] L1 cache reduces flag evaluation to < 1ms (benchmark test).
- [ ] Polling fallback activates when Redis pub/sub is disconnected.
- [ ] No memory leaks: L1 cache respects max size and TTL.

---

## Phase 5: Admin Dashboard Integration

**Duration**: 3-4 days
**Risk**: Low (UI extensions, follows existing patterns)

### 5.1 Tasks

#### Task 5.1.1: Admin Config API Proxy Routes

**File**: `apps/admin/src/app/api/config/entries/route.ts`

Proxy routes to runtime config API (following existing pattern in `tenant-config/route.ts`):

- GET/POST proxy to `/api/config/entries` on runtime.
- Individual entry routes: `[id]/route.ts`, `[id]/history/route.ts`, `[id]/rollback/route.ts`.

#### Task 5.1.2: Admin Feature Flag Proxy Routes

**File**: `apps/admin/src/app/api/config/flags/route.ts`

Proxy routes to runtime feature flag API:

- CRUD, evaluate, targeting, kill switch.

#### Task 5.1.3: Admin Config Promotion Proxy Routes

**File**: `apps/admin/src/app/api/config/promote/route.ts`

Proxy routes to runtime promotion API.

#### Task 5.1.4: Config Browser UI Component

**File**: `apps/admin/src/components/config/ConfigBrowser.tsx`

React component for browsing config entries:

- Table view with columns: Key, Value, Scope, Environment, Source, Updated.
- Filter dropdowns: scope, environment.
- Search by key.
- Click to view details, edit, view history.

#### Task 5.1.5: Feature Flag Management UI Component

**File**: `apps/admin/src/components/config/FeatureFlagManager.tsx`

React component for managing feature flags:

- List view with toggle for enabled/disabled.
- Kill switch button (red, with confirmation dialog).
- Targeting rules editor.
- Flag evaluation tester (input context, see result).

#### Task 5.1.6: Config Diff View Component

**File**: `apps/admin/src/components/config/ConfigDiffView.tsx`

React component for config diff visualization:

- Side-by-side view of two versions or two environments.
- Color-coded: green (added), red (removed), yellow (changed).
- Sensitive values masked with reveal toggle.

### 5.2 Exit Criteria

- [ ] Admin proxy routes return correct data from runtime.
- [ ] Config browser lists entries with pagination.
- [ ] Feature flag manager can create, toggle, and kill flags.
- [ ] Config diff view renders correctly for version comparison and environment promotion.
- [ ] All admin routes require ADMIN role.

---

## Phase 6: Integration Tests and E2E Tests

**Duration**: 3-4 days
**Risk**: Low (test-only, no production code changes)

### 6.1 Tasks

#### Task 6.1.1: Unit Tests for Models

**Files**: `packages/database/src/__tests__/config-entry.model.test.ts`, `config-version.model.test.ts`, `feature-flag.model.test.ts`

Min 3 tests per model: valid creation, required field validation, unique index violation.

#### Task 6.1.2: Integration Tests

**Files**: `apps/runtime/src/__tests__/integration/config-*.test.ts`

Implement all 7 integration test scenarios from the test spec:

- INT-001: Redis cache invalidation.
- INT-002: Feature flag evaluation.
- INT-003: Schema validation.
- INT-004: Config diff and history.
- INT-005: Redis pub/sub propagation.
- INT-006: Audit log integration.
- INT-007: Plan-based limits.

#### Task 6.1.3: E2E Tests

**Files**: `apps/runtime/src/__tests__/e2e/config-*.e2e.test.ts`

Implement all 7 E2E test scenarios from the test spec:

- E2E-001: CRUD with tenant isolation.
- E2E-002: Hierarchy resolution.
- E2E-003: Feature flag lifecycle.
- E2E-004: Versioning and rollback.
- E2E-005: Environment promotion.
- E2E-006: Import/export round-trip.
- E2E-007: Concurrent updates.

All E2E tests start real Express server on random port. No mocks. No direct DB access.

### 6.2 Exit Criteria

- [ ] All unit tests pass.
- [ ] All 7 integration tests pass.
- [ ] All 7 E2E tests pass.
- [ ] Code coverage for new files > 80%.
- [ ] No `vi.mock()` or `jest.mock()` in E2E test files.

---

## Phase 7: Migration and Backward Compatibility

**Duration**: 2-3 days
**Risk**: High (modifying existing services)

### 7.1 Tasks

#### Task 7.1.1: Dual-Write in TenantConfigService

**File**: `apps/runtime/src/services/tenant-config.ts` (modify)

When `setOverrides()` or `invalidateCache()` is called, also write to the new `ConfigEntry` model. This ensures existing callers continue to work while new data flows into the unified model.

#### Task 7.1.2: Data Migration Script

**File**: `packages/database/src/migrations/config-migration.ts`

Script to migrate existing config data:

- Read tenant settings from `Tenant.settings` and write to `config_entries`.
- Read subscription quota overrides and write to `config_entries`.
- Read project runtime config and write to `config_entries`.
- Idempotent: skip entries that already exist (by unique key).

#### Task 7.1.3: Studio Config Service Update

**File**: `apps/studio/src/services/tenant-config.ts` (modify)

Update the simplified studio `TenantConfigService` to optionally call the runtime config API for tenant/project overrides, falling back to plan defaults if the API is unavailable.

### 7.2 Exit Criteria

- [ ] Dual-write produces consistent data in both old and new models.
- [ ] Migration script runs idempotently.
- [ ] Existing runtime tests still pass (no regressions).
- [ ] Studio config resolution returns correct values.

---

## Wiring Verification Checklist

Before the feature is considered complete, verify all wiring connections:

| #   | Check                                                                    | Verified |
| --- | ------------------------------------------------------------------------ | -------- |
| 1   | Models exported from `packages/database/src/models/index.ts`             | [ ]      |
| 2   | Routes registered in `apps/runtime/src/server.ts`                        | [ ]      |
| 3   | Static routes before parameterized routes (Express ordering)             | [ ]      |
| 4   | Redis pub/sub subscriber started on server init                          | [ ]      |
| 5   | ConfigPropagationService called on every config write                    | [ ]      |
| 6   | Audit log written for every config write operation                       | [ ]      |
| 7   | Admin proxy routes connected to runtime endpoints                        | [ ]      |
| 8   | Zod validation runs before every config persistence                      | [ ]      |
| 9   | Plan limit check runs before tenant/project config writes                | [ ]      |
| 10  | TTL index on ConfigVersion model verified in MongoDB                     | [ ]      |
| 11  | L1 cache has max size (1000) and TTL (30s)                               | [ ]      |
| 12  | Feature flag percentage hash is deterministic (same input = same result) | [ ]      |

## Summary

| Phase                    | Duration       | Tasks  | Risk   |
| ------------------------ | -------------- | ------ | ------ |
| 1. Data Models & Repos   | 3-4 days       | 7      | Low    |
| 2. Service Layer         | 4-5 days       | 6      | Medium |
| 3. API Routes            | 3-4 days       | 5      | Medium |
| 4. Real-Time Propagation | 2-3 days       | 3      | Medium |
| 5. Admin Dashboard       | 3-4 days       | 6      | Low    |
| 6. Tests                 | 3-4 days       | 3      | Low    |
| 7. Migration             | 2-3 days       | 3      | High   |
| **Total**                | **20-27 days** | **33** |        |
