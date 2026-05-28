# Test Specification: Environment Variables

**Feature Spec**: `docs/features/environment-variables.md`
**HLD**: `docs/specs/environment-variables.hld.md`
**LLD**: `docs/plans/2026-03-23-environment-variables-impl-plan.md`
**Status**: STABLE
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                                                 | Unit | Integration   | E2E           | Status                                |
| ----- | ----------------------------------------------------------- | ---- | ------------- | ------------- | ------------------------------------- |
| FR-1  | Create endpoint accepts `environment: null` (base values)   | -    | -             | E2E-2, E2E-11 | PASS (E2E + Live)                     |
| FR-2  | EnvVarStore base fallback (env-specific then null)          | -    | INT-2         | E2E-2         | PASS (INT-2)                          |
| FR-3  | RuntimeSecretsProvider propagates base fallback via cache   | -    | INT-1, INT-2  | -             | PASS (INT-1, INT-2)                   |
| FR-4  | Namespace filtering at DB level before pagination           | -    | INT-9         | E2E-12        | PASS (INT-9 + E2E-12)                 |
| FR-5  | Studio UI base value tab                                    | -    | -             | -             | CODE DONE (UI only)                   |
| FR-6  | Diff endpoint between environments                          | -    | -             | E2E-13        | PASS (E2E-13)                         |
| FR-7  | Bulk export/import to JSON                                  | -    | -             | E2E-14        | PASS (E2E-14)                         |
| FR-8  | Pre-deploy validation checks base variables                 | -    | -             | E2E-4         | PASS (E2E-4)                          |
| FR-9  | Snapshot base+override dedup (override wins)                | -    | INT-3         | E2E-2         | DEFERRED (INT-3)                      |
| FR-10 | All 3 resolution paths handle base fallback identically     | -    | INT-2, INT-10 | -             | PARTIAL (INT-2 pass, INT-10 deferred) |
| FR-11 | envVarCache sentinel for "cached undefined" vs "not cached" | -    | INT-11        | -             | PASS (INT-11)                         |

### Existing Feature Coverage

| Feature                             | E2E           | Integration  | Unit     |
| ----------------------------------- | ------------- | ------------ | -------- |
| Create variable (env-specific)      | E2E-1         | -            | -        |
| Create variable (base, env: null)   | E2E-2, E2E-11 | INT-2        | -        |
| List variables                      | E2E-1, E2E-8  | -            | -        |
| Get decrypted value                 | E2E-1         | INT-5        | -        |
| Update variable                     | E2E-1         | -            | -        |
| Delete variable                     | E2E-1         | -            | -        |
| Base+override resolution (live)     | -             | INT-1, INT-2 | -        |
| Base+override resolution (snapshot) | E2E-2         | INT-3        | -        |
| Copy between environments           | E2E-3         | -            | -        |
| Pre-deploy validation               | E2E-4         | -            | -        |
| Duplicate key rejection             | E2E-5         | -            | -        |
| Input validation                    | E2E-6         | -            | -        |
| Cross-project isolation             | E2E-7         | -            | -        |
| Namespace-scoped access             | E2E-8         | -            | -        |
| One-active-deployment               | E2E-9         | INT-4, INT-7 | -        |
| Variable count limit                | E2E-10        | -            | -        |
| Encryption round-trip               | -             | INT-5, INT-6 | -        |
| Environment normalization           | -             | INT-8        | Existing |
| Concurrent deploy safety            | -             | INT-7        | -        |
| Namespace pagination correctness    | E2E-12        | INT-9        | -        |
| Variable diff between envs          | E2E-13        | -            | -        |
| Bulk export/import                  | E2E-14        | -            | -        |
| Cache sentinel correctness          | -             | INT-11       | -        |
| Tool-test-service base fallback     | -             | INT-10       | -        |

---

## 2. E2E Test Scenarios

**CRITICAL:** E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Real Express server on random port with full middleware chain.

### E2E-1: Full Variable CRUD Lifecycle

