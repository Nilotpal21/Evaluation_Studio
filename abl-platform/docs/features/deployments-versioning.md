# Feature Spec: Deployments & Versioning

**Slug:** `deployments-versioning`
**Status:** BETA
**Owner:** Runtime Team
**Created:** 2026-03-22
**Last Updated:** 2026-04-15

---

## 1. Problem Statement

Production agent platforms require deterministic, auditable lifecycle management for agent configurations. Without versioning and deployment primitives, teams cannot safely promote agent changes across environments (dev, staging, production), roll back to known-good states, or trace which exact configuration served a given session. The ABL platform must provide first-class support for immutable version snapshots, multi-environment deployment pipelines, traffic draining, rollback, and cross-environment promotion --- all scoped to the platform's tenant and project isolation model.

## 2. Target Users

| Persona                        | Need                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Agent Developer**            | Create, test, and promote agent DSL versions through lifecycle stages (draft -> testing -> staged -> active -> deprecated) |
| **DevOps / Platform Engineer** | Deploy versioned agent configurations to specific environments, perform rollbacks, manage environment promotion pipelines  |
| **Project Admin**              | View deployment history, audit who deployed what and when, manage deployment permissions                                   |
| **Enterprise Tenant Admin**    | Ensure deployment operations respect tenant isolation, review cross-project deployment policies                            |

## 3. Scope

### In Scope

- **Agent Version Lifecycle**: Create, list, get, promote, diff, and deprecate agent versions with immutable DSL+IR snapshots (model: `AgentVersion`)
- **Workflow Version Lifecycle**: Create, list, get, promote, diff, and deprecate workflow versions with immutable definition snapshots (model: `WorkflowVersion`)
- **Settings Version Lifecycle**: Create, list, get, and promote project settings versions (model: `ProjectSettingsVersion`)
- **Deployment Management**: Create, list, get, retire, rollback, and promote deployments across environments (model: `Deployment`)
- **Variable Snapshots**: Immutable point-in-time capture of env vars and config vars at deployment creation (model: `DeploymentVariableSnapshot`)
- **Auto-Versioning**: Automatic version creation from working copy when deploying with `"auto"` version manifest entries
- **Preflight Validation**: Diagnostic checks before deployment with force-override escape hatch
- **Git-Based Promotion**: Branch promotion (main -> staging -> production) via git provider integration
- **Compilation Caching**: IR compilation output cached in session service at deployment time for fast runtime resolution
- **Channel Auto-Follow**: SDK channels automatically updated to reference new active deployments
- **Endpoint Slug Generation**: Unique per-deployment endpoint identifiers for traffic routing

### Out of Scope

- Canary/blue-green traffic splitting (future: traffic management feature)
- A/B testing between deployment versions
- Automated rollback based on health metrics
- Cross-project deployment orchestration
- Deployment approval workflows (future: governance feature)

## 4. Requirements

### Functional Requirements

| ID    | Priority | Requirement                                                                                           |
| ----- | -------- | ----------------------------------------------------------------------------------------------------- |
| FR-1  | P0       | Create agent versions with compiled DSL+IR snapshots, sourceHash deduplication, and tool snapshots    |
| FR-2  | P0       | Promote agent versions through status transitions: draft -> testing -> staged -> active -> deprecated |
| FR-3  | P0       | Create deployments that pin agent version manifests, entry agent, and environment                     |
| FR-4  | P0       | Retire deployments with draining support (active -> draining -> retired)                              |
| FR-5  | P0       | Rollback to previous deployment by reactivating its configuration                                     |
| FR-6  | P0       | List and filter deployments by environment and status                                                 |
| FR-7  | P1       | Create deployment variable snapshots (immutable env var + config var capture)                         |
| FR-8  | P1       | Promote deployments across environments (dev -> staging -> production)                                |
| FR-9  | P1       | Auto-version agents and workflows from working copy during deployment                                 |
| FR-10 | P1       | Run preflight validation before deployment with force-override                                        |
| FR-11 | P1       | Create workflow versions with definition snapshots and lifecycle promotion                            |
| FR-12 | P1       | Create settings versions from working copy with sourceHash deduplication                              |
| FR-13 | P2       | Diff two agent versions (DSL content comparison)                                                      |
| FR-14 | P2       | Git-based branch promotion across environment branches                                                |
| FR-15 | P2       | Compute snapshot diffs between deployment variable snapshots                                          |

### Non-Functional Requirements

