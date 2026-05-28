# Feature: Tenant LLM Policy

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `governance`, `enterprise`, `admin operations`
**Package(s)**: `apps/runtime`, `packages/database`
**Owner(s)**: `Platform team`
**Testing Guide**: `../testing/tenant-llm-policy.md`
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

Multi-tenant platforms require governance controls over LLM usage. Without tenant-level policies, any user in any tenant can invoke any LLM provider with no restrictions on which providers are permitted, how credentials are resolved, or what cost boundaries apply. This creates three categories of risk: security risks (credentials leaking across contexts, unauthorized provider access), cost risks (no budget or rate limiting), and compliance risks (data sent to unapproved providers in regulated industries).

### Goal Statement

Provide a per-tenant LLM governance policy that controls provider allowlists, credential resolution order, token budget limits, rate limits, default model selections, and project-level credential permissions. The policy integrates into the ModelResolutionService's 5-level resolution chain to enforce restrictions at runtime before any LLM call is made.

### Summary

Tenant LLM Policy stores one policy document per tenant in MongoDB (`tenant_llm_policies` collection). Each policy controls: credential resolution strategy (org_first, user_first, org_only, user_only), allowed provider allowlist, token budgets (monthly/daily), rate limits (requests per minute), default models (primary, fast, voice), and whether project-level credentials are permitted. The policy is consumed by the `ModelResolutionService` (in `apps/runtime/src/services/llm/model-resolution.ts`) via `safeFetchTenantPolicy()`, which calls `findTenantLLMPolicy()` from the resolution repo. Provider allowlist enforcement throws `FORBIDDEN` for unapproved providers. Credential resolution follows the four-mode policy to determine lookup order between user and org credentials.

---

## 2. Scope

### Goals

- Store one LLM governance policy per tenant with upsert semantics (atomic create-or-update)
- Support four credential resolution policies: org_first, user_first, org_only, user_only
- Enforce provider allowlist at model resolution time (reject unapproved providers with FORBIDDEN)
- Store token budget fields (monthly, daily) and rate limit field (requests per minute)
- Configure default models per operation tier (primary, fast, voice)
- Control whether project-level credentials are permitted via `allowProjectCredentials`
- Expose GET/PUT REST API at `/api/tenants/:tenantId/llm-policy` with RBAC (credential:read, credential:write)
- Audit log all policy mutations with userId, tenantId, and changed field names

### Non-Goals (Out of Scope)

- Real-time token budget enforcement middleware (policy stores limits; enforcement is a separate feature)
- Per-project LLM policy overrides (only tenant-level policies exist)
- Budget alerting, notification, or threshold warning system
- Provider-specific policy (e.g., max tokens per request per provider)
- Studio UI for LLM policy management (API-only for now)

---

## 3. User Stories

1. As a **tenant admin**, I want to restrict which LLM providers my organization can use, so that only approved providers (e.g., only Azure, no OpenAI direct) are available to agents at runtime.
2. As a **security officer**, I want to control the credential resolution order (org-first vs user-first), so that organization-managed API keys take precedence over personal keys, or vice versa, depending on our security posture.
3. As a **finance manager**, I want to set monthly and daily token budgets on the policy, so that the budget data is available for future enforcement middleware without requiring schema changes.
4. As a **platform operator**, I want to set default models for my tenant (primary, fast, voice), so that agents use cost-effective models unless explicitly overridden at the project or agent level.
5. As a **platform superadmin**, I want the `platformDemoEnabled` field to be read-only from the tenant API, so that tenants cannot self-enable free platform demo LLM access.

---

## 4. Functional Requirements