**Preconditions:** Authenticated user with `env_var:create`, `env_var:read`, `env_var:update`, `env_var:delete` permissions. Project exists in DB.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`, `userId: "u1"` with project admin role.

**Steps:**

1. POST `/api/projects/p1/env-vars` with `{ environment: "staging", key: "API_KEY", value: "sk-test-123", isSecret: true }`
2. Assert 201, response body: `{ success: true, variable: { id: "<uuid>", key: "API_KEY", environment: "staging", isSecret: true } }`
3. GET `/api/projects/p1/env-vars?environment=staging`
4. Assert 200, `variables` array includes `{ key: "API_KEY", isSecret: true }`, no `value` field
5. GET `/api/projects/p1/env-vars/<id>/value`
6. Assert 200, `{ variable: { value: "sk-test-123" } }`
7. PUT `/api/projects/p1/env-vars/<id>` with `{ value: "sk-prod-456" }`
8. Assert 200, `updatedAt` is newer than `createdAt`
9. GET `/api/projects/p1/env-vars/<id>/value`
10. Assert `value: "sk-prod-456"`
11. DELETE `/api/projects/p1/env-vars/<id>`
12. Assert 200, `{ deleted: "<id>" }`
13. GET `/api/projects/p1/env-vars?environment=staging`
14. Assert `API_KEY` no longer in list

**Isolation Check:** Request with `tenantId: "t2"` to same endpoint returns 404.

### E2E-2: Base Value Create + Override Resolution via Deployment

**Preconditions:** Project with encryption enabled. Deployment endpoints available.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`, `userId: "u1"` with project admin role.

**Steps:**

1. POST create base variable `DB_HOST` with `{ environment: null, key: "DB_HOST", value: "base-db.internal" }`
2. Assert 201 (verifies FR-1 bug fix — previously returned 400)
3. POST create staging override `DB_HOST` with `{ environment: "staging", key: "DB_HOST", value: "staging-db.internal" }`
4. Assert 201
5. POST create base-only variable `SHARED_SECRET` with `{ environment: null, key: "SHARED_SECRET", value: "shared-123" }`
6. Assert 201
7. POST deploy to `staging`
8. GET deployment snapshot
9. Assert snapshot contains `DB_HOST` with staging ciphertext (override wins)
10. Assert snapshot contains `SHARED_SECRET` with base ciphertext (fallback)
11. Assert no duplicate `DB_HOST` entries in snapshot

### E2E-3: Copy Variables Between Environments

