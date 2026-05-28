# Feature Test Guide: Tenant LLM Policy

**Feature**: Tenant LLM Policy -- tenant-level LLM governance (providers, credentials, budgets, defaults)
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/tenant-llm-policy.md](../features/tenant-llm-policy.md)
**First tested**: 2026-03-22
**Last updated**: 2026-03-22
**Overall status**: PARTIAL -- policy enforcement unit-tested via model resolution; no route, integration, or E2E tests

---

## Current State (as of 2026-03-22)

Tenant LLM Policy enforcement is unit-tested indirectly through the ModelResolutionService comprehensive tests (provider allowlist, credential policy, default models). The credential chain analyzer tests verify diagnostic output for LLM policy. However, there is no dedicated test file for the tenant-llm-policy REST route, and no integration or E2E tests exist for the full policy lifecycle.

### Quick Health Dashboard

| Area                                                       | Status     | Last Verified | Notes                                                        |
| ---------------------------------------------------------- | ---------- | ------------- | ------------------------------------------------------------ |
| Provider allowlist enforcement                             | PASS       | 2026-03-22    | FORBIDDEN error for unapproved providers in model resolution |
| Credential policy resolution (org_first, user_first, etc.) | PASS       | 2026-03-22    | Tested in model-resolution-comprehensive                     |
| Default model selection                                    | PASS       | 2026-03-22    | defaultModel, defaultFastModel, defaultVoiceModel            |
| Credential chain diagnostics                               | PASS       | 2026-03-22    | Policy info in diagnostic output                             |
| Repository functions                                       | PASS       | 2026-03-22    | Tested indirectly via repos-data                             |
| REST route: GET /llm-policy                                | NOT TESTED | -             | No dedicated route test                                      |
| REST route: PUT /llm-policy                                | NOT TESTED | -             | No dedicated route test                                      |
| RBAC enforcement (credential:read/write)                   | NOT TESTED | -             | No RBAC test for this route                                  |
| Tenant verification (URL param vs auth context)            | NOT TESTED | -             | No cross-tenant test                                         |
| Zod validation (provider names, budget limits)             | NOT TESTED | -             | No validation test                                           |
| platformDemoEnabled read-only enforcement                  | NOT TESTED | -             | No test verifies field is excluded from updates              |
| Audit logging for policy changes                           | NOT TESTED | -             | No test verifies audit log emission                          |
| E2E: policy affects agent execution                        | NOT TESTED | -             | No E2E test                                                  |

---

## Coverage Matrix

| FR    | Description                                        | Unit | Integration | E2E | Manual | Status     |
| ----- | -------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | One policy per tenant (unique index)               | Yes  | No          | No  | No     | PARTIAL    |
| FR-2  | GET returns policy or defaults                     | No   | No          | No  | No     | NOT TESTED |
| FR-3  | PUT supports partial upsert                        | No   | No          | No  | No     | NOT TESTED |
| FR-4  | credentialPolicy validated as enum                 | No   | No          | No  | No     | NOT TESTED |
| FR-5  | allowedProviders validated against VALID_PROVIDERS | No   | No          | No  | No     | NOT TESTED |
| FR-6  | platformDemoEnabled read-only from tenant API      | No   | No          | No  | No     | NOT TESTED |
| FR-7  | Provider allowlist enforcement (FORBIDDEN)         | Yes  | No          | No  | No     | PARTIAL    |
| FR-8  | Credential policy resolution (4 modes)             | Yes  | No          | No  | No     | PARTIAL    |
| FR-9  | Tenant verification (URL vs auth context)          | No   | No          | No  | No     | NOT TESTED |
| FR-10 | Audit logging on PUT                               | No   | No          | No  | No     | NOT TESTED |

---

## Test Inventory

### Unit Tests (Existing)

