# Tenant LLM Policy -- High-Level Design

**Feature Spec**: `docs/features/tenant-llm-policy.md`
**Test Spec**: `docs/testing/tenant-llm-policy.md`
**Status**: Re-generated via SDLC pipeline (2026-03-22)

---

## 1. Problem Statement

Multi-tenant LLM platforms need governance controls that restrict which providers are available, how credentials are resolved, and what budget/rate limits apply at the organization level. Without these controls, any user can use any provider (security risk), with no cost boundaries (financial risk), using credentials outside organizational policy (compliance risk). The Tenant LLM Policy provides a per-tenant governance document consumed by the ModelResolutionService during every LLM call to enforce these restrictions.

**Refined from feature spec**: The feature is already implemented and deployed. This HLD documents the existing architecture for the purposes of testing, maintenance, and future enhancement planning. Key gaps include: no real-time budget enforcement, no dedicated route tests, and no E2E coverage.

---

## 2. Alternatives Considered

### Alternative A: Policy in Environment Variables

**Description**: Store LLM governance settings (allowed providers, credential policy) in environment variables per deployment, not in MongoDB.

**Pros**:

- Zero DB dependency for policy reads
- Fast access (in-process memory)
- Simple configuration for single-tenant deployments

**Cons**:

- Cannot change per tenant in a multi-tenant setup without redeployment
- No audit trail for policy changes
- No partial updates; must redeploy for any change
- Does not scale to per-tenant governance

**Effort**: S

### Alternative B: Policy in MongoDB with REST API (CHOSEN)

**Description**: Store one policy document per tenant in MongoDB with a REST API for CRUD. Policy consumed by ModelResolutionService at runtime via repo layer.

**Pros**:

- Per-tenant governance with runtime configurability
- Audit trail via writeAuditLog
- Partial updates via upsert semantics
- Integrates with existing auth/RBAC middleware
- Schema versioning via \_v field for future migrations

**Cons**:

- DB query per policy fetch (no caching currently)
- Fail-open behavior if DB unavailable (policy enforcement skipped)
- No real-time budget enforcement (storage only)

**Effort**: M

### Alternative C: Policy in Redis with MongoDB Persistence

**Description**: Cache policy in Redis for sub-millisecond reads, with MongoDB as the source of truth. Write-through cache invalidation on PUT.

**Pros**:

- Sub-millisecond policy reads during model resolution
- Reduced MongoDB load under high throughput
- Can support future rate limiting via Redis counters

**Cons**:

- Additional infrastructure dependency (Redis)
- Cache invalidation complexity
- Stale reads during cache TTL window
- Over-engineering for current query volume (unique index lookup is < 10ms)

**Effort**: M-L

### Recommendation

**Alternative B** (MongoDB + REST API) is the chosen and implemented approach. The unique index on tenantId makes lookups fast enough for current scale. Adding Redis caching (Alternative C) is a reasonable future optimization if policy fetch latency becomes a bottleneck, but is not justified now. Alternative A is rejected for multi-tenant governance.

---

## 3. Architecture

### System Context Diagram

```
                           +-------------------+
                           |   Tenant Admin    |
                           |   (REST Client)   |
                           +--------+----------+
                                    |
                           PUT/GET /api/tenants/:tenantId/llm-policy
                                    |
                                    v
+---------------------------+---------------------------+
|                        Runtime Server                  |
|                                                        |
|  +------------------+    +-------------------------+   |
|  | tenant-llm-      |    | ModelResolutionService  |   |
|  | policy route     |    |                         |   |
|  | (GET/PUT)        |    | safeFetchTenantPolicy() |   |
|  +--------+---------+    | enforceProviderAllowlist|   |
|           |              | resolveCredential()     |   |
|           v              +------------+------------+   |
|  +--------+---------+                 |                |
|  | tenant-llm-      |                 v                |
|  | policy-repo      |    +-----------+-----------+     |
|  | (upsert/find)    |    | llm-resolution-repo   |     |
|  +--------+---------+    | findTenantLLMPolicy() |     |
|           |              +-----------+-----------+     |
|           |                          |                 |
+---------------------------+---------------------------+
                           |           |
                           v           v
                    +------+-----------+------+
                    |        MongoDB          |
                    | tenant_llm_policies     |
                    | (unique idx: tenantId)  |
                    +-------------------------+
```

### Component Diagram

