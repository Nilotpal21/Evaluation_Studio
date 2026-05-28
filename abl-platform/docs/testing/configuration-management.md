# Test Spec: Configuration Management

- **Feature ID**: #45
- **Feature Spec**: `docs/features/configuration-management.md`
- **Status**: PLANNED
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22

---

## 1. Test Strategy Overview

Configuration Management is a cross-cutting platform concern that touches runtime, studio, admin, and the shared config/database packages. Testing must verify:

1. **Data integrity**: Config values resolve correctly through the hierarchy (platform -> tenant -> project -> env).
2. **Tenant isolation**: Cross-tenant config access returns 404, not 403.
3. **Feature flag evaluation**: Typed values, targeting rules, and kill switches work correctly.
4. **Real-time propagation**: Config changes reach running services within 30 seconds.
5. **Versioning and rollback**: Immutable snapshots, diff, and rollback work correctly.
6. **Validation**: Invalid config is rejected before persistence.
7. **Audit logging**: All writes and sensitive reads are logged.

All E2E tests interact via HTTP API only. No mocking of codebase components. No direct DB access.

## 2. E2E Test Scenarios

### E2E-001: Configuration CRUD with Tenant Isolation

**Covers**: FR-001, FR-002, FR-007

**Setup**: Start runtime on random port with full middleware chain (auth, rate limiting, tenant isolation).

**Steps**:

1. Authenticate as tenant-A admin via `/api/auth/dev-login`.
2. POST `/api/config/entries` to create a config entry `{ key: "max_retries", value: 5, scope: "tenant" }` for tenant-A.
3. GET `/api/config/entries?scope=tenant` and verify the entry is returned with `source: "tenant_override"`.
4. Authenticate as tenant-B admin.
5. GET `/api/config/entries?scope=tenant` and verify tenant-A's config entry is NOT visible (tenant-B sees only its own).
6. GET `/api/config/entries/{tenant-A-entry-id}` as tenant-B and verify 404 response (not 403).
7. PUT `/api/config/entries/{entry-id}` as tenant-A to update value to 10.
8. GET and verify updated value.
9. DELETE `/api/config/entries/{entry-id}` as tenant-A.
10. GET and verify 404.

**Assertions**:

- All CRUD operations return `{ success: true/false, data/error }` envelope.
- Cross-tenant access returns exactly 404 with no tenant-A data leaked.
- Audit log entries exist for create, update, delete operations.

### E2E-002: Configuration Hierarchy Resolution

**Covers**: FR-002, FR-006

**Setup**: Start runtime with seeded platform defaults, a tenant with BUSINESS plan, and a project with overrides.

**Steps**:

1. GET `/api/config/resolved?tenantId={tid}&projectId={pid}` to get the fully resolved config.
2. Verify `maxAgentsPerProject` equals the project override (not the plan default of 100).
3. Verify `requestsPerMinute` equals the BUSINESS plan default (1000) since no override exists.
4. POST a tenant-level override for `requestsPerMinute: 800`.
5. GET resolved config and verify `requestsPerMinute` is now 800.
6. POST a project-level override for `requestsPerMinute: 500`.
7. GET resolved config and verify `requestsPerMinute` is 500 (project wins over tenant).
8. DELETE the project override.
9. GET resolved config and verify `requestsPerMinute` falls back to 800 (tenant override).
10. DELETE the tenant override.
11. GET resolved config and verify `requestsPerMinute` falls back to 1000 (plan default).

**Assertions**:

- Each resolved value includes metadata: `{ value, source: "platform_default" | "tenant_override" | "project_override", overriddenBy? }`.
- Resolution order is deterministic: platform -> tenant -> project.

### E2E-003: Feature Flag Lifecycle

**Covers**: FR-003, FR-005, FR-007

**Setup**: Start runtime with auth and Redis running.

**Steps**:

