# High-Level Design: Configuration Management

- **Feature ID**: #45
- **Feature Spec**: `docs/features/configuration-management.md`
- **Test Spec**: `docs/testing/configuration-management.md`
- **Status**: PLANNED
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22

---

## 1. Architecture Overview

Configuration Management introduces a layered configuration system with four scopes (platform, tenant, project, environment), real-time propagation, feature flags, versioning, and an admin dashboard. The system wraps the existing `TenantConfigService` and `packages/config/` infrastructure, adding persistence, versioning, and a unified API surface.

### 1.1 System Context Diagram

```
+------------------+     +------------------+     +------------------+
|   Studio (UI)    |     |   Admin (UI)     |     |  External CLI    |
+--------+---------+     +--------+---------+     +--------+---------+
         |                         |                        |
         +------------+------------+------------------------+
                      |
              +-------v-------+
              |  API Gateway  |  (auth, rate limit, tenant scope)
              +-------+-------+
                      |
         +------------+------------+
         |                         |
+--------v---------+    +----------v----------+
| Config API       |    | Feature Flag API     |
| (CRUD, resolve,  |    | (CRUD, evaluate,     |
|  promote, export)|    |  targeting, kill)     |
+--------+---------+    +----------+-----------+
         |                         |
+--------v-------------------------v----------+
|         Config Service Layer                 |
|  - ConfigEntryService                        |
|  - ConfigResolutionService                   |
|  - ConfigVersionService                      |
|  - FeatureFlagService                        |
|  - ConfigPropagationService                  |
+------+-------+-------+-------+--------------+
       |       |       |       |
+------v-+  +--v---+  +v------+  +------------+
|MongoDB |  |Redis |  | Vault |  | Audit Log  |
| (data) |  |(cache|  |(secrets)| | (MongoDB)  |
|        |  | +pub/ |  |       |  |            |
|        |  | sub)  |  |       |  |            |
+--------+  +------+  +-------+  +------------+
```

### 1.2 Key Design Principles

1. **Layered Resolution**: Platform defaults -> tenant overrides -> project overrides -> environment specifics. Each layer can only narrow or specialize, never exceed plan limits.
2. **Wrap, Don't Replace**: The unified API wraps existing `TenantConfigService` and `packages/config/` infrastructure. Existing consumers are not broken.
3. **Immutable Versions**: Every config change creates a new version. History is append-only. Rollback creates a new version pointing to a prior state.
4. **Eventual Consistency**: Config reads serve from cache (Redis or in-memory). Writes propagate via Redis pub/sub with polling fallback. Stale reads are bounded by TTL (max 30 seconds).
5. **Schema-First**: All config values are validated against Zod schemas before persistence. Invalid config is rejected, never silently stored.

## 2. Architectural Concerns (12 Concerns)

### Concern 1: Tenant Isolation

**Strategy**: Every config entry and feature flag is scoped by `tenantId`. All queries include `tenantId` in the filter. Cross-tenant access returns 404 (not 403).

**Implementation**:

- Config entry model uses `tenantIsolationPlugin` (existing pattern from `ProjectConfigVariable`).
- All routes use `requireProjectScope` or `requireAuth` with `req.tenantContext.tenantId`.
- Platform-scoped config (no tenant) is only writable by ADMIN role via Admin API.

### Concern 2: Authorization and RBAC

**Strategy**: Layered permissions:

- **Platform config**: ADMIN role only (via Admin dashboard).
- **Tenant config**: Tenant OWNER/ADMIN role.
- **Project config**: Project permission `config:read`, `config:write`, `config:delete`.
- **Feature flags**: ADMIN role for management; evaluation is read-only and allowed for any authenticated request.

**Implementation**: Uses existing `requireProjectPermission()` and `requireRole()` middleware.

### Concern 3: Data Model and Persistence

**Strategy**: Three new MongoDB collections:

- `config_entries`: Unified config key-value store with scope, environment, and version.
- `config_versions`: Immutable snapshots for each config change.
- `feature_flags`: Feature flag definitions with targeting rules.

All models use `tenantIsolationPlugin` and `auditTrailPlugin`.

### Concern 4: Caching and Performance

**Strategy**: Two-level cache:

- **L1 (in-memory)**: Feature flag evaluations cached per-pod for < 1ms reads. Map with max size (1000), TTL (30s), and LRU eviction.
- **L2 (Redis)**: Config entries cached with `cfg:{tenantId}:{scope}:{key}` keys, TTL 300s (matching existing `CACHE_TTL_SECONDS`).

Cache invalidation:

- Writes invalidate L2 (Redis DEL) and publish to `config:changes` channel.
- Subscribers invalidate L1 on receiving pub/sub messages.
- Polling fallback via `ConfigWatcher` (existing) at 60s intervals.

