# Variable Namespaces & Deployment Snapshots Design Spec

**Date:** 2026-03-12
**Status:** Reviewed (blockers resolved)
**Scope:** Namespace-based organization for project variables + immutable deployment snapshots

---

## 1. Problem Statement

As projects grow, the flat list of environment variables and config variables becomes unmanageable. Users have no way to organize related variables (e.g., all Stripe keys, all database credentials). Additionally, there is no point-in-time record of what variable values a deployment ran with -- changing a variable silently affects running deployments with no audit trail.

### Existing Gaps (Fixed by This Work)

| Gap                                                          | Severity |
| ------------------------------------------------------------ | -------- |
| Project deletion does not cascade to env vars or config vars | Critical |
| Config var repo queries missing tenantId filter              | Critical |
| Config var collection route missing project access check     | Critical |
| Runtime `loadConfigVariablesMap` missing tenantId            | Critical |
| No max count limit for env vars per project                  | Medium   |
| Config/env var references not restored during project import | Medium   |

---

## 2. Design Decisions

| Decision                           | Choice                                                                          | Rationale                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Namespace identity                 | First-class entity (own collection)                                             | Clean CRUD, prevents typo drift, supports icon/color/ordering              |
| Variable-to-namespace relationship | Many-to-many via join collection                                                | A variable can be tagged under multiple namespaces                         |
| Key uniqueness                     | Globally unique per project (env: project+environment+key, config: project+key) | One value per key -- namespaces are organizational, not scoping containers |
| ABL syntax                         | Unchanged: `{{env.KEY}}`, `{{config.KEY}}`                                      | Namespaces are UI-only organization, no compiler/runtime changes           |
| Required namespace                 | Every variable must belong to at least one namespace                            | Orphaned variables auto-move to "Default"                                  |
| Default namespace                  | Auto-created per project, cannot be deleted or renamed                          | Ensures orphan safety and zero-config starting point                       |
| Deployment snapshots               | Immutable snapshot created on deploy, runtime reads from snapshot               | Frozen values per deployment, enables diff and audit                       |
| UI navigation                      | Dropdown selector (not expanded sections)                                       | Scales to many namespaces without overwhelming the page                    |

---

## 3. Domain Model

### 3.1 Entity Relationships

```
Tenant
  +-- Project
        +-- VariableNamespace[] (ordered, "default" auto-created)
        |
        +-- EnvironmentVariable[] (per environment, encrypted, unique key per project+env)
        |     +-- VariableNamespaceMembership[] --+
        |                                          +-- many-to-many join
        +-- ProjectConfigVariable[] (project-wide, plaintext, unique key per project)
        |     +-- VariableNamespaceMembership[] --+
        |
        +-- Deployment
              +-- DeploymentVariableSnapshot (immutable, point-in-time)
```

### 3.2 VariableNamespace Schema

```
Collection: variable_namespaces

{
  _id:          string (uuidv7)
  tenantId:     string (required)
  projectId:    string (required)
  name:         string (required, lowercase slug)
  displayName:  string (required, human-readable)
  description:  string | null
  icon:         string | null       // lucide icon name, e.g. "credit-card"
  color:        string | null       // hex color, must match /^#[0-9a-fA-F]{6}$/ or null
  order:        number (default 0)
  isDefault:    boolean (default false)
  createdBy:    string (required)
  updatedBy:    string | null
  _v:           number
  createdAt:    Date
  updatedAt:    Date
}

Plugins:
  - tenantIsolationPlugin
  - auditTrailPlugin

Indexes:
  { tenantId, projectId, name }   -- unique
  { tenantId, projectId, order }  -- sorted listing

Validation:
  - name: /^[a-z][a-z0-9-]*$/, 1-50 chars
  - name "default" is reserved for the system-created namespace
  - displayName: 1-100 chars
  - Max 25 namespaces per project (MAX_NAMESPACES_PER_PROJECT)

Rules:
  - "default" namespace (isDefault: true) auto-created on project creation
  - Default namespace: cannot delete, cannot rename, cannot update displayName; can update description/icon/color
  - Deleting a namespace moves orphaned variables to "default" (transactional)
```

### 3.3 VariableNamespaceMembership Schema (Join Collection)

```
Collection: variable_namespace_memberships

{
  _id:           string (uuidv7)
  tenantId:      string (required)
  projectId:     string (required)
  namespaceId:   string (required, FK -> VariableNamespace._id)
  variableId:    string (required, FK -> EnvironmentVariable._id or ProjectConfigVariable._id)
  variableType:  string (required, enum: "env" | "config")
  createdAt:     Date
}

Plugins:
  - tenantIsolationPlugin

Indexes:
  { namespaceId, variableId, variableType }  -- unique (no duplicate membership)
  { variableId, variableType }               -- find all namespaces for a variable
  { tenantId, projectId, namespaceId }       -- list variables in a namespace

Query patterns (avoid N+1):

  Listing variables in a namespace (GET /namespaces/:id/members):
    1. memberships = VariableNamespaceMembership.find({ namespaceId, tenantId, projectId })
    2. envVarIds = memberships.filter(m => m.variableType === 'env').map(m => m.variableId)
    3. configVarIds = memberships.filter(m => m.variableType === 'config').map(m => m.variableId)
    4. envVars = EnvironmentVariable.find({ _id: { $in: envVarIds }, tenantId })
    5. configVars = ProjectConfigVariable.find({ _id: { $in: configVarIds }, tenantId })
    Total: 3 queries (not N+1)

  Enriching variables with their namespace list:
    1. allMemberships = VariableNamespaceMembership.find({ variableId: { $in: varIds }, tenantId })
    2. nsIds = unique(allMemberships.map(m => m.namespaceId))
    3. namespaces = VariableNamespace.find({ _id: { $in: nsIds }, tenantId })
    4. Build Map<variableId, namespace[]> for response enrichment
    Total: 2 additional queries (not N per variable)

Validation:
  - Max 10 namespaces per variable (MAX_NAMESPACES_PER_VARIABLE)
  - variableId must exist and belong to same tenantId + projectId
  - namespaceId must exist and belong to same tenantId + projectId

Rules:
  - Removing a variable from its last namespace auto-creates membership to "default"
  - Deleting a variable cascades: all its memberships are deleted
  - Deleting a namespace cascades: all its memberships are deleted; orphaned variables get "default"
```