1. **FR-1**: The system must store exactly one LLM policy document per tenant, enforced by a unique index on `tenantId` in the `tenant_llm_policies` collection.
2. **FR-2**: The GET endpoint must return the stored policy or sensible defaults (defined in `POLICY_DEFAULTS` in `tenant-llm-policy-repo.ts`) if no policy document exists for the tenant.
3. **FR-3**: The PUT endpoint must support partial updates via MongoDB upsert (`findOneAndUpdate` with `$set` and `setDefaultsOnInsert`), creating the document if it does not exist.
4. **FR-4**: The `credentialPolicy` field must accept exactly one of: `org_first`, `user_first`, `org_only`, `user_only`, validated by a Zod enum.
5. **FR-5**: The `allowedProviders` field must be validated against the `VALID_PROVIDERS` constant (19 providers: openai, anthropic, azure, google, gemini, vertex, vertex_ai, google_vertex, groq, mistral, fireworks, togetherai, perplexity, deepseek, xai, bedrock, cohere, ultravox, custom). Invalid providers return 400.
6. **FR-6**: The `platformDemoEnabled` field must be excluded from the PUT endpoint's allowed update fields, making it read-only from the tenant API (superadmin-only write path).
7. **FR-7**: The `ModelResolutionService.enforceProviderAllowlist()` must throw an `AppError` with `ErrorCodes.FORBIDDEN` when the resolved provider is not in the tenant's `allowedProviders` list (when the list is non-empty).
8. **FR-8**: The `ModelResolutionService.resolveCredential()` must resolve credentials according to the tenant's `credentialPolicy`: org_first tries org then user, user_first tries user then org, org_only tries org only, user_only tries user only.
9. **FR-9**: The `getTenantId()` helper must verify that the URL `:tenantId` parameter matches the authenticated tenant context (`req.tenantContext.tenantId`). Mismatch returns 403.
10. **FR-10**: All policy PUT operations must emit an audit log entry via `writeAuditLog()` with action `tenant-llm-policy:update`, including tenantId, userId, changed field names, and requestId.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| Project lifecycle          | NONE         | Policies are tenant-scoped, not project-scoped                                       |
| Agent lifecycle            | SECONDARY    | Default models and provider restrictions affect agent execution via model resolution |
| Customer experience        | NONE         | End-users do not interact with LLM policies                                          |
| Integrations / channels    | NONE         | No channel-specific behavior                                                         |
| Observability / tracing    | SECONDARY    | Credential chain diagnostics include policy context                                  |
| Governance / controls      | PRIMARY      | Core governance feature controlling LLM provider and credential access               |
| Enterprise / compliance    | PRIMARY      | Provider restrictions and credential policies serve compliance requirements          |
| Admin / operator workflows | PRIMARY      | Tenant admins manage policies via REST API                                           |

### Related Feature Integration Matrix

| Related Feature              | Relationship Type | Why It Matters                                                         | Key Touchpoints                                                             | Current State |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| Model Resolution             | depends on        | Policy consumed by `safeFetchTenantPolicy()` during LLM client setup   | `apps/runtime/src/services/llm/model-resolution.ts` lines 1019-1030         | STABLE        |
| Tenant Models                | shares data with  | Provider allowlist affects which tenant models can be used for agents  | `apps/runtime/src/repos/llm-resolution-repo.ts` (findTenantModelByProvider) | STABLE        |
| LLM Credentials              | configured by     | Credential policy controls resolution order between user and org creds | `apps/runtime/src/repos/llm-resolution-repo.ts` lines 346-396               | STABLE        |
| Platform Admin               | extends           | Superadmin can toggle `platformDemoEnabled` outside tenant API         | `apps/runtime/src/routes/platform-admin-tenants.ts` (inferred)              | STABLE        |
| Credential Chain Diagnostics | emits into        | Analyzer reports LLM policy context for debugging resolution failures  | `apps/runtime/src/services/diagnostics/analyzers/model-resolution.ts`       | STABLE        |

---

## 6. Design Considerations (Optional)

No Studio UI exists for Tenant LLM Policy management. Policies are managed exclusively via the REST API (`GET/PUT /api/tenants/:tenantId/llm-policy`). Future work may add a Studio admin settings page for LLM governance with provider selection checkboxes, budget visualization, credential policy radio buttons, and default model dropdowns.

---

## 7. Technical Considerations (Optional)

