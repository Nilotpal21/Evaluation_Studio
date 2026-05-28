# Tenant LLM Policy -- Low-Level Design & Implementation Plan

**Feature Spec**: `docs/features/tenant-llm-policy.md`
**HLD**: `docs/specs/tenant-llm-policy.hld.md`
**Test Spec**: `docs/testing/tenant-llm-policy.md`
**Status**: Re-generated via SDLC pipeline (2026-03-22)

---

## 1. Design Decisions

### Decision Log

| Decision                             | Rationale                                                                                       | Alternatives Rejected                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Upsert semantics for PUT             | Avoids read-then-write race condition; atomic create-or-update via `findOneAndUpdate`           | Separate POST (create) + PUT (update) endpoints         |
| Fail-open on DB unavailability       | Better to allow LLM calls without policy enforcement than to block all agent execution          | Fail-closed (block all LLM calls if policy unavailable) |
| platformDemoEnabled field exclusion  | Prevents tenants from self-enabling demo mode; enforced via allowedFields filter in PUT handler | Separate schema for superadmin vs tenant writes         |
| Empty allowedProviders = all allowed | Reduces setup friction for new tenants; explicit opt-in for restrictions                        | Empty = none allowed (require explicit opt-in)          |
| Credential policy default: org_first | Enterprise-friendly default; org credentials take precedence over personal                      | user_only (developer-friendly but less secure)          |
| allowedProviders JSON serialization  | Legacy from Prisma/SQLite migration; `llm-resolution-repo.ts` serializes to string              | Native array (would require coordinated migration)      |
| No caching                           | Unique index lookup is < 10ms; caching adds complexity for minimal benefit at current scale     | Redis cache with TTL (viable future optimization)       |

### Key Interfaces & Types

**ITenantLLMPolicy** (Mongoose document interface in `tenant-llm-policy.model.ts`):

```typescript
export interface ITenantLLMPolicy {
  _id: string;
  tenantId: string;
  allowedProviders: string[];
  credentialPolicy: string;
  monthlyTokenBudget: number;
  dailyTokenBudget: number;
  defaultModel: string | null;
  defaultFastModel: string | null;
  defaultVoiceModel: string | null;
  maxRequestsPerMinute: number;
  allowProjectCredentials: boolean;
  platformDemoEnabled: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**TenantLLMPolicyRow** (internal interface in `model-resolution.ts`, line 218):

```typescript
interface TenantLLMPolicyRow {
  tenantId: string;
  allowedProviders: string | null; // JSON-serialized array (legacy)
  credentialPolicy: string;
  allowProjectCredentials: boolean;
  platformDemoEnabled: boolean;
}
```

**POLICY_DEFAULTS** (constant in `tenant-llm-policy-repo.ts`):

```typescript
const POLICY_DEFAULTS = {
  allowedProviders: [] as string[],
  credentialPolicy: 'org_first',
  monthlyTokenBudget: 0,
  dailyTokenBudget: 0,
  defaultModel: null,
  defaultFastModel: null,
  defaultVoiceModel: null,
  maxRequestsPerMinute: 600,
  allowProjectCredentials: true,
  platformDemoEnabled: false,
} as const;
```

### Module Boundaries

| Module                       | Responsibility                                            | Dependencies                            |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------- |
| `tenant-llm-policy.ts`       | REST API (GET/PUT), validation, RBAC, tenant verification | auth middleware, RBAC, repo, audit log  |
| `tenant-llm-policy-repo.ts`  | CRUD operations on MongoDB                                | TenantLLMPolicy Mongoose model          |
| `llm-resolution-repo.ts`     | Read-only policy fetch for model resolution               | TenantLLMPolicy Mongoose model          |
| `model-resolution.ts`        | Policy enforcement (allowlist, credential resolution)     | llm-resolution-repo, encryption service |
| `tenant-llm-policy.model.ts` | Mongoose schema, indexes, plugins                         | tenantIsolationPlugin, uuidv7           |

---

## 2. File-Level Change Map

### Existing Files (Already Implemented)

| File                                                                | Purpose                                                     | Status |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| `packages/database/src/models/tenant-llm-policy.model.ts`           | Mongoose model, schema, unique index, tenantIsolationPlugin | DONE   |
| `apps/runtime/src/repos/tenant-llm-policy-repo.ts`                  | findByTenantId, findOrDefaults, upsert, POLICY_DEFAULTS     | DONE   |
| `apps/runtime/src/repos/llm-resolution-repo.ts`                     | findTenantLLMPolicy (JSON serialized)                       | DONE   |
| `apps/runtime/src/routes/tenant-llm-policy.ts`                      | GET/PUT with Zod, RBAC, tenant verify, audit                | DONE   |
| `apps/runtime/src/services/llm/model-resolution.ts`                 | enforceProviderAllowlist, resolveCredential, safeFetch      | DONE   |
| `apps/runtime/src/server.ts`                                        | Route mounting (line 489)                                   | DONE   |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts` | Unit: allowlist, credential policy, defaults                | DONE   |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`      | Unit: diagnostics with policy context                       | DONE   |

### New Files (Testing Gap Closure)

| File                                                               | Purpose                                             | LOC Estimate |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/tenant-llm-policy-route.test.ts`       | E2E: GET/PUT route, RBAC, tenant verify, validation | ~300         |
| `apps/runtime/src/__tests__/tenant-llm-policy-integration.test.ts` | Integration: repo-to-DB, policy-to-resolution flow  | ~250         |

