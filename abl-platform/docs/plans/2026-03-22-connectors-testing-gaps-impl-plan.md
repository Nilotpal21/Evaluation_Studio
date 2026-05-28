# LLD: Connectors Testing Gaps

**Feature Spec**: `docs/features/connectors.md`
**HLD**: `docs/specs/connectors.hld.md`
**Test Spec**: `docs/testing/connectors.md`
**Related LLD**: `docs/plans/2026-03-22-connectors-impl-plan.md` (architecture convergence)
**Status**: DONE — All 8 phases (0-7b) complete, 5 review rounds passed
**Date**: 2026-03-22
**Completed**: 2026-03-25

---

> **Post-Implementation Note**: All exit criteria across 8 phases were met and verified. See `docs/sdlc-logs/connectors/implementation.log.md` for per-phase status, commit hashes, exit criteria results, and review round findings. Deviations: INT-8 deferred (Graph webhooks use clientState HMAC, not tenantId), SearchAI E2E uses DI-based fake queue factory instead of real Redis.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                       | Rationale                                                                                                                                                                                                                                                           | Alternatives Rejected                                            |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D-1  | Start with integration tests (Phase 1-2) before E2E tests (Phase 3-4)          | Lower infrastructure complexity; service-layer bugs found early prevent noisy E2E debugging cascades                                                                                                                                                                | E2E-first (high setup cost, fragile debugging)                   |
| D-2  | Shared test fixtures in `packages/connectors/src/__tests__/fixtures/`          | `test-connector` fixture is used by both integration and E2E tests across 3 apps; single source prevents drift                                                                                                                                                      | Colocated per-test-file fixtures (duplication risk)              |
| D-3  | Reuse `RuntimeApiHarness` + `channel-e2e-bootstrap.ts` for runtime E2E tests   | Proven infrastructure already handles MongoMemoryServer, env management, auth, project provisioning                                                                                                                                                                 | New connector-specific harness from scratch                      |
| D-4  | Test against current `ConnectionResolver` API, not Phase 2 refactored API      | Tests become regression baseline for the pluggable-refresh-strategy refactor; waiting blocks indefinitely                                                                                                                                                           | Wait for architecture LLD Phase 2                                |
| D-5  | Phase 4 creates thin runtime connection routes, then E2E tests those routes    | Connection CRUD routes exist only in Studio (Next.js App Router) which can't use supertest without mocks. Phase 4 creates Express routes in runtime that delegate to the same `ConnectionService`. This is also planned in HLD section 6 (Runtime Connection CRUD). | Direct Next.js route handler invocation (violates E2E standards) |
| D-6  | Real Redis via `redis-server-harness.ts` for lock/dedup tests                  | INT-5 validates distributed lock semantics; ioredis-mock doesn't guarantee concurrency correctness                                                                                                                                                                  | ioredis-mock (undermines the test's purpose)                     |
| D-7  | Include skipped test fixes as final phase (lower priority)                     | 16 skipped tests are SharePoint-specific unit tests; cross-service E2E is the "primary gap" per HLD section 12                                                                                                                                                      | Defer entirely (leaves 16 tests permanently broken)              |
| D-8  | Include CI configuration (Redis service, MongoMemoryServer caching) as Phase 0 | Redis is a hard dependency for INT-3/4/5/7 and E2E-3/8; without it, tests can't run in CI                                                                                                                                                                           | Defer CI config (tests pass locally, fail in CI)                 |
| D-9  | Group E2E tests into 5 files per test spec section 8                           | Grouped scenarios share Express bootstrap; 5 parallel files better than 8; groups share preconditions                                                                                                                                                               | 8 separate files (redundant server startup)                      |
| D-10 | SearchAI E2E (E2E-5) is the last scenario implemented                          | Requires dual-connection MongoDB + BullMQ + fake Graph API; highest infrastructure complexity of all 8 E2E scenarios                                                                                                                                                | Implement E2E-5 early (blocks on SearchAI setup complexity)      |

### Key Interfaces & Types

```typescript
// NEW: Test connector fixture (packages/connectors/src/__tests__/fixtures/test-connector.ts)
export interface TestConnectorFixture {
  readonly connectorName: 'test-connector';
  register(registry: ConnectorRegistry): void;
}

// NEW: Fake OAuth server (packages/connectors/src/__tests__/fixtures/oauth-server-harness.ts)
export interface OAuthServerHarness {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  /** Configure the next token response (access token, refresh token, expiry) */
  setTokenResponse(response: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }): void;
  /** Get all token requests received */
  getTokenRequests(): Array<{ grant_type: string; code?: string; refresh_token?: string }>;
  reset(): void;
  close(): Promise<void>;
}

// NEW: Fake provider server (packages/connectors/src/__tests__/fixtures/provider-server-harness.ts)
export interface ProviderServerHarness {
  readonly baseUrl: string;
  /** Get all action requests received (method, path, headers, body) */
  getRequests(): Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
  reset(): void;
  close(): Promise<void>;
}

// NEW: Connector E2E bootstrap (apps/runtime/src/__tests__/helpers/connector-e2e-bootstrap.ts)
export interface ConnectorE2EBootstrap {
  harness: RuntimeApiHarness;
  redis: RedisServerHarness;
  fakeOAuth: OAuthServerHarness;
  fakeProvider: ProviderServerHarness;
  auth: { token: string; userId: string; tenantId: string; projectId: string };
  /** Create a connection via HTTP API */
  createConnection(opts: {
    connectorName: string;
    displayName: string;
    authType: string;
    credentials: Record<string, string>;
    scope?: 'tenant' | 'user';
  }): Promise<{ connectionId: string }>;
  /** Seed a second tenant context for isolation tests */
  createCrossTenantContext(): Promise<{ token: string; tenantId: string; projectId: string }>;
  teardown(): Promise<void>;
}

// NEW: Integration test helpers (packages/connectors/src/__tests__/helpers/)
export interface ConnectorIntegrationTestContext {
  mongoUri: string;
  connectionModel: ConnectionModel; // Mongoose model for connector_connections
  triggerModel: TriggerRegistrationModel; // DI interface from triggers/types.ts
  kvModel: Model<IConnectorKVStore>; // Mongoose model from @agent-platform/database
  encryptionService: {
    encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
    decryptForTenant(ciphertext: string, tenantId: string): Promise<string>;
  };
  redisUrl?: string;
  cleanup(): Promise<void>;
  teardown(): Promise<void>;
}
```