- **One policy per tenant**: Unique index on `tenantId` ensures no duplicate policies. Upsert semantics (`findOneAndUpdate` with `upsert: true`) avoid read-then-write race conditions.
- **Empty allowedProviders = all allowed**: An empty array means no restrictions. This reduces setup friction for new tenants. Non-empty array is an explicit allowlist.
- **platformDemoEnabled protection**: Excluded from the `allowedFields` array in the PUT handler (line 200-210 of `tenant-llm-policy.ts`). Only a superadmin path or direct DB access can set this field.
- **Budget fields are storage-only**: `monthlyTokenBudget`, `dailyTokenBudget`, and `maxRequestsPerMinute` are stored but NOT enforced in real-time. Enforcement is planned as a separate rate-limiting middleware.
- **No caching**: Policy is fetched via direct MongoDB query per `safeFetchTenantPolicy()` call. The unique index makes lookups fast (< 10ms). Caching could be added with a short TTL if needed.
- **allowedProviders serialization**: In `llm-resolution-repo.ts`, `findTenantLLMPolicy()` serializes `allowedProviders` to JSON string (line 263). The `ModelResolutionService.enforceProviderAllowlist()` uses `parseJsonField()` to deserialize it back. This is a legacy artifact from a prior Prisma/SQLite data layer.

---

## 8. How to Consume

### API (Runtime)

| Method | Path                                | Permission         | Purpose                                             |
| ------ | ----------------------------------- | ------------------ | --------------------------------------------------- |
| GET    | `/api/tenants/:tenantId/llm-policy` | `credential:read`  | Fetch tenant LLM policy (or defaults if none set)   |
| PUT    | `/api/tenants/:tenantId/llm-policy` | `credential:write` | Create or update tenant LLM policy (partial upsert) |

### Studio UI

N/A. No Studio UI exists for this feature.

### Admin Portal

The `platformDemoEnabled` field can only be modified via superadmin paths (not exposed through the tenant API).

### Channel / SDK / Voice / A2A / MCP Integration

N/A. This feature is not channel-aware. It operates at the tenant governance level, affecting all channels equally through the model resolution chain.

---

## 9. Data Model

### Collections / Tables

```text
Collection: tenant_llm_policies
Fields:
  - _id: string (UUIDv7, primary key, default: uuidv7())
  - tenantId: string (required, unique index)
  - allowedProviders: string[] (default [])
  - credentialPolicy: string (required, enum: org_first | user_first | org_only | user_only)
  - monthlyTokenBudget: number (required, default 0)
  - dailyTokenBudget: number (required, default 0)
  - defaultModel: string | null (default null)
  - defaultFastModel: string | null (default null)
  - defaultVoiceModel: string | null (default null)
  - maxRequestsPerMinute: number (required, default 600)
  - allowProjectCredentials: boolean (required, default true)
  - platformDemoEnabled: boolean (required, default false)
  - _v: number (schema version, default 1)
  - createdAt: Date (auto, timestamps plugin)
  - updatedAt: Date (auto, timestamps plugin)
Indexes:
  - { tenantId: 1 } (unique)
Plugins:
  - tenantIsolationPlugin
```

### Policy Defaults (when no document exists)

Returned by `findLLMPolicyOrDefaults()` in `tenant-llm-policy-repo.ts`:

```json
{
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
```

### Key Relationships

