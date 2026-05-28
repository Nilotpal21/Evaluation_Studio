# LLD + Implementation Plan: Proxy Configuration

**Feature spec**: [docs/features/proxy-config.md](../features/proxy-config.md)
**Test spec**: [docs/testing/proxy-config.md](../testing/proxy-config.md)
**HLD**: [docs/specs/proxy-config.hld.md](../specs/proxy-config.hld.md)
**Created**: 2026-03-23
**Last updated**: 2026-03-23

---

## Implementation Status

The proxy configuration feature is substantially implemented. This LLD documents the existing implementation, identifies gaps, and provides a phased plan for closing them.

### What Exists (DONE)

| Component                       | File                                                                    | LOC                 | Status |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------- | ------ |
| Database model                  | `packages/database/src/models/org-proxy-config.model.ts`                | 91                  | DONE   |
| Normalized type                 | `packages/shared-kernel/src/types/security.ts`                          | 44 (shared)         | DONE   |
| Repository functions            | `packages/shared/src/repos/security-repo.ts`                            | 106 (proxy section) | DONE   |
| Zod validation schemas          | `packages/shared/src/validation/proxy-config-schemas.ts`                | 150                 | DONE   |
| CRUD routes                     | `apps/runtime/src/routes/proxy-config.ts`                               | 629                 | DONE   |
| ProxyResolver                   | `packages/compiler/src/platform/constructs/executors/proxy-resolver.ts` | 260                 | DONE   |
| ProxyConfigService              | `apps/runtime/src/services/proxy-config-service.ts`                     | 143                 | DONE   |
| Apply proxy addon               | `packages/shared/src/services/auth-profile/apply-proxy.ts`              | 27                  | DONE   |
| LLM wiring integration          | `apps/runtime/src/services/execution/llm-wiring.ts`                     | wired               | DONE   |
| Server registration             | `apps/runtime/src/server.ts` (line 525)                                 | wired               | DONE   |
| RBAC role definitions           | `packages/database/src/constants/system-roles.ts`                       | proxy:\*            | DONE   |
| Unit tests - ProxyResolver      | `packages/compiler/src/__tests__/constructs/proxy-resolver.test.ts`     | 381                 | DONE   |
| Unit tests - RBAC               | `apps/runtime/src/__tests__/proxy-config-authz.test.ts`                 | 459                 | DONE   |
| Unit tests - ProxyConfigService | `apps/runtime/src/__tests__/proxy-config-service.test.ts`               | exists              | DONE   |

### What Needs Work (GAPS)

| Gap ID | Description                                                                  | Priority | Effort |
| ------ | ---------------------------------------------------------------------------- | -------- | ------ |
| GAP-1  | ProxyConfigService cache has no max size or LRU eviction                     | P2       | S      |
| GAP-2  | No GET /api/proxy-configs/:id endpoint                                       | P2       | S      |
| GAP-3  | No E2E tests (all authz tests mock repos + middleware)                       | P0       | M      |
| GAP-4  | LLM provider calls do not route through org proxy                            | P1       | L      |
| GAP-5  | No Studio UI for proxy config management                                     | P1       | L      |
| GAP-6  | Error envelope inconsistency (403 response format)                           | P3       | XS     |
| GAP-7  | Cache invalidation is pod-local only                                         | P2       | M      |
| GAP-8  | No integration tests for encryption round-trip                               | P1       | S      |
| GAP-9  | Update route missing input length validation for clientCert/clientKey        | P2       | XS     |
| GAP-10 | `custom` auth type in schema but `api_key` in ProxyResolver -- enum mismatch | P1       | S      |

---

## Phase 1: Critical Bug Fixes and Safety Gaps (P0)

**Goal**: Fix enum mismatch, add missing input validation, ensure data integrity.

### Task 1.1: Fix auth type enum mismatch

**Problem**: Route Zod schemas define `proxyAuthType: z.enum(['none', 'basic', 'bearer', 'custom'])` but ProxyResolver's `ProxyConfig.authType` uses `'none' | 'basic' | 'bearer' | 'api_key'`. The value `custom` is stored in DB but never matched in ProxyResolver -- bearer/api_key proxy auth silently fails if admin selects "custom".

**Fix**:

- Option A: Align to `['none', 'basic', 'bearer', 'api_key']` in both Zod schemas and ProxyResolver
- Option B: Map `custom` to `api_key` in ProxyResolver (backward-compatible for existing data)
- **Recommended**: Option A with a DB migration check (verify no existing records use `custom`)