### 3.4 EnvironmentVariable Schema (Unchanged)

```
No schema changes to the EnvironmentVariable model.

Unique index stays: { tenantId, projectId, environment, key }
Keys remain globally unique per project + environment.
Namespace association is managed entirely via the join collection.
```

### 3.5 ProjectConfigVariable Schema (Unchanged)

```
No schema changes to the ProjectConfigVariable model.

Unique index stays: { tenantId, projectId, key }
Keys remain globally unique per project.
Namespace association is managed entirely via the join collection.
```

### 3.6 DeploymentVariableSnapshot Schema

```
Collection: deployment_variable_snapshots

{
  _id:            string (uuidv7)
  tenantId:       string (required)
  projectId:      string (required)
  deploymentId:   string (required, FK -> Deployment._id)
  environment:    string (required)
  snapshotVersion: number (default 1)
  snapshotHash:   string (required)  // SHA-256 of sorted key:value pairs

  envVars: [{
    key:            string
    encryptedValue: string           // copied from source, still encrypted
    isSecret:       boolean
    description:    string | null
    sourceId:       string           // original EnvironmentVariable._id (for audit trail: trace snapshot value to source)
    namespaces:     string[]         // denormalized namespace names at snapshot time
  }]

  configVars: [{
    key:         string
    value:       string              // plaintext (config vars are not encrypted)
    description: string | null
    sourceId:    string              // original ProjectConfigVariable._id (for audit trail)
    namespaces:  string[]            // denormalized namespace names at snapshot time
  }]

  createdBy:  string
  createdAt:  Date
}

Plugins:
  - tenantIsolationPlugin

Indexes:
  { deploymentId }            -- unique (one snapshot per deployment)
  { tenantId, projectId }     -- list snapshots for a project

Rules:
  - Immutable after creation: no updates
  - Namespace names are denormalized so history survives namespace renames/deletes
  - snapshotHash enables fast equality check in diff endpoint:
    if hashes match, skip per-variable comparison (optimization, not deduplication).
    Identical variable sets across deployments produce the same hash intentionally.
    Hash is NOT used as a unique key -- deploymentId is the primary identifier.
  - Cascade-deleted when project or deployment is deleted
  - snapshotVersion field allows future schema evolution
```

### 3.7 Deployment Schema (Updated)

```
Existing fields unchanged, plus:
  + variableSnapshotId: string | null (FK -> DeploymentVariableSnapshot._id)

Default: null (for pre-existing deployments)
```

---

## 4. ABL Syntax & Resolution

### No Changes

Namespaces are purely organizational. The ABL syntax remains flat:

```
{{env.API_KEY}}         -- resolved at runtime from encrypted DB or deployment snapshot
{{config.PRODUCT_NAME}} -- resolved at compile time from plaintext DB
{{secrets.X}}           -- resolved at runtime via SecretsProvider (unchanged)
```

No regex changes in the compiler or runtime executors. No changes to:

- `packages/compiler/src/platform/ir/compiler.ts` (resolveConfigVariables)
- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` (resolveEnvVars, resolveSecrets)
- `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`
- `packages/project-io/src/export/env-var-scanner.ts`

---

## 5. API Design

### 5.1 Service Ownership

| Routes                              | Service                 | Reason                                   |
| ----------------------------------- | ----------------------- | ---------------------------------------- |
| Namespace CRUD                      | Runtime (Express, 3112) | Co-located with env vars and deployments |
| Namespace memberships               | Runtime                 | Join table operations                    |
| Env var CRUD (existing, updated)    | Runtime                 | Existing ownership                       |
| Config var CRUD (existing, updated) | Studio (Next.js, 5173)  | Existing ownership                       |
| Deployment snapshots                | Runtime                 | Co-located with deployment routes        |

Studio calls Runtime's namespace/membership APIs when config var namespace assignment is needed, or writes memberships directly (shared DB).

### 5.2 Namespace CRUD

`/api/projects/:projectId/namespaces` -- Runtime (Express)

```
Router-level middleware (applied once to namespace router):
  router.use(authMiddleware);
  router.use(requireProjectScope('projectId'));
  router.use(tenantRateLimit('request'));

Per-handler permission checks (inline, same pattern as env-variables.ts):
  if (!(await requireProjectPermission(req, res, 'namespace:read'))) return;
```

#### GET / -- List namespaces

```
Permission: namespace:read (inline check)
TenantIsolation: query filtered by tenantId from req.tenantContext

Response:
{
  "success": true,
  "namespaces": [
    {
      "id": "ns-001",
      "name": "default",
      "displayName": "Default",
      "description": null,
      "icon": null,
      "color": null,
      "order": 0,
      "isDefault": true,
      "counts": { "env": 3, "config": 1 },
      "createdAt": "2026-03-10T10:00:00Z"
    },
    {
      "id": "ns-002",
      "name": "stripe",
      "displayName": "Stripe Integration",
      "description": "Payment processing credentials",
      "icon": "credit-card",
      "color": "#6366f1",
      "order": 1,
      "isDefault": false,
      "counts": { "env": 4, "config": 2 },
      "createdAt": "2026-03-10T10:05:00Z"
    }
  ]
}