1. POST `/api/config/flags` to create a boolean flag `{ key: "new_dashboard", type: "boolean", defaultValue: false }`.
2. GET `/api/config/flags/new_dashboard/evaluate?tenantId={tid}` and verify result is `false`.
3. PUT `/api/config/flags/new_dashboard/targeting` to enable for tenant-A: `{ rules: [{ type: "tenant", tenantIds: ["{tid-A}"], value: true }] }`.
4. Evaluate for tenant-A and verify `true`.
5. Evaluate for tenant-B and verify `false` (default).
6. PUT to add percentage rollout rule: `{ rules: [..., { type: "percentage", percentage: 100, value: true }] }`.
7. Evaluate for tenant-B and verify `true` (100% rollout catches all).
8. POST `/api/config/flags/new_dashboard/kill` to trigger kill switch.
9. Evaluate for both tenants and verify `false` (kill switch overrides all rules).
10. DELETE the kill switch.
11. Evaluate and verify rules are restored.

**Assertions**:

- Flag evaluation is consistent across repeated calls.
- Audit log records each targeting change with before/after values.
- Kill switch takes effect immediately (< 5 second tolerance in test).

### E2E-004: Configuration Versioning and Rollback

**Covers**: FR-004, FR-007

**Setup**: Start runtime with auth.

**Steps**:

1. POST a config entry `{ key: "session_timeout_ms", value: 30000, scope: "tenant" }`. Record version_1.
2. PUT to update value to 60000. Record version_2.
3. PUT to update value to 90000. Record version_3.
4. GET `/api/config/entries/{id}/history` and verify 3 versions with correct values and timestamps.
5. GET `/api/config/entries/{id}/history/{version_1_id}` and verify snapshot contains `value: 30000`.
6. POST `/api/config/entries/{id}/rollback` with `{ targetVersion: version_1_id }`.
7. GET current value and verify it is 30000.
8. GET history and verify version_4 exists (rollback creates new version, not destructive).
9. Verify version_4 metadata includes `{ rollbackFrom: version_3_id, rollbackTo: version_1_id }`.

**Assertions**:

- History is append-only; no version is ever deleted.
- Rollback to a version that violates current schema returns validation error.
- Each version snapshot includes actor, timestamp, and diff from previous.

### E2E-005: Environment Promotion with Validation

**Covers**: FR-008, FR-006

**Setup**: Start runtime with auth. Create config entries in dev environment.

**Steps**:

1. POST multiple config entries in `dev` environment: `session_timeout: 30000`, `max_retries: 3`, `log_level: "debug"`.
2. POST `/api/config/promote/dry-run` with `{ source: "dev", target: "staging" }`.
3. Verify response includes diff: all 3 entries marked as "added" in staging.
4. POST `/api/config/promote` with `{ source: "dev", target: "staging", keys: ["session_timeout", "max_retries"] }` (selective promotion).
5. GET config entries in staging and verify only `session_timeout` and `max_retries` exist (not `log_level`).
6. PUT `session_timeout` in dev to 60000.
7. POST dry-run promotion and verify diff shows `session_timeout` as "changed" (30000 -> 60000).
8. POST promotion with a deliberately invalid value (e.g., `session_timeout: "not_a_number"` injected into dev).
9. Verify promotion is blocked with validation error.

**Assertions**:

- Dry-run returns complete diff without modifying target environment.
- Selective promotion only copies specified keys.
- Validation errors block promotion and return structured error with path and expected type.

### E2E-006: Configuration Import/Export Round-Trip

**Covers**: FR-010

**Setup**: Start runtime with auth. Create config entries across scopes and environments.

**Steps**:

1. Create 5 config entries: 2 platform, 2 tenant, 1 project-scoped.
2. GET `/api/config/export?format=json` and store the exported JSON.
3. Verify the export contains all 5 entries with metadata (scope, environment, version).
4. DELETE all config entries.
5. POST `/api/config/import` with the exported JSON.
6. GET all config entries and verify all 5 are restored with correct values.
7. Verify imported entries have new version IDs (import creates fresh versions).

**Assertions**:

- Export format includes schema version for forward compatibility.
- Import validates against current schema before persisting.
- Import is idempotent: re-importing the same file does not create duplicates.

### E2E-007: Concurrent Config Updates with Optimistic Locking

**Covers**: FR-001, FR-004

**Setup**: Start runtime with auth.

**Steps**:

1. Create a config entry and note its `_v` (version number).
2. Start two concurrent PUT requests both referencing `_v: 1`.
3. One succeeds (returns `_v: 2`), the other fails with 409 Conflict.
4. The failing client re-reads, gets `_v: 2`, retries the PUT.
5. Verify the retry succeeds with `_v: 3`.

**Assertions**:

- Optimistic concurrency control prevents lost updates.
- 409 response includes the current version for client retry.

## 3. Integration Test Scenarios

### INT-001: Redis Cache Invalidation on Config Update

**Covers**: FR-005, NFR-001

**Setup**: TenantConfigService with real Redis and MongoDB (MongoMemoryServer).

**Steps**:

1. Call `getConfigAsync(tenantId)` to populate Redis cache (`cfg:{tenantId}`).
2. Verify Redis key exists with TTL.
3. Update tenant config in MongoDB directly (simulating a write).
4. Call `invalidateCache(tenantId)`.
5. Verify Redis key is deleted.
6. Call `getConfigAsync(tenantId)` again.
7. Verify new value is returned (loaded from DB, not stale cache).

**Assertions**:

- Cache hit returns within < 5ms.
- Cache miss triggers DB load and writes back to Redis.
- Invalidation removes the correct key without affecting other tenants.

### INT-002: Feature Flag Evaluation with Targeting Rules

**Covers**: FR-003, NFR-008

**Setup**: FeatureFlagService with real MongoDB.

**Steps**:

1. Create a flag with multiple targeting rules: tenant allowlist + percentage rollout + default.
2. Evaluate for a tenant in the allowlist. Verify rule match.
3. Evaluate for a tenant NOT in the allowlist. Verify percentage rollout applies.
4. Evaluate with kill switch active. Verify default returned regardless of rules.
5. Evaluate a flag with JSON value type. Verify the full JSON object is returned.
6. Evaluate with invalid tenantId. Verify default value returned (not error).

**Assertions**:

- Evaluation order: kill switch > tenant rules > percentage > default.
- Evaluation latency < 1ms with warm cache.
- JSON flags return parsed objects, not strings.

### INT-003: Configuration Schema Validation

**Covers**: FR-006

**Setup**: ConfigValidationService with Zod schemas.

**Steps**:

1. Submit a valid config change. Verify it passes validation.
2. Submit with wrong type (string where number expected). Verify structured error with path.
3. Submit with value exceeding plan limits (FREE plan, maxAgentsPerProject: 100). Verify rejection with plan-specific error.
4. Submit with unknown key. Verify rejection (strict schema mode).
5. Submit dry-run with valid change. Verify success response but no DB write.
6. Submit dry-run with invalid change. Verify error response with no side effects.

**Assertions**:

- Validation errors include: `{ path, expected, received, message }`.
- Plan-limit validation provides the plan name and maximum allowed value.
- Dry-run never writes to DB (verified by checking version count before/after).

### INT-004: Config Diff and History Service

**Covers**: FR-004, FR-008

**Setup**: ConfigVersionService with real MongoDB.

**Steps**:

1. Create a config entry (version 1).
2. Update it 3 times (versions 2, 3, 4).
3. Call `getHistory(entryId)` and verify 4 versions ordered by timestamp desc.
4. Call `diff(version1, version4)` and verify the diff shows all changed fields.
5. Call `diff(version3, version4)` and verify only the last change is shown.
6. Verify each version snapshot is immutable (attempting to modify returns error).
7. Verify sensitive fields are masked in diff output.

**Assertions**:

- Diff uses the existing `diffConfigs` function from `packages/config/src/validation/config-diff.ts`.
- Sensitive paths (jwt.secret, encryption.masterKey, etc.) are masked with `***`.
- Version snapshots include actor ID and timestamp.

### INT-005: Redis Pub/Sub Configuration Propagation

**Covers**: FR-005, NFR-004

**Setup**: Two instances of ConfigPropagationService connected to the same Redis.

**Steps**:

1. Instance A subscribes to `config:changes` channel.
2. Instance B publishes a config change event: `{ tenantId, key, newValue, version }`.
3. Verify Instance A receives the event within 1 second.
4. Verify Instance A's local cache is invalidated for the affected tenant.
5. Verify Instance A's next `getConfigAsync` call returns the new value.
6. Test with Redis disconnection: verify polling fallback triggers within `intervalMs`.