### Modified Files

| File                     | Change Description                           | Risk |
| ------------------------ | -------------------------------------------- | ---- |
| `docs/testing/README.md` | Add tenant-llm-policy entry to Feature Index | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Data Layer & Repository Verification

**Goal**: Verify the existing data layer works correctly through dedicated integration tests.

**Tasks**:
1.1. Create `tenant-llm-policy-integration.test.ts` with MongoMemoryServer setup
1.2. Write INT-1: Repository upsert creates and updates atomically (5 assertions)
1.3. Write INT-6: Unique index prevents duplicate tenant policies
1.4. Write INT-5: Policy fetch gracefully handles DB unavailability
1.5. Write INT-4: Audit log emission on policy update (verify writeAuditLog called)
1.6. Write INT-2: Model resolution enforces provider allowlist from DB policy (requires ModelResolutionService with real DB)

**Files Touched**:

- `apps/runtime/src/__tests__/tenant-llm-policy-integration.test.ts` -- NEW

**Exit Criteria**:

- [ ] All 5 integration tests pass: `pnpm test --filter=runtime -- tenant-llm-policy-integration`
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Repository upsert correctly creates, updates, and preserves unmodified fields
- [ ] Unique index constraint verified via duplicate insert attempt
- [ ] safeFetchTenantPolicy returns null when DB is unavailable (not throws)

**Test Strategy**:

- Integration: Repo functions against MongoMemoryServer, audit log spy, DB disconnect simulation

**Rollback**: Delete `tenant-llm-policy-integration.test.ts`. No production code changes.

---

### Phase 2: REST Route E2E Tests

**Goal**: Cover the REST API surface with E2E tests exercising the full middleware chain.

**Tasks**:
2.1. Create `tenant-llm-policy-route.test.ts` with Express server setup on random port
2.2. Write E2E-1: GET returns defaults for new tenant
2.3. Write E2E-2: PUT creates policy and GET retrieves it
2.4. Write E2E-3: PUT partial update preserves existing fields
2.5. Write E2E-4: PUT rejects invalid providers with 400
2.6. Write E2E-5: Cross-tenant access returns 403
2.7. Write E2E-6: RBAC enforcement (missing permission returns 403)
2.8. Write E2E-7: platformDemoEnabled not writable from tenant API
2.9. Write E2E-8: Unauthenticated request returns 401

**Files Touched**:

- `apps/runtime/src/__tests__/tenant-llm-policy-route.test.ts` -- NEW

**Exit Criteria**:

- [ ] All 8 E2E tests pass: `pnpm test --filter=runtime -- tenant-llm-policy-route`
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] GET returns correct defaults when no policy exists
- [ ] PUT creates, updates, and preserves fields correctly
- [ ] Invalid provider returns 400 with descriptive error
- [ ] Cross-tenant access returns 403 "Tenant access denied"
- [ ] Missing permission returns 403
- [ ] platformDemoEnabled ignored in PUT response
- [ ] Unauthenticated returns 401

**Test Strategy**:

- E2E: Real Express server on `{ port: 0 }`, full middleware chain (auth, rate limit, RBAC), real MongoDB via MongoMemoryServer
- Auth tokens generated via test JWT helper
- No mocking of codebase components

**Rollback**: Delete `tenant-llm-policy-route.test.ts`. No production code changes.

---

### Phase 3: Documentation Finalization

**Goal**: Update all cross-references, testing README, and feature spec to reflect test coverage.

**Tasks**:
3.1. Update `docs/testing/README.md` Feature Index with tenant-llm-policy entry
3.2. Update feature spec section 17 (Testing & Validation) with actual test status
3.3. Update testing guide health dashboard with test results
3.4. Log SDLC artifacts to `docs/sdlc-logs/tenant-llm-policy/`

**Files Touched**:

- `docs/testing/README.md` -- MODIFIED
- `docs/features/tenant-llm-policy.md` -- MODIFIED (section 17)
- `docs/testing/tenant-llm-policy.md` -- MODIFIED (health dashboard)
- `docs/sdlc-logs/tenant-llm-policy/` -- NEW log files

**Exit Criteria**:

- [ ] Testing README lists tenant-llm-policy with correct status
- [ ] Feature spec section 17 reflects actual test pass/fail status
- [ ] Health dashboard updated with results from Phase 1-2

**Test Strategy**: N/A (documentation only).

**Rollback**: Revert doc changes.

---

## 4. Wiring Checklist

- [x] Mongoose model registered in database package index (`packages/database/src/models/index.ts`)
- [x] Route mounted in `server.ts` (`tenantRouter.use('/llm-policy', tenantLLMPolicyRouter)` at line 489)
- [x] Repository functions exported and importable
- [x] `llm-resolution-repo.ts` exports `findTenantLLMPolicy()`
- [x] `model-resolution.ts` imports and uses `findTenantLLMPolicy`
- [x] Auth middleware applied to route
- [x] Rate limit middleware applied to route
- [x] RBAC middleware applied per endpoint
- [x] OpenAPI documentation generated via `createOpenAPIRouter`
- [ ] Test files added to test configuration (auto-discovered by vitest)
- [ ] Testing README updated with feature entry

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. The `tenant_llm_policies` collection is created on first document insertion. The unique index is created by Mongoose schema definition.

### Feature Flags

None. The feature is always enabled. Policy enforcement is naturally disabled when no policy document exists (fail-open with defaults).

### Configuration Changes

None. No new environment variables or config keys required.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All Phase 1 integration tests pass (5 tests)
- [ ] All Phase 2 E2E tests pass (8 tests)
- [ ] No regressions in existing model-resolution-comprehensive tests
- [ ] No regressions in existing credential-chain-analyzer tests
- [ ] Feature spec section 17 updated with actual coverage
- [ ] Testing README updated
- [ ] SDLC log committed

---

## 7. Open Questions

1. **Test infrastructure for auth tokens**: What test helper generates JWT tokens with specific tenant contexts and permissions? Need to identify or create a `createTestAuthToken(tenantId, userId, permissions)` utility.
2. **MongoMemoryServer availability**: Is MongoMemoryServer configured in the runtime test setup, or does it need to be added as a dev dependency?
3. **Audit log verification pattern**: Should integration tests query the audit collection directly, or spy on the `writeAuditLog` function? Querying the collection is more realistic but requires audit persistence setup.
4. **Server setup for E2E**: Should E2E tests use the full `createApp()` from `server.ts`, or a minimal Express app with just the LLM policy route and required middleware? Full app is more realistic but slower and more brittle.
