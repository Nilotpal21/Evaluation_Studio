# High-Level Design: Deployments & Versioning

**Feature Slug:** `deployments-versioning`
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Overview

The Deployments & Versioning system provides production lifecycle management for agent configurations in the ABL platform. It enables teams to create immutable versioned snapshots of agents, workflows, and settings; deploy them to specific environments (dev, staging, production); promote across environments; roll back to previous known-good states; and audit the full history of who deployed what and when.

### Design Goals

1. **Immutability**: Every version is a frozen snapshot --- DSL, compiled IR, tool bindings, and config vars are captured at creation time and never mutated.
2. **Multi-Environment**: Three environments (dev, staging, production) with independent active deployments and promotion pipelines.
3. **Auditability**: Every deployment, promotion, and rollback creates a traceable record with user attribution and timestamps.
4. **Safety**: Preflight validation, draining support, and optimistic locking prevent broken deployments and data races.
5. **Tenant Isolation**: Every operation scoped to tenantId + projectId at the query level, not as a post-hoc filter.

## 2. Architecture

### System Context

```
Studio UI ──[HTTP proxy]──> Runtime API ──> MongoDB
    │                            │               │
    │                            ├──> Redis (IR cache)
    │                            │
    └──[Git API]──> Git Provider (GitHub/GitLab/Bitbucket)
```

### Component Architecture

```
┌────────────────────────────────────────────────────────┐
│                    Studio (Next.js)                      │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ DeployPanel   │  │ Version  │  │ Git Promote Route │ │
│  │ (widget/SDK)  │  │ Store    │  │ (branch mgmt)     │ │
│  └──────────────┘  └──────────┘  └───────────────────┘ │
│  ┌──────────────────┐  ┌───────────────────────────┐    │
│  │ useAgentVersions  │  │ Settings Version Proxy   │    │
│  │ (SWR hook)        │  │ Routes                   │    │
│  └──────────────────┘  └───────────────────────────┘    │
└────────────────────────────────────────────────────────┘
                          │ HTTP
┌────────────────────────────────────────────────────────┐
│                    Runtime (Express)                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │              routes/deployments.ts                │   │
│  │  POST / | GET / | GET /:id | POST /:id/retire   │   │
│  │  POST /:id/rollback | POST /:id/promote          │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────┐  ┌─────────────────────────┐     │
│  │ VersionService   │  │ WorkflowVersionService  │     │
│  │ (agent versions) │  │ (workflow versions)     │     │
│  └─────────────────┘  └─────────────────────────┘     │
│  ┌─────────────────┐  ┌─────────────────────────┐     │
│  │ SettingsVersion  │  │ SnapshotService         │     │
│  │ Service          │  │ (variable snapshots)    │     │
│  └─────────────────┘  └─────────────────────────┘     │
│  ┌─────────────────┐  ┌─────────────────────────┐     │
│  │ PreflightValid.  │  │ SessionService          │     │
│  │ Service          │  │ (IR caching)            │     │
│  └─────────────────┘  └─────────────────────────┘     │
│  ┌─────────────────────────────────────────────────┐   │
│  │              repos/deployment-repo.ts             │   │
│  │              repos/project-repo.ts                │   │
│  │              repos/channel-repo.ts                │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
                          │ Mongoose
┌────────────────────────────────────────────────────────┐
│                    MongoDB                               │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ deployments   │ │ agent_       │ │ workflow_      │  │
│  │               │ │ versions     │ │ versions       │  │
│  └──────────────┘ └──────────────┘ └────────────────┘  │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ project_     │ │ deployment_  │ │ git_           │  │
│  │ settings_    │ │ variable_    │ │ integrations   │  │
│  │ versions     │ │ snapshots    │ │                │  │
│  └──────────────┘ └──────────────┘ └────────────────┘  │
└────────────────────────────────────────────────────────┘
```

## 3. Architectural Concerns

### 3.1 Resource Isolation

**Tenant Isolation**:

- Deployment model uses `tenantIsolationPlugin` which injects `tenantId` into every query automatically.
- All repo functions (`findDeploymentById`, `listDeployments`, `retirePreviousActiveDeployment`) include `tenantId` in the filter --- never `findById()` alone.
- Cross-tenant access returns 404, not 403, to avoid leaking resource existence.

**Project Isolation**:

- All deployment routes use `requireProjectScope('projectId')` middleware.
- Every query includes `projectId` in the filter.
- Deployment route handler verifies `req.params.projectId` matches before any operation.

