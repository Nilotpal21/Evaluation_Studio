# HLD: Environment Variables

**Feature Spec**: `docs/features/environment-variables.md`
**Test Spec**: `docs/testing/environment-variables.md`
**Status**: IMPLEMENTED
**Author**: Platform Team
**Date**: 2026-03-23

---

## 1. Problem Statement

The environment variables system (ALPHA) has 4 critical bugs that break core functionality and several P1/P2 gaps preventing STABLE status:

1. **GAP-001**: Create route rejects `environment: null` — falsy check at `environment-variables.ts:120` treats null as missing
2. **GAP-002**: Runtime `EnvVarStore.findEnvVar()` in `llm-wiring.ts:253-293` only queries exact environment — no base fallback to `environment: null`
3. **GAP-003**: Namespace-filtered listing in `environment-variables.ts:353-356` applies pagination before namespace filtering — wrong page counts
4. **GAP-004**: `envVarCache` in `secrets-provider.ts:232-270` uses `Map.get()` which returns `undefined` for missing keys — indistinguishable from "cached as not found"

Additionally, P1/P2 gaps exist: no base value UI in Studio, no variable diff view, no bulk export/import, and pre-deploy validation doesn't check base variables.

This HLD designs the fixes and new features to bring environment variables to STABLE.

---

## 2. Alternatives Considered

### Option A: Surgical In-Place Fixes + New Endpoints

- **Description**: Fix the 4 bugs in their existing locations. Add diff/export/import as new routes on the existing `/api/projects/:projectId/env-vars` router. Add base tab to existing Studio UI.
- **Pros**: Minimal code churn. Each fix is isolated and independently testable. No migration. Rollback is trivial (revert individual changes).
- **Cons**: EnvVarStore in llm-wiring.ts grows slightly more complex with two-query pattern.
- **Effort**: M

### Option B: Extract EnvVarService Layer

- **Description**: Extract all env var resolution logic into a new `EnvVarService` class. Move DB queries out of llm-wiring.ts and secrets-provider.ts into the service. Fix bugs during extraction.
- **Pros**: Cleaner architecture. Single place for resolution logic. Easier to test.
- **Cons**: Larger blast radius. Refactoring risk — could introduce regressions in working paths (snapshot service, tool-test-service). More files to review and test.
- **Effort**: L

### Option C: Database-Level Base Fallback

- **Description**: Create a MongoDB view or aggregation that automatically resolves base+override at query time, eliminating the two-query pattern in application code.
- **Pros**: Resolution logic lives in the DB layer. All consumers get base fallback automatically.
- **Cons**: Complex MongoDB aggregation. Harder to debug. Performance unpredictable for encrypted fields. Encryption plugin interop issues.
- **Effort**: L

### Recommendation: Option A — Surgical In-Place Fixes

**Rationale**: The bugs are well-understood with clear fix locations. The existing architecture is sound — the bugs are implementation errors, not design flaws. Extracting a service layer (Option B) adds risk for no functional benefit in this iteration. DB-level resolution (Option C) conflicts with the encryption plugin's Mongoose hooks. Option A minimizes blast radius while achieving STABLE status.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Studio (Next.js)                         │
│  ┌──────────────────────┐  ┌──────────────────────────────┐    │
│  │ EnvironmentVariables │  │ useEnvVars hook (SWR)        │    │
│  │ Section (UI)         │  │ api/environment-variables.ts │    │
│  │ + Base Tab (NEW)     │  └──────────────┬───────────────┘    │
│  └──────────┬───────────┘                 │                     │
└─────────────┼─────────────────────────────┼────────────────────┘
              │ HTTP                         │ HTTP
              ▼                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Runtime (Express)                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │        routes/environment-variables.ts (CRUD)            │  │