### Module Boundaries

| Module                                                     | Responsibility                                                                   | Depends On                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/connectors/src/__tests__/fixtures/`              | Shared test connector + fake servers                                             | `express`, `crypto`, connector registry types           |
| `packages/connectors/src/__tests__/helpers/`               | Integration test context (MongoDB, Redis, encryption)                            | `mongodb-memory-server`, `ioredis`, database models     |
| `packages/connectors/src/__tests__/integration/`           | 7 integration test files (INT-1, INT-2, INT-3+INT-7, INT-4, INT-5, INT-6, INT-9) | fixtures, helpers, connector services                   |
| `apps/runtime/src/__tests__/helpers/connector-e2e-*`       | Connector E2E bootstrap wrapping RuntimeApiHarness                               | `runtime-api-harness`, `redis-server-harness`, fixtures |
| `apps/runtime/src/__tests__/connector-*.e2e.test.ts`       | 4 E2E test files for runtime-hosted scenarios (flat, per convention)             | connector-e2e-bootstrap, RuntimeApiHarness              |
| `apps/search-ai/src/__tests__/e2e/connector-*.e2e.test.ts` | 1 E2E test file for enterprise sync scenario                                     | SearchAI setup-mongo, fixtures, BullMQ                  |
| `apps/search-ai/src/__tests__/integration/`                | 1 integration test for webhook tenant isolation (INT-8)                          | SearchAI setup-mongo, connector fixtures                |

---

## 2. File-Level Change Map

### New Files

| File                                                                                        | Purpose                                                             | LOC Estimate |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------ |
| `packages/connectors/src/__tests__/fixtures/test-connector.ts`                              | Test connector fixture: echo action + webhook trigger               | ~80          |
| `packages/connectors/src/__tests__/fixtures/oauth-server-harness.ts`                        | Express server mimicking OAuth2 token endpoint                      | ~100         |
| `packages/connectors/src/__tests__/fixtures/provider-server-harness.ts`                     | Express server mimicking connector action API                       | ~80          |
| `packages/connectors/src/__tests__/helpers/setup-mongo.ts`                                  | MongoMemoryServer + real encryption + model setup for INT tests     | ~120         |
| `packages/connectors/src/__tests__/integration/connection-encryption.integration.test.ts`   | INT-1: ConnectionService encrypted round-trip                       | ~150         |
| `packages/connectors/src/__tests__/integration/tenant-isolation.integration.test.ts`        | INT-6: Cross-tenant connection isolation at data layer              | ~180         |
| `packages/connectors/src/__tests__/integration/oauth-refresh-lock.integration.test.ts`      | INT-5 + PERF-1: Concurrent OAuth refresh with distributed lock      | ~200         |
| `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` | INT-2: Tool executor → resolver → encryption chain                  | ~200         |
| `packages/connectors/src/__tests__/integration/webhook-dispatch.integration.test.ts`        | INT-3 + INT-7: Webhook processing + auto-pause                      | ~220         |
| `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts`         | INT-4: Polling scheduler with BullMQ + cursor state                 | ~180         |
| `packages/connectors/src/__tests__/integration/registry-boot-failure.integration.test.ts`   | INT-9: Graceful degradation on connector load failure               | ~100         |
| `apps/runtime/src/routes/connections.ts`                                                    | Thin runtime connection CRUD routes delegating to ConnectionService | ~150         |
| `apps/runtime/src/__tests__/helpers/connector-e2e-bootstrap.ts`                             | Connector E2E bootstrap wrapping RuntimeApiHarness + Redis          | ~200         |
| `apps/runtime/src/__tests__/connector-connection-crud.e2e.test.ts`                          | E2E-1 + E2E-6: Connection CRUD + tenant/project isolation           | ~300         |
| `apps/runtime/src/__tests__/connector-trigger-lifecycle.e2e.test.ts`                        | E2E-3 + E2E-8: Trigger lifecycle + webhook security                 | ~350         |
| `apps/runtime/src/__tests__/connector-oauth-flow.e2e.test.ts`                               | E2E-4: OAuth initiate → callback → refresh                          | ~280         |
| `apps/runtime/src/__tests__/connector-tool-execution.e2e.test.ts`                           | E2E-2 + E2E-7: Tool execution + user/tenant scope resolution        | ~350         |
| `apps/search-ai/src/__tests__/e2e/connector-discovery-sync.e2e.test.ts`                     | E2E-5: Enterprise discovery-to-sync lifecycle                       | ~350         |
| `apps/search-ai/src/__tests__/integration/webhook-tenant-isolation.integration.test.ts`     | INT-8: SearchAI webhook tenant isolation                            | ~150         |

### Modified Files

| File                                                                                      | Change Description                                          | Risk   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| `.github/workflows/ci.yml` (or equivalent)                                                | Add Redis service container, MongoMemoryServer binary cache | Low    |
| `packages/connectors/sharepoint/src/__tests__/full-sync-coordinator.test.ts`              | Fix 10 skipped tests                                        | Medium |
| `packages/connectors/sharepoint/src/__tests__/sync-permission-integration.test.ts`        | Fix 5 skipped tests                                         | Medium |
| `packages/connectors/sharepoint/src/__tests__/integration/sync-flow.integration.test.ts`  | Fix 1 skipped test                                          | Low    |
| `packages/connectors/sharepoint/src/__tests__/integration/oauth-flow.integration.test.ts` | Un-skip entire describe block, fix OAuth flow tests         | High   |
| `packages/connectors/base/src/__tests__/token-manager.test.ts.skip`                       | Rename to `.test.ts`, fix and re-enable                     | Medium |

### Deleted Files

| File                                                                          | Reason                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/search-ai/src/__tests__/e2e/connectors.e2e.test.ts`                     | Replaced by `connector-discovery-sync.e2e.test.ts` (violates E2E standards)               |
| `apps/runtime/src/__tests__/integration/auth-profile-connector-setup.test.ts` | Superseded by E2E-4 (`connector-oauth-flow.e2e.test.ts`); uses `vi.mock` + inline service |

