# Feature: Environment Variables

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `governance`, `enterprise`
**Package(s)**: `@agent-platform/database`, `@agent-platform/config`, `@abl/compiler`, `apps/runtime`, `apps/studio`
**Owner(s)**: Platform Team
**Testing Guide**: `../testing/environment-variables.md`
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

Agents reference external API keys, endpoints, credentials, and configuration values at runtime via `{{env.KEY}}` placeholders. Without a robust environment variable system, users must hardcode these values into agent DSL files, creating security risks (credentials in source control), operational friction (manual edits when promoting agents across dev/staging/production), and no way to enforce least-privilege access per tool.

The current implementation (ALPHA) has critical bugs that break core functionality: base value fallback silently fails at runtime, the create API rejects base values, and namespace-filtered listing returns incorrect pagination. These bugs undermine the reliability of the entire variable system.

### Goal Statement

Make environment variables fully reliable, robust, and production-ready (STABLE status). Fix all critical bugs, close P1/P2 gaps (base value UI, variable diff view), and ensure the resolution chain works correctly in all paths — runtime, snapshots, Studio tool testing, and deployment validation.

### Summary

Environment variables are encrypted key-value pairs scoped to `(tenantId, projectId, environment)` with an optional base value (`environment: null`) that serves as a default. At runtime, agents resolve `{{env.KEY}}` through a multi-layer chain: session cache -> env-specific DB lookup -> base fallback -> undefined. Variables are organized into namespaces for per-tool access control. At deploy time, resolved values are frozen into immutable snapshots. The system supports copy between environments, pre-deploy validation, and bulk import.

---

## 2. Scope

### Goals

- Fix all critical bugs in the environment variables system (base fallback, create route, pagination)
- Close P1 gaps: base value UI in Studio, runtime base fallback in all resolution paths
- Close P2 gaps: variable diff view between environments, bulk export/import
- Achieve STABLE status with full E2E and integration test coverage
- Ensure all 3 resolution paths (runtime secrets provider, Studio tool-test-service, snapshot service) handle base fallback consistently

### Non-Goals (Out of Scope)

- Deprecation of config variables or tool secrets (they remain independent systems)
- Migration of existing config variable or tool secret data into env vars
- Changes to `{{config.KEY}}` or `{{secrets.KEY}}` syntax or resolution
- Dynamic user-defined environments (future, P3)
- Variable versioning / change history (future, P3)
- Changes to config variable or tool secret APIs, UI, or models

---

## 3. User Stories

1. As a **project developer**, I want to create a base variable (`environment: null`) via the API so that all environments share a default value without duplication.
2. As a **project developer**, I want the runtime to automatically fall back to base values when no environment-specific override exists so that my agents don't fail with undefined variables.
3. As a **project developer**, I want to manage base variables in the Studio UI so that I can set defaults without using the API directly.
4. As a **project developer**, I want to see a diff between two environments' variables so that I can identify what differs before promoting.
5. As a **project developer**, I want namespace-filtered variable lists to paginate correctly so that I can browse large variable sets without missing entries.
6. As a **project developer**, I want to export my variables to a file and import them into another project/environment so that I can replicate setups efficiently.
7. As a **project developer**, I want pre-deploy validation to check base variable coverage so that missing variables are caught even when no environment-specific override exists.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept `environment: null` in the create endpoint to store base values. _(BUG FIX — currently rejected by falsy check at `environment-variables.ts:120`)_
2. **FR-2**: The runtime `EnvVarStore.findEnvVar()` must query for environment-specific value first, then fall back to `environment: null` if not found. _(BUG FIX — currently no fallback in `llm-wiring.ts:253-293`)_
3. **FR-3**: The `RuntimeSecretsProvider.getEnvVar()` must propagate the base fallback from the store correctly via its cache layer.
4. **FR-4**: Namespace-filtered variable listing must filter at the database query level (before pagination), not post-pagination. _(BUG FIX — `environment-variables.ts:353-356`)_
5. **FR-5**: The Studio UI must provide a "Base" tab/section for managing variables with `environment: null`, distinct from environment-specific tabs.
6. **FR-6**: The system must provide a diff endpoint that compares variables between two environments (or between base and an environment), returning added/removed/changed keys.
7. **FR-7**: The system must support bulk export of variables to JSON format and bulk import from JSON, with overwrite control.
8. **FR-8**: Pre-deploy validation must check both environment-specific and base variable definitions when reporting missing `{{env.KEY}}` references.
9. **FR-9**: The snapshot service must continue to deduplicate base+override correctly (override wins for same key).
10. **FR-10**: All three resolution paths (runtime secrets provider, Studio tool-test-service, snapshot service) must handle base fallback identically.
11. **FR-11**: The `envVarCache` in `RuntimeSecretsProvider` must distinguish between "not cached" and "cached as undefined" to avoid redundant DB queries for missing keys.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                         |
| -------------------------- | ------------ | ------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Variables are project-scoped, deployed with projects          |
| Agent lifecycle            | PRIMARY      | Agents resolve `{{env.KEY}}` at runtime                       |
| Customer experience        | SECONDARY    | Indirect — agents fail if variables are misconfigured         |
| Integrations / channels    | SECONDARY    | Tool HTTP bindings use env vars for auth tokens and endpoints |
| Observability / tracing    | SECONDARY    | Resolution logging, cache hit rates, audit trail              |
| Governance / controls      | PRIMARY      | Namespace scoping enforces least-privilege per tool           |
| Enterprise / compliance    | PRIMARY      | Encryption at rest, audit logging, tenant isolation           |
| Admin / operator workflows | SECONDARY    | Admin proxy routes env var management through Studio          |