| ID    | Priority | Requirement                                                                     |
| ----- | -------- | ------------------------------------------------------------------------------- |
| NFR-1 | P0       | All deployment operations scoped to tenantId + projectId (tenant isolation)     |
| NFR-2 | P0       | Optimistic locking on version promotion to prevent concurrent modification      |
| NFR-3 | P0       | Unique constraint on (projectId, environment) for active deployments            |
| NFR-4 | P1       | Version creation handles duplicate key collisions with retry (up to 3 attempts) |
| NFR-5 | P1       | DSL content validated against 512KB size limit                                  |
| NFR-6 | P1       | Deployment list responses cached with `Cache-Control: private, max-age=60`      |
| NFR-7 | P1       | Variable snapshots store raw ciphertext (no decryption at snapshot time)        |
| NFR-8 | P2       | Semver auto-increment for version numbering (0.1.0 -> 0.1.1)                    |

## 5. User Stories

### US-1: Create and Deploy Agent Version

**As** an agent developer, **I want** to create a versioned snapshot of my agent DSL and deploy it to staging, **so that** I can test it before promoting to production.

**Acceptance Criteria:**

- DSL is compiled to IR at version creation time
- Version is created with status "draft" and sourceHash for deduplication
- Deployment to staging pins the specific version and generates a unique endpoint slug
- Previous active staging deployment is automatically retired

### US-2: Rollback Production Deployment

**As** a DevOps engineer, **I want** to roll back a production deployment to the previous version, **so that** I can quickly recover from a bad release.

**Acceptance Criteria:**

- Rollback identifies the previous deployment via `previousDeploymentId` chain
- Current deployment transitions to retired
- New deployment is created with the previous deployment's manifest
- Channel connections are updated to the new deployment

### US-3: Promote Across Environments

**As** a platform engineer, **I want** to promote a deployment from staging to production, **so that** I can follow a structured release pipeline.

**Acceptance Criteria:**

- Promotion creates a new deployment in the target environment using the source deployment's manifest
- `promotedFromDeploymentId` links back to the source deployment
- Preflight validation runs before promotion (unless force-overridden)

### US-4: View Deployment History

**As** a project admin, **I want** to view the deployment history for each environment, **so that** I can audit who deployed what and when.

**Acceptance Criteria:**

- Deployments listed with status, environment, label, createdBy, and timestamps
- Filterable by environment and status
- Detail view includes channel count and version manifest

### US-5: Auto-Version on Deploy

**As** an agent developer, **I want** to deploy with auto-versioning, **so that** I don't need to manually create versions before deploying.

**Acceptance Criteria:**

- Passing `"auto"` in the version manifest triggers automatic version creation from working copy
- Auto-created versions have changelog "Auto-created for deployment"
- Compilation errors in auto-versioning block the deployment with 422 response

## 6. Data Model

### AgentVersion

| Field          | Type            | Description                                       |
| -------------- | --------------- | ------------------------------------------------- |
| `_id`          | String (UUIDv7) | Primary key                                       |
| `agentId`      | String          | FK to ProjectAgent                                |
| `version`      | String          | Semver (e.g., "0.1.0")                            |
| `status`       | Enum            | draft, testing, staged, active, deprecated        |
| `dslContent`   | String          | Raw ABL DSL source                                |
| `irContent`    | String          | JSON-serialized CompilationOutput                 |
| `sourceHash`   | String          | SHA-256(DSL + config vars), truncated to 16 chars |
| `changelog`    | String?         | Optional change description                       |
| `toolSnapshot` | Array?          | Snapshot of project tools at version time         |
| `createdBy`    | String          | User who created                                  |
| `promotedAt`   | Date?           | When promoted to current status                   |
| `promotedBy`   | String?         | Who promoted                                      |

**Indexes:** `(agentId, version)` unique, `(agentId, createdAt)` desc

### Deployment

| Field                      | Type            | Description                          |
| -------------------------- | --------------- | ------------------------------------ |
| `_id`                      | String (UUIDv7) | Primary key                          |
| `projectId`                | String          | FK to Project                        |
| `tenantId`                 | String          | Tenant isolation                     |
| `environment`              | Enum            | dev, staging, production             |
| `status`                   | Enum            | active, draining, retired            |
| `agentVersionManifest`     | Mixed           | `{ agentName: version }` mapping     |
| `workflowVersionManifest`  | Mixed           | `{ workflowName: version }` mapping  |
| `entryAgentName`           | String          | Which agent handles initial requests |
| `endpointSlug`             | String          | Unique deployment endpoint           |
| `compilationHash`          | String?         | Cached compilation output reference  |
| `previousDeploymentId`     | String?         | Rollback chain link                  |
| `promotedFromDeploymentId` | String?         | Cross-env promotion link             |
| `settingsVersionId`        | String?         | Pinned settings version              |
| `variableSnapshotId`       | String?         | Pinned variable snapshot             |
| `drainingStartedAt`        | Date?           | When draining started                |
| `retiredAt`                | Date?           | When retired                         |