│  │   POST / | GET / | GET /:id/value | PUT /:id | DELETE    │  │
│  │   POST /copy | POST /validate                            │  │
│  │   GET /diff (NEW) | POST /export (NEW) | POST /import    │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────▼───────────────────────────────────┐  │
│  │              repos/security-repo.ts                       │  │
│  │  + findEnvironmentVariables (aggregation pipeline fix)    │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────▼───────────────────────────────────┐  │
│  │  services/secrets-provider.ts (RuntimeSecretsProvider)    │  │
│  │  Resolution: cache → envVar → base(NEW) → configVar      │  │
│  │  + Cache sentinel fix (Map.has() pattern)                 │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────▼───────────────────────────────────┐  │
│  │  services/execution/llm-wiring.ts (EnvVarStore impl)     │  │
│  │  + Two-query pattern: env-specific → base fallback        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        MongoDB                                   │
│  ┌────────────────────┐  ┌──────────────────────────────────┐  │
│  │ environment_       │  │ deployment_variable_snapshots    │  │
│  │ variables           │  │ (immutable, per deployment)     │  │
│  └────────────────────┘  └──────────────────────────────────┘  │
│  ┌────────────────────┐  ┌──────────────────────────────────┐  │
│  │ variable_namespaces│  │ variable_namespace_memberships   │  │
│  └────────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Diagram — Changes

```
┌─────────────────────────────────────────────────────────┐
│ Bug Fixes (in existing components)                       │
│                                                          │
│  environment-variables.ts:120                            │
│    BEFORE: if (!environment || !key || !value)           │
│    AFTER:  if (environment === undefined || !key ||      │
│            value === undefined || value === null)         │
│                                                          │
│  llm-wiring.ts EnvVarStore.findEnvVar()                  │
│    ADD: second query with environment: null when first   │
│         query returns null                               │
│                                                          │
│  secrets-provider.ts getEnvVar()                         │
│    BEFORE: if (cached !== undefined) return cached       │
│    AFTER:  if (this.envVarCache.has(key))                │
│            return this.envVarCache.get(key)              │
│                                                          │
│  security-repo.ts findEnvironmentVariables()             │
│    ADD: aggregation pipeline path when namespaceId       │
│         filter is provided ($lookup + $match + $skip)    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ New Endpoints (on existing router)                       │
│                                                          │
│  GET  /diff    — compare variables between envs          │
│  POST /export  — export variables to JSON                │
│  POST /import  — import variables from JSON              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Studio UI Changes                                        │
│                                                          │
│  EnvironmentsTab.tsx: Add "Base (Default)" pseudo-tab    │
│  EnvironmentVariablesSection.tsx: Accept nullable env     │
│  CopyVariablesDialog.tsx: Allow base as source/target    │
└─────────────────────────────────────────────────────────┘
```

### Data Flow — Base Fallback Resolution (Post-Fix)

```
Agent Tool Execution
  │
  ├─ SecretsProvider.getEnvVar("API_KEY")
  │   ├─ 1. Check envVarCache (Map.has(key))
  │   │   └─ HAS key → return Map.get(key) (may be undefined sentinel)
  │   │
  │   ├─ 2. Query EnvVarStore (environment-specific)
  │   │   ├─ EnvironmentVariable.findOne({tenantId, projectId,
  │   │   │     environment: "staging", key: "API_KEY"})
  │   │   └─ Found → decrypt → cache → return
  │   │
  │   ├─ 3. Query EnvVarStore (base fallback) ← NEW
  │   │   ├─ EnvironmentVariable.findOne({tenantId, projectId,
  │   │   │     environment: null, key: "API_KEY"})
  │   │   └─ Found → decrypt → cache → return
  │   │
  │   ├─ 4. Cache "not found" sentinel
  │   │   └─ envVarCache.set(key, undefined) ← NEW
  │   │
  │   └─ 5. Return undefined
```

### Sequence Diagram — Namespace Pagination (Post-Fix)