**Preconditions:** Project exists.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`, `userId: "u1"`.

**Steps:**

1. POST create 3 variables for `dev`: `VAR_A=a1`, `VAR_B=b1`, `VAR_C=c1`
2. POST `/api/projects/p1/env-vars/copy` with `{ sourceEnvironment: "dev", targetEnvironment: "staging", overwrite: false }`
3. Assert `{ copied: 3, skipped: 0 }`
4. GET `/api/projects/p1/env-vars?environment=staging`
5. Assert all 3 variables present
6. POST create `VAR_A` for staging with value `different`
7. POST copy from dev to staging with `overwrite: false`
8. Assert `{ copied: 0, skipped: 3 }`
9. POST copy from dev to staging with `overwrite: true`
10. Assert `{ copied: 3, skipped: 0 }`
11. GET staging `VAR_A` value — assert it matches dev value (overwritten)

### E2E-4: Pre-Deploy Validation With Base Fallback

**Preconditions:** Project with compiled agents referencing `{{env.API_KEY}}`, `{{env.BASE_VAR}}`, `{{env.MISSING_VAR}}`.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST create `API_KEY` for `production` with value `key-123`
2. POST create `BASE_VAR` with `environment: null` (base only)
3. POST `/api/projects/p1/env-vars/validate` with `{ environment: "production" }`
4. Assert `defined` includes `API_KEY` and `BASE_VAR` (FR-8: base vars checked)
5. Assert `missing` includes `MISSING_VAR`
6. Assert `BASE_VAR` is NOT in `missing` (base coverage counts)

### E2E-5: Duplicate Key Rejection

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST create `API_KEY` for `dev` — Assert 201
2. POST create `API_KEY` for `dev` again — Assert 409
3. POST create `API_KEY` for `staging` — Assert 201 (different env allowed)

### E2E-6: Invalid Input Rejection

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST with `key: ""` — Assert 400
2. POST with `key: "1BAD_KEY"` — Assert 400
3. POST with `key:` 257 chars — Assert 400
4. POST with `value:` 16385 chars — Assert 400
5. POST with `environment: "invalid_env"` — Assert 400
6. POST `/copy` with `sourceEnvironment: "dev", targetEnvironment: "dev"` — Assert 400

### E2E-7: Cross-Project Isolation

**Preconditions:** Two projects P1, P2 in same tenant.

**Auth Context:** `tenantId: "t1"`, `userId: "u1"` with admin on both projects.

**Steps:**

1. POST create `SECRET` in P1 for `dev`
2. GET `/api/projects/p2/env-vars?environment=dev`
3. Assert `SECRET` NOT in P2's response
4. GET `/api/projects/p2/env-vars/<p1-var-id>/value`
5. Assert 404

### E2E-8: Namespace-Scoped Variable Access

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST create namespace `payment-tools`
2. POST create namespace `analytics-tools`
3. POST create `STRIPE_KEY` for `dev`, assigned to `payment-tools` namespace
4. POST create `MIXPANEL_KEY` for `dev`, assigned to `analytics-tools` namespace
5. GET `/api/projects/p1/env-vars?environment=dev&namespaceId=<payment-id>`
6. Assert only `STRIPE_KEY` returned
7. GET with `namespaceId=<analytics-id>`
8. Assert only `MIXPANEL_KEY` returned
9. GET without namespace filter
10. Assert both variables returned

### E2E-9: One Active Deployment Per Environment

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST deploy to `staging` (D1) — Assert active
2. POST deploy to `staging` (D2)
3. Assert D2 is active, D1 is retired
4. Assert exactly one active deployment for `staging`

### E2E-10: Per-Project Variable Count Limit

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. Create variables up to `MAX_ENV_VARS_PER_PROJECT` for `dev`
2. POST create one more — Assert 400 with limit error

### E2E-11: Base Value CRUD Lifecycle (Bug Fix Verification)

**Purpose:** Explicitly verify GAP-001 fix — `environment: null` accepted by create endpoint.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. POST `/api/projects/p1/env-vars` with `{ environment: null, key: "DEFAULT_TIMEOUT", value: "30000" }`
2. Assert 201, response: `{ variable: { environment: null, key: "DEFAULT_TIMEOUT" } }`
3. GET `/api/projects/p1/env-vars` (no environment filter)
4. Assert `DEFAULT_TIMEOUT` appears in list
5. GET `/api/projects/p1/env-vars?environment=null` or equivalent
6. Assert `DEFAULT_TIMEOUT` appears
7. PUT update value to `60000`
8. Assert 200
9. GET value — Assert `60000`
10. DELETE — Assert 200

### E2E-12: Namespace Pagination Correctness (Bug Fix Verification)

**Purpose:** Verify GAP-003 fix — namespace filtering before pagination.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. Create namespace `ns-a`
2. Create 30 variables for `dev`, 10 assigned to `ns-a`, 20 to default namespace
3. GET `/api/projects/p1/env-vars?environment=dev&namespaceId=<ns-a-id>&limit=5&page=1`
4. Assert `variables.length === 5`, `pagination.total === 10`
5. GET page 2 — Assert `variables.length === 5`
6. GET page 3 — Assert `variables.length === 0`
7. Assert all 10 variables from `ns-a` are retrievable across pages (no gaps, no duplicates)

### E2E-13: Variable Diff Between Environments

**Purpose:** Verify FR-6 — diff endpoint.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. Create `SHARED` for both `dev` and `staging` with SAME value
2. Create `DEV_ONLY` for `dev` only
3. Create `STAGING_ONLY` for `staging` only
4. Create `DIFFERS` for both `dev` and `staging` with DIFFERENT values
5. GET `/api/projects/p1/env-vars/diff?source=dev&target=staging`
6. Assert `added` includes `STAGING_ONLY` (in target, not source)
7. Assert `removed` includes `DEV_ONLY` (in source, not target)
8. Assert `changed` includes `DIFFERS`
9. Assert `SHARED` is NOT in any diff category

### E2E-14: Bulk Export and Import

**Purpose:** Verify FR-7 — export/import.

**Auth Context:** `tenantId: "t1"`, `projectId: "p1"`.

**Steps:**

1. Create 5 variables for `dev` with known values
2. POST `/api/projects/p1/env-vars/export` with `{ environment: "dev" }`
3. Assert response is JSON array with 5 entries, each having `key`, `value`, `isSecret`, `description`
4. DELETE all 5 variables
5. POST `/api/projects/p1/env-vars/import` with `{ environment: "staging", variables: <exported-json>, overwrite: false }`
6. Assert `imported: 5`
7. GET `/api/projects/p1/env-vars?environment=staging`
8. Assert all 5 variables present with correct values

---

## 3. Integration Test Scenarios

### INT-1: RuntimeSecretsProvider — Env-Specific Resolution

**Boundary:** `RuntimeSecretsProvider` -> `EnvVarStore` -> MongoDB -> `SecretDecryptor`

**Setup:** Real MongoMemoryServer, real encryption service. Create encrypted variable `API_KEY` for `staging`.

**Steps:**

1. Create `RuntimeSecretsProvider` with `environment: "staging"`, real `EnvVarStore`, real `SecretDecryptor`
2. Call `getEnvVar("API_KEY")`
3. Assert returns decrypted value
4. Call `getEnvVar("API_KEY")` again — Assert same value (from `envVarCache`, verify no second DB query via spy)
5. Call `getEnvVar("NONEXISTENT")` — Assert returns `undefined`

**Failure Mode:** If decryptor throws, provider returns `undefined` and logs error.

### INT-2: RuntimeSecretsProvider — Base Fallback (Bug Fix Verification)

**Boundary:** `RuntimeSecretsProvider` -> `EnvVarStore` (two-query pattern) -> MongoDB

**Purpose:** Verify GAP-002 fix.

**Setup:** Real MongoDB. Create base variable (`environment: null`) for key `BASE_ONLY_VAR`.

**Steps:**

1. Create `RuntimeSecretsProvider` with `environment: "staging"`
2. Call `getEnvVar("BASE_ONLY_VAR")`
3. Assert returns decrypted base value (first query for `staging` misses, second query for `null` hits)
4. Create staging override for `BASE_ONLY_VAR` with different value
5. Create new provider (fresh cache)
6. Call `getEnvVar("BASE_ONLY_VAR")`
7. Assert returns staging value (override wins)

### INT-3: Snapshot Service — Base+Override Dedup

**Boundary:** `createDeploymentSnapshot()` -> `EnvironmentVariable.find()` -> `VariableNamespaceMembership`

**Setup:** Real MongoDB with encryption plugin.

**Steps:**

1. Insert base `API_URL` (`environment: null`, value `base-url`)
2. Insert staging `API_URL` (`environment: "staging"`, value `staging-url`)
3. Insert base-only `SHARED_TOKEN` (`environment: null`)
4. Insert staging-only `STAGING_FLAG` (`environment: "staging"`)
5. Call `createDeploymentSnapshot({ environment: "staging" })`
6. Assert snapshot envVars has 3 entries: `API_URL` (staging), `SHARED_TOKEN` (base), `STAGING_FLAG` (staging)
7. Assert no duplicate `API_URL`
8. Assert `snapshotHash` is SHA-256 hex string

### INT-4: Deployment Repo — Retire Previous Active

**Boundary:** `retirePreviousActiveDeployment()` -> MongoDB (with partial unique index)

**Setup:** Real MongoDB.

**Steps:**

1. Create active deployment D1 for `staging`
2. Call `retirePreviousActiveDeployment(projectId, tenantId, "staging")`
3. Assert returns D1 data
4. Query D1 — Assert `status: "retired"`, `retiredAt` set
5. Call retire again — Assert returns `null`

### INT-5: Encryption Plugin Round-Trip

**Boundary:** Mongoose `encryptionPlugin` -> MongoDB

**Setup:** Real MongoDB, real encryption service with test master key.

**Steps:**

1. Create env var with value `my-secret-api-key`
2. Query raw document bypassing Mongoose hooks (collection.findOne)
3. Assert raw `encryptedValue` !== `my-secret-api-key` (is ciphertext)
4. Query via Mongoose model (hooks active)
5. Assert `encryptedValue` === `my-secret-api-key` (decrypted)

### INT-6: Snapshot Ciphertext Preservation

**Boundary:** `createDeploymentSnapshot()` -> `EnvironmentVariable.find()` (without decrypt)

**Setup:** Real MongoDB, real encryption.

**Steps:**

1. Create env var `SECRET_KEY` with value `plaintext-secret`
2. Call `createDeploymentSnapshot()`
3. Read snapshot from DB
4. Assert snapshot's envVar `encryptedValue` !== `plaintext-secret` (ciphertext preserved)
5. Decrypt via `decryptForTenant()` — Assert recovers `plaintext-secret`

### INT-7: Concurrent Deployment Race Condition

**Boundary:** Two concurrent `retirePreviousActiveDeployment()` + deployment create

**Setup:** Real MongoDB with partial unique index.

**Steps:**

1. Create active deployment D1 for `staging`
2. Simultaneously fire two deployment creates for `staging`
3. Assert exactly one active deployment exists after both complete
4. Assert at most one E11000 error or both succeed sequentially

### INT-8: Environment Normalization

**Boundary:** Pure functions in `@agent-platform/config`

**Steps:**

1. `normalizeEnvironment("development")` -> `"dev"`
2. `normalizeEnvironment("prod")` -> `"production"`
3. `normalizeEnvironment("stg")` -> `"staging"`
4. `normalizeEnvironment("PRODUCTION")` -> `"production"`
5. `normalizeEnvironment(undefined)` -> `"dev"`
6. `normalizeEnvironment("invalid")` -> throws
7. `VALID_ENVIRONMENTS` is `["dev", "staging", "production"]`
8. `isProduction("production")` -> `true`
9. `isDevelopment("dev")` -> `true`

### INT-9: Namespace Pagination at DB Level (Bug Fix Verification)

**Boundary:** Env vars route -> MongoDB aggregation pipeline with `$lookup`

**Purpose:** Verify GAP-003 fix.

**Setup:** Real MongoDB. Create 30 variables, 10 in namespace A, 20 in default.

**Steps:**

1. Call `findEnvironmentVariables` with `namespaceId` filter, `skip: 0`, `take: 5`
2. Assert returns exactly 5 variables, all from namespace A
3. Assert `total` count is 10 (not 30)
4. Call with `skip: 5`, `take: 5` — Assert returns next 5 from namespace A
5. Call with `skip: 10`, `take: 5` — Assert returns 0 (all 10 exhausted)

### INT-10: Tool-Test-Service Base Fallback

**Boundary:** `tool-test-service.ts` `createSecretsProviderForToolTest()` -> MongoDB

**Purpose:** Verify the Studio tool-test path also resolves base variables correctly (FR-10).

**Setup:** Real MongoDB. Create base variable `BASE_KEY` (`environment: null`). Create namespace membership.

**Steps:**

1. Call `createSecretsProviderForToolTest()` with `environment: "staging"` and linked namespace IDs
2. Call `getSecret("BASE_KEY")`
3. Assert returns decrypted base value (env-specific miss -> base fallback -> namespace check)

### INT-11: Cache Sentinel Correctness (Bug Fix Verification)

**Boundary:** `RuntimeSecretsProvider.envVarCache`

**Purpose:** Verify GAP-004 fix.

**Setup:** Real MongoDB. No variable `MISSING_KEY` exists.

**Steps:**

1. Create `RuntimeSecretsProvider`
2. Call `getEnvVar("MISSING_KEY")` — Assert returns `undefined`
3. Insert `MISSING_KEY` into DB (simulating another process adding it)
4. Call `getEnvVar("MISSING_KEY")` again
5. Assert still returns `undefined` (cached "not found" sentinel prevents re-query within same session)
6. Create new provider — Call `getEnvVar("MISSING_KEY")`
7. Assert returns the inserted value (fresh cache)

---

## 4. Unit Test Scenarios

### UT-1: Environment Normalization (Existing)

**Module:** `packages/config/src/environment.ts`
**Status:** PASS — existing tests at `packages/config/src/__tests__/environment.test.ts`

Covers `normalizeEnvironment()`, `isProduction()`, `isDevelopment()`, `VALID_ENVIRONMENTS`.

### UT-2: Key Validation Pattern

**Module:** `apps/runtime/src/routes/environment-variables.ts`

**Steps:**

1. `KEY_PATTERN.test("VALID_KEY")` -> `true`
2. `KEY_PATTERN.test("1INVALID")` -> `false`
3. `KEY_PATTERN.test("")` -> `false`
4. `KEY_PATTERN.test("has spaces")` -> `false`
5. `KEY_PATTERN.test("has-dashes")` -> `false`
6. `KEY_PATTERN.test("A")` -> `true` (single char)

### UT-3: Snapshot Diff Computation

**Module:** `apps/runtime/src/services/snapshot-service.ts` (`computeSnapshotDiff`)

**Steps:**

1. Compute diff between `{ envVars: [A, B] }` and `{ envVars: [B, C] }` — Assert `added: [C]`, `removed: [A]`
2. Compute diff where B has different `encryptedValue` — Assert `changed: [B]`
3. Compute diff with empty source — Assert all target vars are `added`
4. Compute diff with same vars — Assert empty diff

---

## 5. Security & Isolation Tests

| Concern                                  | Test(s)                                                | Expected Behavior          |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------- |
| Cross-tenant access                      | E2E-7 (modify auth to different tenant)                | 404                        |
| Cross-project access                     | E2E-7                                                  | 404                        |
| Missing auth token                       | E2E-1 variant: omit Authorization header               | 401                        |
| Insufficient permissions (viewer create) | E2E-1 variant: user with `env_var:read` only           | 403                        |
| Encryption at rest                       | INT-5                                                  | Raw DB value is ciphertext |
| No plaintext in snapshot                 | INT-6                                                  | Snapshot stores ciphertext |
| Input validation                         | E2E-6                                                  | 400 for malformed data     |
| Rate limiting                            | E2E-1 variant: rapid-fire requests                     | 429 after limit            |
| Audit logging                            | E2E-1: verify audit entries after create/update/delete | Audit records exist        |

---

## 6. Performance & Load Tests

| Scenario                                       | Target  | How Measured                                  |
| ---------------------------------------------- | ------- | --------------------------------------------- |
| Variable resolution (cached)                   | < 1ms   | Benchmark `getEnvVar()` after first call      |
| Variable resolution (cold, with base fallback) | < 50ms  | Benchmark `getEnvVar()` first call, base path |
| List 100 variables                             | < 200ms | Benchmark GET `/env-vars?limit=100`           |
| Snapshot creation (50 env + 20 config vars)    | < 500ms | Benchmark `createDeploymentSnapshot()`        |
| Bulk copy 50 variables                         | < 2s    | Benchmark POST `/copy`                        |

---

## 7. Test Infrastructure

### Required Services

- **MongoMemoryServer** — ephemeral MongoDB (no external dependency)
- **Real encryption service** — initialized with test master key
- **Express server** — started on random port (`{ port: 0 }`)
- **Full middleware chain** — auth, rate limiting, tenant isolation, project permission, Zod validation

### Data Seeding

| Entity              | Count | Details                                    |
| ------------------- | ----- | ------------------------------------------ |
| Tenant              | 2     | T1 (primary), T2 (isolation test)          |
| Project             | 2     | P1 (primary), P2 (isolation test)          |
| User                | 2     | U1 (admin), U2 (viewer)                    |
| Auth token          | 2     | Valid JWTs for U1 and U2                   |
| Variable namespaces | 3     | `payment-tools`, `analytics-tools`, `ns-a` |

### Environment Variables for Tests

```bash
encryption_master_key=test-master-key-32-chars-exactly!
NODE_ENV=test
```

### Test Server Pattern

```typescript
// E2E test setup — real Express with full middleware
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import http from 'http';

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Start real Express app with full middleware chain
  const app = createApp(); // imports real auth, rate limit, routes
  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