Notes:
  - No pagination (max 25 namespaces)
  - Counts aggregated from memberships collection
  - Sorted by order field
```

#### POST / -- Create namespace

```
Permission: namespace:create (inline check)
TenantIsolation: tenantId from req.tenantContext

Body:
{
  "name": "stripe",
  "displayName": "Stripe Integration",
  "description": "Payment processing credentials",
  "icon": "credit-card",
  "color": "#6366f1"
}

Validation:
  - name: /^[a-z][a-z0-9-]*$/, 1-50 chars
  - name != "default"
  - name unique within project (409 on conflict)
  - displayName: 1-100 chars, required
  - count < MAX_NAMESPACES_PER_PROJECT (25)

Response (201):
{
  "success": true,
  "namespace": { "id": "ns-003", "name": "stripe", ... }
}

Audit: namespace:create { name, projectId }
```

#### PUT /:namespaceId -- Update namespace metadata

```
Permission: namespace:update (inline check)
TenantIsolation: findOne({ _id: namespaceId, tenantId })

Body (all optional):
{
  "displayName": "Stripe Payments",
  "description": "Updated description",
  "icon": "wallet",
  "color": "#10b981"
}

Rules:
  - Cannot update name or isDefault
  - Default namespace: can update description, icon, color; cannot update displayName

Response:
{
  "success": true,
  "namespace": { ... }
}

Audit: namespace:update { namespaceId, changes }
```

#### DELETE /:namespaceId -- Delete namespace

```
Permission: namespace:delete (inline check)
TenantIsolation: findOne({ _id: namespaceId, tenantId })

Rules:
  - Cannot delete default namespace (400)
  - Transactional (MongoDB session):
    1. Find all memberships for this namespace
    2. For each member variable, check if it has other memberships
    3. If orphaned -> create membership to "default" namespace
    4. Delete all memberships for this namespace
    5. Delete namespace

Response:
{
  "success": true,
  "movedToDefault": 3
}

Audit: namespace:delete { namespaceId, name, movedToDefault }
```

#### PUT /reorder -- Bulk update order

```
Permission: namespace:update (inline check)

Body:
{
  "order": [
    { "namespaceId": "ns-001", "order": 0 },
    { "namespaceId": "ns-002", "order": 1 },
    { "namespaceId": "ns-003", "order": 2 }
  ]
}

Implementation: bulkWrite for atomicity
Response:
{
  "success": true,
  "namespaces": [{ "id": "ns-001", "order": 0 }, ...]
}

Audit: namespace:reorder { projectId }
```

### 5.3 Membership Routes

`/api/projects/:projectId/namespaces/:namespaceId/members` -- Runtime

Shares the same router-level middleware as namespace routes (authMiddleware, requireProjectScope, tenantRateLimit).

#### GET / -- List variables in a namespace

```
Permission: namespace:read (inline check)
TenantIsolation: validate namespace belongs to tenantId + projectId

Query params:
  - type: "env" | "config" (optional filter)
  - environment: string (required when type=env or when type is omitted)
  - page: number (default 1)
  - limit: number (default 50, max 100)