### Related Feature Integration Matrix

| Related Feature                     | Relationship Type | Why It Matters                                                    | Key Touchpoints                                           | Current State |
| ----------------------------------- | ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------- |
| Deployments & Versioning            | depends on        | Snapshots freeze variable state at deploy time                    | `snapshot-service.ts`, `deployment-repo.ts`               | Implemented   |
| Variable Namespaces & Tool Auto-Tag | extends           | Namespaces scope variable visibility per tool                     | `VariableNamespaceMembership`, `VariableNamespace` models | Implemented   |
| Auth Profiles                       | shares data with  | Secrets provider checks auth profiles before env vars             | `RuntimeSecretsProvider.resolveFromAuthProfile()`         | Implemented   |
| Config Variables                    | parallel system   | Separate plaintext variable system, resolved via `{{config.KEY}}` | `ProjectConfigVariable` model, `ConfigVarStore`           | Independent   |
| Tool Secrets                        | parallel system   | Separate encrypted per-tool secret system                         | `ToolSecret` model, `ToolSecretStore`                     | Independent   |
| Encryption at Rest                  | depends on        | Env var values encrypted with tenant-scoped AES-256-GCM           | `encryptionPlugin`, `EncryptionService`                   | Implemented   |
| Project Import/Export               | configured by     | `core-assembler.ts` includes env vars in project export           | `packages/project-io/src/export/layer-assemblers/`        | Implemented   |

---

## 6. Design Considerations

### Base Value UI

The Studio `EnvironmentVariablesSection` component is currently scoped to a single `environment` prop. To support base values:

- Add a "Base (Default)" pseudo-tab or section above the environment-specific tabs in `EnvironmentsTab.tsx`
- Pass `environment: null` to the API when managing base variables
- Show base values with a visual indicator (e.g., "default" badge) in environment-specific views when they serve as fallback

### Variable Diff View

- Add a "Compare" action in the deployments UI that lets users pick two environments
- Show a side-by-side or unified diff: added (only in target), removed (only in source), changed (different values)
- Use the existing `computeSnapshotDiff()` in `snapshot-service.ts` as a starting point, but operate on live variables (not just snapshots)

---

## 7. Technical Considerations

### Bug Fix: Create Route Rejects Base Values

**File:** `apps/runtime/src/routes/environment-variables.ts:120`
**Bug:** `if (!environment || !key || !value)` treats `null` environment as falsy.
**Fix:** Change to `if (environment === undefined || !key || value === undefined || value === null)`. The `environment` field is intentionally nullable (base values).