**Assertions**:

- Pub/sub message format is well-defined and versioned.
- Cache invalidation is targeted (only affected tenant, not global flush).
- Polling fallback activates when pub/sub is unavailable.

### INT-006: Audit Log Integration for Config Changes

**Covers**: FR-007

**Setup**: ConfigService with real MongoDB and audit logging.

**Steps**:

1. Create a config entry. Query audit log for `config:create` action.
2. Update the entry. Query audit log for `config:update` action.
3. Verify audit log entries include: `{ action, tenantId, userId, metadata: { key, oldValue, newValue, version } }`.
4. For sensitive keys, verify `oldValue` and `newValue` are masked in audit log.
5. Delete the entry. Query audit log for `config:delete` action.
6. Perform a rollback. Query audit log for `config:rollback` action with source and target version.

**Assertions**:

- Every write operation produces exactly one audit log entry.
- Audit entries are tenant-scoped (querying tenant-B's audit log does not show tenant-A's changes).
- Sensitive value masking in audit log matches `SENSITIVE_PATHS` list.

### INT-007: Plan-Based Configuration Limits

**Covers**: FR-002, FR-006

**Setup**: TenantConfigService with real MongoDB, tenants on different plans.

**Steps**:

1. Create a FREE-tier tenant. Attempt to set `maxAgentsPerProject: 100`. Verify rejection (FREE limit is 3).
2. Create a BUSINESS-tier tenant. Set `maxAgentsPerProject: 50`. Verify success (within BUSINESS limit of 100).
3. Create an ENTERPRISE-tier tenant. Set `maxAgentsPerProject: 500`. Verify success (ENTERPRISE is unlimited = -1).
4. Attempt to set a project override that exceeds the tenant's plan limit. Verify rejection.
5. Upgrade a tenant from FREE to TEAM. Verify previously rejected override now succeeds.

**Assertions**:

- Plan limits are enforced at write time, not just read time.
- `-1` (unlimited) correctly bypasses limit checks.
- Plan upgrades immediately unlock higher limits.

## 4. Coverage Matrix

| Functional Requirement     | E2E Tests                 | Integration Tests |
| -------------------------- | ------------------------- | ----------------- |
| FR-001: Unified Config API | E2E-001, E2E-007          | INT-001           |
| FR-002: Config Hierarchy   | E2E-002                   | INT-007           |
| FR-003: Feature Flags      | E2E-003                   | INT-002           |
| FR-004: Versioning         | E2E-004, E2E-007          | INT-004           |
| FR-005: Propagation        | E2E-003                   | INT-001, INT-005  |
| FR-006: Validation         | E2E-002, E2E-005          | INT-003, INT-007  |
| FR-007: Audit Logging      | E2E-001, E2E-003, E2E-004 | INT-006           |
| FR-008: Environment Mgmt   | E2E-005                   | INT-004           |
| FR-009: Admin Dashboard    | (UI tests, separate)      | -                 |
| FR-010: Import/Export      | E2E-006                   | -                 |

## 5. Test Infrastructure Requirements

| Requirement         | Solution                                                       |
| ------------------- | -------------------------------------------------------------- |
| MongoDB             | MongoMemoryServer for integration; real MongoDB for E2E        |
| Redis               | Real Redis instance (Docker or local)                          |
| Auth tokens         | Dev-login endpoint for JWT generation                          |
| Multiple tenants    | Seed script creates tenant-A and tenant-B with different plans |
| Concurrent requests | Use `Promise.all` with proper isolation per request            |

## 6. Non-Functional Test Scenarios

| NFR                                     | Test Approach                                                    |
| --------------------------------------- | ---------------------------------------------------------------- |
| NFR-001: Read latency < 5ms (cached)    | INT-001: Measure `getConfigAsync` with warm cache; assert < 5ms  |
| NFR-002: Read latency < 50ms (uncached) | INT-001: Measure cold read; assert < 50ms                        |
| NFR-004: Propagation < 30s              | INT-005: Measure pub/sub delivery; assert < 1s (sub-requirement) |
| NFR-008: Flag eval < 1ms                | INT-002: Benchmark 1000 evaluations; assert p99 < 1ms            |