---

## 3. Implementation Phases

### Phase 0: CI Infrastructure + Shared Test Fixtures

**Goal**: Set up CI infrastructure (Redis service, MongoMemoryServer caching) and create shared test fixtures used by all subsequent phases.

**Tasks**:

0.1. Create `packages/connectors/src/__tests__/fixtures/test-connector.ts` — register a `test-connector` with:

- `version: '1.0.0'` (required by `Connector` interface)
- Action: `echo` — calls fake provider HTTP server, returns response with auth header passthrough
- Trigger: `on_event` — webhook strategy with HMAC-SHA256 signature verification
- Auth: `{ type: 'api_key', fields: [{ name: 'apiKey', displayName: 'API Key', required: true, sensitive: true }] }` (matches `ConnectorAuthField` interface: name, displayName, required, sensitive — NOT `type: 'string'`)
- OAuth2 variant: `{ type: 'oauth2', fields: [{ name: 'clientId', displayName: 'Client ID', required: true, sensitive: true }] }`

  0.2. Create `packages/connectors/src/__tests__/fixtures/oauth-server-harness.ts` — Express on random port:

- `POST /oauth/token` — returns configurable token response
- `GET /oauth/authorize` — returns configurable auth code redirect
- Request recording for assertion: grant_type, code, refresh_token
- Configurable: expired tokens, refresh failures, slow responses

  0.3. Create `packages/connectors/src/__tests__/fixtures/provider-server-harness.ts` — Express on random port:

- `POST /echo` — echoes input with auth header validation
- `POST /error` — returns configurable error response
- Request recording for assertion: method, path, headers, body

  0.4. Create `packages/connectors/src/__tests__/helpers/setup-mongo.ts`:

- `setupIntegrationContext()` — MongoMemoryServer + real encryption service + Mongoose models for `connector_connections`, `trigger_registrations`, `connector_kv_store`
- `teardownIntegrationContext()` — disconnect + stop MongoMemoryServer
- `clearCollections()` — drop all test data between tests

  0.5. Update CI workflow to add Redis service container and cache `~/.cache/mongodb-binaries/`

  0.6. Create `packages/connectors/vitest.integration.config.ts` with `pool: 'forks'` for `src/__tests__/integration/**` — MongoMemoryServer requires process isolation per the runtime `setup-mongo.ts` header comment. Also update the default `packages/connectors/vitest.config.ts` to EXCLUDE `'src/__tests__/integration/**'` from its include pattern (prevents integration tests from running without process isolation during `pnpm test`)

**DI Wiring Note**: The Mongoose `ConnectorConnection` model from `@agent-platform/database/models` satisfies the `ConnectionModel` DI interface and can be passed directly. The `encrypt`/`decrypt` functions must be adapted from `EncryptionService` to match `ConnectionServiceDeps` parameter order: `(tenantId, plain) => encryptionService.encryptForTenant(plain, tenantId)`. The `setup-mongo.ts` helper should export these adapter wrappers.

**Files Touched**:

- `packages/connectors/src/__tests__/fixtures/test-connector.ts` — NEW
- `packages/connectors/src/__tests__/fixtures/oauth-server-harness.ts` — NEW
- `packages/connectors/src/__tests__/fixtures/provider-server-harness.ts` — NEW
- `packages/connectors/src/__tests__/helpers/setup-mongo.ts` — NEW
- `.github/workflows/ci.yml` (or equivalent CI config) — add Redis service + cache

**Exit Criteria**:

- [ ] `test-connector` fixture registers successfully in a `ConnectorRegistry` instance (verified by a smoke test)
- [ ] Fake OAuth server starts on random port, returns configurable tokens, records requests
- [ ] Fake provider server starts on random port, echoes input with auth header passthrough
- [ ] `setupIntegrationContext()` creates working MongoMemoryServer + encryption service + models
- [ ] CI pipeline includes Redis service container and MongoMemoryServer binary cache
- [ ] `pnpm build --filter=@agent-platform/connectors` succeeds with 0 errors

**Test Strategy**:

- Smoke: Each fixture has a single test verifying it starts, registers, and responds correctly
- Existing: All 14 `packages/connectors/src/__tests__/` unit tests continue passing

**Rollback**: Delete fixture files. No production code changed.

---

### Phase 1: Integration Tests — Data Layer (INT-1, INT-6)

**Goal**: Implement integration tests for the connection data layer: encrypted credential round-trip and cross-tenant isolation at the MongoDB query level.

**Tasks**:

1.1. Implement `connection-encryption.integration.test.ts` (INT-1):

- `ConnectionService.create(tenantId, projectId, input)` with raw API key credentials
- Read raw MongoDB document — assert `encryptedCredentials` is NOT the raw key
- `ConnectionService.getById(tenantId, projectId, id)` — assert credentials are redacted (`hasCredentials: true`, no raw values)
- `ConnectionResolver.resolve(opts)` returns `ResolvedConnection` (connection + scope), then call `ConnectionResolver.decrypt(connection)` to get plaintext — assert decrypted credentials match original input
- Test `ENCRYPTION_FAILED` error path (corrupt master key)

  1.2. Implement `tenant-isolation.integration.test.ts` (INT-6):