```

---

## 8. Test File Mapping

| Test File                                                           | Type        | Covers                                |
| ------------------------------------------------------------------- | ----------- | ------------------------------------- |
| `apps/runtime/src/__tests__/env-vars-e2e.test.ts`                   | E2E         | E2E-1 through E2E-14                  |
| `apps/runtime/src/__tests__/secrets-provider-integration.test.ts`   | integration | INT-1, INT-2, INT-11                  |
| `apps/runtime/src/__tests__/snapshot-service-integration.test.ts`   | integration | INT-3, INT-6                          |
| `apps/runtime/src/__tests__/deployment-repo-integration.test.ts`    | integration | INT-4, INT-7                          |
| `apps/runtime/src/__tests__/env-vars-namespace-pagination.test.ts`  | integration | INT-9                                 |
| `apps/studio/src/__tests__/tool-test-service-base-fallback.test.ts` | integration | INT-10                                |
| `packages/config/src/__tests__/environment.test.ts`                 | unit        | INT-8, UT-1 (existing)                |
| `apps/runtime/src/__tests__/environment-variables-authz.test.ts`    | integration | RBAC (existing, uses mocks — not E2E) |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`        | integration | Isolation (existing)                  |

---

## 9. Open Testing Questions

1. Should E2E tests for deployment snapshots call the actual deployment API, or is it acceptable to call `createDeploymentSnapshot()` directly in E2E setup? (Recommendation: use deployment API for true E2E)
2. How to handle encryption master key in CI? Should it be a fixed test key or generated per run?
3. Should performance benchmarks be assertions (fail if too slow) or advisory (log only)?
4. The existing `environment-variables-authz.test.ts` uses `vi.mock()` — should it be rewritten as E2E, or kept as a fast integration check alongside the new E2E tests?