### Bug Fix: Runtime Base Fallback Missing

**File:** `apps/runtime/src/services/execution/llm-wiring.ts:253-293`
**Bug:** `EnvVarStore.findEnvVar()` queries only for the exact environment. No second query for `environment: null`.
**Fix:** Add a second query in `findEnvVar()` when the first returns null: query with `environment: null` (same key, tenantId, projectId). This mirrors what `tool-test-service.ts:226-234` already does correctly.

### Bug Fix: Namespace Pagination

**File:** `apps/runtime/src/routes/environment-variables.ts:353-356`
**Bug:** Namespace filtering happens after `skip`/`take` pagination, so filtered results may be incomplete.
**Fix:** When `namespaceId` is provided, use a MongoDB aggregation pipeline with `$lookup` on `VariableNamespaceMembership` to filter before pagination. Apply `$skip` and `$limit` after the join.

### Cache Correctness

**File:** `apps/runtime/src/services/secrets-provider.ts:232-270`
The `envVarCache` uses `Map.get()` which returns `undefined` for missing keys — indistinguishable from "key not in cache". Use a sentinel value or `Map.has()` to distinguish "not cached" from "cached as not found".

---

## 8. How to Consume

### Studio UI

- **Environment Variables Section** (`EnvironmentVariablesSection.tsx`): Per-environment variable management with inline edit, secret masking, search, namespace filtering
- **Base Variables Tab** (NEW): Manage `environment: null` variables in `EnvironmentsTab.tsx`
- **Variable Diff View** (NEW): Compare variables between environments
- **Manage Namespaces Panel** (`ManageVariableNamespacesPanel.tsx`): Create/edit/delete variable namespaces
- **Entry point:** Deployments page -> Environment tab -> Variables section

### API (Runtime)

All mounted at `/api/projects/:projectId/env-vars`

| Method | Path         | Purpose                                                                   |
| ------ | ------------ | ------------------------------------------------------------------------- |
| POST   | `/`          | Create variable (environment nullable for base)                           |
| GET    | `/`          | List variables (optional `environment`, `namespaceId` filter, pagination) |
| GET    | `/:id/value` | Get decrypted value for single variable                                   |
| PUT    | `/:id`       | Update value, isSecret, description, namespace assignments                |
| DELETE | `/:id`       | Delete variable and its namespace memberships                             |
| POST   | `/copy`      | Copy variables from source to target environment                          |
| POST   | `/validate`  | Validate env var references against definitions                           |
| GET    | `/diff`      | **(NEW)** Compare variables between two environments                      |
| POST   | `/export`    | **(NEW)** Export variables to JSON                                        |
| POST   | `/import`    | **(NEW)** Import variables from JSON with overwrite control               |

### API (Studio)

| Method | Path                  | Purpose                          |
| ------ | --------------------- | -------------------------------- |
| GET    | `/api/admin/env-vars` | Proxy to runtime env-vars list   |
| POST   | `/api/admin/env-vars` | Proxy to runtime env-vars create |
| PUT    | `/api/admin/env-vars` | Proxy to runtime env-vars update |
| DELETE | `/api/admin/env-vars` | Proxy to runtime env-vars delete |

### Admin Portal

Environment variables are managed through Studio's admin proxy. No separate admin-specific endpoints.

### Channel / SDK / Voice / A2A / MCP Integration

Environment variables are resolved transparently at runtime. Channel integrations don't interact with env vars directly — they consume the resolved values through the agent's tool execution chain.

---

## 9. Data Model

### Collections / Tables

```text
Collection: environment_variables
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - environment: string | null (enum: ['dev','staging','production', null])
  - key: string (required, uppercase-normalized)
  - encryptedValue: string (AES-256-GCM ciphertext)
  - isSecret: boolean (default: false)
  - description: string | null
  - createdBy: string (required)
  - updatedBy: string | null
  - _v: number (optimistic concurrency)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1, key: 1 } (unique)
  - { tenantId: 1, projectId: 1, environment: 1 }
Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin (fieldsToEncrypt: ['encryptedValue'])
  - auditTrailPlugin
```