- Create connections for Tenant A (Project P1) and Tenant B (Project P2)
- `ConnectionService.list('tenant-A', 'P1')` — only Tenant A returned
- `ConnectionService.getById('tenant-A', 'P1', tenantBConnectionId)` — returns null (cross-tenant)
- `ConnectionService.update('tenant-A', 'P1', tenantBConnectionId, { displayName: 'hacked' })` — returns null
- `ConnectionService.delete('tenant-A', 'P1', tenantBConnectionId)` — returns false
- PERF-2: Two simultaneous `create()` with identical `{ tenantId, projectId, connectorName, scope, userId }` — one succeeds (201), one fails with `CONNECTION_EXISTS` (unique compound index)
- Verify all queries include `tenantId` and `projectId` in filter

**Files Touched**:

- `packages/connectors/src/__tests__/integration/connection-encryption.integration.test.ts` — NEW
- `packages/connectors/src/__tests__/integration/tenant-isolation.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] INT-1: Encrypted credentials are NOT stored as plaintext (raw document assertion)
- [ ] INT-1: `ConnectionService.getById()` returns redacted credentials (`hasCredentials: true`, no raw values)
- [ ] INT-1: `ConnectionResolver.resolve()` returns `ResolvedConnection`, then `decrypt()` returns original plaintext credentials
- [ ] INT-6: Cross-tenant `getById`/`update`/`delete` all return null/false (not the other tenant's data)
- [ ] INT-6: `list` with wrong tenantId returns empty array
- [ ] PERF-2: Concurrent identical `create()` — one succeeds, one returns `CONNECTION_EXISTS`
- [ ] Both test files pass: `pnpm vitest run --config vitest.integration.config.ts packages/connectors/src/__tests__/integration/`
- [ ] All 14 existing unit tests continue passing

**Test Strategy**:

- Integration: Real MongoDB (MongoMemoryServer), real `EncryptionService` with test master key
- No mocks except constructor-injected DI dependencies

**Rollback**: Delete test files. No production code changed.

---

### Phase 2: Integration Tests — Service Chain + Concurrency (INT-2, INT-5, INT-9)

**Goal**: Implement integration tests for the full executor→resolver→encryption chain, concurrent OAuth refresh with distributed lock, and registry boot failure graceful degradation.

**Tasks**:

2.1. Implement `executor-resolver-chain.integration.test.ts` (INT-2):

- Create connection with encrypted API key credentials
- Call `ConnectorToolExecutor.execute()` with `test-connector.echo`
- Assert fake provider server received decrypted API key in Authorization header
- Assert executor returned the fake provider's echo response
- Test expired OAuth token triggers refresh (fake OAuth server records exactly one refresh request)

  2.2. Implement `oauth-refresh-lock.integration.test.ts` (INT-5 + PERF-1):

- Create OAuth connection with expired `oauth2TokenExpiresAt`
- Launch two concurrent `ConnectionResolver.resolve()` calls
- Assert fake OAuth provider received **exactly one** refresh request
- Assert Redis lock was acquired (check via `GET` on lock key during test)
- Assert both callers received refreshed credentials
- Test lock TTL expiry fallback: if holder crashes, second caller eventually refreshes

  2.3. Implement `registry-boot-failure.integration.test.ts` (INT-9):

- Register `test-connector` (working) and a `broken-connector` (throws on registration)
- Assert `test-connector` loaded successfully (in catalog)
- Assert `broken-connector` failed to load (logged, not in catalog)
- Execute `test-connector.echo` — succeeds
- Attempt `broken-connector.action` — structured error `CONNECTOR_UNAVAILABLE`

**Files Touched**:

- `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` — NEW
- `packages/connectors/src/__tests__/integration/oauth-refresh-lock.integration.test.ts` — NEW
- `packages/connectors/src/__tests__/integration/registry-boot-failure.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] INT-2: Fake provider received decrypted credentials (not encrypted blob)
- [ ] INT-2: Executor returns fake provider response through full chain
- [ ] INT-5: Fake OAuth provider received exactly 1 refresh request (not 2) under concurrent resolve
- [ ] INT-5: Both concurrent callers received valid refreshed tokens
- [ ] INT-9: Working connector usable, broken connector returns structured error, no runtime crash
- [ ] All 3 new test files pass
- [ ] All existing tests (14 unit + 2 from Phase 1) continue passing

**Test Strategy**:

- INT-2: Real MongoDB, real encryption, real registry, fake provider server
- INT-5: Real MongoDB, **real Redis** (via `redis-server-harness`), real encryption, fake OAuth server
- INT-9: Real registry with injected broken connector

**Rollback**: Delete test files. No production code changed.

---

### Phase 3: Integration Tests — Triggers + Webhooks (INT-3, INT-4, INT-7, INT-8)

**Goal**: Implement integration tests for webhook processing, polling triggers, trigger auto-pause, and SearchAI webhook tenant isolation.

**Tasks**:

3.1. Implement `webhook-dispatch.integration.test.ts` (INT-3 + INT-7 + PERF-3):

- INT-3: Create trigger registration with webhook strategy in MongoDB
- Call `handleWebhook(req, deps)` with HMAC-signed payload
- Assert Redis dedup key set (NX with TTL)
- Assert workflow dispatch spy called with correct `triggerMetadata`
- Assert `lastFiredAt` updated in MongoDB
- Call again with same event ID — assert dropped (dedup)
- INT-7: Simulate 10 consecutive failures (dispatch throws)
- Assert `consecutiveErrors` incremented after each failure
- After 10th: assert trigger `status` transitioned to `error`
- Submit another webhook — assert rejected (trigger in error state)
- PERF-3: Two simultaneous webhook POSTs with same event ID — assert only one workflow dispatch triggered (Redis NX dedup under concurrency)

  3.2. Implement `polling-trigger.integration.test.ts` (INT-4):

- Register polling trigger with 1-second interval
- Wait for BullMQ job to fire
- Assert `ConnectionResolver` resolved credentials for the polling job
- Assert connector trigger's `run()` was called with decrypted credentials
- Assert new items dispatched to workflow spy
- Assert cursor updated in `connector_kv_store`
- Wait for second poll — assert cursor-based pagination (only new items)

  3.3. Fix the known tenant isolation bug in `apps/search-ai/src/routes/webhooks.ts` L71:

- Change `ConnectorConfig.findOne({ _id: connectorId })` to `ConnectorConfig.findOne({ _id: connectorId, tenantId })`
- This is the production code fix that INT-8 will verify (also planned in the architecture convergence LLD Phase 1 task 1.3)

  3.4. Implement `webhook-tenant-isolation.integration.test.ts` (INT-8) in `apps/search-ai/`:

- Create `connector_config` for Tenant A and Tenant B
- POST webhook notification for Tenant A's config — assert processed
- POST webhook notification with Tenant B's config ID using Tenant A's context — assert rejected
- Verify query includes `{ _id: connectorId, tenantId }`

**Files Touched**:

- `packages/connectors/src/__tests__/integration/webhook-dispatch.integration.test.ts` — NEW
- `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts` — NEW
- `apps/search-ai/src/routes/webhooks.ts` — MODIFIED (add `tenantId` to `ConnectorConfig.findOne` query at L71)
- `apps/search-ai/src/__tests__/integration/webhook-tenant-isolation.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] INT-3: Webhook processing chain works with real Redis dedup and real MongoDB state
- [ ] INT-3: Duplicate event ID is dropped (no second dispatch)
- [ ] PERF-3: Two concurrent webhook POSTs with same event ID result in exactly one dispatch
- [ ] INT-7: Trigger auto-pauses after 10 consecutive errors
- [ ] INT-4: Polling trigger fires, resolves credentials, persists cursor, paginates on second poll
- [ ] INT-8: Cross-tenant webhook hijacking is blocked at query level
- [ ] SearchAI `webhooks.ts` L71 includes `tenantId` in query filter (production fix)
- [ ] All new test files pass
- [ ] All existing tests + Phase 1-2 tests continue passing

**Test Strategy**:

- INT-3 + INT-7 + PERF-3: Real MongoDB, real Redis, workflow dispatch spy (DI-injected `RestateIngressClient`)
- INT-4: Real MongoDB, real Redis (BullMQ), real encryption, fake provider
- INT-8: Real MongoDB (SearchAI dual-connection setup), real connector config model

**Rollback**: Revert `webhooks.ts` tenant isolation fix. Delete test files.

---

### Phase 4: E2E Tests — Connection CRUD + OAuth (E2E-1, E2E-4, E2E-6)

**Goal**: Implement true E2E tests for connection CRUD lifecycle, OAuth flow, and tenant/project isolation through the runtime HTTP API with full middleware chain.

**Tasks**:

4.0. Create runtime connection CRUD routes in `apps/runtime/src/routes/connections.ts` (addresses HLD GAP-002):

- Runtime currently has ZERO connection routes — verified by filesystem inspection
- Create thin Express route handlers that delegate to `ConnectionService` from `packages/connectors`:
  - `GET /api/projects/:projectId/connections` → `ConnectionService.list(tenantId, projectId)`
  - `POST /api/projects/:projectId/connections` → `ConnectionService.create(tenantId, projectId, input)`
  - `GET /api/projects/:projectId/connections/:id` → `ConnectionService.getById(tenantId, projectId, id)`
  - `PUT /api/projects/:projectId/connections/:id` → `ConnectionService.update(tenantId, projectId, id, input)`
  - `DELETE /api/projects/:projectId/connections/:id` → `ConnectionService.delete(tenantId, projectId, id)`
  - `POST /api/projects/:projectId/connections/:id/test` → `ConnectionService.test(tenantId, projectId, id)`
- Auth: `requireProjectPermission('connection:read')` for GET, `requireProjectPermission('connection:write')` for POST/PUT, `requireProjectPermission('connection:delete')` for DELETE (singular `connection:` per `apps/studio/src/lib/permissions.ts`)
- Zod validation: `CreateConnectionSchema` and `UpdateConnectionSchema` for request bodies, `z.string().min(1)` for `projectId` and `id` params
- Static route ordering: register `/:id/test` BEFORE `/:id` to prevent param capture
- Standard error envelope responses: `{ success: true/false, data/error: { code, message } }`
- Also add OAuth initiate/callback routes if needed for E2E-4, or test OAuth through Studio proxy
- Register routes in `apps/runtime/src/server.ts` via `app.use('/api/projects/:projectId/connections', connectionsRouter)` (runtime has no routes/index.ts — routes are mounted directly in server.ts)

  4.1. Create `apps/runtime/src/__tests__/helpers/connector-e2e-bootstrap.ts`:

- Wraps `RuntimeApiHarness` with connector-specific setup
- Starts `RedisServerHarness` for distributed locks
- Starts `OAuthServerHarness` and `ProviderServerHarness` from shared fixtures
- Registers `test-connector` in `ConnectorRegistry` during bootstrap
- Mounts connection CRUD routes + OAuth routes + trigger routes on the Express app
- Provides `bootstrapProject()` for tenant/project/user provisioning
- Provides `createConnection()` convenience method
- Provides `createCrossTenantContext()` for isolation tests

  4.2. Implement `connector-connection-crud.e2e.test.ts` (E2E-1 + E2E-6):

- E2E-1: Full CRUD lifecycle via HTTP API (create → list → get → update → test → delete)
- Assert credentials redacted in all read responses
- Assert connection test endpoint returns structured result
- Assert DELETE followed by GET returns 404
- E2E-6: Create connection as Tenant A, Project P1
- GET as Tenant B → 404 (not 403)
- GET as Tenant A, Project P2 → 404
- PUT/DELETE as Tenant B → 404
- No auth token → 401
- Missing permission → 403

  4.3. Implement `connector-oauth-flow.e2e.test.ts` (E2E-4):

- POST oauth/initiate → assert redirect URL to fake OAuth provider
- POST oauth/callback with auth code → assert connection created with `authType: 'oauth2'`
- GET connection → assert OAuth metadata present, tokens redacted
- Configure fake OAuth to return expired token
- Execute connector tool action → assert fake OAuth received refresh request
- Assert tool action succeeds with refreshed token
- GET connection → assert `oauth2TokenExpiresAt` updated

**Files Touched**:

- `apps/runtime/src/routes/connections.ts` — NEW (thin Express route handlers delegating to ConnectionService)
- `apps/runtime/src/server.ts` — MODIFIED (mount connection routes via `app.use()`)
- `apps/runtime/src/__tests__/helpers/connector-e2e-bootstrap.ts` — NEW
- `apps/runtime/src/__tests__/connector-connection-crud.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/connector-oauth-flow.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/integration/auth-profile-connector-setup.test.ts` — DELETED (superseded by E2E-4)

**Exit Criteria**:

- [ ] E2E-1: Full CRUD lifecycle works through real HTTP API with encrypted storage and redacted reads
- [ ] E2E-4: OAuth flow from initiation through callback, token storage, and automatic refresh
- [ ] E2E-6: Cross-tenant returns 404, cross-project returns 404, no auth returns 401, wrong permission returns 403
- [ ] All E2E tests start real Express server with full middleware chain (auth, rate limiting, tenant isolation)
- [ ] No `vi.mock()` or `jest.mock()` in any E2E test file
- [ ] No direct Mongoose model imports in E2E tests (API-only interaction)
- [ ] All existing tests + Phase 1-3 tests continue passing

**Test Strategy**:

- E2E: Real Express (port 0), real MongoDB, real Redis, real encryption, real auth middleware
- External stubs: Fake OAuth server (DI), fake provider server (DI)
- Auth: Real JWT tokens created via `bootstrapProject()`

**Rollback**: Delete test files and connector-e2e-bootstrap. If runtime routes were added, they can remain (they're thin, useful beyond tests).

---

### Phase 5: E2E Tests — Triggers + Tool Execution (E2E-2, E2E-3, E2E-7, E2E-8)

**Goal**: Implement E2E tests for connector tool execution through agent sessions, trigger lifecycle, user/tenant scope resolution, and webhook security.

**Tasks**:

5.1. Implement `connector-trigger-lifecycle.e2e.test.ts` (E2E-3 + E2E-8):

- Note: Trigger routes use `workflow:read`/`workflow:write` permissions (not `triggers:read,write` as the test spec says — the codebase has no trigger-specific permissions)

- E2E-3: Create trigger registration via HTTP API
- Assert webhook URL returned
- POST signed webhook payload → assert workflow dispatch spy called
- Assert `lastFiredAt` updated
- Pause trigger → POST webhook → assert dropped
- Resume trigger → POST webhook → assert processed
- Delete trigger → assert removed
- E2E-8: POST with invalid signature → rejected
- POST same event ID → dropped (dedup)
- POST with missing/expired timestamp → rejected (replay protection)
- Wait for dedup TTL → POST same event ID → processed again

  5.2. Implement `connector-tool-execution.e2e.test.ts` (E2E-2 + E2E-7):

- E2E-2: Create connection with API key
- Deploy minimal agent with `test-connector.echo` tool bound (via project I/O import + deployment API)
- Create session, send message triggering tool invocation
- Assert fake provider received decrypted API key
- Assert session response contains echo result
- Note: TraceEvent verification for connector tool execution is deferred — `packages/connectors/src/` does not emit TraceEvents directly; tracing is handled by the runtime's shared tool pipeline wrapper. Verify trace via session history or runtime trace API if available.
- E2E-7: Create tenant-scoped connection (`{ apiKey: 'tenant-key' }`)
- Create user-scoped connection for User U1 (`{ apiKey: 'user-key' }`)
- Execute tool as U1 → assert fake provider receives `user-key`
- Execute tool as U2 → assert fake provider receives `tenant-key` (fallback)
- Delete user-scoped connection → execute as U1 → assert `tenant-key` (fallback)

**Files Touched**:

- `apps/runtime/src/__tests__/connector-trigger-lifecycle.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/connector-tool-execution.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] E2E-3: Full trigger lifecycle from creation through webhook processing to deletion
- [ ] E2E-8: Invalid signatures rejected, replay protection enforced, dedup works with TTL expiry
- [ ] E2E-2: Connector tool executes through real agent session pipeline with credential decryption
- [ ] E2E-7: User-scoped precedence verified; tenant-scoped fallback verified
- [ ] No `vi.mock()` or `jest.mock()` in any E2E test file
- [ ] All existing tests + Phase 1-4 tests continue passing