```
Client                 Route Handler            security-repo.ts              MongoDB
  │                        │                         │                          │
  ├─ GET /env-vars?        │                         │                          │
  │  namespaceId=ns1&      │                         │                          │
  │  page=1&limit=5 ──────▶│                         │                          │
  │                        │── findEnvironmentVars ──▶│                          │
  │                        │   {namespaceId: "ns1",   │                          │
  │                        │    skip: 0, take: 5}     │                          │
  │                        │                         │── aggregate([            │
  │                        │                         │   {$match: {tenantId,    │
  │                        │                         │     projectId, env}},    │
  │                        │                         │   {$lookup: {            │
  │                        │                         │     from: "variable_     │
  │                        │                         │     namespace_memberships│
  │                        │                         │     ...}},               │
  │                        │                         │   {$match: {             │
  │                        │                         │     "memberships.        │
  │                        │                         │     namespaceId": ns1}}, │
  │                        │                         │   {$facet: {             │
  │                        │                         │     data: [$skip,$limit],│
  │                        │                         │     total: [$count]}}    │
  │                        │                         │ ]) ─────────────────────▶│
  │                        │                         │◀── {data: 5, total: 10} ─│
  │◀── {variables: [...],  │                         │                          │
  │     pagination: {       │                         │                          │
  │       total: 10,        │                         │                          │
  │       page: 1}} ────────│                         │                          │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                                                         |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | Every MongoDB query includes `tenantId`. The `tenantIsolationPlugin` enforces this at model level. Cross-tenant returns 404. New endpoints (diff, export, import) inherit the same middleware chain — `authMiddleware` + `requireProjectScope`.                                                                         |
| 2   | **Data Access**      | Existing repository pattern in `security-repo.ts`. Bug fixes modify existing repo functions (aggregation pipeline for namespace pagination). New endpoints use existing repo functions where possible (`bulkUpsertEnvironmentVariables` for import). No new repo files.                                                 |
| 3   | **API Contract**     | Bug fixes are non-breaking: create now accepts `null` environment (additive). New endpoints follow existing envelope pattern: `{ success: true, data }` / `{ success: false, error: { message } }`. Error codes: 400 (validation), 404 (not found), 409 (duplicate).                                                    |
| 4   | **Security Surface** | All new endpoints require same auth chain: `authMiddleware` → `requireProjectScope` → `requireProjectPermission('env_var:read')` for GET, `env_var:create` for POST import. Export decrypts values — requires `env_var:read` permission. Import validates all keys against `KEY_PATTERN` and values against max length. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                   |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Bug fixes improve error handling: create route now distinguishes `null` (valid base) from `undefined` (missing). Cache sentinel prevents silent retry storms. Aggregation pipeline errors return 500 with logged context.                                         |
| 6   | **Failure Modes** | Base fallback adds one additional DB query on cache miss — if MongoDB is slow, resolution latency doubles (2x ~25ms). Acceptable for cold path. Aggregation pipeline failure falls back to returning 500 (no degraded mode — pagination must be correct or fail). |
| 7   | **Idempotency**   | Create is idempotent by unique index — duplicate returns 409. Import with `overwrite: false` skips existing keys (idempotent). Export is read-only. Diff is read-only.                                                                                            |
| 8   | **Observability** | Base fallback adds log: `log.debug('Environment variable resolved', { key, layer: 'envVarStore-base' })`. Cache sentinel adds: `log.debug('Environment variable cached as not-found', { key })`. New endpoints log audit entries for import.                      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                       |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Base fallback: +1 DB query on miss (~25ms cold). Cached path unchanged (<1ms). Aggregation pipeline: comparable to current find+filter but correct. Export: O(N) decrypt for N variables. Import: O(N) encrypt+upsert. All within existing latency targets from test spec.                            |
| 10  | **Migration Path**     | No data migration. Schema changes are backward-compatible (null environment already allowed in model enum). Code changes are all additive or fix-in-place.                                                                                                                                            |
| 11  | **Rollback Plan**      | Each fix is independent and revertable: (1) Create route: revert one line. (2) Base fallback: remove second query in EnvVarStore. (3) Pagination: revert aggregation to simple find. (4) Cache sentinel: revert `has()` to `get() !== undefined`. New endpoints can be removed with zero data impact. |
| 12  | **Test Strategy**      | 14 E2E scenarios via real Express + MongoMemoryServer with full middleware. 11 integration scenarios testing service boundaries (SecretsProvider→EnvVarStore→MongoDB, SnapshotService→MongoDB, aggregation pipeline). No mocks of codebase components. See `docs/testing/environment-variables.md`.   |

---

## 5. Data Model

### No New Collections

All changes operate on existing collections. No schema changes required.

### Modified Behavior

| Collection              | Change                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `environment_variables` | Create route now accepts `environment: null` (was rejected). No schema change — model already supports null. |

### Aggregation Pipeline (New Query Pattern)

When `namespaceId` filter is provided, `findEnvironmentVariables` switches from simple `find()` + post-filter to:

```javascript
db.environment_variables.aggregate([
  { $match: { tenantId, projectId, environment } },
  {
    $lookup: {
      from: 'variable_namespace_memberships',
      let: { varId: '$_id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$variableId', '$$varId'] },
                { $eq: ['$variableType', 'env'] },
                { $eq: ['$namespaceId', namespaceId] },
              ],
            },
          },
        },
      ],
      as: 'memberships',
    },
  },
  { $match: { 'memberships.0': { $exists: true } } },
  {
    $facet: {
      data: [{ $skip: skip }, { $limit: take }],
      total: [{ $count: 'count' }],
    },
  },
]);
```

**Index coverage**: Existing index `{ variableId: 1, variableType: 1 }` on `variable_namespace_memberships` covers the `$lookup` join. Existing index `{ tenantId: 1, projectId: 1, environment: 1 }` on `environment_variables` covers the initial `$match`.

---

## 6. API Design

### New Endpoints

| Method | Path                                       | Purpose                                           | Auth             |
| ------ | ------------------------------------------ | ------------------------------------------------- | ---------------- |
| GET    | `/api/projects/:projectId/env-vars/diff`   | Compare variables between two environments        | `env_var:read`   |
| POST   | `/api/projects/:projectId/env-vars/export` | Export variables to JSON (decrypted)              | `env_var:read`   |
| POST   | `/api/projects/:projectId/env-vars/import` | Import variables from JSON with overwrite control | `env_var:create` |

### Diff Endpoint

**Request**: `GET /diff?source=dev&target=staging`

**Response**:

```json
{
  "success": true,
  "diff": {
    "added": [{ "key": "STAGING_ONLY", "environment": "staging" }],
    "removed": [{ "key": "DEV_ONLY", "environment": "dev" }],
    "changed": [{ "key": "API_URL", "sourceValue": "(masked)", "targetValue": "(masked)" }],
    "unchanged": 5
  }
}
```

**Design**: Query all variables for both environments. Compare by key. AES-GCM produces different ciphertext for identical plaintext (unique IV per encryption), so diff must decrypt both values and compare plaintext. This adds O(N) decryption cost but ensures correctness. For N < 100 variables this is well within latency targets.

### Export Endpoint

**Request**: `POST /export { environment: "dev" }`

**Response**:

```json
{
  "success": true,
  "variables": [
    { "key": "API_KEY", "value": "sk-123", "isSecret": true, "description": "API key" },
    { "key": "DB_HOST", "value": "db.internal", "isSecret": false, "description": null }
  ]
}
```

**Design**: Query all variables for the environment, decrypt each, return as JSON array. Includes `isSecret` flag so import can restore masking behavior.

### Import Endpoint

**Request**: `POST /import { environment: "staging", variables: [...], overwrite: false }`

**Response**:

```json
{
  "success": true,
  "imported": 3,
  "skipped": 2,
  "errors": []
}
```

**Design**: Validate all keys against `KEY_PATTERN` and values against max length. Use `bulkUpsertEnvironmentVariables` with overwrite flag. Each variable is individually created/updated within a loop (not a bulk write) to maintain encryption plugin hooks.

### Modified Endpoints

| Method | Path        | Change                                                                                                 |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------ |
| POST   | `/`         | Fix: `environment: null` accepted (was rejected). Zod schema: `z.enum(VALID_ENVIRONMENTS).nullable()`. |
| GET    | `/`         | Fix: When `namespaceId` provided, uses aggregation pipeline for correct pagination.                    |
| POST   | `/validate` | Fix: Checks both env-specific and base (`environment: null`) variables when reporting coverage.        |

### Error Responses

| Code | When                                             | Body                                                       |
| ---- | ------------------------------------------------ | ---------------------------------------------------------- |
| 400  | Invalid key, value too long, invalid environment | `{ success: false, error: { message: "..." } }`            |
| 401  | Missing or invalid auth token                    | `{ success: false, error: { message: "Unauthorized" } }`   |
| 403  | Insufficient permissions                         | `{ success: false, error: { message: "Forbidden" } }`      |
| 404  | Variable/project not found, cross-tenant access  | `{ success: false, error: { message: "Not found" } }`      |
| 409  | Duplicate key+environment                        | `{ success: false, error: { message: "Already exists" } }` |
| 429  | Rate limit exceeded                              | `{ success: false, error: { message: "Rate limited" } }`   |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Import endpoint writes bulk audit entry: `env-variable:import` with `{ count, environment, overwrite }`. Export writes `env-variable:export` with `{ environment, count }`. Diff is read-only, no audit.
- **Rate Limiting**: All new endpoints use existing `tenantRateLimit('request')` middleware.
- **Caching**: No new caches. Existing `envVarCache` in RuntimeSecretsProvider gets sentinel fix (`Map.has()` pattern).
- **Encryption**: Export decrypts values (requires `env_var:read`). Import encrypts via encryption plugin's `pre-save` hook. No direct crypto code in new endpoints.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type      | Risk                                                              |
| ----------------------------- | --------- | ----------------------------------------------------------------- |
| `@agent-platform/database`    | workspace | Encryption plugin behavior critical — tested with real encryption |
| `@agent-platform/config`      | workspace | `VALID_ENVIRONMENTS` enum — stable, no changes needed             |
| `@agent-platform/shared-auth` | workspace | Auth middleware — stable, no changes needed                       |
| MongoDB                       | external  | Aggregation pipeline correctness — tested with MongoMemoryServer  |

### Downstream (depends on this feature)

| Consumer            | Impact                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| ABL Compiler        | Benefits from base fallback fix — `{{env.KEY}}` resolves correctly          |
| Tool execution      | Benefits from base fallback — tools get base values when no override exists |
| Deployment system   | No impact — snapshot service already handles base+override correctly        |
| Studio tool testing | No impact — tool-test-service already has correct base fallback             |
| Studio UI           | New base tab — additive change to EnvironmentsTab.tsx                       |

---

## 9. Open Questions & Decisions Needed

1. Should the diff endpoint compare decrypted values (more accurate but slower) or ciphertext (faster but AES-GCM nonce makes identical values appear different)? **Recommendation**: Decrypt — correctness over speed. Cost is O(N) decrypt, N typically < 100.
2. Should export include namespace membership data, or just key-value pairs? **Recommendation**: Include optional `namespaces` array per variable for full-fidelity export.
3. Should import into a different project be supported, or only same-project cross-environment? **Recommendation**: Same-project only for v1 — cross-project requires permission checks on both projects.

---

## 10. References

- Feature spec: `docs/features/environment-variables.md`
- Test spec: `docs/testing/environment-variables.md`
- Existing design: `docs/specs/2026-03-13-environment-consistency-variable-overrides-design.md`
- Implementation plan: `docs/plans/2026-03-13-environment-consistency-variable-overrides.md`
- SDLC logs: `docs/sdlc-logs/environment-variables/`