```text
Collection: variable_namespaces
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required)
  - projectId: string (required)
  - name: string (required)
  - isDefault: boolean
  - createdBy: string
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
```

```text
Collection: variable_namespace_memberships
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required)
  - projectId: string (required)
  - namespaceId: string (required)
  - variableId: string (required)
  - variableType: string (enum: ['env', 'config'])
Indexes:
  - { tenantId: 1, namespaceId: 1, variableId: 1, variableType: 1 } (unique)
  - { variableId: 1, variableType: 1 }
```

```text
Collection: deployment_variable_snapshots
Fields:
  - _id: string (uuidv7)
  - tenantId: string
  - projectId: string
  - deploymentId: string (unique index)
  - environment: string
  - snapshotVersion: number
  - snapshotHash: string (SHA-256 integrity)
  - envVars: Array<{ key, encryptedValue, isSecret, description, sourceId, namespaces }>
  - configVars: Array<{ key, value, description, sourceId, namespaces }>
  - createdBy: string
  - createdAt: Date
```

### Key Relationships

- Environment variables are scoped to projects via `projectId`
- Variables belong to namespaces via `variable_namespace_memberships` (M:N)
- Tools are linked to namespaces; at runtime, only variables in the tool's namespaces are resolved
- Deployment snapshots reference the source variable IDs via `sourceId` for traceability
- The secrets provider aggregates env vars, config vars, tool secrets, and auth profiles in a prioritized resolution chain

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/database/src/models/environment-variable.model.ts`          | Mongoose schema with encryption plugin                  |
| `packages/database/src/models/variable-namespace.model.ts`            | Namespace model                                         |
| `packages/database/src/models/variable-namespace-membership.model.ts` | M:N membership model                                    |
| `packages/database/src/models/deployment-variable-snapshot.model.ts`  | Immutable snapshot model                                |
| `packages/config/src/environment.ts`                                  | `VALID_ENVIRONMENTS`, `normalizeEnvironment()`          |
| `apps/runtime/src/services/secrets-provider.ts`                       | Multi-layer resolution chain                            |
| `apps/runtime/src/services/snapshot-service.ts`                       | Snapshot creation + diff computation                    |
| `apps/runtime/src/services/execution/llm-wiring.ts`                   | EnvVarStore, ConfigVarStore, ToolSecretStore singletons |

### Routes / Handlers

| File                                                           | Purpose                          |
| -------------------------------------------------------------- | -------------------------------- |
| `apps/runtime/src/routes/environment-variables.ts`             | CRUD + copy + validate endpoints |
| `apps/runtime/src/repos/security-repo.ts`                      | DB access functions for env vars |
| `apps/runtime/src/repos/variable-namespace-membership-repo.ts` | Namespace membership DB access   |
| `apps/runtime/src/repos/variable-namespace-repo.ts`            | Namespace DB access              |

### UI Components

| File                                                                     | Purpose                                  |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` | Per-environment variable table with CRUD |
| `apps/studio/src/components/deployments/EnvironmentsTab.tsx`             | Environment tab container                |
| `apps/studio/src/components/deployments/CopyVariablesDialog.tsx`         | Copy between environments dialog         |
| `apps/studio/src/components/variables/VariableNamespaceDropdown.tsx`     | Namespace filter dropdown                |
| `apps/studio/src/components/variables/VariableNamespaceTagPopover.tsx`   | Inline namespace tag editor              |
| `apps/studio/src/components/variables/ManageVariableNamespacesPanel.tsx` | Namespace CRUD panel                     |
| `apps/studio/src/api/environment-variables.ts`                           | API client functions                     |
| `apps/studio/src/hooks/useEnvVars.ts`                                    | SWR hook for env var management          |

### Jobs / Workers / Background Processes

| File | Purpose                                                              |
| ---- | -------------------------------------------------------------------- |
| N/A  | No background jobs — all operations are synchronous request-response |

### Tests