**Test Strategy**:

- E2E: Real Express, real MongoDB, real Redis, real auth, full middleware chain
- E2E-2: Requires real `RuntimeExecutor` + `ConnectorToolExecutor` in the pipeline — verify compiler support for `tool_type: connector` or use direct tool definition seeding
- External stubs: `RestateIngressClient` spy (DI), fake provider server, fake OAuth server

**Rollback**: Delete test files. No production code changed.

---

### Phase 6: E2E Tests — SearchAI Enterprise Sync (E2E-5)

**Goal**: Implement the SearchAI enterprise connector E2E test covering discovery-to-sync lifecycle.

**Tasks**:

6.1. Implement `connector-discovery-sync.e2e.test.ts` (E2E-5):

- Start SearchAI Express app with real connector routes (mount `connectorRouter`, `connectorDiscoveryRouter` only — avoids ClickHouse dependency), real MongoDB (dual-connection), real encryption
- Register fake enterprise connector that mimics SharePoint responses
- POST `/api/search-ai/connectors/:connectorId/auth/initiate` — start auth
- Complete auth flow via fake provider
- POST `/api/search-ai/connectors/:connectorId/discover` — run discovery
- Assert discovery results returned (sites, drives from fake provider)
- GET `/api/search-ai/connectors/:connectorId/discovery` — verify discovery record persisted with resources and content profiles
- POST `/api/search-ai/connectors/:connectorId/recommendations` — request AI-generated sync recommendation
- POST `/api/search-ai/connectors/:connectorId/recommendations/:recId/accept` — accept the recommendation
- POST `/api/search-ai/connectors/:connectorId/sync/start` — start full sync
- GET `/api/search-ai/connectors/:connectorId/sync/status` — verify sync in progress with checkpoint data
- Simulate sync completion via fake provider returning all pages
- Assert sync state updated with `lastFullSyncAt`, checkpoint cleared

  6.2. Delete `apps/search-ai/src/__tests__/e2e/connectors.e2e.test.ts` (the mock-based "E2E")