**User Isolation**:

- `createdBy` field on versions and deployments enables audit trails.
- RBAC permissions (`deployment:create`, `deployment:retire`) gate write operations.

### 3.2 Authentication & Authorization

**Auth Flow**:

1. `authMiddleware` validates JWT/API key and populates `req.tenantContext`
2. `requireProjectScope('projectId')` verifies the token/key is scoped to the project
3. `requireProjectPermission(req, res, 'deployment:*')` checks role-based permissions

**Permission Matrix**:

| Operation             | Required Permission | Roles                    |
| --------------------- | ------------------- | ------------------------ |
| Create deployment     | `deployment:create` | admin                    |
| List deployments      | `deployment:read`   | admin, developer, viewer |
| Get deployment detail | `deployment:read`   | admin, developer, viewer |
| Retire deployment     | `deployment:retire` | admin                    |
| Rollback deployment   | `deployment:create` | admin                    |
| Promote deployment    | `deployment:create` | admin                    |
| Create version        | `version:create`    | admin, developer         |
| Read version          | `version:read`      | admin, developer, viewer |
| Promote version       | `version:promote`   | admin, developer         |

### 3.3 Data Consistency

**Optimistic Locking**: Version promotion uses `findOneAndUpdate` with `status: currentStatus` guard. If another process promoted the version concurrently, the update returns null and the caller gets a 422 (UNPROCESSABLE_ENTITY).

**Atomic Retirement**: `retirePreviousActiveDeployment` uses `findOneAndUpdate` with `status: 'active'` filter, ensuring exactly one deployment is retired even under concurrent requests.

**Unique Active Deployment**: A partial unique index on `(projectId, environment)` where `status='active'` ensures at most one active deployment per environment. The `E11000` duplicate key error is caught and returns 409.

**Deployment Chain Integrity**: `previousDeploymentId` and `promotedFromDeploymentId` create an immutable linked list for rollback and promotion audit trails.

### 3.4 Scalability

**Horizontal Scaling**: All state is in MongoDB and Redis. No pod-local state. Multiple runtime instances can handle deployment operations concurrently, protected by database-level constraints.

**IR Caching**: Compiled agent IR is cached in Redis (via SessionService) at deployment time, keyed by compilation hash. Runtime session bootstrap reads from cache, avoiding re-compilation on every request.

**Batch Operations**: Agent version validation uses `Promise.all` for parallel lookups. All project agents loaded in a single query before manifest iteration.

**Pagination**: Version and deployment list endpoints support `limit`/`offset` with configurable bounds (DEFAULT_LIST_LIMIT=50, MAX_LIST_LIMIT=200).

### 3.5 Performance

**Deployment Creation Latency** (typical):

- Agent version lookups: ~5-15ms per agent (parallel)
- Config variable resolution: ~5ms
- Compilation output caching: ~10ms
- Previous deployment retirement: ~5ms
- Deployment record creation: ~10ms
- Variable snapshot creation: ~20ms
- Channel auto-follow: ~5-15ms
- **Total**: ~50-80ms (without auto-versioning); +100-200ms per auto-versioned agent (compilation)

**Version Creation Latency**:

- DSL parsing: ~5-20ms
- IR compilation: ~50-150ms
- Tool resolution: ~10-30ms
- DB write: ~10ms
- **Total**: ~75-210ms

**Caching**:

- Deployment list responses: `Cache-Control: private, max-age=60, stale-while-revalidate=120`
- Compiled IR: Redis cache with TTL (SessionService)
- Version deduplication: sourceHash prevents redundant work

### 3.6 Reliability

**Non-Blocking Side Effects**: Variable snapshot creation, channel auto-follow, and compilation caching are wrapped in try/catch --- their failures are logged but do not block the deployment creation response.

**Retry on Collision**: Version creation retries up to 3 times on duplicate key collisions (E11000), auto-incrementing the version number.

**Graceful Retirement**: Active deployments transition through `draining` before `retired`, allowing in-flight sessions to complete. Force-retire skips draining for emergency cases.

**Preflight Validation**: Diagnostic checks run before deployment. Errors block deployment (unless `force=true`). Warnings are included in the response as non-blocking advisories.

### 3.7 Observability

**Structured Logging**: All services use `createLogger('module-name')` with context objects:

- Version creation: `{ projectId, agentName, version, sourceHash, versionId }`
- Deployment creation: `{ compilationHash, agentCount, environment, channelsUpdated }`
- Promotion: `{ from, to, promotedBy }`
- Errors: full error messages with context