**Indexes:** `(endpointSlug)` unique, `(projectId, environment)` unique partial filter `status='active'`, `(projectId, tenantId, status, createdAt)`

### DeploymentVariableSnapshot

| Field          | Type            | Description                                                              |
| -------------- | --------------- | ------------------------------------------------------------------------ |
| `_id`          | String (UUIDv7) | Primary key                                                              |
| `tenantId`     | String          | Tenant isolation                                                         |
| `projectId`    | String          | FK to Project                                                            |
| `deploymentId` | String          | FK to Deployment                                                         |
| `environment`  | Enum            | dev, staging, production                                                 |
| `snapshotHash` | String          | SHA-256 of all variable values                                           |
| `envVars`      | Array           | `[{ key, encryptedValue, isSecret, description, sourceId, namespaces }]` |
| `configVars`   | Array           | `[{ key, value, description, sourceId, namespaces }]`                    |

**Indexes:** `(deploymentId)` unique, `(tenantId, projectId)`

### WorkflowVersion

| Field        | Type            | Description                                |
| ------------ | --------------- | ------------------------------------------ |
| `_id`        | String (UUIDv7) | Primary key                                |
| `workflowId` | String          | FK to Workflow                             |
| `tenantId`   | String          | Tenant isolation                           |
| `projectId`  | String          | FK to Project                              |
| `version`    | String          | Semver                                     |
| `definition` | Mixed           | JSON workflow definition snapshot          |
| `sourceHash` | String          | SHA-256 of canonical JSON definition       |
| `status`     | Enum            | draft, testing, staged, active, deprecated |

**Indexes:** `(tenantId, projectId, workflowId, version)` unique

### ProjectSettingsVersion

| Field        | Type            | Description                                                               |
| ------------ | --------------- | ------------------------------------------------------------------------- |
| `_id`        | String (UUIDv7) | Primary key                                                               |
| `tenantId`   | String          | Tenant isolation                                                          |
| `projectId`  | String          | FK to Project                                                             |
| `version`    | String          | Semver                                                                    |
| `status`     | Enum            | draft, testing, staged, active, deprecated                                |
| `settings`   | Object          | `{ enableThinking, thinkingBudget, thoughtDescription, promptOverrides }` |
| `sourceHash` | String          | SHA-256 of settings JSON                                                  |

**Indexes:** `(tenantId, projectId, version)` unique

## 7. API Surface

### Runtime API (Express)

| Method | Path                                                                   | Description              |
| ------ | ---------------------------------------------------------------------- | ------------------------ |
| POST   | `/api/projects/:projectId/deployments`                                 | Create deployment        |
| GET    | `/api/projects/:projectId/deployments`                                 | List deployments         |
| GET    | `/api/projects/:projectId/deployments/:deploymentId`                   | Get deployment detail    |
| POST   | `/api/projects/:projectId/deployments/:deploymentId/retire`            | Retire deployment        |
| POST   | `/api/projects/:projectId/deployments/:deploymentId/rollback`          | Rollback to previous     |
| POST   | `/api/projects/:projectId/deployments/:deploymentId/promote`           | Promote to environment   |
| POST   | `/api/projects/:projectId/agents/:agentName/versions`                  | Create agent version     |
| GET    | `/api/projects/:projectId/agents/:agentName/versions`                  | List agent versions      |
| GET    | `/api/projects/:projectId/agents/:agentName/versions/:version`         | Get agent version        |
| POST   | `/api/projects/:projectId/agents/:agentName/versions/:version/promote` | Promote version          |
| GET    | `/api/projects/:projectId/agents/:agentName/versions/diff`             | Diff two versions        |
| POST   | `/api/projects/:projectId/settings/versions`                           | Create settings version  |
| GET    | `/api/projects/:projectId/settings/versions`                           | List settings versions   |
| POST   | `/api/projects/:projectId/settings/versions/:version/promote`          | Promote settings version |

### Studio API (Next.js proxy)