| File                                                             | Type        | Coverage Focus                           |
| ---------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `apps/runtime/src/__tests__/environment-variables-authz.test.ts` | integration | RBAC permission checks                   |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`     | integration | Cross-project variable isolation         |
| `packages/config/src/__tests__/environment.test.ts`              | unit        | normalizeEnvironment, VALID_ENVIRONMENTS |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`            | unit        | Resolution chain logic                   |
| `apps/studio/src/__tests__/tool-test-service.test.ts`            | unit        | Studio tool test variable resolution     |

---

## 11. Configuration

### Environment Variables

| Variable                   | Default | Description                                            |
| -------------------------- | ------- | ------------------------------------------------------ |
| `ENCRYPTION_MASTER_KEY`    | (none)  | Master key for tenant-scoped AES-256-GCM encryption    |
| `MAX_ENV_VARS_PER_PROJECT` | 500     | Maximum variables per project (from compiler/platform) |

### Runtime Configuration

- `MAX_VARIABLE_NAMESPACES_PER_VARIABLE`: Maximum namespaces a single variable can belong to (from `@abl/compiler/platform`)
- `VALID_ENVIRONMENTS`: `['dev', 'staging', 'production']` (from `@agent-platform/config`)

### DSL / Agent IR / Schema

Variables are referenced in agent DSL files using `{{env.KEY}}` syntax. The compiler preserves these as placeholder strings in the IR. At runtime, the `SecretsProvider.getEnvVar()` method resolves them.