**Files**:

- `apps/runtime/src/routes/proxy-config.ts` -- update enum in CreateProxyConfigSchema, UpdateProxyConfigSchema
- `packages/shared/src/validation/proxy-config-schemas.ts` -- update enum in ProxyConfigMetadataSchema, CreateProxyConfigSchema, UpdateProxyConfigSchema

**Exit criteria**: ProxyResolver auth types match Zod schema enum values. No silent auth failures.

### Task 1.2: Add missing input length validation in update route

**Problem**: The update route validates `caCertificate` length but not `clientCert` or `clientKey` length, unlike the create route.

**Fix**: Add clientCert and clientKey length checks to the update handler.

**File**: `apps/runtime/src/routes/proxy-config.ts` (PUT handler, after caCertificate check)

**Exit criteria**: PUT endpoint rejects clientCert/clientKey exceeding MAX_CERT_LENGTH with 400.

### Task 1.3: Add cache size limit and eviction to ProxyConfigService

**Problem**: The in-memory cache Map in ProxyConfigService has no max size. In a multi-tenant deployment with thousands of tenants, this could cause memory growth.

**Fix**: Add MAX_CACHE_SIZE constant (default 1000), implement LRU-like eviction (delete oldest entry when at capacity).

**File**: `apps/runtime/src/services/proxy-config-service.ts`

**Exit criteria**: Cache does not grow beyond MAX_CACHE_SIZE entries.

### Phase 1 Exit Criteria

- [ ] Auth type enum consistent between Zod schemas and ProxyResolver
- [ ] Update route validates all certificate field lengths
- [ ] ProxyConfigService cache has max size and eviction
- [ ] All existing unit tests still pass
- [ ] `pnpm build --filter=@agent-platform/shared --filter=@abl/compiler --filter=runtime` succeeds

---

## Phase 2: GET by ID Endpoint and Integration Tests (P1)

**Goal**: Add missing single-record endpoint and E2E-grade integration tests.

### Task 2.1: Add GET /api/proxy-configs/:id endpoint

**Why**: The CRUD API is missing a single-record retrieval endpoint. Admins need this to view details of a specific config.

**Implementation**:

- Add `openapi.route('get', '/:id', ...)` handler in `proxy-config.ts`
- Requires `proxy:read` permission
- Returns same shape as create response (metadata + proxyUrl masked)
- Cross-tenant returns 404

**Files**:

- `apps/runtime/src/routes/proxy-config.ts`

**Exit criteria**: GET /api/proxy-configs/:id returns config metadata or 404. RBAC enforced.

### Task 2.2: Write E2E tests for CRUD lifecycle

**Setup**: Real Express server on random port, MongoMemoryServer, real encryption.

**Test file**: `apps/runtime/src/__tests__/e2e/proxy-config-crud.e2e.test.ts`

**Scenarios**:

1. Full CRUD lifecycle (create, list, get, update, delete)
2. Tenant isolation (cross-tenant 404)
3. Duplicate name+environment conflict (409)
4. SSRF rejection (400 for private IPs)
5. Pagination (page, limit, total)
6. Input validation (missing name, invalid URL, cert too long)

**Exit criteria**: 6+ E2E test scenarios passing with real server + real DB.

### Task 2.3: Write integration tests for encryption round-trip

**Test file**: `packages/shared/src/__tests__/proxy-config-encryption.test.ts`

**Scenarios**:

1. Create config with plaintext credentials, verify DB stores ciphertext
2. Read config through Mongoose, verify fields are decrypted
3. Update credentials, verify re-encryption

**Exit criteria**: Encryption round-trip verified at integration level.

### Phase 2 Exit Criteria

- [ ] GET /:id endpoint implemented and tested
- [ ] 6+ E2E test scenarios passing
- [ ] Encryption round-trip integration tests passing
- [ ] `pnpm test --filter=runtime` all passing

---

## Phase 3: LLM Provider Proxy Routing (P1)

**Goal**: Route LLM API calls (OpenAI, Anthropic, etc.) through org proxy configs.

### Task 3.1: Design LLM proxy integration

**Problem**: Currently, ProxyResolver is wired into HttpToolExecutor for tool invocations. But LLM provider API calls (via `@agent-platform/llm` provider-factory) do not pass through the proxy.

**Design**:

- Add optional `proxyConfig` parameter to LLM provider creation in `packages/llm/src/provider-factory.ts`
- LLMWiringService already has access to ProxyConfigService -- resolve proxy for LLM base URL
- Pass resolved proxy to SessionLLMClient

