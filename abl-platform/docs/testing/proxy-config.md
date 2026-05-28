# Feature Test Guide: Proxy Configuration

**Feature**: Organization-level proxy configuration for outbound HTTP traffic routing with CRUD API, RBAC, encrypted credentials, URL pattern matching, priority ordering, bypass patterns, and runtime ProxyResolver integration
**Owner**: Platform team
**Created**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: ALPHA

---

## Current State (as of 2026-03-23)

The proxy configuration feature has existing unit tests for ProxyResolver (14 tests) and RBAC authorization (20 tests). No E2E tests exist yet. The CRUD route, repository layer, database model, and ProxyConfigService are implemented and integrated into the runtime.

### Quick Health Dashboard

| Area                     | Status  | Last Verified | Notes                                             |
| ------------------------ | ------- | ------------- | ------------------------------------------------- |
| API CRUD (create)        | UNIT    | 2026-03-23    | Route implemented, authz test covers 201          |
| API CRUD (list)          | UNIT    | 2026-03-23    | Route implemented, authz test covers 200          |
| API CRUD (update)        | UNIT    | 2026-03-23    | Route implemented, authz test covers 404 (mock)   |
| API CRUD (delete)        | UNIT    | 2026-03-23    | Route implemented, authz test covers 404 (mock)   |
| RBAC enforcement         | UNIT    | 2026-03-23    | 20 authz tests across 5 roles + unauthenticated   |
| Tenant isolation         | UNIT    | 2026-03-23    | Queries scoped by tenantId in repo layer          |
| Credential encryption    | ---     | Not tested    | Encryption plugin integration not E2E tested      |
| SSRF validation          | UNIT    | 2026-03-23    | ProxyResolver rejects private IPs                 |
| URL pattern matching     | UNIT    | 2026-03-23    | 14 ProxyResolver tests cover patterns             |
| Priority ordering        | UNIT    | 2026-03-23    | ProxyResolver test verifies highest priority wins |
| Bypass patterns          | UNIT    | 2026-03-23    | ProxyResolver test verifies bypass skips proxy    |
| Certificate handling     | UNIT    | 2026-03-23    | ProxyResolver decrypts CA + mTLS certs            |
| Auth injection           | UNIT    | 2026-03-23    | basic, bearer, api_key, none all tested           |
| ProxyConfigService cache | UNIT    | 2026-03-23    | proxy-config-service.test.ts covers caching       |
| Audit logging            | ---     | Not tested    | writeAuditLog called but not verified E2E         |
| Runtime tool integration | ---     | Not tested    | HttpToolExecutor proxy wiring not E2E tested      |
| Error handling           | PARTIAL | 2026-03-23    | 409 duplicate, 400 SSRF tested in route           |
| Pagination               | ---     | Not tested    | List endpoint pagination not verified             |
| Studio UI                | ---     | N/A           | No UI exists yet (out of scope)                   |

---

## Test Coverage Map

### Unit Tests -- ProxyResolver (packages/compiler)

- [x] Wildcard `*` pattern matches any URL -- `proxy-resolver.test.ts PASS`
- [x] Exact hostname pattern matching -- `proxy-resolver.test.ts PASS`
- [x] Glob hostname pattern `*.internal.com` -- `proxy-resolver.test.ts PASS`
- [x] Multiple comma-separated patterns -- `proxy-resolver.test.ts PASS`
- [x] Bypass patterns skip proxy -- `proxy-resolver.test.ts PASS`
- [x] Priority ordering (highest first) -- `proxy-resolver.test.ts PASS`
- [x] Basic auth header injection -- `proxy-resolver.test.ts PASS`
- [x] Bearer token auth injection -- `proxy-resolver.test.ts PASS`
- [x] API key auth injection -- `proxy-resolver.test.ts PASS`
- [x] No header for auth type `none` -- `proxy-resolver.test.ts PASS`
- [x] SSRF rejects private IP proxy URL -- `proxy-resolver.test.ts PASS`
- [x] SSRF rejects cloud metadata proxy URL -- `proxy-resolver.test.ts PASS`
- [x] Custom CA certificate decryption -- `proxy-resolver.test.ts PASS`
- [x] mTLS client cert + key decryption -- `proxy-resolver.test.ts PASS`
- [x] Combined mTLS + CA + auth together -- `proxy-resolver.test.ts PASS`
- [x] Null cert fields handled gracefully -- `proxy-resolver.test.ts PASS`
- [x] Decryption failure skips config -- `proxy-resolver.test.ts PASS`
- [x] Disabled configs excluded -- `proxy-resolver.test.ts PASS`
- [x] No match returns null -- `proxy-resolver.test.ts PASS`
- [x] Empty config list returns null -- `proxy-resolver.test.ts PASS`