| Method | Path                                                     | Description          |
| ------ | -------------------------------------------------------- | -------------------- |
| POST   | `/api/projects/[id]/settings/versions`                   | Proxy to runtime     |
| GET    | `/api/projects/[id]/settings/versions`                   | Proxy to runtime     |
| POST   | `/api/projects/[id]/settings/versions/[version]/promote` | Proxy to runtime     |
| POST   | `/api/projects/[id]/git/promote`                         | Git branch promotion |

## 8. Key Algorithms

### Version Deduplication

Before creating a new version, compute `sourceHash = SHA-256(dslContent + configVars)` and compare against the latest version's sourceHash. If identical, return the existing version with `deduplicated: true`.

### Semver Auto-Increment

Fetch all existing version numbers, parse as `[major, minor, patch]` tuples, find the highest by numeric comparison, and increment patch: `0.1.5 -> 0.1.6`.

### Deployment Creation Pipeline

1. Validate environment, manifest, and entry agent
2. Validate all agent versions exist (parallel lookups)
3. Auto-version any `"auto"` entries from working copy
4. Resolve `{{config.KEY}}` placeholders in loaded IRs
5. Build and cache `CompilationOutput` in session service
6. Check for missing `{{env.KEY}}` references (non-blocking warnings)
7. Validate workflow version manifest
8. Run preflight validation (unless `force=true`)
9. Retire previous active deployment for this environment
10. Create deployment record with unique endpoint slug
11. Create deployment variable snapshot
12. Update SDK channels via auto-follow

### Retirement Flow

- `active` + `force=false` -> `draining` (sets `drainingStartedAt`)
- `active` + `force=true` -> `retired` (sets `retiredAt`)
- `draining` -> `retired` (sets `retiredAt`)
- On retirement: cascade-delete the `DeploymentVariableSnapshot`

## 9. Security Considerations

- **Tenant Isolation**: All queries include `tenantId`. Deployment model uses `tenantIsolationPlugin`. Cross-tenant access returns 404.
- **Project Scope**: All deployment routes use `requireProjectScope('projectId')` and `requireProjectPermission(req, res, 'deployment:*')`.
- **Encrypted Variables**: Deployment variable snapshots store raw AES-256-GCM ciphertext, never decrypted plaintext. The snapshot service explicitly avoids selecting encryption metadata fields to prevent the Mongoose encryption plugin from auto-decrypting.
- **Git Credentials**: Git promotion routes resolve credentials via `resolveGitCredentials` with tenant-scoped secret lookup.
- **Input Validation**: DSL content capped at 512KB, changelog at 10K chars, branch names validated against `SAFE_BRANCH_PATTERN`.
- **RBAC**: Deployment operations gated by permissions: `deployment:create`, `deployment:read`, `deployment:retire`, `PROJECT_DEPLOY`.
- **Rate Limiting**: Git promote route: 5 req/min/tenant. All deployment routes use `tenantRateLimit('request')`.

## 10. Observability

- **Structured Logging**: All services use `createLogger('module')` with context objects `{ projectId, agentName, version, deploymentId, environment }`.
- **Key Log Events**: Version creation, version promotion (from/to status), deployment creation (with compilationHash, agentCount), deployment retirement, rollback, auto-follow channel updates, preflight results.
- **Error Logging**: Compilation failures, snapshot creation failures, channel auto-follow failures, config variable resolution failures --- all logged with error details.
- **Cache-Control**: Deployment list responses include `Cache-Control: private, max-age=60, stale-while-revalidate=120` for client-side caching.

## 11. Performance Considerations

- **Parallel Version Lookups**: Agent version validation uses `Promise.all` for concurrent composite key lookups.
- **Batch Agent Loading**: All project agents loaded in a single query (`findProjectAgentsForProject`) before iterating manifest entries.
- **IR Caching**: Compiled IR cached in session service (`cacheCompilationOutput`, `cacheAgentIR`) for fast runtime resolution.
- **Deduplication**: sourceHash comparison prevents creating redundant versions.
- **Optimistic Locking**: Version promotion uses `currentStatus` guard to prevent concurrent modification without heavy locking.

## 12. Migration Strategy

The feature uses self-contained MongoDB models with auto-created indexes. No migration scripts are needed for new installations. For existing deployments:

- `AgentVersion`, `Deployment`, `DeploymentVariableSnapshot`, `WorkflowVersion`, `ProjectSettingsVersion` collections are created on first write.
- Partial unique index on `(projectId, environment)` where `status='active'` ensures at most one active deployment per environment.
- UUIDv7 IDs provide time-ordered uniqueness without coordination.

## 13. Dependencies