```
tenant-llm-policy.ts (Route)
  |-- authMiddleware (JWT validation)
  |-- tenantRateLimit('request')
  |-- requirePermission('credential:read' | 'credential:write')
  |-- getTenantId() (URL param vs auth context verification)
  |-- Zod validation (policyUpdateSchema / policyResponseSchema)
  |-- tenant-llm-policy-repo.ts (Repository)
  |     |-- findLLMPolicyOrDefaults()
  |     |-- upsertLLMPolicy()
  |     |-- TenantLLMPolicy model (Mongoose)
  |-- writeAuditLog() (auth-repo.ts)

model-resolution.ts (Consumer)
  |-- safeFetchTenantPolicy()
  |     |-- llm-resolution-repo.findTenantLLMPolicy()
  |     |-- TenantLLMPolicy model (Mongoose)
  |-- enforceProviderAllowlist(policy, provider, modelId)
  |-- resolveCredential(context, provider, policy)
  |     |-- findDefaultUserCredential() / findDefaultTenantCredential()
```

### Data Flow: Policy Update

```
1. Tenant admin sends PUT /api/tenants/:tenantId/llm-policy
2. authMiddleware validates JWT, populates req.tenantContext
3. tenantRateLimit checks request rate
4. requirePermission('credential:write') checks RBAC
5. getTenantId() verifies URL :tenantId matches auth context
6. Zod policyUpdateSchema validates request body
7. PUT handler validates allowedProviders against VALID_PROVIDERS
8. PUT handler filters body through allowedFields (excludes platformDemoEnabled)
9. upsertLLMPolicy() calls findOneAndUpdate with $set and upsert:true
10. MongoDB atomically creates or updates the document
11. log.info emits structured log with tenantId and changed fields
12. writeAuditLog emits audit entry with action, userId, fields, requestId
13. Response: { success: true, policy: { ...all fields } }
```

### Data Flow: Policy Enforcement at Runtime