- **ModelResolutionService**: Reads the policy via `findTenantLLMPolicy()` in `llm-resolution-repo.ts`. The policy is cast to `TenantLLMPolicyRow` (interface at line 218 of `model-resolution.ts`).
- **LLM Credentials**: The `credentialPolicy` field controls lookup order between `findDefaultUserCredential()` and `findDefaultTenantCredential()` in `llm-resolution-repo.ts`.
- **Audit Log**: Policy mutations are logged via `writeAuditLog()` from `auth-repo.ts`.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                      | Purpose                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/repos/tenant-llm-policy-repo.ts`        | Repository: `findLLMPolicyByTenantId`, `findLLMPolicyOrDefaults`, `upsertLLMPolicy`, `POLICY_DEFAULTS` |
| `apps/runtime/src/repos/llm-resolution-repo.ts`           | `findTenantLLMPolicy()` — used by ModelResolutionService, serializes allowedProviders to JSON          |
| `apps/runtime/src/services/llm/model-resolution.ts`       | Consumer: `enforceProviderAllowlist()`, `resolveCredential()`, `safeFetchTenantPolicy()`               |
| `packages/database/src/models/tenant-llm-policy.model.ts` | Mongoose model: `ITenantLLMPolicy` interface, schema, tenantIsolationPlugin, unique index              |

### Routes / Handlers

| File                                           | Purpose                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/tenant-llm-policy.ts` | GET/PUT REST API with OpenAPI router, Zod validation, RBAC, tenant verification, audit |
| `apps/runtime/src/server.ts`                   | Route mounting: `tenantRouter.use('/llm-policy', tenantLLMPolicyRouter)` (line 489)    |

### UI Components

N/A. No Studio UI for this feature.

### Jobs / Workers / Background Processes

N/A. No background processing for LLM policy.

### Tests