| Test File                                                                       | Suites | Status | Key Scenarios                                                                                          |
| ------------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`             | ~15    | PASS   | Provider allowlist enforcement (FORBIDDEN), credential policy resolution order, default model fallback |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                  | ~5     | PASS   | Credential chain analysis with LLM policy context                                                      |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                              | ~8     | PASS   | Tenant model interactions (indirect policy testing)                                                    |
| `apps/runtime/src/__tests__/llm-services.test.ts`                               | ~4     | PASS   | LLM service setup with policy                                                                          |
| `apps/runtime/src/__tests__/repos-data.test.ts`                                 | ~3     | PASS   | Repository operations (indirect)                                                                       |
| `apps/runtime/src/__tests__/auth-profile/model-resolution-auth-profile.test.ts` | ~4     | PASS   | Auth profile resolution with LLM policy                                                                |

### Integration Tests (Planned)

None exist. See planned scenarios below.

### E2E Tests (Planned)

None exist. See planned scenarios below.

---

## E2E Test Scenarios (MANDATORY)

### E2E-1: GET policy returns defaults for new tenant

**Preconditions**: Authenticated user with `credential:read` permission for tenant T1. No policy document exists for T1.

**Steps**:

1. `GET /api/tenants/T1/llm-policy` with valid JWT for tenant T1
2. Assert response status 200
3. Assert response body `{ success: true, policy: { credentialPolicy: "org_first", allowedProviders: [], allowProjectCredentials: true, platformDemoEnabled: false, monthlyTokenBudget: 0, dailyTokenBudget: 0, maxRequestsPerMinute: 600, defaultModel: null, defaultFastModel: null, defaultVoiceModel: null } }`

**Expected Result**: Default policy values returned when no document exists.

**Auth Context**: Tenant T1, user U1 with `credential:read`.

**Isolation Check**: GET with JWT for tenant T2 using T1's URL returns 403.

### E2E-2: PUT creates policy and GET retrieves it

**Preconditions**: Authenticated user with `credential:write` permission for tenant T1. No policy document exists.

**Steps**:

1. `PUT /api/tenants/T1/llm-policy` with body `{ "credentialPolicy": "org_only", "allowedProviders": ["openai", "anthropic"], "monthlyTokenBudget": 100000 }`
2. Assert response status 200, `success: true`
3. Assert response contains the updated fields
4. `GET /api/tenants/T1/llm-policy` with valid JWT
5. Assert response contains `credentialPolicy: "org_only"`, `allowedProviders: ["openai", "anthropic"]`, `monthlyTokenBudget: 100000`
6. Assert unchanged defaults: `allowProjectCredentials: true`, `platformDemoEnabled: false`

**Expected Result**: PUT creates the policy document; GET returns the persisted values.

**Auth Context**: Tenant T1, user U1 with `credential:write` / `credential:read`.

**Isolation Check**: N/A (covered in E2E-5).

### E2E-3: PUT partial update preserves existing fields

**Preconditions**: Tenant T1 has existing policy with `credentialPolicy: "org_only"`, `allowedProviders: ["openai"]`.

**Steps**:

1. `PUT /api/tenants/T1/llm-policy` with body `{ "dailyTokenBudget": 5000 }`
2. Assert response status 200
3. `GET /api/tenants/T1/llm-policy`
4. Assert `dailyTokenBudget: 5000` AND `credentialPolicy: "org_only"` AND `allowedProviders: ["openai"]` (previous values preserved)

**Expected Result**: Partial update only modifies the specified field.

**Auth Context**: Tenant T1, user U1 with `credential:write` / `credential:read`.

**Isolation Check**: N/A.

### E2E-4: PUT rejects invalid providers with 400

**Preconditions**: Authenticated user with `credential:write` for tenant T1.

**Steps**:

1. `PUT /api/tenants/T1/llm-policy` with body `{ "allowedProviders": ["openai", "invalid_provider"] }`
2. Assert response status 400
3. Assert error message contains "Invalid provider(s): invalid_provider"
4. `GET /api/tenants/T1/llm-policy` -- confirm policy unchanged

**Expected Result**: Invalid provider names rejected with 400, policy not modified.

**Auth Context**: Tenant T1, user U1 with `credential:write`.

**Isolation Check**: N/A.

### E2E-5: Cross-tenant access returns 403

**Preconditions**: Two tenants T1 and T2. User U1 belongs to T1 with `credential:read`.

**Steps**:

1. `GET /api/tenants/T2/llm-policy` with JWT for tenant T1 (user U1)
2. Assert response status 403
3. Assert response body `{ success: false, error: "Tenant access denied" }`
4. `PUT /api/tenants/T2/llm-policy` with JWT for tenant T1 and body `{ "credentialPolicy": "user_only" }`
5. Assert response status 403

**Expected Result**: Cross-tenant GET and PUT both return 403.

**Auth Context**: JWT for tenant T1 used against tenant T2 URL.

**Isolation Check**: This IS the isolation check.

### E2E-6: RBAC enforcement -- missing permission returns 403

**Preconditions**: User U2 in tenant T1 with NO `credential:read` or `credential:write` permissions.

**Steps**:

1. `GET /api/tenants/T1/llm-policy` with JWT for U2
2. Assert response status 403 (permission denied)
3. `PUT /api/tenants/T1/llm-policy` with JWT for U2 and body `{ "credentialPolicy": "org_only" }`
4. Assert response status 403 (permission denied)

**Expected Result**: Users without credential permissions cannot read or write LLM policy.

**Auth Context**: Tenant T1, user U2 without credential permissions.

**Isolation Check**: N/A.

### E2E-7: platformDemoEnabled not writable from tenant API

**Preconditions**: Tenant T1 has existing policy with `platformDemoEnabled: false`.

**Steps**:

1. `PUT /api/tenants/T1/llm-policy` with body `{ "platformDemoEnabled": true, "credentialPolicy": "user_first" }`
2. Assert response status 200 (PUT succeeds)
3. Assert response body shows `platformDemoEnabled: false` (unchanged)
4. Assert response body shows `credentialPolicy: "user_first"` (other field updated)
5. `GET /api/tenants/T1/llm-policy`
6. Assert `platformDemoEnabled: false`

**Expected Result**: `platformDemoEnabled` silently ignored in PUT; other fields updated normally.

**Auth Context**: Tenant T1, user U1 with `credential:write`.

**Isolation Check**: N/A.

### E2E-8: Unauthenticated request returns 401

**Preconditions**: None.

**Steps**:

1. `GET /api/tenants/T1/llm-policy` with no JWT header
2. Assert response status 401
3. `PUT /api/tenants/T1/llm-policy` with no JWT header
4. Assert response status 401

**Expected Result**: Missing auth token returns 401.

**Auth Context**: No auth.

**Isolation Check**: N/A.

---

## Integration Test Scenarios (MANDATORY)

### INT-1: Repository upsert creates and updates atomically

**Boundary**: `tenant-llm-policy-repo.ts` -> MongoDB (via Mongoose)

**Setup**: MongoDB connection (MongoMemoryServer or test DB).

**Steps**:

1. Call `findLLMPolicyOrDefaults('tenant-1')` -- expect defaults returned (no DB doc)
2. Call `upsertLLMPolicy('tenant-1', { credentialPolicy: 'org_only', allowedProviders: ['openai'] })`
3. Call `findLLMPolicyByTenantId('tenant-1')` -- expect doc with `credentialPolicy: 'org_only'`
4. Call `upsertLLMPolicy('tenant-1', { dailyTokenBudget: 5000 })` -- partial update
5. Call `findLLMPolicyByTenantId('tenant-1')` -- expect `dailyTokenBudget: 5000` AND `credentialPolicy: 'org_only'` (preserved)

**Expected Result**: Upsert creates on first call, updates on second, preserves unmodified fields.

**Failure Mode**: DB connection failure returns null/throws (tested in INT-5).

### INT-2: Model resolution enforces provider allowlist from DB policy

**Boundary**: `model-resolution.ts` -> `llm-resolution-repo.ts` -> MongoDB

**Setup**: MongoDB with tenant T1 policy `{ allowedProviders: ["anthropic"] }`. TenantModel for openai provider exists.

**Steps**:

1. Create ModelResolutionService with real DB connection and encryption service
2. Call `resolve()` with context `{ tenantId: 'T1', provider: 'openai', ... }`
3. Expect `AppError` with `ErrorCodes.FORBIDDEN` containing "Provider 'openai' ... is not allowed"
4. Call `resolve()` with context `{ tenantId: 'T1', provider: 'anthropic', ... }`
5. Expect successful resolution (no FORBIDDEN error)

**Expected Result**: Provider allowlist from DB policy is enforced during model resolution.

**Failure Mode**: If DB is unavailable, `safeFetchTenantPolicy()` returns null and no enforcement occurs (fail-open).

### INT-3: Credential policy resolution order matches DB policy

**Boundary**: `model-resolution.ts` -> `llm-resolution-repo.ts` -> MongoDB (LLMCredential collection)

**Setup**: MongoDB with tenant T1 policy `{ credentialPolicy: 'org_only' }`. Both user and org credentials exist for 'openai'.

**Steps**:

1. Create ModelResolutionService
2. Call `resolve()` with `org_only` policy -- expect org credential used
3. Update policy to `user_only` via `upsertLLMPolicy('T1', { credentialPolicy: 'user_only' })`
4. Call `resolve()` again -- expect user credential used
5. Update policy to `org_first` -- expect org credential tried first, user as fallback

**Expected Result**: Credential resolution order matches the stored policy.

**Failure Mode**: If no credential found for the policy's required scope, resolution falls through to TenantModel connection fallback.

### INT-4: Audit log emission on policy update

**Boundary**: `tenant-llm-policy.ts` route -> `auth-repo.ts` writeAuditLog

**Setup**: Real Express server with full middleware chain. MongoDB connection.

**Steps**:

1. Start Express server on random port with full middleware (auth, rate limit)
2. `PUT /api/tenants/T1/llm-policy` with body `{ "credentialPolicy": "user_first" }`
3. Query audit log collection for action `tenant-llm-policy:update` with tenantId T1
4. Assert audit entry contains `fields: ["credentialPolicy"]`, `userId`, `requestId`

**Expected Result**: Every PUT mutation produces a corresponding audit log entry.

**Failure Mode**: If writeAuditLog throws, the PUT still succeeds (fire-and-forget audit).

### INT-5: Policy fetch gracefully handles DB unavailability

**Boundary**: `model-resolution.ts` -> `llm-resolution-repo.ts` -> MongoDB (unavailable)

**Setup**: ModelResolutionService initialized. MongoDB connection dropped/unavailable.

**Steps**:

1. Stop/disconnect MongoDB
2. Call `safeFetchTenantPolicy('T1')`
3. Expect `null` returned (not an error thrown)
4. Call model `resolve()` -- expect resolution proceeds without policy enforcement (fail-open)

**Expected Result**: DB unavailability does not block model resolution; policy enforcement is silently skipped.

**Failure Mode**: This IS the failure mode test.

### INT-6: Unique index prevents duplicate tenant policies

**Boundary**: `tenant-llm-policy-repo.ts` -> MongoDB unique index

**Setup**: MongoDB connection.

**Steps**:

1. Insert policy via `upsertLLMPolicy('T1', { credentialPolicy: 'org_first' })`
2. Attempt direct MongoDB insert of another document with `tenantId: 'T1'`
3. Expect MongoDB duplicate key error (E11000)

**Expected Result**: Unique index on tenantId prevents two policy documents for the same tenant.

**Failure Mode**: N/A (this tests the constraint itself).

---

## Unit Test Scenarios

### UNIT-1: enforceProviderAllowlist -- empty list allows all

**Module**: `ModelResolutionService.enforceProviderAllowlist()`
**Input**: `tenantPolicy.allowedProviders: '[]'`, provider: `'openai'`
**Expected Output**: No error thrown (empty = all allowed)

### UNIT-2: enforceProviderAllowlist -- non-empty list rejects unlisted

**Module**: `ModelResolutionService.enforceProviderAllowlist()`
**Input**: `tenantPolicy.allowedProviders: '["anthropic"]'`, provider: `'openai'`
**Expected Output**: `AppError` with `ErrorCodes.FORBIDDEN`

### UNIT-3: resolveCredential -- org_first tries org then user

**Module**: `ModelResolutionService.resolveCredential()`
**Input**: `tenantPolicy.credentialPolicy: 'org_first'`, both user and org credentials exist
**Expected Output**: Org credential returned (first try succeeds)

### UNIT-4: resolveCredential -- user_only returns null if no user credential

**Module**: `ModelResolutionService.resolveCredential()`
**Input**: `tenantPolicy.credentialPolicy: 'user_only'`, no user credential exists
**Expected Output**: Falls through to TenantModel connection fallback

### UNIT-5: Zod policyUpdateSchema -- validates credential policy enum

**Module**: `policyUpdateSchema` Zod schema
**Input**: `{ credentialPolicy: "invalid_policy" }`
**Expected Output**: Zod validation error

### UNIT-6: Zod policyUpdateSchema -- rejects negative budget

**Module**: `policyUpdateSchema` Zod schema
**Input**: `{ monthlyTokenBudget: -100 }`
**Expected Output**: Zod validation error (min 0)

### UNIT-7: getTenantId -- returns null on mismatch

**Module**: `getTenantId()` helper in route
**Input**: `req.tenantContext.tenantId: 'T1'`, `req.params.tenantId: 'T2'`
**Expected Output**: `null` (triggers 403 response)

### UNIT-8: POLICY_DEFAULTS -- correct default values

**Module**: `POLICY_DEFAULTS` in `tenant-llm-policy-repo.ts`
**Input**: N/A (static constant)
**Expected Output**: `{ credentialPolicy: 'org_first', allowedProviders: [], allowProjectCredentials: true, platformDemoEnabled: false, monthlyTokenBudget: 0, dailyTokenBudget: 0, maxRequestsPerMinute: 600, defaultModel: null, defaultFastModel: null, defaultVoiceModel: null }`

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 403 (E2E-5)
- [ ] Cross-project access: N/A (tenant-scoped feature)
- [ ] Cross-user access: N/A (not user-owned)
- [x] Missing auth returns 401 (E2E-8)
- [x] Insufficient permissions returns 403 (E2E-6)
- [x] Input validation rejects malformed data (E2E-4)
- [x] platformDemoEnabled is read-only from tenant API (E2E-7)

---

## Performance & Load Tests

Not applicable for the current implementation. Policy fetch is a single MongoDB query on a unique index (< 10ms). If caching is added in the future, cache invalidation and TTL behavior should be tested.

---

## Test Infrastructure

### Required Services

- MongoDB (via MongoMemoryServer for unit/integration, real MongoDB for E2E)
- Express server started on random port `{ port: 0 }` for E2E tests

### Data Seeding Strategy

- Create tenant via platform admin API or test helper
- Create users with specific permissions via auth API or test helper
- Create LLM credentials (user and org scope) for credential policy tests
- Create TenantModel entries for provider allowlist enforcement tests

### Environment Variables

- `MONGODB_URI` -- MongoDB connection string
- `JWT_SECRET` -- for generating test auth tokens
- `ENCRYPTION_MASTER_KEY` -- for credential encryption in integration tests

### CI Configuration

- E2E tests require running MongoDB instance
- Tests should be tagged `@tenant-llm-policy` for selective execution

---

## Test File Mapping

| Test File (Existing)                                                            | Type | Covers          |
| ------------------------------------------------------------------------------- | ---- | --------------- |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`             | unit | FR-7, FR-8      |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                  | unit | Diagnostics     |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                              | unit | FR-7 (indirect) |
| `apps/runtime/src/__tests__/llm-services.test.ts`                               | unit | FR-8 (indirect) |
| `apps/runtime/src/__tests__/repos-data.test.ts`                                 | unit | FR-1 (indirect) |
| `apps/runtime/src/__tests__/auth-profile/model-resolution-auth-profile.test.ts` | unit | FR-8 (indirect) |