**Key Metrics** (future):

- Deployment creation latency (P50, P95)
- Version creation frequency per project
- Deployment failure rate (preflight blocks, E11000 conflicts)
- Draining duration (time from draining -> retired)

**Audit Trail**: `createdBy`, `promotedBy`, `createdAt`, `promotedAt` fields on all records. `previousDeploymentId` and `promotedFromDeploymentId` enable full deployment lineage reconstruction.

### 3.8 Security

**Encrypted Variable Snapshots**: The snapshot service explicitly selects only `_id, key, encryptedValue, isSecret, description, environment` --- omitting `ire, iv, cek, fieldsToEncrypt, tenantId`. This prevents the Mongoose encryption plugin's post-find hook from decrypting, ensuring only raw AES-256-GCM ciphertext is stored. Decryption happens at runtime via `decryptForTenant`.

**Input Validation**:

- DSL content: 512KB max (`MAX_DSL_SIZE`)
- Changelog: 10K chars max (`MAX_CHANGELOG_SIZE`)
- Workflow definition: 512KB max (`MAX_DEFINITION_SIZE`)
- Branch names: validated against `SAFE_BRANCH_PATTERN` to prevent path traversal
- Environment: enum validation (`dev`, `staging`, `production`)

**Rate Limiting**:

- All deployment routes: `tenantRateLimit('request')`
- Git promote route: 5 req/min/tenant
- Endpoint slugs: crypto-random to prevent guessing

**RBAC**: Write operations gated by project-level permissions via `requireProjectPermission`. See permission matrix above.

### 3.9 Compliance

**Data Minimization**: Variable snapshots capture only keys and encrypted values. Secret values are never decrypted in the snapshot layer.

**Audit Logging**: Every deployment, version creation, promotion, and retirement records the acting user, timestamp, and previous state.

**Immutability**: Version records (DSL, IR, sourceHash) are never modified after creation. Status changes are the only mutable field, tracked via `promotedAt`/`promotedBy`.

**Right to Erasure**: Deployment retirement cascade-deletes the associated variable snapshot. Version records can be deprecated but not deleted (audit trail preservation).

### 3.10 Extensibility

**Version Status Pipeline**: The `VALID_STATUS_TRANSITIONS` map is configurable. Adding new states (e.g., `approved`) requires only updating the map and adding the enum value.

**Environment List**: `VALID_ENVIRONMENTS` is imported from `@agent-platform/config`, making it a single-point change to add new environments.

**Manifest Structure**: `agentVersionManifest` and `workflowVersionManifest` are `Mixed` schema types, allowing flexible key-value mappings without schema migration.

**Deployment Hooks**: The deployment creation pipeline is structured as a linear sequence of optional steps (IR caching, env var checking, preflight, snapshot creation, channel auto-follow). New steps can be inserted without restructuring.

### 3.11 Error Handling

**Error Envelope**: All error responses follow the standard pattern:

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

**Specific Error Codes**:

- `PREFLIGHT_FAILED` (422): Preflight validation found errors
- `E11000` / 409: Concurrent deployment conflict
- 404: Resource not found (also used for cross-tenant isolation)
- 422: Invalid status transition, concurrent modification

**Non-Fatal Warnings**: Missing env var references, tool resolution warnings, and preflight warnings are included in the success response as a `warnings` array.

### 3.12 Testing Strategy

**Layered Testing**:

- Unit: Pure function tests (sourceHash, semver, snapshot diff, status transitions)
- Integration: Service-level tests with mocked repos (version lifecycle, deployment CRUD)
- E2E: Full HTTP API round-trips with real middleware (isolation, RBAC, lifecycle flows)
- Authorization: RBAC permission matrix tests for all endpoints

**Existing Coverage**: 11 test files with ~110 test cases covering the core flows. See Test Spec for gaps.

## 4. Data Flow: Deployment Creation