---

## 10. Risks & Mitigations

| Risk                                               | Mitigation                                                |
| -------------------------------------------------- | --------------------------------------------------------- |
| Encryption plugin behavior differs in test vs prod | Use real encryption with test master key, not mocks       |
| MongoMemoryServer version drift                    | Pin version in devDependencies                            |
| Partial unique index not created in test DB        | Verify via `db.collection.getIndexes()` in test setup     |
| Rate limiter interferes with test speed            | Use high rate limit or disable for test tenant            |
| Audit log writes slow down tests                   | Verify audit log exists but don't wait for async writes   |
| E2E server startup too slow                        | Share server across test suite (beforeAll at suite level) |

---

## 11. Live E2E Testing — Iteration Log

### Iteration 2 — 2026-03-23

**Scope**: Full feature smoke test — all Phase 1-2 endpoints, encryption round-trips, namespace pagination
**Branch**: develop
**Duration**: ~25min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                                   | Method                                                                | Expected                               | Actual                                                  | Status |
| --- | -------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- | ------ |
| 1   | Create base var (env:null)             | `POST /env-vars` `{environment:null, key:"BASE_API_URL", ...}`        | 201                                    | 201, `{success:true, variable:{environment:null}}`      | PASS   |
| 2   | Create dev override (same key)         | `POST /env-vars` `{environment:"dev", key:"BASE_API_URL", ...}`       | 201                                    | 201, `{success:true, variable:{environment:"dev"}}`     | PASS   |
| 3   | Create secret + decrypt + DB check     | `POST /env-vars` (isSecret) → `GET /value` → mongosh raw              | Plaintext decrypts, DB stores cipher   | Decrypted=`supersecret123`, raw cipher len=106, ire set | PASS   |
| 4   | Create staging var                     | `POST /env-vars` `{environment:"staging", ...}`                       | 201                                    | 201                                                     | PASS   |
| 5   | Copy dev→staging                       | `POST /env-vars/copy` `{source:"dev", target:"staging"}`              | `{upserted:≥1}`                        | `{upserted:1, matched:0}`                               | PASS   |
| 6   | Diff dev vs staging                    | `GET /env-vars/diff?source=dev&target=staging`                        | Shows added/removed/changed/unchanged  | Correct diff with expected categories                   | PASS   |
| 7   | Export dev vars                        | `POST /env-vars/export` `{environment:"dev"}`                         | JSON array of decrypted vars           | Array with keys+decrypted values                        | PASS   |
| 8a  | Import to production                   | `POST /env-vars/import` `{environment:"production", variables:[...]}` | `{imported:N, skipped:0}`              | `{imported:2, skipped:0}`                               | PASS   |
| 8b  | Import skip existing (overwrite=false) | `POST /env-vars/import` same vars, `overwrite:false`                  | `{imported:0, skipped:2}`              | `{imported:0, skipped:2}`                               | PASS   |
| 9   | Validate endpoint                      | `POST /env-vars/validate` `{environment:"dev"}`                       | Returns defined+missing                | `{missing:[], defined:[]}` (no agent IRs — correct)     | PASS   |
| 10  | Duplicate key rejection                | `POST /env-vars` same key+env                                         | 409                                    | 409 "Variable already exists..."                        | PASS   |
| 11  | Invalid environment                    | `POST /env-vars` `{environment:"development"}`                        | 400                                    | 400 "Invalid environment..."                            | PASS   |
| 12  | Copy encryption round-trip             | Copy dev→staging → `GET /value` for copied var                        | Decrypted value matches original       | Values match after copy                                 | PASS   |
| 13  | Import encryption round-trip           | Import vars → `GET /value` for imported var                           | Decrypted value matches export payload | Values match after import                               | PASS   |
| 14  | Base var encryption round-trip         | Create base (env:null) → `GET /value`                                 | Decrypted value matches original       | Values match                                            | PASS   |
| 15  | Update + encrypt round-trip            | `PUT /env-vars/:id` new value → `GET /value`                          | Decrypted = new value                  | Decrypted matches updated value                         | PASS   |
| 16  | Delete variable                        | `DELETE /env-vars/:id`                                                | 200                                    | 200 `{deleted:"<id>"}`                                  | PASS   |
| 17  | Namespace pagination                   | `GET /env-vars?namespaceId=<default-ns>&limit=5&page=1`               | Correct total, filtered results        | `{total:1, variables:[1 var]}`                          | PASS   |