| Component                | Dependency                                                                     | Direction                |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------ |
| `deployment-repo.ts`     | `@agent-platform/database/models` (Deployment)                                 | Runtime -> Database      |
| `version-service.ts`     | `@abl/compiler/platform` (compileABLtoIR, parseAgentBasedABL)                  | Runtime -> Compiler      |
| `version-service.ts`     | `@agent-platform/shared/tools/resolve`                                         | Runtime -> Shared        |
| `snapshot-service.ts`    | `@agent-platform/database/models` (EnvironmentVariable, ProjectConfigVariable) | Runtime -> Database      |
| `deployments.ts` (route) | `preflight-validation-service.ts`                                              | Internal                 |
| `deployments.ts` (route) | `session-service.ts` (IR caching)                                              | Internal                 |
| `git-promote route`      | `@agent-platform/project-io/git` (BranchManager)                               | Studio -> ProjectIO      |
| Studio proxy routes      | Runtime API                                                                    | Studio -> Runtime (HTTP) |

## 14. Risks & Mitigations

| Risk                                                  | Impact             | Mitigation                                                                         |
| ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| Concurrent deployment creation for same environment   | Data inconsistency | Partial unique index on `(projectId, environment, status='active')` + E11000 retry |
| Snapshot stores stale ciphertext after key rotation   | Decryption failure | Runtime decryption uses current KEK; re-deploy to refresh snapshot                 |
| Auto-versioning compilation failure blocks deployment | Deploy blocked     | 422 response with clear error; user can fix DSL or use explicit versions           |
| Large IR content in version records                   | Storage growth     | Consider compression for `irContent` field; current 512KB DSL limit bounds IR size |
| Preflight validation false positives                  | Deploy friction    | `force=true` escape hatch allows overriding preflight errors                       |

## 15. Alternatives Considered

| Alternative                                          | Why Not Chosen                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Immutable deployment records (no status transitions) | Need draining support for graceful traffic migration                   |
| Version-less deployments (always deploy latest)      | No rollback capability, no audit trail                                 |
| External CI/CD for deployment orchestration          | Platform must be self-contained; git integration provides escape hatch |
| Database-level triggers for auto-follow              | Application-level channel updates are more auditable and debuggable    |

## 16. Existing Implementation Status

### Fully Implemented

- `AgentVersion` model + `VersionService` (create, list, get, promote, diff, nextVersion)
- `WorkflowVersion` model + `WorkflowVersionService` (create, list, get, promote, diff)
- `ProjectSettingsVersion` model + `SettingsVersionService` (create, list, get, promote)
- `Deployment` model + `deployment-repo.ts` (CRUD + retire + rollback + promote)
- `DeploymentVariableSnapshot` model + `snapshot-service.ts` (create + diff)
- Full deployment route (`routes/deployments.ts`) with preflight validation, auto-versioning, IR caching, variable snapshots, channel auto-follow
- Studio proxy routes for settings versions and git promotion
- `useAgentVersions` hook and `version-store.ts` for Studio UI
- `DeployPanel` component (widget embedding, API keys, settings)

### Gaps / Not Yet Implemented

- Studio UI for deployment management (create, list, retire, rollback, promote) -- `DeployPanel` currently only handles widget/SDK deployment, not the full deployment lifecycle UI
- Deployment audit log integration (events emitted to audit store)
- Deployment health monitoring / metrics dashboard
- Automated draining timeout (draining deployments remain in draining state indefinitely)
- Deployment approval workflows
- Canary/traffic splitting

## 17. Testing Strategy

- **Unit Tests**: Service-level tests for VersionService, WorkflowVersionService, SettingsVersionService
- **Integration Tests**: Route-level tests with real MongoDB for deployment CRUD, version lifecycle
- **E2E Tests**: Full API flow: create version -> deploy -> verify -> rollback -> verify
- **Authorization Tests**: Cross-tenant isolation, permission checks (`versions-authz.test.ts`)

## 18. References

- **Models**: `packages/database/src/models/deployment.model.ts`, `agent-version.model.ts`, `workflow-version.model.ts`, `project-settings-version.model.ts`, `deployment-variable-snapshot.model.ts`
- **Services**: `apps/runtime/src/services/version-service.ts`, `workflow-version-service.ts`, `settings-version-service.ts`, `snapshot-service.ts`, `preflight-validation-service.ts`
- **Routes**: `apps/runtime/src/routes/deployments.ts`
- **Repos**: `apps/runtime/src/repos/deployment-repo.ts`
- **Studio**: `apps/studio/src/hooks/useAgentVersions.ts`, `store/version-store.ts`, `components/deploy/DeployPanel.tsx`
- **Git**: `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`