| File                                                                            | Type | Coverage Focus                                                           |
| ------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`             | unit | Provider allowlist enforcement (FORBIDDEN), credential policy resolution |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                  | unit | Credential chain diagnostics with LLM policy context                     |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                              | unit | Tenant model interactions with LLM policy (indirect)                     |
| `apps/runtime/src/__tests__/llm-services.test.ts`                               | unit | LLM service setup with policy (indirect)                                 |
| `apps/runtime/src/__tests__/repos-data.test.ts`                                 | unit | Repository data operations (indirect)                                    |
| `apps/runtime/src/__tests__/auth-profile/model-resolution-auth-profile.test.ts` | unit | Auth profile resolution with LLM policy                                  |

---

## 11. Configuration

### Supported Providers (VALID_PROVIDERS)

openai, anthropic, azure, google, gemini, vertex, vertex_ai, google_vertex, groq, mistral, fireworks, togetherai, perplexity, deepseek, xai, bedrock, cohere, ultravox, custom

### Credential Policies

| Policy       | First Try         | Fallback          | Behavior                                         |
| ------------ | ----------------- | ----------------- | ------------------------------------------------ |
| `org_first`  | Tenant credential | User credential   | Prefer org-managed keys, fall back to personal   |
| `user_first` | User credential   | Tenant credential | Prefer personal keys, fall back to org-managed   |
| `org_only`   | Tenant credential | None              | Only org-managed keys, no user credential access |
| `user_only`  | User credential   | None              | Only personal keys, no org credential access     |

### Permissions

| Permission         | Required For                          |
| ------------------ | ------------------------------------- |
| `credential:read`  | GET /api/tenants/:tenantId/llm-policy |
| `credential:write` | PUT /api/tenants/:tenantId/llm-policy |

### Environment Variables

N/A. No environment-specific configuration for this feature.

### Runtime Configuration

N/A. Policy values are stored in MongoDB, not runtime config.

### DSL / Agent IR / Schema

N/A. LLM policy is not configurable in the DSL or compiler IR. It is purely a runtime governance layer.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | `tenantId` in URL param must match authenticated `req.tenantContext.tenantId`. Mismatch returns 403 via `getTenantId()` helper. |
| Data isolation    | Unique index on `tenantId` ensures one policy per tenant. `tenantIsolationPlugin` applied to Mongoose schema.                   |
| Project isolation | N/A. Policy is tenant-scoped, not project-scoped.                                                                               |
| User isolation    | N/A. Policy is tenant-scoped, not user-owned.                                                                                   |

**Note**: The current tenant verification returns 403 (not 404). Per platform principles, cross-scope access should return 404 to avoid leaking resource existence. This is a known deviation (see GAP-007).

### Security & Compliance

- `platformDemoEnabled` is read-only from tenant API (excluded from PUT allowed fields)
- Provider allowlist enforced at model resolution time via `AppError(FORBIDDEN)`
- Credential policy controls which secret scopes (user vs org) are accessed
- All mutations audit-logged via `writeAuditLog()` with userId, tenantId, changed field names, requestId
- Zod validation on PUT body prevents invalid credential policies and provider names

### Performance & Scalability

- Policy fetched once per model resolution call via `safeFetchTenantPolicy()` (once per session start typically)
- No caching: direct MongoDB query using unique index on `tenantId` (expected < 10ms latency)
- Upsert semantics via `findOneAndUpdate` with `$set` avoids race conditions on concurrent updates
- Single document per tenant: negligible storage footprint

### Reliability & Failure Modes

- **DB unavailable**: `safeFetchTenantPolicy()` catches errors and returns `null`, which means model resolution proceeds without policy enforcement (fail-open). This is intentional to avoid blocking all LLM calls when the DB is temporarily unreachable.
- **Invalid policy data**: Zod validation on the PUT endpoint prevents storing invalid data. Model resolution uses `parseJsonField()` with fallback to empty array for malformed `allowedProviders`.
- **Idempotency**: PUT is idempotent via upsert semantics. Identical concurrent PUTs produce the same result.

### Observability

- INFO-level log on policy update with tenantId and changed field names (`log.info('Tenant LLM policy updated', ...)`)
- ERROR-level log on fetch/update failures (`log.error('Failed to get/update LLM policy', ...)`)
- Audit log: `tenant-llm-policy:update` action with field names and requestId
- Credential chain diagnostics include policy info for debugging model resolution failures

### Data Lifecycle

- One policy document per tenant. No TTL; persists until explicitly updated or tenant is deleted.
- No automatic cascade deletion when a tenant is removed (requires explicit cleanup).
- Schema version tracked via `_v` field (currently 1) for future migrations.
- Audit log entries follow the platform's standard audit log retention policy.

---

## 13. Delivery Plan / Work Breakdown

1. Data Layer (DONE)
   1.1 Mongoose model (`tenant-llm-policy.model.ts`) with `ITenantLLMPolicy` interface, tenantIsolationPlugin, unique index
   1.2 Repository functions in `tenant-llm-policy-repo.ts` (findByTenantId, findOrDefaults, upsert) with `POLICY_DEFAULTS`
   1.3 Resolution repo function `findTenantLLMPolicy()` in `llm-resolution-repo.ts`
2. REST API (DONE)
   2.1 GET endpoint with `credential:read` RBAC and tenant verification
   2.2 PUT endpoint with Zod validation, upsert, `platformDemoEnabled` exclusion from allowed fields
   2.3 Audit logging via `writeAuditLog()` for all mutations
   2.4 Route mounting in `server.ts` (`tenantRouter.use('/llm-policy', ...)`)
3. Model Resolution Integration (DONE)
   3.1 `enforceProviderAllowlist()` — FORBIDDEN for unapproved providers
   3.2 `resolveCredential()` — four credential policy modes
   3.3 `safeFetchTenantPolicy()` — DB fetch with error handling (fail-open)
4. Testing (PARTIAL)
   4.1 Unit tests for provider allowlist, credential policy, default models (DONE)
   4.2 Dedicated route test file for GET/PUT/RBAC/validation (NOT DONE)
   4.3 Integration tests for policy-to-model-resolution flow (NOT DONE)
   4.4 E2E tests for policy enforcement in agent execution (NOT DONE)

---

## 14. Success Metrics

| Metric                          | Baseline | Target     | How Measured                                        |
| ------------------------------- | -------- | ---------- | --------------------------------------------------- |
| Provider restriction violations | N/A      | 0 bypasses | FORBIDDEN errors in model resolution traces         |
| Policy update audit coverage    | N/A      | 100%       | All PUT mutations produce audit log entries         |
| Cross-tenant access attempts    | N/A      | 0 success  | 403 responses for mismatched tenantId               |
| Policy fetch latency            | N/A      | < 10ms p99 | MongoDB query timing on unique index                |
| Route test coverage             | 0%       | 100%       | Dedicated route test file covering GET/PUT/RBAC/400 |

---

## 15. Open Questions

1. Should real-time token budget enforcement be implemented as a separate middleware or integrated into the model resolution chain?
2. Should the tenant verification return 404 (per platform principles) instead of 403 for mismatched tenantId?
3. Should a dedicated superadmin route exist for managing `platformDemoEnabled`, or is direct DB access sufficient?
4. Should the policy be cached with a short TTL (e.g., 60s) to reduce DB queries during high-throughput model resolution?
5. Should `findTenantLLMPolicy()` in `llm-resolution-repo.ts` stop serializing `allowedProviders` to JSON string (legacy from Prisma era)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                  | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No real-time token budget enforcement (policy stores limits but enforcement is separate)     | High     | Open   |
| GAP-002 | No dedicated test file for tenant-llm-policy REST route (GET/PUT/RBAC/validation untested)   | High     | Open   |
| GAP-003 | No E2E test verifying policy affects agent execution end-to-end                              | High     | Open   |
| GAP-004 | No integration test for policy-to-model-resolution flow                                      | High     | Open   |
| GAP-005 | No Studio UI for LLM policy management                                                       | Medium   | Open   |
| GAP-006 | No per-project LLM policy overrides                                                          | Medium   | Open   |
| GAP-007 | Tenant verification returns 403 instead of 404 (deviates from platform isolation principles) | Medium   | Open   |
| GAP-008 | No caching of policy (direct DB query per fetch)                                             | Low      | Open   |
| GAP-009 | `allowedProviders` serialized to JSON string in `llm-resolution-repo.ts` (legacy artifact)   | Low      | Open   |
| GAP-010 | No cascade deletion of policy when tenant is deleted                                         | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                 | Coverage Type | Status     | Test File / Note                                 |
| --- | ---------------------------------------- | ------------- | ---------- | ------------------------------------------------ |
| 1   | Provider allowlist enforcement           | unit          | PASS       | `model-resolution-comprehensive.test.ts`         |
| 2   | Credential policy resolution (4 modes)   | unit          | PASS       | `model-resolution-comprehensive.test.ts`         |
| 3   | Default model selection                  | unit          | PASS       | `model-resolution-comprehensive.test.ts`         |
| 4   | Credential chain diagnostics             | unit          | PASS       | `credential-chain-analyzer.test.ts`              |
| 5   | GET route returns policy or defaults     | e2e           | NOT TESTED | No dedicated route test                          |
| 6   | PUT route upserts with validation        | e2e           | NOT TESTED | No dedicated route test                          |
| 7   | RBAC enforcement (credential:read/write) | e2e           | NOT TESTED | No RBAC test                                     |
| 8   | Tenant verification (cross-tenant 403)   | e2e           | NOT TESTED | No cross-tenant test                             |
| 9   | platformDemoEnabled read-only            | e2e           | NOT TESTED | No test verifying field exclusion                |
| 10  | Audit log emission on PUT                | integration   | NOT TESTED | No audit log verification                        |
| 11  | Policy-to-model-resolution integration   | integration   | NOT TESTED | No integration test for DB policy -> enforcement |

### Testing Notes

Unit tests for policy enforcement exist via model-resolution-comprehensive tests, but these mock the policy data directly. No tests exercise the full path from REST API to policy storage to model resolution enforcement. The route itself (GET/PUT) has zero direct test coverage.

> Full testing details: `../testing/tenant-llm-policy.md`

---

## 18. References

- HLD: `docs/specs/tenant-llm-policy.hld.md`
- LLD: `docs/plans/2026-03-22-tenant-llm-policy-impl-plan.md`
- Model resolution service: `apps/runtime/src/services/llm/model-resolution.ts`
- Database model: `packages/database/src/models/tenant-llm-policy.model.ts`
- Repo: `apps/runtime/src/repos/tenant-llm-policy-repo.ts`
- Resolution repo: `apps/runtime/src/repos/llm-resolution-repo.ts`
- REST route: `apps/runtime/src/routes/tenant-llm-policy.ts`
- Route mounting: `apps/runtime/src/server.ts` (line 489)