```
Client
  │
  ├─ POST /api/projects/:projectId/deployments
  │  Body: { environment, agentVersionManifest, entryAgentName, ... }
  │
  ▼
authMiddleware ──> requireProjectScope ──> tenantRateLimit
  │
  ▼
requireProjectPermission('deployment:create')
  │
  ▼
Validate inputs (environment, manifest, entry agent)
  │
  ▼
Load all project agents (single batch query)
  │
  ├─ For each manifest entry:
  │    ├─ version="auto"? → VersionService.createVersion() from working copy
  │    └─ version="X.Y.Z"? → findAgentVersion() lookup
  │
  ▼
Resolve {{config.KEY}} in loaded IRs
  │
  ▼
Build CompilationOutput → SessionService.cacheCompilationOutput()
  │
  ▼
Check missing {{env.KEY}} references → warnings[]
  │
  ▼
Validate workflow version manifest (if present)
  │
  ▼
runPreflightValidation() (unless force=true)
  │
  ├─ status='errors' → 422 + preflightReport
  └─ status='warnings' → append to warnings[]
  │
  ▼
retirePreviousActiveDeployment(projectId, tenantId, environment)
  │
  ▼
createDeployment() → deployment record with unique endpointSlug
  │
  ▼
createDeploymentSnapshot() → variable snapshot
  │
  ▼
bulkUpdateChannelDeployment() → channel auto-follow
  │
  ▼
201 { success: true, deployment, channelsUpdated, warnings?, preflightReport? }
```

## 5. Data Flow: Version Status Lifecycle

```
draft ──> testing ──> staged ──> active ──> deprecated
  │         │           │
  │         │           └── (back to draft)
  │         └── (back to draft)
  └── (to staged directly)
```

Each transition:

1. Validate current status allows target status (`VALID_STATUS_TRANSITIONS`)
2. Optimistic lock: `findOneAndUpdate({ status: currentStatus })` with `{ status: targetStatus, promotedAt, promotedBy }`
3. If update returns null (0 matched): 422 "concurrent modification"
4. On `active`: sync `ProjectAgent.activeVersions` map

## 6. Data Flow: Deployment Rollback

```
GET deployment (verify exists, is active or draining)
  │
  ▼
Get previousDeploymentId from deployment record
  │
  ├─ null → 422 "No previous deployment to rollback to"
  │
  ▼
Load previous deployment (verify status retired or draining)
  │
  ▼
Create new deployment with previous deployment's manifest
  │
  ├─ endpointSlug: new unique slug
  ├─ agentVersionManifest: copied from previous
  ├─ previousDeploymentId: current deployment's id
  │
  ▼
Retire current deployment (force)
  │
  ▼
201 { success: true, deployment: newDeployment }
```

## 7. Key Design Decisions

| #   | Decision                                              | Rationale                                            | Alternatives Considered                                          |
| --- | ----------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Deployment status lifecycle (active/draining/retired) | Graceful traffic migration with draining phase       | Immediate replacement (no draining) --- risk of dropped requests |
| 2   | Immutable version records with status-only mutations  | Audit trail integrity, consistent deployment pinning | Mutable versions with change history --- harder to reason about  |
| 3   | sourceHash deduplication at version creation          | Prevent redundant versions, save storage             | Always create new version --- wastes storage, clutters history   |
| 4   | Auto-versioning via "auto" manifest entry             | Lower friction for CI/CD pipelines                   | Require explicit versioning --- more ceremony, blocks automation |
| 5   | Partial unique index for active deployment            | Database-enforced single active deployment per env   | Application-level check --- race condition vulnerable            |
| 6   | Variable snapshots store raw ciphertext               | Security: snapshot layer never sees plaintext        | Decrypt and re-encrypt --- unnecessary key exposure              |
| 7   | Preflight validation with force escape hatch          | Safety with flexibility for emergency deploys        | Hard-block (no override) --- too rigid for production incidents  |
| 8   | Channel auto-follow on deployment                     | Zero-config for SDK channels that track environments | Manual channel update --- operational burden                     |

## 8. Deployment Topology

The deployments-versioning feature runs entirely within the existing Runtime process (Express app). No new services, workers, or infrastructure components are required.

- **Runtime API**: Hosts all deployment and version endpoints
- **MongoDB**: Stores all deployment, version, and snapshot records
- **Redis**: Caches compiled IR for runtime session bootstrap
- **Studio**: Proxies version/settings endpoints to Runtime, hosts git promotion routes

## 9. Future Considerations

1. **Canary Deployments**: Traffic splitting between two active deployments with percentage-based routing
2. **Automated Rollback**: Health-check monitoring that triggers rollback when error rates exceed thresholds
3. **Deployment Approval Workflows**: Required approval gates before production deployments
4. **Draining Timeout**: Automatic retirement after configurable draining period (currently indefinite)
5. **Deployment Metrics Dashboard**: Visualize deployment frequency, rollback rate, environment health
6. **Cross-Project Deployment**: Orchestrated deployments across multiple projects
7. **Deployment Webhooks**: Notify external systems on deployment events