### Unit Tests -- RBAC Authorization (apps/runtime)

- [x] OWNER: GET 200, POST 201, PUT 404, DELETE 404 -- `proxy-config-authz.test.ts PASS`
- [x] ADMIN: GET 200, POST 201, PUT 404, DELETE 404 -- `proxy-config-authz.test.ts PASS`
- [x] OPERATOR: GET 200, POST 403, PUT 403, DELETE 403 -- `proxy-config-authz.test.ts PASS`
- [x] MEMBER: all 403 -- `proxy-config-authz.test.ts PASS`
- [x] VIEWER: all 403 -- `proxy-config-authz.test.ts PASS`
- [x] Unauthenticated: all 401 -- `proxy-config-authz.test.ts PASS`

### Unit Tests -- ProxyConfigService (apps/runtime)

- [x] Cache hit returns resolver without DB query -- `proxy-config-service.test.ts`
- [x] Cache miss triggers DB query -- `proxy-config-service.test.ts`
- [x] Empty result cached (prevents repeated queries) -- `proxy-config-service.test.ts`
- [x] Cache invalidation per tenant -- `proxy-config-service.test.ts`
- [x] Cache invalidation per tenant+environment -- `proxy-config-service.test.ts`

---

## E2E Test Scenarios (Required)

### E2E-1: Full CRUD lifecycle

**Setup**: Real runtime server, real MongoDB, authenticated admin user
**Steps**:

1. POST /api/proxy-configs with valid body (name, proxyUrl, basic auth creds)
2. Verify 201 response with config metadata (no raw credentials)
3. GET /api/proxy-configs -- verify config in list with proxyUrl masked to origin
4. PUT /api/proxy-configs/:id -- update name, priority, and bypass patterns
5. Verify 200 response with updated fields
6. DELETE /api/proxy-configs/:id -- verify 200 with deleted ID
7. GET /api/proxy-configs -- verify empty list

**Validates**: FR-1, FR-2, FR-4

### E2E-2: Tenant isolation

**Setup**: Two tenants (A and B) with admin users, real server
**Steps**:

1. Tenant A creates proxy config
2. Tenant B attempts GET /api/proxy-configs/:id (tenant A's config) -- expect 404
3. Tenant B attempts PUT /api/proxy-configs/:id (tenant A's config) -- expect 404
4. Tenant B attempts DELETE /api/proxy-configs/:id (tenant A's config) -- expect 404
5. Tenant B lists configs -- expect empty (no tenant A configs visible)

**Validates**: FR-2, cross-tenant 404 invariant

### E2E-3: RBAC enforcement with real middleware

**Setup**: Real server with full middleware chain (auth + rate limiting + permissions)
**Steps**:

1. ADMIN user creates proxy config -- expect 201
2. OPERATOR user lists configs -- expect 200
3. OPERATOR user attempts create -- expect 403
4. MEMBER user attempts list -- expect 403
5. Unauthenticated request -- expect 401

**Validates**: FR-3

### E2E-4: SSRF protection on proxy URL

**Setup**: Real server, authenticated admin
**Steps**:

1. POST with proxyUrl=http://127.0.0.1:8080 -- expect 400
2. POST with proxyUrl=http://169.254.169.254 -- expect 400
3. POST with proxyUrl=http://10.0.0.1:3128 -- expect 400
4. POST with proxyUrl=https://proxy.example.com:8080 -- expect 201

**Validates**: FR-5

### E2E-5: Duplicate name+environment conflict

**Setup**: Real server, authenticated admin
**Steps**:

1. POST proxy config with name="corp-proxy", environment="dev"
2. POST same name+environment -- expect 409 Conflict
3. POST same name, different environment (staging) -- expect 201

**Validates**: FR-1, unique index enforcement

### E2E-6: Credential encryption round-trip

**Setup**: Real server with encryption key configured, authenticated admin
**Steps**:

1. POST proxy config with basic auth credentials (username, password)
2. Verify response does NOT contain raw credentials
3. Directly query MongoDB -- verify encryptedProxyUsername and encryptedProxyPassword are ciphertext (not plaintext)
4. Verify ProxyResolver can decrypt and apply auth headers correctly

**Validates**: FR-4, NFR-3

### E2E-7: Runtime proxy resolution integration

**Setup**: Real runtime with proxy config in DB, mock external HTTP server, mock proxy server
**Steps**:

1. Create proxy config targeting `*.external.com` with bypass for `*.bypass.com`
2. Execute agent tool that calls `https://api.external.com/data` -- verify request went through proxy
3. Execute agent tool that calls `https://api.bypass.com/data` -- verify request bypassed proxy
4. Verify proxy auth headers present on proxied requests

**Validates**: FR-6, FR-7, FR-8, US-3

---

## Integration Test Scenarios (Required)

### INT-1: Repository layer CRUD with real MongoDB

**Setup**: MongoMemoryServer, encryption plugin
**Steps**:

1. createOrgProxyConfig with all fields
2. findOrgProxyConfigs with tenantId filter
3. findOrgProxyConfigById with correct and wrong tenantId
4. updateOrgProxyConfig with partial fields
5. deleteOrgProxyConfig and verify gone

**Validates**: Repository functions, tenant isolation at DB level

### INT-2: ProxyConfigService with real store

**Setup**: Mock ProxyConfigStore, real ProxyResolver
**Steps**:

1. getResolver -- first call loads from store
2. getResolver -- second call returns cached (store not called again)
3. Wait for TTL expiry -- next call hits store again
4. invalidate(tenantId) -- next call hits store

**Validates**: FR-13, caching behavior

### INT-3: Zod validation schema enforcement

**Setup**: Unit test with Zod schemas
**Steps**:

1. CreateProxyConfigSchema.parse with valid input -- succeeds
2. CreateProxyConfigSchema.parse with missing name -- fails
3. CreateProxyConfigSchema.parse with invalid URL -- fails
4. CreateProxyConfigSchema.parse with cert exceeding 64KB -- fails
5. UpdateProxyConfigSchema.parse with all optional fields -- succeeds

**Validates**: Request validation, NFR-3, NFR-4

### INT-4: Encryption plugin integration

**Setup**: Real Mongoose model with encryption plugin, encryption key
**Steps**:

1. Create config with plaintext credentials
2. Read raw document from MongoDB -- verify fields are encrypted
3. Read through Mongoose -- verify fields are decrypted
4. Update credentials -- verify re-encryption

**Validates**: FR-4

### INT-5: Audit log emission

**Setup**: Real route handler, mock audit store
**Steps**:

1. Create proxy config -- verify writeAuditLog called with action=proxy-config:create
2. Update proxy config -- verify writeAuditLog called with action=proxy-config:update
3. Delete proxy config -- verify writeAuditLog called with action=proxy-config:delete
4. Verify metadata includes configId, name, requestId

**Validates**: FR-12

### INT-6: Pagination

**Setup**: Real server or repository with 30 proxy configs
**Steps**:

1. GET with default pagination -- expect 25 items, totalPages=2
2. GET with page=2 -- expect 5 items
3. GET with limit=10 -- expect 10 items, totalPages=3
4. GET with limit=200 -- capped to 100

**Validates**: NFR-5

### INT-7: ProxyResolver with HttpToolExecutor

**Setup**: ProxyResolver with test configs, HttpToolExecutor instance
**Steps**:

1. Execute tool against URL matching proxy pattern -- verify proxy headers applied
2. Execute tool against URL matching bypass -- verify no proxy
3. Execute tool against URL with no match -- verify direct connection

**Validates**: FR-6, FR-7, FR-8, runtime integration

---

## Gaps and Known Issues

| ID  | Gap                                                 | Severity | Status |
| --- | --------------------------------------------------- | -------- | ------ |
| G-1 | No E2E tests exist -- all tests use mocks           | HIGH     | OPEN   |
| G-2 | No Studio UI for proxy management                   | MEDIUM   | OPEN   |
| G-3 | ProxyConfigService cache has no max size / eviction | MEDIUM   | OPEN   |
| G-4 | Auth profile integration not tested                 | LOW      | OPEN   |
| G-5 | No performance/load tests for proxy resolution      | LOW      | OPEN   |
| G-6 | LLM provider calls do not route through org proxy   | MEDIUM   | OPEN   |