**Files Touched**:

- `apps/search-ai/src/__tests__/e2e/connector-discovery-sync.e2e.test.ts` — NEW
- `apps/search-ai/src/__tests__/e2e/connectors.e2e.test.ts` — DELETED

**Exit Criteria**:

- [ ] E2E-5: Enterprise connector flow from discovery through recommendation acceptance through sync with checkpoint persistence
- [ ] Cross-tenant discovery returns 404 (add a cross-tenant test step: create second tenant, attempt discover with wrong tenantId)
- [ ] No `vi.mock()` or `jest.mock()` in the E2E test file
- [ ] Old mock-based E2E test is removed
- [ ] All existing tests + Phase 1-5 tests continue passing

**Test Strategy**:

- E2E: SearchAI real Express app, dual-connection MongoMemoryServer, real encryption
- External stubs: Fake Graph API server (mimics SharePoint discovery, item listing, delta queries)
- BullMQ: Real queues for sync worker orchestration (real Redis)

**Rollback**: Restore `connectors.e2e.test.ts` from git. Delete new E2E file.

---

### Phase 7: Fix Skipped Tests

**Goal**: Re-enable and fix all ~47 skipped/disabled individual test cases across 5 files in the SharePoint connector package plus the token manager base test. (18 refers to skip blocks/groups; actual individual `it`/`test` cases total ~47.)

**Tasks**:

7.1. Fix 10 `it.skip` tests in `packages/connectors/sharepoint/src/__tests__/full-sync-coordinator.test.ts`:

- Read test descriptions, identify why they were skipped (likely `BaseSyncCoordinator` refactor)
- Update mocks/fixtures to match current `FullSyncCoordinator` API
- Un-skip all 10 tests, verify they pass

  7.2. Fix 5 `test.skip` tests in `packages/connectors/sharepoint/src/__tests__/sync-permission-integration.test.ts`:

- Read test descriptions: simplified crawl, full crawl, disabled crawl, failure resilience, delta sync crawl
- Update vi.mock targets if module paths changed
- Un-skip all 5 tests, verify they pass

  7.3. Fix 1 `it.skip` in `packages/connectors/sharepoint/src/__tests__/integration/sync-flow.integration.test.ts`:

- Error propagation from `getDriveItemsRecursive`
- Likely needs updated mock or assertion

  7.4. Un-skip `packages/connectors/sharepoint/src/__tests__/integration/oauth-flow.integration.test.ts`:

- Entire `describe.skip` with TODO "Fix OAuth flow integration tests"
- Fix `MicrosoftOAuthProvider` + `DeviceCodeFlowAuthenticator` integration
- Update mock fetch patterns if provider API changed

  7.5. Rename `packages/connectors/base/src/__tests__/token-manager.test.ts.skip` → `.test.ts`:

- Fix `TokenManager` OAuth lifecycle tests (storage, refresh, expiry)
- Update mock DB imports and `IOAuthProvider` interface

**Files Touched**:

- `packages/connectors/sharepoint/src/__tests__/full-sync-coordinator.test.ts` — un-skip 10 tests
- `packages/connectors/sharepoint/src/__tests__/sync-permission-integration.test.ts` — un-skip 5 tests
- `packages/connectors/sharepoint/src/__tests__/integration/sync-flow.integration.test.ts` — un-skip 1 test
- `packages/connectors/sharepoint/src/__tests__/integration/oauth-flow.integration.test.ts` — un-skip entire file
- `packages/connectors/base/src/__tests__/token-manager.test.ts.skip` → `token-manager.test.ts` — rename + fix

**Exit Criteria**:

- [ ] All 10 previously skipped `full-sync-coordinator` tests pass
- [ ] All 5 previously skipped `sync-permission-integration` tests pass
- [ ] The 1 previously skipped `sync-flow.integration` test passes
- [ ] All tests in `oauth-flow.integration.test.ts` pass (no longer `describe.skip`)
- [ ] `token-manager.test.ts` exists (not `.skip`) and all tests pass
- [ ] Total new passing tests from this phase: ~47 individual test cases across 5 files
- [ ] All existing tests continue passing

**Test Strategy**:

- Fix each test incrementally: read current source, identify mismatch, update test
- Run file-level `pnpm vitest run <file>` after each fix to verify

**Rollback**: Re-skip any test that can't be fixed without production code changes. Log as an issue.

---

### Phase 7b: Test Spec + Doc Sync

**Goal**: Update the test spec to reflect actual file placements, fixture shapes, and coverage status.

**Tasks**:

7b.1. Update `docs/testing/connectors.md` section 8 "New Test Files" file paths to match LLD placements (studio → runtime for E2E-1/E2E-4/E2E-6)

7b.2. Update `docs/testing/connectors.md` section 7 "Test Connector Fixture" code block to use correct `ConnectorAuthField` shape (`name`, `displayName`, `required`, `sensitive` — not `type: 'string'`)

7b.3. Update `docs/testing/connectors.md` section 1 "Coverage Matrix" — change "Planned" to "PASS" for all implemented scenarios

7b.4. Update `docs/testing/connectors.md` E2E-3 auth context to use `workflow:read,write` (not `triggers:read,write`)

7b.5. Note in HLD `docs/specs/connectors.hld.md` section 6 that runtime connection routes use singular `connection:read`/`connection:write`/`connection:delete` per `apps/studio/src/lib/permissions.ts` (HLD currently uses plural `connections:read/write`)

**Files Touched**:

- `docs/testing/connectors.md` — update file paths, fixture code, coverage matrix, permissions
- `docs/specs/connectors.hld.md` — update permission strings in API table

**Exit Criteria**:

- [ ] Test spec section 8 file paths match actual file locations
- [ ] Test spec fixture code uses correct `ConnectorAuthField` interface
- [ ] Coverage matrix shows PASS for all implemented scenarios
- [ ] No stale "Planned" statuses for scenarios that have passing tests

**Rollback**: Revert doc changes via git.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

### Phase 0 — Test Fixtures

- [ ] `test-connector.ts` exports `registerTestConnector(registry)` function
- [ ] `oauth-server-harness.ts` exports `startOAuthServerHarness()` returning `OAuthServerHarness`
- [ ] `provider-server-harness.ts` exports `startProviderServerHarness()` returning `ProviderServerHarness`
- [ ] `setup-mongo.ts` exports `setupIntegrationContext()` and `teardownIntegrationContext()`
- [ ] All fixtures use `express` on random port (`{ port: 0 }`) — no hardcoded ports

### Phase 4 — E2E Bootstrap

- [ ] `connector-e2e-bootstrap.ts` imports from `runtime-api-harness.ts`, `redis-server-harness.ts`, and shared fixtures
- [ ] Connector routes (connections, OAuth, triggers) mounted on the RuntimeApiHarness Express app
- [ ] `test-connector` registered in `ConnectorRegistry` singleton during bootstrap
- [ ] `OAuthServerHarness` URL configured as the OAuth provider URL in test env
- [ ] `ProviderServerHarness` URL configured as the connector action endpoint

### Phase 6 — SearchAI E2E

- [ ] SearchAI test uses `apps/search-ai/src/__tests__/helpers/setup-mongo.ts` for dual-connection MongoDB
- [ ] Fake Graph API server registered for SharePoint connector discovery/sync
- [ ] BullMQ workers started with test Redis URL

### Runtime Connection Routes (Phase 4)

- [ ] Routes registered in `apps/runtime/src/server.ts` via `app.use()`
- [ ] Routes use `requireProjectPermission('connection:read')` for GET, `requireProjectPermission('connection:write')` for POST/PUT, `requireProjectPermission('connection:delete')` for DELETE (singular `connection:` per `apps/studio/src/lib/permissions.ts`)
- [ ] Routes delegate to `ConnectionService` from `packages/connectors`
- [ ] Zod schemas validate request bodies (`CreateConnectionSchema`, `UpdateConnectionSchema`) and ID params (`z.string().min(1)`)
- [ ] Static route `/:id/test` registered BEFORE `/:id` to prevent param capture
- [ ] Error responses use standard envelope: `{ success: true/false, data/error: { code, message } }`
- [ ] Routes use `createUnifiedAuthMiddleware` for auth

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This LLD is test-only — no production schema changes.

### Feature Flags

None. Tests operate against the current production API surface.

### Configuration Changes

| Phase | Change                               | Scope     |
| ----- | ------------------------------------ | --------- |
| 0     | Redis service in CI workflow         | CI only   |
| 0     | MongoMemoryServer binary cache in CI | CI only   |
| 0     | `ENCRYPTION_MASTER_KEY` in test env  | Test only |

### Test Infrastructure Dependencies

| Dependency          | Required By        | Source                                                      |
| ------------------- | ------------------ | ----------------------------------------------------------- |
| MongoMemoryServer   | All phases         | Already in `devDependencies`, proven in runtime + search-ai |
| redis-server binary | Phase 2-6          | `redis-server-harness.ts` spawns subprocess                 |
| ioredis             | Phase 2-6          | Already in `dependencies`                                   |
| BullMQ              | Phase 3 (INT-4)    | Already in `dependencies`                                   |
| express             | Phase 0 (fixtures) | Already in `dependencies`                                   |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 7 phases complete with exit criteria met
- [ ] 8 new integration test files passing (INT-1 through INT-9 minus overlap)
- [ ] 5 new E2E test files passing (E2E-1 through E2E-8, grouped)
- [ ] 18 previously skipped tests re-enabled and passing
- [ ] Mock-based `connectors.e2e.test.ts` in SearchAI replaced with real E2E
- [ ] Zero `vi.mock()` or `jest.mock()` in any E2E test file
- [ ] Zero direct Mongoose model imports in any E2E test file
- [ ] All E2E tests start real Express servers with full middleware chain
- [ ] CI pipeline runs all new tests (Redis service available, MongoDB binary cached)
- [ ] No regressions in any existing test files across the entire monorepo
- [ ] `pnpm build && pnpm test` passes
- [ ] Test spec `docs/testing/connectors.md` coverage matrix updated from "Planned" to "PASS"
- [ ] Test spec section 8 file paths updated to match LLD file placements (studio → runtime for E2E-1/E2E-4/E2E-6)
- [ ] Test spec section 7 fixture code updated to use correct `ConnectorAuthField` shape (name, displayName, required, sensitive)

---

## 7. Open Questions

1. **RESOLVED — Runtime connection routes do not exist.** Verified: `apps/runtime/src/routes/` has zero connection-related files. Phase 4 includes task 4.0 to create thin Express route handlers in `apps/runtime/src/routes/connections.ts` that delegate to `ConnectionService`. This also addresses HLD GAP-002 (non-Studio CRUD API).

2. **Compiler support for `tool_type: connector`**: Can E2E-2 (tool execution through agent session) use DSL import to bind connector tools, or does the compiler not yet support `tool_type: connector` in DSL? If not, the test may need to seed tool definitions directly via API. **Mitigation**: Read `packages/connectors/src/compiler/connector-to-tool.ts` during Phase 5 implementation. If DSL import doesn't support connector tool binding, seed tool definitions via the tool API or direct `ConnectorToolExecutor` invocation with a mocked tool resolution.

3. **SearchAI E2E test isolation**: Can SearchAI's Express app be started without ClickHouse? The connector routes don't touch ClickHouse, but the server startup might require it. **Mitigation**: Mount only the connector-specific routes (`connectorRouter`, `connectorDiscoveryRouter`) on a test Express app rather than starting the full SearchAI server. This avoids ClickHouse dependency entirely.