#### DB State Verification

- Raw `encryptedValue` in MongoDB is ciphertext (length 106, not plaintext) — **verified via mongosh**
- `ire` encryption metadata field present on all env var records — **verified**
- Copy/import create new records with independent encryption (different ciphertext for same plaintext due to AES-GCM nonce) — **verified**
- Namespace memberships auto-created for all new variables — **verified**

#### Encryption Verification Summary

| Operation | Plaintext→Ciphertext | Ciphertext→Plaintext | Status |
| --------- | -------------------- | -------------------- | ------ |
| Create    | Stored encrypted     | Decrypts correctly   | PASS   |
| Update    | Re-encrypted         | Decrypts to new val  | PASS   |
| Copy      | Re-encrypted         | Decrypts correctly   | PASS   |
| Import    | Encrypted on import  | Decrypts correctly   | PASS   |
| Export    | N/A (returns plain)  | N/A                  | PASS   |
| Base var  | Stored encrypted     | Decrypts correctly   | PASS   |

#### Test Environment

- Runtime: `localhost:3112` (PM2, `dist/index.js`)
- Studio: `localhost:5173` (PM2, Next.js dev)
- MongoDB: `localhost:27017/abl_platform`
- Test project: `proj-lastminute`
- Default namespace: `019ceb72-e523-76e3-afb5-e230a08fc145`