| Test File (Planned)                                                | Type        | Covers                             |
| ------------------------------------------------------------------ | ----------- | ---------------------------------- |
| `apps/runtime/src/__tests__/tenant-llm-policy-route.test.ts`       | e2e         | FR-2, FR-3, FR-4, FR-5, FR-6, FR-9 |
| `apps/runtime/src/__tests__/tenant-llm-policy-integration.test.ts` | integration | FR-1, FR-7, FR-8, FR-10            |

---

## How to Run

```bash
# All LLM policy-related unit tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "llm.policy\|model.resolution\|credential.chain"

# Specific test files
pnpm test --filter=runtime -- apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/credential-chain-analyzer.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/tenant-models.test.ts
```

---

## Coverage Gaps

| Gap                                                          | Severity | Notes                                                                       |
| ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------- |
| No dedicated test for tenant-llm-policy REST route (GET/PUT) | High     | CRUD, validation, error handling untested directly                          |
| No RBAC enforcement test (credential:read/write)             | High     | Permission checks not verified                                              |
| No cross-tenant access test (URL tenantId vs auth context)   | High     | Security boundary not tested                                                |
| No Zod validation test (invalid providers, negative budgets) | Medium   | Schema validation not verified                                              |
| No platformDemoEnabled read-only enforcement test            | Medium   | Superadmin-only field not tested                                            |
| No audit logging verification                                | Medium   | Audit log emission not asserted                                             |
| No E2E test for policy affecting agent execution             | High     | No test verifies end-to-end: set policy -> resolve model -> policy enforced |
| No integration test for policy-to-DB roundtrip               | High     | Repository functions not tested against real MongoDB                        |

---

## Open Testing Questions

1. Should E2E tests for this feature start a full runtime server or a minimal Express app with just the LLM policy route?
2. What test helper exists for creating authenticated requests with specific tenant contexts and permissions?
3. Should integration tests use MongoMemoryServer or require a running MongoDB instance?
4. How should the encryption service be configured in integration tests for credential resolution testing?