Response:
{
  "success": true,
  "envVars": [
    {
      "id": "ev-001",
      "key": "API_KEY",
      "environment": "dev",
      "isSecret": true,
      "description": "Stripe API key",
      "namespaces": [
        { "id": "ns-002", "name": "stripe", "displayName": "Stripe Integration" },
        { "id": "ns-004", "name": "payments", "displayName": "Payments" }
      ],
      "createdAt": "2026-03-10T10:00:00Z",
      "updatedAt": "2026-03-10T10:00:00Z"
    }
  ],
  "configVars": [
    {
      "id": "cv-001",
      "key": "CURRENCY",
      "value": "usd",
      "description": "Default currency",
      "namespaces": [
        { "id": "ns-002", "name": "stripe", "displayName": "Stripe Integration" }
      ],
      "createdAt": "2026-03-10T10:00:00Z",
      "updatedAt": "2026-03-10T10:00:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 6, "totalPages": 1 }
}

Notes:
  - Env var values are NEVER returned in list endpoints
  - Config var values ARE returned (they are plaintext)
  - Each variable includes its full namespace list (not just the queried one)
```

#### POST / -- Add variables to namespace

```
Permission: namespace:update (inline check)

Body:
{
  "variables": [
    { "variableId": "ev-001", "variableType": "env" },
    { "variableId": "cv-001", "variableType": "config" }
  ]
}

Validation:
  - Max 100 variables per request
  - Each variableId must exist in same tenantId + projectId
  - Each variable must not exceed MAX_NAMESPACES_PER_VARIABLE (10)
  - Idempotent: skips if membership already exists

Response:
{
  "success": true,
  "added": 2,
  "skipped": 1,
  "errors": [
    { "variableId": "ev-003", "reason": "MAX_NAMESPACES_PER_VARIABLE exceeded" }
  ]
}

Notes:
  - success is true even with partial errors (some added, some skipped)
  - success is false only if zero variables were added and errors occurred
  - "skipped" means membership already existed (idempotent)
  - "errors" lists variables that failed validation

Audit: membership:add { namespaceId, added, skipped }
```

#### DELETE /:variableId -- Remove variable from namespace

```
Permission: namespace:update (inline check)

Query: ?type=env|config (required)

Rules:
  - If this is the variable's last namespace -> auto-add to "default"
  - Cannot remove from "default" if it is the only namespace (400)
  - Idempotent: 204 if membership does not exist

Response:
{
  "success": true,
  "movedToDefault": false
}

Audit: membership:remove { namespaceId, variableId, movedToDefault }
```

#### POST /move -- Move variables between namespaces

```
Permission: namespace:update (inline check)

Body:
{
  "targetNamespaceId": "ns-003",
  "variables": [
    { "variableId": "ev-001", "variableType": "env" },
    { "variableId": "ev-002", "variableType": "env" }
  ]
}

Validation:
  - Max 100 variables per request
  - Source != target (400)
  - Target namespace exists in same project

Implementation:
  - Atomic: MongoDB session
  - Remove membership from source namespace
  - Add membership to target namespace
  - If variable was only in source, the move is a simple reassignment

Response:
{
  "success": true,
  "moved": 2
}

Audit: membership:move { sourceNamespaceId, targetNamespaceId, count }
```

### 5.4 Updated Environment Variable Routes

`/api/projects/:projectId/env-vars` -- Runtime (existing routes, updated)

#### POST / -- Create (updated)

```
Body adds:
  + namespaceIds: string[] (optional)

Behavior:
  - If namespaceIds provided and non-empty: create memberships to those namespaces
  - If namespaceIds omitted or empty: create membership to "default" namespace
  - Validates: all namespaceIds exist in same project, max 10

Error responses:
  - 400: { "success": false, "error": "Namespace ns-999 not found in this project" }
  - 400: { "success": false, "error": "Cannot assign to more than 10 namespaces" }

Response adds per variable:
  + namespaces: [{ id, name, displayName }]
```

#### GET / -- List (updated)

```
Query adds:
  + namespaceId: string (optional filter)

Behavior:
  - If namespaceId provided: return only variables that are members of that namespace
  - If omitted: return all variables for the environment (current behavior)
  - Variables are deduplicated (appears once even if matching multiple criteria)

Response: each variable includes:
  + namespaces: [{ id, name, displayName }]
```

#### PUT /:id -- Update (updated)

```
Body adds:
  + namespaceIds: string[] (optional)

Behavior:
  - If namespaceIds provided: replace all memberships (set semantics)
  - If namespaceIds is empty array: move to "default" only
  - If namespaceIds omitted: memberships unchanged
  - Validates: at least one namespace after update, max 10
```

#### DELETE /:id -- Delete (updated)

```
Cascade: delete all VariableNamespaceMembership rows for this variableId + variableType="env"
```

### 5.5 Updated Config Variable Routes

`/api/projects/:projectId/config-variables` -- Studio (existing routes, same updates)

Same pattern as env vars:

- POST adds optional `namespaceIds`
- GET returns `namespaces` per variable, accepts `namespaceId` filter
- PATCH adds optional `namespaceIds`
- DELETE cascades memberships with variableType="config"

### 5.6 Deployment Snapshot Routes

#### POST /api/projects/:projectId/deployments (updated)

```
Existing deployment creation flow, plus after creating the deployment record:

1. Load all env vars for (tenantId, projectId, environment)
   CRITICAL: Use .select('key encryptedValue isSecret description') WITHOUT selecting
   encryption metadata fields (ire, iv, cek, fieldsToEncrypt, tenantId).
   This causes the Mongoose encryption plugin's post-find hook to SKIP decryption,
   returning the raw AES-256-GCM ciphertext. The snapshot stores this ciphertext as-is.
   If you select ire/tenantId, the plugin decrypts and you store PLAINTEXT -- security bug.
2. Load all config vars for (tenantId, projectId)
   Config vars are plaintext (no encryption plugin), so no special handling needed.
3. Load all namespace memberships for those variable IDs
4. Load all namespace names for denormalization
5. Compute snapshotHash:
   - Sort env vars by key, concatenate "env:KEY=ENCRYPTED_VALUE" pairs (uses ciphertext)
   - Sort config vars by key, concatenate "config:KEY=VALUE" pairs
   - SHA-256 of the concatenated string
   Note: Hash uses ciphertext, so it is tenant-specific. This is fine since
   snapshots are always within the same tenant.
6. Create DeploymentVariableSnapshot document
   The snapshot model does NOT use the encryptionPlugin (envVars is Schema.Types.Mixed).
   The raw ciphertext from step 1 is stored directly in the sub-document array.
7. Update deployment record with variableSnapshotId

Runtime decryption from snapshot:
  RuntimeSecretsProvider loads snapshot, builds Map<key, encryptedValue>.
  getEnvVar(key) calls decryptor.decryptForTenant(ciphertext, tenantId) to decrypt.

Error handling:
  - If snapshot creation fails, deployment creation fails (rolled back)
  - Snapshot creation is part of the same logical transaction

Response adds:
  + variableSnapshotId: string
  + snapshotHash: string
```

#### GET /api/projects/:projectId/deployments/:deploymentId/snapshot

```
Permissions (AND, sequential):
  if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;
  if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;
TenantIsolation: validate deployment and snapshot belong to tenantId

Response:
{
  "success": true,
  "snapshot": {
    "id": "snap-001",
    "deploymentId": "dep-001",
    "environment": "production",
    "snapshotHash": "a3f8c2...",
    "snapshotVersion": 1,
    "createdAt": "2026-03-10T14:30:00Z",
    "envVars": [
      {
        "key": "API_KEY",
        "isSecret": true,
        "description": "Stripe API key",
        "namespaces": ["stripe", "payments"]
      },
      {
        "key": "DB_HOST",
        "isSecret": false,
        "description": "Database host",
        "namespaces": ["database"]
      }
    ],
    "configVars": [
      {
        "key": "PRODUCT_NAME",
        "value": "TravelBot",
        "description": "Product display name",
        "namespaces": ["default"]
      }
    ],
    "totals": { "envVars": 12, "configVars": 5 }
  }
}

Notes:
  - Env var values are NOT included in this response (metadata only)
  - Config var values ARE included (plaintext, non-sensitive by design)
```

#### GET /api/projects/:projectId/deployments/:deploymentId/snapshot/value/:key

```
Permissions (AND, sequential):
  if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;
  if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

Response:
{
  "success": true,
  "key": "API_KEY",
  "value": "sk_live_abc123..."
}

Notes:
  - Decrypts encryptedValue from the snapshot using tenant key
  - Returns 404 if key not found in snapshot
```

#### GET /api/projects/:projectId/deployments/:deploymentId/snapshot/diff

```
Permission: deployment:read (inline check)

Query: compareWith=<deploymentId> (required)

Validation:
  - Both deployments must belong to same tenantId + projectId
  - Both must have snapshots (404 if either missing)

Response:
{
  "success": true,
  "hashMatch": false,
  "source": { "deploymentId": "dep-001", "snapshotHash": "a3f8c2..." },
  "target": { "deploymentId": "dep-002", "snapshotHash": "b4e9d1..." },
  "added": [
    { "key": "API_VERSION", "type": "config", "namespaces": ["default"] }
  ],
  "removed": [
    { "key": "DEBUG_MODE", "type": "env", "namespaces": ["default"] }
  ],
  "changed": [
    { "key": "DB_HOST", "type": "env", "valueChanged": true, "namespaces": ["database"] },
    { "key": "WEBHOOK_SECRET", "type": "env", "valueChanged": true, "namespaces": ["stripe"] }
  ]
}

Notes:
  - If hashMatch is true, added/removed/changed are empty arrays (fast path)
  - Actual values are NEVER exposed in diff response
  - valueChanged is a boolean indicating the encrypted content differs
  - Secrets and non-secrets treated identically in diff (no value exposure)
```

### 5.7 Runtime Resolution Changes

```
When deployment context exists (session tied to a deployment):
  1. Load DeploymentVariableSnapshot by deploymentId (one DB query)
  2. Build in-memory Map<key, encryptedValue> from snapshot.envVars
  3. Cache in RuntimeSecretsProvider for session lifetime

  getEnvVar(key):
    if (snapshotMap exists) -> decrypt from snapshot cache
    else -> live DB lookup (existing behavior)

When no deployment context (studio preview, test runs):
  - Resolve from live DB (current behavior, unchanged)

Performance:
  - One DB read per session init (not per variable lookup)
  - Snapshot cached in RuntimeSecretsProvider instance (session-scoped)
  - No Redis needed -- snapshot is small enough for in-memory

Changes to RuntimeSecretsProvider:
  + snapshotStore?: DeploymentSnapshotStore  // new optional interface
  + deploymentId?: string                     // set when running in deployment context

Cache invalidation strategy:
  - Snapshot data is immutable (deployments never modify their snapshots)
  - Cache is session-scoped (one RuntimeSecretsProvider per session, not global)
  - If a deployment is retired mid-session, the running session continues with its
    cached snapshot (by design -- deployment lifecycle changes do not affect active sessions)
  - New sessions always create a fresh RuntimeSecretsProvider with the current active
    deployment's snapshot
  - No cache invalidation mechanism needed -- immutability + session scoping is sufficient
```

### 5.8 Deployment Promotion

```
Promote dev -> staging:
  1. Create new deployment in staging environment
  2. Snapshot from staging environment's LIVE variables (not from dev snapshot)
  3. Config vars are project-wide so they are the same
  4. Env vars come from staging's own values in the DB

Rationale: staging has its own env var values; you do not want dev secrets in staging.

Config var snapshot behavior on promote:
  - Config vars are project-wide (not environment-specific)
  - The snapshot captures their VALUES at promotion time (current state)
  - If config vars changed between original dev deploy and staging promote,
    staging gets the NEW values (snapshot of current state, not copy from dev)
```

---

## 6. Permission Model

### New Permissions

| Permission         | Operations                                                  |
| ------------------ | ----------------------------------------------------------- |
| `namespace:read`   | List namespaces, list members                               |
| `namespace:create` | Create namespace                                            |
| `namespace:update` | Update namespace metadata, reorder, add/remove/move members |
| `namespace:delete` | Delete namespace                                            |

### Existing Permissions (Unchanged)

| Permission        | Operations                                                   |
| ----------------- | ------------------------------------------------------------ |
| `env_var:create`  | Create env var (now also creates memberships)                |
| `env_var:read`    | List/read env vars, reveal values, read snapshots            |
| `env_var:update`  | Update env var value/metadata (now also updates memberships) |
| `env_var:delete`  | Delete env var (cascades memberships)                        |
| `config_var:*`    | Same pattern for config vars                                 |
| `deployment:read` | Read deployment details, read snapshots, diff snapshots      |

### Composite Checks (AND -- both required, checked sequentially)

```
// Pattern: check each permission inline, return on first failure
if (!(await requireProjectPermission(req, res, 'deployment:read'))) return;
if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;
```

| Route                    | Required Permissions (AND)           |
| ------------------------ | ------------------------------------ |
| GET /snapshot            | `deployment:read` AND `env_var:read` |
| GET /snapshot/value/:key | `deployment:read` AND `env_var:read` |
| GET /snapshot/diff       | `deployment:read` only               |

---

## 7. Audit Log Events

| Action                | Metadata                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `namespace:create`    | `{ name, displayName, projectId, requestId }`                            |
| `namespace:update`    | `{ namespaceId, changes, requestId }`                                    |
| `namespace:delete`    | `{ namespaceId, name, movedToDefault, requestId }`                       |
| `namespace:reorder`   | `{ projectId, requestId }`                                               |
| `membership:add`      | `{ namespaceId, added, skipped, requestId }`                             |
| `membership:remove`   | `{ namespaceId, variableId, variableType, movedToDefault, requestId }`   |
| `membership:move`     | `{ sourceNamespaceId, targetNamespaceId, count, requestId }`             |
| `deployment:snapshot` | `{ deploymentId, snapshotHash, envVarCount, configVarCount, requestId }` |

---

## 8. Cascade Deletes

| When Deleted          | Also Delete                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project               | VariableNamespaces + VariableNamespaceMemberships + DeploymentVariableSnapshots + EnvironmentVariables + ProjectConfigVariables (fixes existing gap) |
| EnvironmentVariable   | All memberships where variableId matches and variableType="env"                                                                                      |
| ProjectConfigVariable | All memberships where variableId matches and variableType="config"                                                                                   |
| VariableNamespace     | All memberships where namespaceId matches; orphaned variables get "default" membership                                                               |
| Deployment            | DeploymentVariableSnapshot where deploymentId matches                                                                                                |
| Tenant                | Cascades through projects                                                                                                                            |

---

## 9. UI / UX Design

### 9.1 Project Settings -- Variables Tab

Replace the current separate "Config Variables" tab with a unified "Variables" tab in Project Settings.

```
+-------------------------------------------------------------+
|  Project Settings                                           |
|  +------+------------+----------+-------------+             |
|  | General | Variables | Members | Integrations |           |
|  +------+------------+----------+-------------+             |
|                                                             |
|  +--- Tab Bar -----------------------------------------+   |
|  |  Environment Vars    Config Vars                     |   |
|  +-----------------------------------------------------+   |
|                                                             |
|  +--- Toolbar -----------------------------------------+   |
|  |  Environment: [dev v]                                |   |
|  |                                                      |   |
|  |  Namespace: [Stripe Integration (4) v]              |   |
|  |                                                      |   |
|  |  Search: [Filter keys...]                           |   |
|  |                                                      |   |
|  |  [+ Add Variable]  [Manage Namespaces]              |   |
|  +-----------------------------------------------------+   |
|                                                             |
|  +--------------+-------------+------------------------+   |
|  | KEY          | VALUE       | ACTIONS                 |   |
|  +--------------+-------------+------------------------+   |
|  | API_KEY [S]  | ********    | Reveal Edit Tag Delete  |   |
|  | WEBHOOK_S [S]| ********    | Reveal Edit Tag Delete  |   |
|  | PUB_KEY      | ********    | Reveal Edit Tag Delete  |   |
|  | CURRENCY *   | ********    | Reveal Edit Tag Delete  |   |
|  +--------------+-------------+------------------------+   |
|                                                             |
|  * also in: Payments                                       |
|  [S] = secret                                              |
|                                                             |
|  Showing 4 of 15 variables                                 |
+-------------------------------------------------------------+
```

Key elements:

- Sub-tabs: "Environment Vars" and "Config Vars"
- Environment picker dropdown (visible only on env vars tab)
- Namespace dropdown: primary navigation for filtering by namespace
- Search: filters keys within the selected namespace
- Multi-membership indicator (\*) with tooltip showing other namespaces
- Lock/secret indicator [S] for isSecret variables

### 9.2 Namespace Dropdown

```
+--------------------------------------+
|  Namespace: [Stripe Integration v]   |
|  +----------------------------------+|
|  |  Search namespaces...            ||
|  |  --------------------------------||
|  |  All Variables              (15) ||
|  |  --------------------------------||
|  |  Default                     (3) ||
|  |  Stripe Integration          (4) ||  <-- selected
|  |  Payments                    (3) ||
|  |  Database                    (3) ||
|  |  Feature Flags               (2) ||
|  |  --------------------------------||
|  |  + Create new namespace...       ||
|  +----------------------------------+|
+--------------------------------------+
```

Behaviors:

- "All Variables" at top: shows every variable flat (default on page load).
  Count is a distinct count from the variable collection itself (not sum of namespace counts,
  which would double-count multi-namespace variables):
  `EnvironmentVariable.countDocuments({ tenantId, projectId, environment })`
- Each namespace shows variable count for current environment (env vars) or total (config vars)
  via aggregation: `VariableNamespaceMembership.countDocuments({ namespaceId, variableType })`
- Search within dropdown when many namespaces exist
- "Create new namespace..." at bottom opens inline form (name + displayName)
- Selecting a namespace filters the table
- Icon and color dot render next to each namespace name

### 9.3 Add Variable Dialog

```
+-------------------------------------------+
|  Add Environment Variable                  |
|                                            |
|  Key:         [STRIPE_API_KEY          ]   |
|  Value:       [sk_live_...             ]   |
|  Description: [Stripe live API key     ]   |
|  Secret:      [x]                          |
|                                            |
|  Namespaces:                               |
|    [Stripe Integration x] [Payments x]     |
|    [+ Add v]                               |
|                                            |
|  Environment: dev (from toolbar)           |
|                                            |
|              [Cancel] [Create]             |
+-------------------------------------------+
```

- Namespace pre-filled with currently selected namespace from dropdown
- If "All Variables" selected, defaults to "Default"
- Multi-select tag input for adding to multiple namespaces
- At least one namespace required (validation)

### 9.4 Tag / Namespace Assignment Popover

Triggered by the Tag action button on each variable row:

```
+---------------------------------+
|  Assign to Namespaces           |
|                                 |
|  [x] Default                    |
|  [x] Stripe Integration        |
|  [ ] Database                   |
|  [x] Payments                   |
|  [ ] Feature Flags              |
|                                 |
|  -------------------------      |
|  + Create new namespace...      |
|                                 |
|          [Cancel] [Save]        |
+---------------------------------+
```

- Checkboxes for each namespace
- At least one must remain checked (client-side validation)
- "Create new namespace" opens inline form
- Save calls PUT /env-vars/:id with namespaceIds (set semantics)

### 9.5 Manage Namespaces Panel

Slide-over panel accessed via "Manage Namespaces" button:

```
+---------------------------------------------------+
|  Manage Namespaces                          [x]   |
|                                                    |
|  Drag to reorder:                                  |
|                                                    |
|  = Default              3 vars    (system)         |
|  = Stripe Integration   4 vars    [Edit] [Delete]  |
|  = Payments             3 vars    [Edit] [Delete]  |
|  = Database             3 vars    [Edit] [Delete]  |
|  = Feature Flags        0 vars    [Edit] [Delete]  |
|                                                    |
|  [+ Add Namespace]                                 |
|                                                    |
|  -------------------------------------------------|
|  Deleting a namespace moves its orphaned           |
|  variables to Default.                             |
+---------------------------------------------------+
```

- Drag handle (=) for reordering, saved via PUT /reorder
- Default namespace shows "(system)", no edit/delete buttons
- Edit opens inline: displayName, description, icon picker, color picker
- Delete shows confirmation: "3 variables will be moved to Default. Continue?"
- Empty namespaces (0 vars) are visually dimmed but not auto-deleted

### 9.6 Deployments Page -- Env Vars Section (Updated)

The existing EnvironmentVariablesSection component on the Deployments page gets namespace dropdown:

```
+--- Environment Variables (dev) --------- 12 vars ------+
|  v (expanded)                                           |
|                                                         |
|  Namespace: [All Variables (12) v]                      |
|                                                         |
|  +--------------+-------------+--------------------+    |
|  | KEY          | VALUE       | ACTIONS             |   |
|  +--------------+-------------+--------------------+    |
|  | API_KEY [S]  | ********    | Reveal Edit Delete  |   |
|  | DB_HOST      | ********    | Reveal Edit Delete  |   |
|  | LOG_LEVEL    | ********    | Reveal Edit Delete  |   |
|  | ...          |             |                     |   |
|  +--------------+-------------+--------------------+    |
|                                                         |
|  [Copy from... v]  [+ Add Variable]                     |
+---------------------------------------------------------+
```

### 9.7 Deployment Snapshot View

In deployment detail page, each deployment has a "Variables" expandable section:

```
+-----------------------------------------------------+
|  Deployment: v12 (production)                        |
|  Created: 2026-03-10 14:30 by @sai                  |
|  Status: active                                      |
|                                                      |
|  v Variables Snapshot (15 env, 5 config)             |
|  +---------------------------------------------------+
|  |  Snapshot hash: a3f8c2...                        |
|  |  [Compare with: v11 v]                           |
|  |                                                   |
|  |  Namespace: [All Variables (20) v]               |
|  |                                                   |
|  |  KEY              TYPE    VALUE                   |
|  |  API_KEY [S]      env     ********   [Reveal]    |
|  |  WEBHOOK_SEC [S]  env     ********   [Reveal]    |
|  |  CURRENCY         config  usd                    |
|  |  DB_HOST          env     db.prod.internal       |
|  |  PRODUCT_NAME     config  TravelBot              |
|  |  ...                                              |
|  +---------------------------------------------------+
|                                                      |
|  Read-only -- values frozen at deploy time           |
+-----------------------------------------------------+
```

- Read-only view, no edit/delete actions
- TYPE column distinguishes env vs config
- Namespace dropdown filters the snapshot view
- Secret values masked, revealable with permission check
- Config var values shown directly (plaintext)

### 9.8 Deployment Diff View

Triggered by "Compare with" dropdown in snapshot view:

```
+-----------------------------------------------------+
|  Variable Changes: v11 -> v12                        |
|                                                      |
|  Namespace: [All Variables v]                        |
|                                                      |
|  +------------------+--------+---------------------+|
|  | KEY              | STATUS | DETAIL               ||
|  +------------------+--------+---------------------+|
|  | API_VERSION      | added  | v3                   ||
|  | WEBHOOK_SEC [S]  | changed| (secret)             ||
|  | DB_HOST          | changed| db-old -> db.prod    ||
|  | DEBUG_MODE       | removed|                      ||
|  +------------------+--------+---------------------+|
|                                                      |
|  Summary: 1 added, 2 changed, 1 removed             |
+-----------------------------------------------------+
```

- Color coded: green (added), yellow (changed), red (removed)
- Namespace dropdown filters the diff
- Secret values show "(secret)" -- never actual values
- Non-secret values show old -> new
- Config var diffs show actual value changes

### 9.9 Empty States

| State                                    | Display                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| New project, zero variables              | Default namespace in dropdown, empty table: "Add your first variable to get started."        |
| Selected namespace, zero variables       | "No variables in this namespace. Add one or assign existing variables using the Tag button." |
| "All Variables" selected, zero variables | "No variables configured for this environment."                                              |
| Pre-migration deployment, no snapshot    | "No snapshot available. Snapshots are created for new deployments."                          |

---

## 10. Constants

```typescript
// packages/compiler/src/platform/constants.ts (or new shared location)

export const MAX_NAMESPACES_PER_PROJECT = 25;
export const MAX_NAMESPACES_PER_VARIABLE = 10;
export const MAX_ENV_VARS_PER_PROJECT = 500;
export const MAX_CONFIG_VARS_PER_PROJECT = 200; // existing constant, already defined
export const MAX_NAMESPACE_NAME_LENGTH = 50;
export const MAX_NAMESPACE_DISPLAY_NAME_LENGTH = 100;
export const NAMESPACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
export const DEFAULT_NAMESPACE_NAME = 'default';
export const DEFAULT_NAMESPACE_DISPLAY_NAME = 'Default';
```

---

## 11. Data Migration

### Migration Script

```
For each project in the system:
  1. Create "default" VariableNamespace:
     { name: "default", displayName: "Default", isDefault: true, order: 0, tenantId, projectId }
  2. For each EnvironmentVariable in the project:
     Create VariableNamespaceMembership:
     { namespaceId: defaultNs._id, variableId: envVar._id, variableType: "env", tenantId, projectId }
  3. For each ProjectConfigVariable in the project:
     Create VariableNamespaceMembership:
     { namespaceId: defaultNs._id, variableId: configVar._id, variableType: "config", tenantId, projectId }

Properties:
  - Idempotent:
    - If "default" namespace already exists for project, reuse it
    - If a membership already exists (unique index), skip it (use bulkWrite with ordered: false)
    - After processing a project, verify all variables have at least one membership;
      create missing memberships to "default" for any orphans (handles partial migration crash)
    - Log: "Project {id}: default exists, added {N} missing memberships"
  - Batched: process 100 projects at a time
  - Logged: emit migration progress events with project count and timing
  - Reversible: drop variable_namespaces and variable_namespace_memberships collections
```

### Existing Deployments

- Pre-existing deployments get `variableSnapshotId: null`
- No backfill of snapshots -- forward-only
- UI shows "No snapshot available" for pre-migration deployments

### Schema Version

- DeploymentVariableSnapshot includes `snapshotVersion: 1` for future evolution
- If snapshot format changes in future, version field allows safe migration

---

## 12. Pre-existing Gap Fixes (Bundled)

These bugs in the current codebase are fixed as part of this work:

### 12.1 Tenant Isolation in Config Variable Repo

File: `apps/studio/src/repos/config-variable-repo.ts`

| Function                         | Fix                                        |
| -------------------------------- | ------------------------------------------ |
| `findConfigVariablesByProject`   | Add tenantId parameter, filter by tenantId |
| `findConfigVariableByKey`        | Add tenantId parameter, filter by tenantId |
| `deleteConfigVariablesByProject` | Add tenantId parameter, filter by tenantId |
| `countConfigVariables`           | Add tenantId parameter, filter by tenantId |

Migration strategy for existing callers:

1. Add tenantId as second required parameter to all four functions
2. Audit all callers in `apps/studio/src/app/api/` to pass `user.tenantId` from session context
3. Audit the compile route `apps/studio/src/app/api/abl/compile/route.ts` (line ~59) which calls
   `findConfigVariablesByProject(projectId)` -- must pass tenantId from authenticated session
4. Run type check: `pnpm build --filter=@abl/studio` to catch all broken callers
5. Add integration test verifying that a query with wrong tenantId returns empty results

### 12.2 Project Access Check on Config Var Collection Route

File: `apps/studio/src/app/api/projects/[id]/config-variables/route.ts`

The `[varId]` sub-route correctly uses `requireProjectAccess` -- the collection route must match.

- GET handler: replace `requireTenantAuth` with the same `requireProjectAccess` pattern
  used in the `[varId]/route.ts` (which verifies user has access to the specific project)
- POST handler: same change
- Both handlers must also verify `projectId` belongs to `user.tenantId`

### 12.3 Runtime Config Var Loading

File: `apps/runtime/src/repos/project-repo.ts`

- `loadConfigVariablesMap`: add tenantId parameter, filter by tenantId

### 12.4 Cascade Delete

File: `packages/database/src/cascade/cascade-delete.ts`

Add to `deleteProject` cascade (order matters -- delete deepest-first):

1. `VariableNamespaceMembership.deleteMany({ projectId })` -- memberships before variables/namespaces
2. `EnvironmentVariable.deleteMany({ projectId })`
3. `ProjectConfigVariable.deleteMany({ projectId })`
4. `VariableNamespace.deleteMany({ projectId })`
5. `DeploymentVariableSnapshot.deleteMany({ projectId })`

### 12.5 Max Env Var Count

File: `apps/runtime/src/routes/environment-variables.ts`

- Add count check on POST: `countEnvironmentVariables({ tenantId, projectId, environment })` must be < MAX_ENV_VARS_PER_PROJECT (500)

### 12.6 Project Import

File: `packages/project-io/src/import/`

- When importing, read `environment/config-vars.json` and `environment/env-vars.json`
- Create placeholder entries in "default" namespace with empty values
- Log warning that values must be manually configured

---

## 13. Concurrency & Edge Cases

| Scenario                                                            | Handling                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Concurrent namespace delete + variable create with that namespaceId | Variable creation validates namespaceIds exist before insert; if namespace gone, returns 400               |
| Concurrent removal from all namespaces by two requests              | MongoDB transaction on orphan-move-to-default; second request finds membership already exists (idempotent) |
| Deployment creation during namespace reorganization                 | Snapshot reads point-in-time data within a MongoDB session; captures whatever state exists at read time    |
| Concurrent namespace reorder by two users                           | Last-write-wins semantics (no optimistic locking); order field is low-stakes metadata                      |
| Snapshot for project with zero variables                            | Valid: creates snapshot with empty envVars[] and configVars[], snapshotHash of empty input                 |

---

## 14. Performance Considerations

| Concern                                            | Mitigation                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| N+1 queries when listing variables with namespaces | Aggregation pipeline: join memberships in single query, then join namespace names                                           |
| Large snapshot documents                           | Max ~500 env vars + 200 config vars = ~700 items; at ~200 bytes each = ~140KB per snapshot; acceptable for MongoDB document |
| Snapshot accumulation                              | Cascade-delete when deployment deleted; no TTL needed (deployments have lifecycle)                                          |
| Membership batch operations                        | Max 100 per request; uses bulkWrite                                                                                         |
| Namespace counts in dropdown                       | Aggregation on memberships collection with $group; cached in API response (stale OK for counts)                             |
| Runtime snapshot loading                           | One DB read per session init; cached in-memory for session lifetime                                                         |