```
1. Agent execution triggers model resolution
2. ModelResolutionService.resolve(context) called
3. safeFetchTenantPolicy(tenantId) queries MongoDB
   -> If DB error: returns null (fail-open, logged as warning)
4. If policy exists and allowedProviders is non-empty:
   -> enforceProviderAllowlist() checks provider against list
   -> Throws FORBIDDEN AppError if not allowed
5. resolveCredential(context, provider, policy) called
   -> Reads credentialPolicy (default: 'user_only' if null)
   -> org_first: findDefaultTenantCredential -> findDefaultUserCredential
   -> user_first: findDefaultUserCredential -> findDefaultTenantCredential
   -> org_only: findDefaultTenantCredential only
   -> user_only: findDefaultUserCredential only
   -> Last resort: findTenantModelByProvider for connection credential
6. Resolution continues through 5-level chain
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Analysis                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | `tenantId` is included in every query via `findOne({ tenantId })`. `tenantIsolationPlugin` is applied to the Mongoose schema. Route-level verification via `getTenantId()` ensures URL `:tenantId` matches auth context. **Gap**: Returns 403 on mismatch instead of 404 per platform principles.      |
| 2   | **Data Access Pattern** | Repository layer (`tenant-llm-policy-repo.ts`) abstracts MongoDB operations. Two repos exist: the route-facing repo (upsert/find with defaults) and the resolution-facing repo (`llm-resolution-repo.ts` with JSON serialization). No caching. Direct MongoDB queries via unique index.                |
| 3   | **API Contract**        | GET returns `{ success: true, policy: {...} }`. PUT accepts partial body (Zod-validated), returns same shape. Error responses: `{ success: false, error: string }`. No API versioning. OpenAPI router provides schema documentation. Error codes: 400 (validation), 403 (tenant/RBAC), 500 (internal). |
| 4   | **Security Surface**    | Auth: `authMiddleware` (JWT) + `requirePermission()` (RBAC). Input validation: Zod schemas for body, provider allowlist validation. SSRF: N/A (no external calls). Encryption: N/A (no secrets stored in policy). `platformDemoEnabled` excluded from tenant writes.                                   |

### Behavioral Concerns

| #   | Concern           | Analysis                                                                                                                                                                                                                                          |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | GET: 403 (tenant mismatch), 500 (DB error). PUT: 400 (validation), 403 (tenant/RBAC), 500 (DB error). Model resolution: `AppError(FORBIDDEN)` for provider violations. DB errors logged at ERROR level, policy fetch failures logged as WARN.     |
| 6   | **Failure Modes** | DB unavailable: `safeFetchTenantPolicy()` returns null (fail-open). Policy enforcement silently skipped. No circuit breaker. No retry on transient DB errors. Upsert race condition: MongoDB handles atomically via `findOneAndUpdate`.           |
| 7   | **Idempotency**   | PUT is idempotent via upsert with `$set`. Identical concurrent PUTs produce the same final state. GET is naturally idempotent (read-only).                                                                                                        |
| 8   | **Observability** | INFO log on policy update (tenantId, changed fields). ERROR log on failures. Audit log entry (`tenant-llm-policy:update`) with userId, fields, requestId. Credential chain diagnostics include policy context. No dedicated metrics or dashboard. |

### Operational Concerns

| #   | Concern                | Analysis                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Policy fetch: < 10ms (unique index on tenantId). Route response: < 50ms (single DB query + serialization). Payload size: ~500 bytes per policy document. No batch operations needed (one doc per tenant).                                                                                                                                                                       |
| 10  | **Migration Path**     | Schema versioned via `_v` field (currently 1). Future migrations: increment `_v`, add migration script. No existing data migration needed (feature deployed from scratch). Adding new fields: use Mongoose defaults + `setDefaultsOnInsert`.                                                                                                                                    |
| 11  | **Rollback Plan**      | Remove route from `server.ts` (line 489). Model resolution `safeFetchTenantPolicy()` returns null when collection is empty, so enforcement is automatically disabled. Data in `tenant_llm_policies` is safe to leave (orphaned but harmless).                                                                                                                                   |
| 12  | **Test Strategy**      | **Unit**: Provider allowlist, credential policy, Zod validation (existing: model-resolution-comprehensive, credential-chain-analyzer). **Integration**: Repo-to-MongoDB roundtrip, audit log emission, DB unavailability. **E2E**: Full route lifecycle (GET/PUT/RBAC/tenant verification) via HTTP against real Express server. Coverage target: 80% of FRs with direct tests. |

---

## 5. Data Model

### New Collection: tenant_llm_policies

```text
Collection: tenant_llm_policies
Fields:
  _id: String (UUIDv7, primary key)
  tenantId: String (required, unique)
  allowedProviders: [String] (default [])
  credentialPolicy: String (required)
  monthlyTokenBudget: Number (required, default 0)
  dailyTokenBudget: Number (required, default 0)
  defaultModel: String (default null)
  defaultFastModel: String (default null)
  defaultVoiceModel: String (default null)
  maxRequestsPerMinute: Number (required, default 600)
  allowProjectCredentials: Boolean (required, default true)
  platformDemoEnabled: Boolean (required, default false)
  _v: Number (default 1)
  createdAt: Date (auto)
  updatedAt: Date (auto)

Indexes:
  { tenantId: 1 } UNIQUE

Plugins:
  tenantIsolationPlugin
```

### Modified Collections

None.

### Key Relationships

- Referenced by `ModelResolutionService` (read-only via `findTenantLLMPolicy()`)
- Referenced by `writeAuditLog()` (write-only for policy mutations)
- No foreign key constraints to other collections

---

## 6. API Design

### Endpoints

| Method | Path                                | Auth                   | Purpose                                                                 |
| ------ | ----------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/tenants/:tenantId/llm-policy` | JWT + credential:read  | Fetch tenant LLM policy (returns defaults if none exists)               |
| PUT    | `/api/tenants/:tenantId/llm-policy` | JWT + credential:write | Upsert tenant LLM policy (partial update, platformDemoEnabled excluded) |

### Request/Response Shapes

**GET Response (200)**:

```json
{
  "success": true,
  "policy": {
    "credentialPolicy": "org_first",
    "allowedProviders": [],
    "allowProjectCredentials": true,
    "platformDemoEnabled": false,
    "monthlyTokenBudget": 0,
    "dailyTokenBudget": 0,
    "maxRequestsPerMinute": 600,
    "defaultModel": null,
    "defaultFastModel": null,
    "defaultVoiceModel": null
  }
}
```

**PUT Request Body** (all fields optional):

```json
{
  "credentialPolicy": "org_only",
  "allowedProviders": ["openai", "anthropic"],
  "allowProjectCredentials": false,
  "monthlyTokenBudget": 100000,
  "dailyTokenBudget": 5000,
  "maxRequestsPerMinute": 300,
  "defaultModel": "gpt-4o",
  "defaultFastModel": "gpt-4o-mini",
  "defaultVoiceModel": null
}
```

**PUT Response (200)**: Same shape as GET response.