---

### Iteration 1 — 2026-03-23

**Scope**: Phase 1 bug fix verification (GAP-001 through GAP-004 + validate base coverage)
**Branch**: develop
**Duration**: ~30min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                                      | Method                                              | Expected              | Actual                                             | Status |
| --- | ----------------------------------------- | --------------------------------------------------- | --------------------- | -------------------------------------------------- | ------ |
| 1   | Create env var with `environment:null`    | `POST /env-vars` body `{environment:null,...}`      | 201, success=true     | 201, `{success:true, variable:{environment:null}}` | PASS   |
| 2a  | Create dev-specific override (same key)   | `POST /env-vars` body `{environment:"dev",...}`     | 201                   | 201, success=true                                  | PASS   |
| 2b  | List shows both base and env-specific     | `GET /env-vars`                                     | Both vars listed      | 2 vars: `{env:null}` and `{env:"dev"}`             | PASS   |
| 3   | Validate endpoint (no agent IRs)          | `POST /env-vars/validate` `{environment:"staging"}` | Empty missing/defined | `{missing:[], defined:[]}`                         | PASS   |
| 4b  | Namespace filter returns only scoped vars | `GET /env-vars?namespaceId=test-ns-pagination-001`  | 1 var, total=1        | `{total:1, vars:[{key:"BASE_API_URL"}]}`           | PASS   |
| 4c  | Default namespace returns all vars        | `GET /env-vars?namespaceId=<default-ns>`            | 3 vars, total=3       | `{total:3, vars:[3 vars]}`                         | PASS   |
| 4d  | No namespace filter returns all vars      | `GET /env-vars`                                     | 3 vars, total=3       | `{total:3, vars:[3 vars]}`                         | PASS   |
| 5   | Decrypt value round-trip                  | `GET /env-vars/:id/value`                           | Original plaintext    | `https://api.example.com`                          | PASS   |
| 6   | Missing required fields                   | `POST /env-vars` body `{key:"X"}`                   | 400                   | 400 "Missing required fields..."                   | PASS   |
| 7   | Invalid environment                       | `POST /env-vars` body `{environment:"development"}` | 400                   | 400 "Invalid environment..."                       | PASS   |
| 8   | Duplicate key+env                         | `POST /env-vars` same key+null env                  | 409                   | 409 "Variable already exists..."                   | PASS   |