```yaml
# Example in agent DSL
tools:
  - name: weather_api
    http:
      url: '{{env.WEATHER_API_URL}}'
      headers:
        Authorization: 'Bearer {{env.WEATHER_API_KEY}}'
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every query includes `projectId`. Cross-project access returns 404. Enforced by `requireProjectScope` middleware. |
| Tenant isolation  | Every query includes `tenantId` via `tenantIsolationPlugin`. Cross-tenant access returns 404.                     |
| User isolation    | Variables are project-scoped (not user-scoped). Access controlled by project role permissions.                    |

### Security & Compliance

- **Encryption at rest**: All values encrypted with tenant-scoped AES-256-GCM via Mongoose `encryptionPlugin`
- **Snapshot security**: Snapshots store raw ciphertext (encryption plugin post-find hook bypassed by omitting `ire`/`tenantId` from `.select()`)
- **Permission model**: `env_var:create`, `env_var:read`, `env_var:update`, `env_var:delete` via `requireProjectPermission`
- **Rate limiting**: `tenantRateLimit('request')` on all routes
- **Audit logging**: All mutations logged via `writeAuditLog()` with action, tenantId, userId, metadata
- **Secret masking**: `isSecret: true` variables have values masked in list responses (value only exposed via `/:id/value`)
- **Cross-tenant 404**: Returns 404 (not 403) to avoid leaking resource existence

### Performance & Scalability

- **Session cache**: `RuntimeSecretsProvider` maintains per-session `envVarCache` Map to avoid repeated DB+decrypt on hot path
- **Singleton stores**: `EnvVarStore`, `ConfigVarStore`, `ToolSecretStore` are lazy-init singletons per pod (not per session)
- **Pagination**: List endpoint supports `page`/`limit` with max 100 per page
- **Variable count limit**: `MAX_ENV_VARS_PER_PROJECT` prevents unbounded growth
- **Snapshot integrity**: SHA-256 hash over sorted variable keys+values for tamper detection

### Reliability & Failure Modes

- **Decrypt failure**: If decryption fails for a variable (e.g., key rotation), the variable is skipped with a warning log. Other variables continue resolving.
- **Concurrent deployments**: Partial unique index on `(projectId, environment)` where `status: 'active'` + E11000 handling prevents duplicate active deployments
- **Copy with decrypt failures**: Source variables that fail decryption are skipped and counted in `decryptionFailed` response field
- **Cache miss on undefined**: Must use sentinel pattern to distinguish "not in cache" from "cached as undefined" to avoid retry storms

### Observability

| Metric/Log                         | Source                                                   |
| ---------------------------------- | -------------------------------------------------------- |
| Variables created/updated/deleted  | Audit log (`env-variable:create/update/delete`)          |
| Variable resolution cache hit rate | `RuntimeSecretsProvider` debug logs                      |
| Base fallback usage frequency      | `secrets-provider` debug log `layer: 'envVarStore-base'` |
| Snapshot creation latency          | `snapshot-service` logs                                  |
| Copy operation volume              | Audit log (`env-variable:copy`)                          |
| Validation failures pre-deploy     | Validate endpoint responses                              |
| Decrypt failures                   | `secrets-provider` error logs                            |

### Data Lifecycle

- **No TTL**: Variables persist until explicitly deleted
- **Cascade delete**: `deleteEnvironmentVariable` also deletes `VariableNamespaceMembership` records
- **Snapshot immutability**: Snapshots are append-only, never updated after creation
- **Right to erasure**: Deleting a variable removes it from the collection and namespace memberships. Existing snapshots retain the ciphertext (no plaintext to erase).

---

## 13. Delivery Plan / Work Breakdown

1. **Bug Fixes (Critical)**
   1.1 Fix create route to accept `environment: null` for base values
   1.2 Add base fallback in `EnvVarStore.findEnvVar()` (llm-wiring.ts) — two-query pattern
   1.3 Fix namespace pagination — use aggregation pipeline for pre-pagination filtering
   1.4 Fix `envVarCache` sentinel value for "cached as not found" vs "not cached"

2. **Runtime Resolution Consistency**
   2.1 Verify `RuntimeSecretsProvider.getEnvVar()` propagates base fallback correctly
   2.2 Verify `tool-test-service.ts` base fallback is working (already implemented, needs test)
   2.3 Update pre-deploy validation to check base variables when reporting missing keys
   2.4 Add base fallback to namespace-scoped resolution path in EnvVarStore

3. **Studio UI Enhancements**
   3.1 Add "Base (Default)" tab in EnvironmentsTab for `environment: null` variables
   3.2 Show base value indicator in environment-specific views (fallback badge)
   3.3 Add variable diff view — compare two environments side-by-side

4. **New Endpoints**
   4.1 GET `/diff` — compare variables between two environments
   4.2 POST `/export` — export variables to JSON
   4.3 POST `/import` — import variables from JSON with overwrite control

5. **Testing**
   5.1 E2E: Full CRUD lifecycle including base values
   5.2 E2E: Base+override resolution via deployment snapshot
   5.3 E2E: Copy between environments
   5.4 E2E: Namespace-scoped resolution
   5.5 E2E: Pre-deploy validation with base fallback
   5.6 Integration: RuntimeSecretsProvider base fallback
   5.7 Integration: Namespace pagination correctness
   5.8 Integration: Snapshot base+override dedup
   5.9 Integration: Cache sentinel correctness
   5.10 Integration: Concurrent deployment safety

---

## 14. Success Metrics

| Metric                                        | Baseline             | Target            | How Measured                              |
| --------------------------------------------- | -------------------- | ----------------- | ----------------------------------------- |
| Base value resolution success rate            | 0% (broken)          | 100%              | E2E test + runtime logs                   |
| Create API accepts base values                | Rejected (400)       | Accepted (201)    | E2E test                                  |
| Namespace-filtered list accuracy              | Incorrect after p1   | Correct all pages | E2E test with >50 vars + namespace filter |
| E2E test scenario count                       | 0                    | >= 5              | Test suite                                |
| Integration test scenario count               | 2 (authz, isolation) | >= 5              | Test suite                                |
| Variable resolution latency (cached)          | N/A                  | < 1ms             | Benchmark                                 |
| Variable resolution latency (cold, with base) | N/A                  | < 50ms            | Benchmark                                 |

---

## 15. Open Questions

1. Should the diff endpoint compare live variables or snapshot-to-snapshot? (Recommendation: live variables, with optional snapshot comparison)
2. Should bulk export include namespace membership data, or just key-value pairs?
3. Should the base value UI show which environment-specific overrides exist for each base key?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                  | Severity | Status |
| ------- | ---------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Create route rejects `environment: null` (base values) — falsy check bug     | CRITICAL | Open   |
| GAP-002 | Runtime EnvVarStore has no base fallback — `environment: null` never queried | CRITICAL | Open   |
| GAP-003 | Namespace pagination filters post-query — incorrect page results             | HIGH     | Open   |
| GAP-004 | envVarCache cannot distinguish "not cached" from "cached as undefined"       | HIGH     | Open   |
| GAP-005 | Studio UI has no base value management                                       | HIGH     | Open   |
| GAP-006 | No variable diff view between environments                                   | MEDIUM   | Open   |
| GAP-007 | No bulk export/import to file                                                | MEDIUM   | Open   |
| GAP-008 | Pre-deploy validation does not check base variables                          | MEDIUM   | Open   |
| GAP-009 | Usage tracking — no way to see which agents/tools reference a variable       | LOW      | Open   |
| GAP-010 | Dynamic user-defined environments (hardcoded to dev/staging/production)      | LOW      | Open   |
| GAP-011 | Variable versioning / change history                                         | LOW      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                        | Coverage Type | Status     | Test File / Note                                    |
| --- | ----------------------------------------------- | ------------- | ---------- | --------------------------------------------------- |
| 1   | Full CRUD lifecycle (create/read/update/delete) | E2E           | NOT TESTED | Needs real Express + MongoMemoryServer              |
| 2   | Base value create + read                        | E2E           | NOT TESTED | Tests `environment: null` path                      |
| 3   | Base+override resolution via deployment         | E2E           | NOT TESTED | Deploy, verify snapshot dedup                       |
| 4   | Copy between environments                       | E2E           | NOT TESTED | Copy + overwrite flag                               |
| 5   | Namespace-scoped resolution                     | E2E           | NOT TESTED | Tool resolves only its namespace's vars             |
| 6   | Pre-deploy validation with base fallback        | E2E           | NOT TESTED | Missing vars check with base coverage               |
| 7   | Cross-project isolation                         | E2E           | NOT TESTED | Project A vars invisible to project B               |
| 8   | RBAC permission enforcement                     | integration   | PARTIAL    | `environment-variables-authz.test.ts` (uses mocks)  |
| 9   | RuntimeSecretsProvider base fallback            | integration   | NOT TESTED | env-specific miss -> base hit                       |
| 10  | Namespace pagination correctness                | integration   | NOT TESTED | >50 vars, namespace filter, verify page accuracy    |
| 11  | Snapshot base+override dedup                    | integration   | NOT TESTED | Same key in base + env -> only env in snapshot      |
| 12  | Cache sentinel correctness                      | integration   | NOT TESTED | Undefined cached vs not-in-cache behavior           |
| 13  | Concurrent deployment safety                    | integration   | NOT TESTED | Race condition on retire + create                   |
| 14  | normalizeEnvironment utility                    | unit          | PASS       | `packages/config/src/__tests__/environment.test.ts` |

### Testing Notes

The existing `environment-variables-authz.test.ts` uses `vi.mock()` for auth middleware, which means it does NOT exercise the real middleware chain. For STABLE status, E2E tests must use real Express servers with full middleware.

The Studio `tool-test-service.ts` has base fallback implemented (lines 226-234) but no dedicated test verifying it works.

> Full testing details: `../testing/environment-variables.md`

---

## 18. References

- Design docs: `docs/specs/environment-variables.hld.md`
- Implementation plan: `docs/plans/2026-03-22-environment-variables-impl-plan.md`
- Variable namespaces: `docs/features/sub-features/variable-namespaces-tool-auto-tagging.md`
- Testing spec: `docs/testing/environment-variables.md`
- SDLC logs: `docs/sdlc-logs/environment-variables/`

---

## 19. Changelog

| Date       | Change                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-13 | Initial design spec: environment normalization, base+override, one-active-deployment                                                                                                                                       |
| 2026-03-14 | Variable namespaces and tool auto-tagging implemented                                                                                                                                                                      |
| 2026-03-22 | Feature spec generated via SDLC pipeline — code-grounded from current implementation                                                                                                                                       |
| 2026-03-23 | Major update: identified critical bugs (GAP-001 through GAP-004), restructured to TEMPLATE.md format, added delivery plan for STABLE transition, scoped to env vars hardening only (no config var/tool secret deprecation) |