### Error Responses

| Status | Condition              | Body                                                                          |
| ------ | ---------------------- | ----------------------------------------------------------------------------- |
| 400    | Invalid provider names | `{ success: false, error: "Invalid provider(s): xxx. Valid providers: ..." }` |
| 400    | Zod validation failure | `{ success: false, error: "..." }` (Zod error message)                        |
| 401    | Missing auth token     | Auth middleware response                                                      |
| 403    | Missing permission     | RBAC middleware response                                                      |
| 403    | Tenant ID mismatch     | `{ success: false, error: "Tenant access denied" }`                           |
| 500    | Internal/DB error      | `{ success: false, error: "Failed to get/update LLM policy" }`                |

---

## 7. Cross-Cutting Concerns

### Audit Logging

- `writeAuditLog()` called on every successful PUT with action `tenant-llm-policy:update`
- Metadata includes: `fields` (array of changed field names), `requestId`
- Fire-and-forget: audit failure does not block the response

### Rate Limiting

- `tenantRateLimit('request')` middleware applied to the route
- Limits based on tenant-level rate configuration
- Rate limit for the policy API itself is separate from the policy's `maxRequestsPerMinute` field (which is for LLM calls, not API calls)

### Caching

- **Currently**: No caching. Direct MongoDB query per fetch.
- **Future**: Short TTL (30-60s) Redis cache could be added if policy fetch becomes a bottleneck. Invalidation on PUT.

### Encryption

- N/A for policy storage (no secrets in policy document)
- Credential resolution (triggered by policy's `credentialPolicy`) uses the platform's EncryptionService for decrypting API keys

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                | Risk   | Notes                                                                                                  |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| MongoDB                   | Medium | DB unavailability = fail-open (policy enforcement skipped silently)                                    |
| authMiddleware (JWT)      | Low    | Standard platform auth, well-tested                                                                    |
| requirePermission (RBAC)  | Low    | Standard platform RBAC, well-tested                                                                    |
| tenantIsolationPlugin     | Low    | Standard platform plugin, well-tested                                                                  |
| writeAuditLog (auth-repo) | Low    | Fire-and-forget; audit failure does not block policy operations                                        |
| EncryptionService         | Medium | Required by credential resolution (not by policy storage); unavailability blocks credential decryption |

### Downstream (depends on this feature)

| Consumer                  | Impact | Notes                                                                                 |
| ------------------------- | ------ | ------------------------------------------------------------------------------------- |
| ModelResolutionService    | High   | Primary consumer. If policy enforcement changes behavior, all LLM calls are affected. |
| Credential Chain Analyzer | Low    | Diagnostics only. No functional dependency.                                           |
| Future budget enforcement | Medium | Will depend on budget fields currently stored but not enforced.                       |

---

## 9. Open Questions & Decisions Needed

1. **Budget enforcement architecture**: Should real-time budget enforcement be a middleware (checking counters before model resolution) or integrated into the ModelResolutionService? Trade-off: middleware is cleaner separation; integrated is fewer DB queries.
2. **Tenant verification response code**: Should cross-tenant access return 404 (per platform principles) or 403 (current behavior)? Changing to 404 requires updating the route handler.
3. **Redis caching**: At what request volume should Redis caching be introduced? Current unique-index queries are < 10ms.
4. **allowedProviders JSON serialization**: Should `findTenantLLMPolicy()` in `llm-resolution-repo.ts` stop serializing to JSON string? This is a legacy artifact from a prior Prisma/SQLite data layer that adds unnecessary serialization/deserialization overhead.
5. **Per-project overrides**: Should the architecture support per-project LLM policy overrides that inherit from and can restrict the tenant policy? This would require a `project_llm_policies` collection with inheritance logic.

---

## 10. References

- Feature spec: `docs/features/tenant-llm-policy.md`
- Test spec: `docs/testing/tenant-llm-policy.md`
- LLD: `docs/plans/2026-03-22-tenant-llm-policy-impl-plan.md`
- Mongoose model: `packages/database/src/models/tenant-llm-policy.model.ts`
- Route repo: `apps/runtime/src/repos/tenant-llm-policy-repo.ts`
- Resolution repo: `apps/runtime/src/repos/llm-resolution-repo.ts`
- Model resolution: `apps/runtime/src/services/llm/model-resolution.ts`
- Route handler: `apps/runtime/src/routes/tenant-llm-policy.ts`
- Server mounting: `apps/runtime/src/server.ts` (line 489)