### Concern 5: Consistency and Concurrency

**Strategy**: Optimistic concurrency control via `_v` (version) field on config entries. Updates include `_v` in the query filter; MongoDB's atomic `findOneAndUpdate` with `{_v: expectedVersion}` ensures no lost updates. 409 Conflict on version mismatch.

**Distributed state**: Redis pub/sub for cross-pod cache invalidation. No pod-local state is authoritative -- Redis/MongoDB are the sources of truth.

### Concern 6: Audit and Compliance

**Strategy**: Every config write generates an audit log entry via `writeAuditLog()` (existing in `auth-repo.ts`).

**Audit log fields**: `{ action: "config:create|update|delete|rollback|promote", tenantId, userId, metadata: { key, scope, environment, oldValue, newValue, version } }`.

Sensitive values (`jwt.secret`, `encryption.masterKey`, etc.) are masked in audit log metadata using the `SENSITIVE_PATHS` list from `config-diff.ts`.

### Concern 7: Observability and Tracing

**Strategy**: All config operations emit structured logs via `createLogger('config-service')`. Key metrics:

- Config read latency histogram (cached vs uncached).
- Config write latency histogram.
- Cache hit/miss ratio counter.
- Feature flag evaluation counter (per flag, per result).
- Config propagation latency histogram.

Future: TraceEvent integration for config changes in execution paths.

### Concern 8: Error Handling and Resilience

**Strategy**: Fail-open for reads, fail-closed for writes.

- **Read failure** (Redis down, DB timeout): Return TEAM plan defaults (existing pattern in `TenantConfigService.loadFromDB`).
- **Write failure**: Return error to caller; never silently lose a config change.
- **Validation failure**: Return structured error `{ success: false, error: { code: "VALIDATION_ERROR", message, details: [{ path, expected, received }] } }`.
- **Propagation failure**: Log warning, rely on polling fallback.

### Concern 9: Schema Evolution and Backward Compatibility

**Strategy**: Zod schemas with `.default()` for all new fields. Adding a field is backward-compatible (existing configs get the default). Removing a field requires a migration to clean up stored values.

Config version snapshots store the schema version at the time of creation. Rollback validates the historic snapshot against the current schema, rejecting if incompatible.

### Concern 10: Security

**Strategy**:

- Config values are validated at boundaries (Zod schemas).
- Sensitive config paths are never returned in plaintext via API (masked with `***`).
- Feature flag targeting rules do not expose tenant lists to other tenants.
- Import endpoint validates and sanitizes all input before persistence.
- Rate limiting on config write endpoints (existing `tenantRateLimit`).

### Concern 11: Scalability

**Strategy**:

- Config entries are indexed by `{tenantId, scope, key, environment}` for O(1) lookups.
- Feature flag evaluation uses in-memory L1 cache; no DB call on hot path.
- Config propagation is fan-out via Redis pub/sub; scales with subscriber count.
- Version history is append-only; old versions are TTL-purged after `NFR-005` retention period (90 days).

### Concern 12: Testability

**Strategy**:

- All services accept dependencies via constructor injection (Redis client, DB models).
- Feature flag evaluation is a pure function (targeting rules + context -> result) that can be unit-tested.
- Config resolution is a pure merge function that can be unit-tested.
- E2E tests use real servers on random ports (no mocks).
- Integration tests use MongoMemoryServer.

## 3. Data Model

### 3.1 ConfigEntry

```typescript
interface IConfigEntry {
  _id: string; // UUIDv7
  tenantId: string; // Tenant scope (required)
  projectId?: string; // Project scope (optional -- null for tenant-scoped)
  scope: 'platform' | 'tenant' | 'project';
  environment: string; // 'dev' | 'staging' | 'prod' | 'test' | '*' (all envs)
  key: string; // Dot-notation path: "limits.maxAgentsPerProject"
  value: unknown; // JSON-serializable value
  valueType: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  createdBy: string;
  updatedBy?: string;
  _v: number; // Optimistic concurrency version
  createdAt: Date;
  updatedAt: Date;
}
// Index: { tenantId: 1, scope: 1, key: 1, environment: 1 } (unique)
// Index: { tenantId: 1, projectId: 1 }
```

### 3.2 ConfigVersion

```typescript
interface IConfigVersion {
  _id: string; // UUIDv7
  configEntryId: string; // FK to ConfigEntry
  tenantId: string;
  version: number; // Sequential version number
  snapshot: {
    key: string;
    value: unknown;
    valueType: string;
    scope: string;
    environment: string;
  };
  diff?: {
    // Diff from previous version
    oldValue: unknown;
    newValue: unknown;
  };
  rollbackMeta?: {
    // Present only for rollback versions
    rollbackFrom: string; // Version ID rolled back from
    rollbackTo: string; // Version ID rolled back to
  };
  actorId: string;
  schemaVersion: number; // Schema version at time of creation
  createdAt: Date;
  expiresAt: Date; // TTL for retention (90 days)
}
// Index: { configEntryId: 1, version: -1 }
// Index: { tenantId: 1, createdAt: -1 }
// TTL Index: { expiresAt: 1 }, expireAfterSeconds: 0
```