**Files**:

- `packages/llm/src/provider-factory.ts` -- accept proxy options
- `apps/runtime/src/services/llm/session-llm-client.ts` -- pass proxy to provider
- `apps/runtime/src/services/execution/llm-wiring.ts` -- resolve proxy for LLM URLs

**Exit criteria**: LLM calls to `api.openai.com`, `api.anthropic.com` route through org proxy when configured.

### Phase 3 Exit Criteria

- [ ] LLM provider factory accepts proxy configuration
- [ ] SessionLLMClient passes proxy to underlying HTTP client
- [ ] E2E test verifies LLM call routes through proxy
- [ ] Existing LLM tests still pass (no proxy = direct connection)

---

## Phase 4: Studio UI (P1)

**Goal**: Build Studio UI for proxy configuration management.

### Task 4.1: Proxy config list page

**Location**: `apps/studio/src/app/(app)/settings/proxy-configs/page.tsx`

**Components**:

- ProxyConfigList -- table showing name, proxyUrl (masked), authType, environment, priority, enabled toggle
- Pagination controls
- Environment filter

### Task 4.2: Create/edit proxy config dialog

**Components**:

- ProxyConfigFormDialog -- form with all fields
- Auth type-dependent field visibility (username/password for basic, token for bearer)
- Certificate upload (PEM text or file)
- URL pattern editor

### Task 4.3: Studio API proxy routes

**Location**: `apps/studio/src/app/api/proxy-configs/route.ts`

**Approach**: Proxy requests to runtime `/api/proxy-configs` endpoints (same pattern as other Studio API routes).

### Phase 4 Exit Criteria

- [ ] List page renders proxy configs with pagination
- [ ] Create dialog submits successfully
- [ ] Edit dialog pre-fills existing config
- [ ] Delete confirmation dialog works
- [ ] All E2E tests pass

---

## Phase 5: Hardening (P2)

### Task 5.1: Cross-pod cache invalidation via Redis pub/sub

When a proxy config is created/updated/deleted, publish an invalidation event to Redis. All pods subscribe and invalidate their local cache.

### Task 5.2: Error envelope normalization

Ensure all error responses use `{ success: false, error: { code, message } }` format, including 403 responses from `requirePermission`.

### Task 5.3: Auth profile integration testing

Test the `authProfileId` dual-read path in ProxyConfigService with real auth profile data.

### Phase 5 Exit Criteria

- [ ] Cache invalidation propagates across pods within seconds
- [ ] All error responses follow standard envelope
- [ ] Auth profile integration tested E2E

---

## Wiring Checklist

| Integration Point                | Source                                              | Target                   | Status |
| -------------------------------- | --------------------------------------------------- | ------------------------ | ------ |
| Route registered in server.ts    | `apps/runtime/src/server.ts:525`                    | `routes/proxy-config.ts` | DONE   |
| Repo functions exported          | `packages/shared/src/repos/index.ts`                | CRUD functions           | DONE   |
| Model in database index          | `packages/database/src/models/index.ts`             | OrgProxyConfig           | DONE   |
| Type in shared-kernel index      | `packages/shared-kernel/src/index.ts`               | NormalizedOrgProxyConfig | DONE   |
| Validation schemas exported      | `packages/shared/src/validation/index.ts`           | Zod schemas              | DONE   |
| ProxyConfigService in LLMWiring  | `apps/runtime/src/services/execution/llm-wiring.ts` | ProxyConfigService       | DONE   |
| ProxyResolver in compiler index  | `packages/compiler/src/index.ts`                    | ProxyResolver export     | DONE   |
| System roles include proxy:\*    | `packages/database/src/constants/system-roles.ts`   | ADMIN, OPERATOR          | DONE   |
| Runtime re-exports security repo | `apps/runtime/src/repos/security-repo.ts`           | re-export barrel         | DONE   |

---

## Risk Register

| Risk                                                 | Phase   | Mitigation                                                  |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------- |
| Auth type enum mismatch causes silent auth failures  | Phase 1 | Fix immediately; verify no `custom` records in prod         |
| LLM proxy routing breaks existing provider tests     | Phase 3 | Make proxy optional with fallback to direct                 |
| Studio UI proxy route conflicts with existing routes | Phase 4 | Use distinct `/api/proxy-configs` path; test route ordering |
| Redis pub/sub adds operational complexity            | Phase 5 | Feature-flag; fallback to TTL-based refresh                 |