#### DB State Verification

- `environment_variables` record created with `environment: null` and encrypted value — **verified**
- Namespace membership auto-created for default namespace — **verified**
- Aggregation pipeline returns correct total count when namespace-filtered — **verified**

#### Bug Fix Verification

| Bug     | Fix Description                         | Verified                               |
| ------- | --------------------------------------- | -------------------------------------- |
| GAP-001 | Create route accepts `environment:null` | PASS                                   |
| GAP-003 | Namespace pagination uses aggregation   | PASS                                   |
| GAP-004 | Cache sentinel (code review only)       | N/A (internal, no direct API test)     |
| GAP-002 | Base fallback in EnvVarStore            | N/A (requires agent execution context) |

#### Notes

- GAP-002 (base fallback) and GAP-004 (cache sentinel) fixes are internal to the execution pipeline — they can only be verified by running an agent that references `{{env.KEY}}` where the key exists only as a base variable. Full verification deferred to Phase 4 integration tests (INT-2, INT-11).
- Namespace routes are not mounted in runtime server — they're in Studio. Created test namespace directly in MongoDB.
- Validate endpoint returned empty because no agent IRs reference `{{env.KEY}}` in the test project. The fix (querying base vars) is correct per code review.
- `pnpm install` was broken due to pnpm 8.15.0 bug — fixed by using `npx pnpm@9 install`.