### 3.3 FeatureFlag

```typescript
interface IFeatureFlag {
  _id: string; // UUIDv7
  tenantId: string; // '*' for platform-wide flags
  key: string; // Unique flag name
  type: 'boolean' | 'string' | 'number' | 'json';
  defaultValue: unknown; // Default when no rule matches
  description?: string;
  enabled: boolean; // Master enable/disable
  killSwitch: boolean; // When true, always returns defaultValue
  targetingRules: ITargetingRule[];
  createdBy: string;
  updatedBy?: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ITargetingRule {
  type: 'tenant' | 'project' | 'percentage' | 'user_cohort';
  priority: number; // Lower = higher priority
  tenantIds?: string[]; // For type: 'tenant'
  projectIds?: string[]; // For type: 'project'
  percentage?: number; // For type: 'percentage' (0-100)
  cohortId?: string; // For type: 'user_cohort'
  value: unknown; // Value to return when rule matches
}
// Index: { tenantId: 1, key: 1 } (unique)
// Index: { key: 1 } (for platform-wide lookups)
```

## 4. API Design

### 4.1 Config Entry API

| Method | Path                                                   | Description                                  |
| ------ | ------------------------------------------------------ | -------------------------------------------- |
| POST   | `/api/projects/:projectId/config/entries`              | Create config entry                          |
| GET    | `/api/projects/:projectId/config/entries`              | List config entries (filtered by scope, env) |
| GET    | `/api/projects/:projectId/config/entries/:id`          | Get config entry                             |
| PUT    | `/api/projects/:projectId/config/entries/:id`          | Update config entry (requires `_v`)          |
| DELETE | `/api/projects/:projectId/config/entries/:id`          | Delete config entry                          |
| GET    | `/api/projects/:projectId/config/resolved`             | Get fully resolved config                    |
| GET    | `/api/projects/:projectId/config/entries/:id/history`  | Get version history                          |
| POST   | `/api/projects/:projectId/config/entries/:id/rollback` | Rollback to version                          |

### 4.2 Feature Flag API

| Method | Path                               | Description                 |
| ------ | ---------------------------------- | --------------------------- |
| POST   | `/api/config/flags`                | Create feature flag (ADMIN) |
| GET    | `/api/config/flags`                | List all flags              |
| GET    | `/api/config/flags/:key`           | Get flag definition         |
| PUT    | `/api/config/flags/:key`           | Update flag                 |
| DELETE | `/api/config/flags/:key`           | Delete flag                 |
| GET    | `/api/config/flags/:key/evaluate`  | Evaluate flag for context   |
| PUT    | `/api/config/flags/:key/targeting` | Update targeting rules      |
| POST   | `/api/config/flags/:key/kill`      | Activate kill switch        |
| DELETE | `/api/config/flags/:key/kill`      | Deactivate kill switch      |

### 4.3 Environment Promotion API

| Method | Path                          | Description            |
| ------ | ----------------------------- | ---------------------- |
| POST   | `/api/config/promote/dry-run` | Preview promotion diff |
| POST   | `/api/config/promote`         | Execute promotion      |
| GET    | `/api/config/export`          | Export config snapshot |
| POST   | `/api/config/import`          | Import config snapshot |

## 5. Service Architecture

### 5.1 ConfigEntryService

Handles CRUD operations on config entries. Delegates to `ConfigVersionService` for version tracking and `ConfigPropagationService` for cache invalidation.

### 5.2 ConfigResolutionService

Merges config values across the hierarchy. Takes a resolution context `{ tenantId, projectId, environment }` and returns the fully resolved config with source attribution. Wraps the existing `TenantConfigService.resolveEffectiveLimits()` pattern.

### 5.3 ConfigVersionService

Creates immutable version snapshots on every config change. Provides history, diff, and rollback operations. Uses the existing `diffConfigs()` function from `packages/config/src/validation/config-diff.ts`.

### 5.4 FeatureFlagService

Manages feature flag lifecycle and evaluation. Evaluation is a pure function:

1. Check `killSwitch` -> return `defaultValue`.
2. Check `enabled` -> if false, return `defaultValue`.
3. Evaluate `targetingRules` in priority order -> return first match's value.
4. Return `defaultValue`.

### 5.5 ConfigPropagationService

Manages cache invalidation across pods:

1. On config write: invalidate Redis L2 cache, publish to `config:changes` pub/sub channel.
2. Subscribers: receive pub/sub message, invalidate local L1 cache.
3. Fallback: `ConfigWatcher` polls for changes at 60s intervals.

## 6. Alternatives Considered

### Alternative A: LaunchDarkly / External Feature Flag Service

**Description**: Use an external SaaS feature flag provider instead of building in-house.

**Pros**:

- Mature targeting rules, A/B testing, analytics.
- No development cost for flag management.
- Battle-tested at scale.

**Cons**:

- External dependency for a critical path (feature flag evaluation in agent execution).
- Per-seat or per-evaluation pricing adds variable cost.
- Data residency concerns (flag evaluation context sent to external service).
- Does not solve the broader config management problem (only covers flags).

**Decision**: Rejected. Feature flags are on the hot path of agent execution (< 1ms target). External network call adds unacceptable latency and availability risk. The broader config management problem (hierarchy, versioning, promotion) still needs solving regardless.

### Alternative B: File-Based Configuration with Git as Source of Truth

**Description**: Store all configuration in YAML/JSON files in a Git repository. Use GitOps (ArgoCD) for deployment. No database-backed config.

**Pros**:

- Full change history via Git (commit log = audit trail).
- PRs as approval workflow for config changes.
- Works well with existing GitOps deployment (ArgoCD in `abl-platform-deploy`).
- Simple mental model: config-as-code.

**Cons**:

- Cannot support real-time config changes (requires Git push + deploy pipeline).
- Feature flag toggle latency: minutes (PR + CI/CD) vs seconds.
- No per-tenant or per-project config hierarchy (files are global).
- Git is not designed for high-frequency writes (flag evaluations, tenant overrides).
- Tenant admins cannot self-service config changes via UI.

**Decision**: Rejected for runtime config and feature flags. However, platform defaults and schema definitions CAN use file-based config (they change infrequently and benefit from GitOps review). The hybrid approach uses both: file-based for platform schemas, DB-backed for runtime overrides.

### Alternative C: etcd / Consul as Configuration Store

**Description**: Use etcd or HashiCorp Consul as a dedicated configuration store instead of MongoDB.

**Pros**:

- Purpose-built for configuration with watch/subscribe semantics.
- Strong consistency guarantees.
- Hierarchical key-value model fits config hierarchy.

**Cons**:

- Additional infrastructure dependency (the platform already runs MongoDB + Redis).
- Operational complexity of managing another stateful service.
- Limited query capabilities compared to MongoDB (no aggregation, no rich indexes).
- Existing patterns in the codebase use MongoDB + Redis for all shared state.

**Decision**: Rejected. Adding etcd/Consul introduces operational burden without sufficient benefit. MongoDB + Redis (already in the stack) provide equivalent functionality with the `ConfigWatcher` pattern already established.

## 7. Migration Strategy

### Phase 0: Foundation (Non-Breaking)

- Add new MongoDB models (`ConfigEntry`, `ConfigVersion`, `FeatureFlag`).
- Implement `ConfigEntryService`, `ConfigVersionService`, `FeatureFlagService`.
- No existing code changes. New API endpoints are additive.

### Phase 1: Dual-Write

- Runtime `TenantConfigService` writes config changes to both existing and new models.
- New API reads from new models. Existing APIs continue to work.
- Feature flags are available via new API only.

### Phase 2: Migration

- Migrate existing config data (tenant settings, plan defaults, project overrides) to new `ConfigEntry` model.
- Update admin dashboard to use new API.
- Deprecate direct `TenantConfigService.setOverrides()` calls.

### Phase 3: Cleanup

- Remove deprecated in-memory override pattern.
- Studio switches from local `TenantConfigService` to unified API.
- Remove dual-write logic.

## 8. Cross-Cutting Wiring

### 8.1 Package Dependencies

```
packages/config/         -- Schemas, types, validation (existing)
packages/database/       -- New models: ConfigEntry, ConfigVersion, FeatureFlag
packages/redis/          -- Pub/sub for propagation (existing)
apps/runtime/            -- Config API routes, service layer
apps/admin/              -- Config management UI routes
apps/studio/             -- Config read API consumer
```

### 8.2 Middleware Chain

All config API routes use the standard middleware chain:

1. `authMiddleware` -- JWT verification
2. `requireProjectScope('projectId')` -- tenant/project context extraction
3. `tenantRateLimit('request')` -- rate limiting
4. `requireProjectPermission(req, res, 'config:*')` -- RBAC

### 8.3 Dockerfile Updates

New models in `packages/database/` require no Dockerfile changes (already copied). If a new package is created (e.g., `packages/config-service/`), its `package.json` must be added to all app Dockerfiles per CLAUDE.md rules.
