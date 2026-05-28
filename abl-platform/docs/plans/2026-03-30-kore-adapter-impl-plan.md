# LLD: Kore SmartAssist Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/kore-adapter.md`
**HLD**: `docs/specs/kore-adapter.hld.md`
**Test Spec**: `docs/testing/sub-features/kore-adapter.md`
**Status**: DRAFT
**Date**: 2026-03-30

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                           | Rationale                                                                                                                                                                                                                                                                               | Alternatives Rejected                                                                            |
| ---- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D-1  | Test infrastructure first, code changes last                                       | Tests are STABLE promotion bottleneck. GAP-008 code change is ~5 lines. Build test harness first so all phases can validate.                                                                                                                                                            | Code-first would delay test validation                                                           |
| D-2  | E2E tests live in `apps/runtime/src/__tests__/`                                    | Express is NOT a dependency of `packages/agent-transfer` (per agents.md). E2E tests need real Express with webhook route.                                                                                                                                                               | Package-level E2E would require adding Express dependency                                        |
| D-3  | Integration tests live in `packages/agent-transfer/src/__tests__/`                 | Integration tests use DI-injected mocks for SmartAssistClient. No Express needed.                                                                                                                                                                                                       | Runtime-level would add unnecessary coupling                                                     |
| D-4  | SmartAssist mocked only via DI constructor injection                               | Per test spec D-1. No `vi.mock()` for codebase components. SmartAssistClient takes `fetchFn` or pool via constructor.                                                                                                                                                                   | `vi.mock()` would violate E2E standards                                                          |
| D-5  | GAP-008: Config snapshot in `execute()` (HLD Option A)                             | ~5 line change. Captures `const config = { ...this.smartAssistConfig }` at execute entry. Validated by INT-13.                                                                                                                                                                          | Per-execution clone (Option B) deferred                                                          |
| D-6  | In-memory `TransferSessionStoreHandle` for integration tests                       | Per agents.md learnings. `_sessions` Map, `_providerIndex` Map, JSON-stringified `providerData`/`metadata`.                                                                                                                                                                             | Real Redis for all integration tests                                                             |
| D-7  | Real Redis for E2E and session-specific integration tests                          | INT-8/INT-9 and all E2E scenarios require real Redis for atomic Lua script validation.                                                                                                                                                                                                  | In-memory would miss Lua script bugs                                                             |
| D-8  | Extend existing `mock-smartassist.ts` instead of creating new file                 | `packages/agent-transfer/src/__tests__/helpers/mock-smartassist.ts` already exists with 6 of 9 methods. Add the 3 missing methods (`getAccountIdByBotId`, `createSyntheticUser`, `sendEvent`) to avoid parallel factories.                                                              | Creating a new `mock-smartassist-client.ts` would cause confusion with two overlapping factories |
| D-9  | INT-5 (webhook pipeline) lives in `apps/runtime/` not `packages/agent-transfer/`   | INT-5 needs Express/HTTP server. Per agents.md, Express is NOT available in `packages/agent-transfer`. Move to runtime tests.                                                                                                                                                           | Using `node:http` in package would be fragile for webhook route testing                          |
| D-10 | E2E-4 auth: Use `X-Tenant-Id` / `X-Project-Id` headers with mocked auth middleware | Existing `agent-transfer-routes-authz.test.ts` uses `vi.mock('../../middleware/auth.js')` but E2E tests cannot use `vi.mock`. For E2E-4, bypass auth by setting headers that the real auth middleware accepts in test mode, or create a test-auth middleware that trusts these headers. | Test token generator (more complex), skip auth entirely (insufficient coverage)                  |
| D-11 | INT-1 retry observation via Pool.request call count, not private method spying     | Count HTTP requests made (1 = no retry, 3 = retried) instead of spying on private `executeRequest`/`executeWithRetry`.                                                                                                                                                                  | Private method spying is fragile and requires type casting                                       |

### Key Interfaces & Types

No new interfaces. The implementation modifies existing code and adds test files. Key existing interfaces used:

```typescript
// packages/agent-transfer/src/adapters/kore/index.ts
export interface TransferSessionStoreHandle {
  create(params: { tenantId, contactId, channel, provider, providerSessionId?, agentId, providerData?, metadata? }): Promise<{ success: boolean; sessionKey?: string; error?: { code: string; message: string } }>;
  get(key: string): Promise<Record<string, string> | null>;
  end(sessionKey: string): Promise<void>;
  extendTTL(sessionKey: string): Promise<void>;
  getByProvider(provider: string, tenantId: string, providerSessionId: string): Promise<Record<string, string> | null>;
  addProviderAlias?(provider: string, aliasTenantId: string, providerSessionId: string, sessionKey: string, ttl?: number): Promise<void>;
}

// packages/agent-transfer/src/adapters/kore/smartassist-client.ts
export class SmartAssistClient {
  constructor(config: SmartAssistConfig, circuitBreaker?: CircuitBreakerHandle) { ... }
  // 9 public methods: checkBusinessHours, checkAgentAvailability, validateQueue,
  // createSyntheticUser, getAccountIdByBotId, initTransfer, sendEvent, updateTransfer, close
}
```

### Module Boundaries

| Module                          | Responsibility                                  | Depends On                                       |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `KoreAdapter`                   | Orchestrates full transfer lifecycle            | SmartAssistClient, TransferSessionStoreHandle    |
| `SmartAssistClient`             | HTTP communication with SmartAssist/KoreServer  | undici.Pool, CircuitBreaker, SSRF guard          |
| `KoreEventHandler`              | XO event type mapping and handler dispatch      | None (pure functions + handler list)             |
| `TransferSessionStore`          | Redis session CRUD with atomic Lua scripts      | ioredis                                          |
| `Webhook Route`                 | HTTP endpoint for inbound SmartAssist events    | AdapterRegistry, SessionStore, EventHandler      |
| `routing-executor`              | Wires adapter initialization and orgId callback | AdapterRegistry, ConnectorConnection, encryption |
| `CheckHoursTool / SetQueueTool` | ABL tools for agent-controlled pre-checks       | SmartAssistClient                                |
| `MessageBridge`                 | Routes agent events to user channels            | WebSocket sessions, channel adapters             |

---

## 2. File-Level Change Map

### New Files

| File                                                                                   | Purpose                                                            | LOC Estimate |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| `apps/runtime/src/__tests__/integration/kore-webhook-pipeline.test.ts`                 | INT-5: webhook route → event handler → session store pipeline      | ~180         |
| `apps/runtime/src/__tests__/integration/kore-routing-executor.test.ts`                 | INT-6: routing executor → adapter registry → connection            | ~150         |
| `packages/agent-transfer/src/__tests__/helpers/mock-session-store.ts`                  | In-memory TransferSessionStoreHandle                               | ~100         |
| `packages/agent-transfer/src/__tests__/helpers/test-redis.ts`                          | Redis connection helper with test prefix isolation                 | ~60          |
| `packages/agent-transfer/src/__tests__/integration/kore-smartassist-retry.test.ts`     | INT-1: SmartAssistClient retry vs non-retry behavior               | ~130         |
| `packages/agent-transfer/src/__tests__/integration/kore-execute-flow.test.ts`          | INT-2: KoreAdapter execute() full flow ordering                    | ~150         |
| `apps/runtime/src/__tests__/integration/kore-message-bridge.test.ts`                   | INT-7: message bridge agent→user routing (runtime scope)           | ~120         |
| `packages/agent-transfer/src/__tests__/integration/kore-orgid-resolution.test.ts`      | INT-12: lazy orgId fetch, cache, persist                           | ~150         |
| `packages/agent-transfer/src/__tests__/integration/kore-singleton-isolation.test.ts`   | INT-13: GAP-008 no stale orgId leak                                | ~100         |
| `packages/agent-transfer/src/__tests__/integration/kore-precheck-flow.test.ts`         | INT-11: pre-check business hours, queue, availability              | ~150         |
| `packages/agent-transfer/src/__tests__/integration/kore-credential-resolution.test.ts` | INT-3: credential selection and payload assembly                   | ~180         |
| `packages/agent-transfer/src/__tests__/integration/kore-provider-alias.test.ts`        | INT-4: provider alias index lifecycle                              | ~130         |
| `packages/agent-transfer/src/__tests__/integration/kore-session-atomicity.test.ts`     | INT-8: concurrent end + extend TTL                                 | ~120         |
| `packages/agent-transfer/src/__tests__/integration/kore-session-ttl.test.ts`           | INT-9: TTL expiry and channel-specific behavior                    | ~100         |
| `packages/agent-transfer/src/__tests__/integration/kore-tools.test.ts`                 | INT-10: check-hours and set-queue via tool executor                | ~130         |
| `packages/agent-transfer/src/__tests__/unit/kore-orgid-unit.test.ts`                   | UT-1, UT-2, UT-3: getAccountIdByBotId, syntheticUser, resolveOrgId | ~200         |
| `packages/agent-transfer/src/__tests__/unit/kore-channel-mapping.test.ts`              | UT-4: channel→source and channel→conversationType mapping          | ~80          |
| `packages/agent-transfer/src/__tests__/unit/kore-tools-unit.test.ts`                   | UT-5: check-hours and set-queue unit tests                         | ~100         |
| `apps/runtime/src/__tests__/e2e/kore-webhook.e2e.test.ts`                              | E2E-1,2,3,5,6,7: webhook pipeline E2E tests                        | ~650         |
| `apps/runtime/src/__tests__/e2e/kore-session-mgmt.e2e.test.ts`                         | E2E-4: session management list/end via HTTP                        | ~200         |
| `apps/runtime/src/__tests__/e2e/helpers/kore-e2e-harness.ts`                           | E2E Express server factory with real boot service wiring           | ~200         |

### Modified Files

| File                                                                           | Change Description                                                          | Risk |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---- |
| `packages/agent-transfer/src/adapters/kore/index.ts`                           | GAP-008: config snapshot in `execute()` (~5 lines)                          | Low  |
| `packages/agent-transfer/src/__tests__/helpers/mock-smartassist.ts`            | Add 3 missing methods (getAccountIdByBotId, createSyntheticUser, sendEvent) | Low  |
| `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts` | UT-6: extend with structured content tests if needed                        | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Prerequisites

**Before starting Phase 1**, the 22 modified source files currently on the `kore-adapter-enhancements` branch must be committed as a baseline. Implementation phases assume a clean working tree.

### Phase 1: Test Infrastructure

**Goal**: Create shared test helpers that all subsequent phases depend on.

**Tasks**:

1.1. Extend existing `mock-smartassist.ts` — add the 3 missing methods (`getAccountIdByBotId`, `createSyntheticUser`, `sendEvent`) to the existing factory at `packages/agent-transfer/src/__tests__/helpers/mock-smartassist.ts`. Update `MockSmartAssistClient` interface to include all 9 methods. Update `createMockSmartAssistClient()` options to support orgId resolution and synthetic user defaults. **Do NOT create a new file** — extend the existing one per D-8. Note: SSRF guard blocks `localhost` URLs — use URL-rewriting `fetchFn` pattern from agents.md when creating real SmartAssistClient instances in integration tests.

1.2. Create `mock-session-store.ts` — extract and generalize the existing in-memory `TransferSessionStoreHandle` from `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts:17-63`. Add missing `addProviderAlias` method. Include `agentId` in `create()` params. **Important**: `extendTTL` must implement the **concrete** store signature `(key: string, ttl?: number, channel?: string): Promise<boolean>` (not the narrower interface `(sessionKey: string): Promise<void>`), since INT-8 and INT-9 call with 3 args and check the boolean return. Update the Five9 test file to import from this shared helper instead of defining its own copy.

1.3. Create `test-redis.ts` — thin wrapper for `packages/agent-transfer` integration tests that need Redis. Uses DB-level isolation (matching `apps/runtime/src/__tests__/helpers/redis-server-harness.ts` pattern) rather than key-prefix scanning. E2E tests in `apps/runtime/` should use the existing `redis-server-harness.ts` directly. Gated by `AGENT_TRANSFER_E2E=1` describe skip.

1.4. Create `kore-e2e-harness.ts` — Express server factory for E2E tests. Initializes real `TransferSessionStore` with real Redis, creates real `KoreAdapter` with DI-injected mock `SmartAssistClient`, registers in real `AdapterRegistry`, wires `MessageBridge` with capture callback, mounts webhook route. Returns `{ app, server, port, cleanup, bridge, store, adapter }`. Uses `app.listen(0)` for random port.

**Files Touched**:

- `packages/agent-transfer/src/__tests__/helpers/mock-smartassist.ts` — modify (extend with 3 missing methods per D-8)
- `packages/agent-transfer/src/__tests__/helpers/mock-session-store.ts` — new
- `packages/agent-transfer/src/__tests__/helpers/test-redis.ts` — new
- `apps/runtime/src/__tests__/e2e/helpers/kore-e2e-harness.ts` — new

**Exit Criteria**:

- [ ] `mock-smartassist.ts` exports updated factory with all 9 SmartAssistClient methods (6 existing + 3 new: getAccountIdByBotId, createSyntheticUser, sendEvent)
- [ ] `mock-session-store.ts` exports `createInMemorySessionStore()` implementing `TransferSessionStoreHandle` with `create`, `get`, `end`, `extendTTL`, `getByProvider`, `addProviderAlias`
- [ ] `test-redis.ts` exports `createTestRedis()` and `cleanupTestKeys(prefix)` — `pnpm build --filter=@agent-platform/agent-transfer` succeeds
- [ ] `kore-e2e-harness.ts` exports `createKoreE2EHarness()` returning server on random port — server starts and responds to health probe
- [ ] All helpers have TypeScript types (no `any`)

**Test Strategy**:

- Unit: Each helper has a smoke test (`describe('mock-smartassist-client', () => { it('creates all methods', ...) })`)
- Integration: `kore-e2e-harness.ts` validated in Phase 4 by actual E2E tests

**Rollback**: Delete new files. No production code modified.

---

### Phase 2: Integration Tests

**Goal**: Implement all 13 integration test scenarios from the test spec.

**Tasks**:

2.1. Implement INT-1 in `packages/agent-transfer/src/__tests__/integration/kore-smartassist-retry.test.ts` (new file): SmartAssistClient initTransfer non-retryable vs retryable operations. Observe retry behavior via Pool.request call count (per D-11), not private method spying.

2.2. Implement INT-2 in `packages/agent-transfer/src/__tests__/integration/kore-execute-flow.test.ts` (new file): KoreAdapter `execute()` full flow ordering with DI mock client. Verify call order: resolveOrgId → prechecks → syntheticUser → initTransfer. Verify pre-check failure short-circuits.

2.3. Implement INT-3: SmartAssistClient credential resolution — `koreApiKey` vs `apiKey` selection, `metaInfo.abl` embedding, `LANGUAGE_MAP` application, `updateTransfer` delegation.

2.4. Implement INT-4: Provider alias index lifecycle — create with orgId alias, lookup by both paths, atomic cleanup on end. Uses real Redis (test-redis helper).

2.5. Implement INT-5 in `apps/runtime/src/__tests__/integration/kore-webhook-pipeline.test.ts` (per D-9 — requires Express): Webhook route → event handler → session store pipeline. Uses in-memory session store and real Express (minimal setup, not full E2E server).

2.6. Implement INT-6: Routing executor → adapter registry → connection resolution. Mock adapter registry, mock ConnectorConnection. Verify orgId persistence callback wiring.

2.7. Implement INT-7 in `apps/runtime/src/__tests__/integration/kore-message-bridge.test.ts` (new file — MessageBridge lives in `apps/runtime/src/services/agent-transfer/message-bridge.ts`): Message bridge — agent→user WebSocket routing. Verify send, typing, and graceful missing WebSocket handling.

2.8. Implement INT-8: Session atomicity — concurrent end + extend TTL with real Redis. Run 10 iterations to verify no race condition flakiness.

2.9. Implement INT-9: Session TTL expiry — chat session with 2s TTL, voice session with infinite TTL. Uses real Redis.

2.10. Implement INT-10: ABL tools — check-hours and set-queue via DI-injected mock SmartAssistClient. Verify delegation, error handling, and structured results.

2.11. Implement INT-11: Pre-check flow — business hours, queue validation, agent availability. Verify short-circuit on failure, queue-presence routing logic.

2.12. Implement INT-12: Lazy orgId resolution — fetch, cache, persist via callback. Verify skip when orgId present, fallback on failure.

2.13. Implement INT-13: Singleton isolation (GAP-008) — re-initialize with different project, verify no stale orgId leak. **Note**: This test will initially fail until Phase 3 applies the config snapshot fix.

**Files Touched**:

- `packages/agent-transfer/src/__tests__/integration/kore-smartassist-retry.test.ts` — new (INT-1)
- `packages/agent-transfer/src/__tests__/integration/kore-execute-flow.test.ts` — new (INT-2)
- `packages/agent-transfer/src/__tests__/integration/kore-credential-resolution.test.ts` — new (INT-3)
- `packages/agent-transfer/src/__tests__/integration/kore-provider-alias.test.ts` — new (INT-4)
- `apps/runtime/src/__tests__/integration/kore-webhook-pipeline.test.ts` — new (INT-5, per D-9)
- `apps/runtime/src/__tests__/integration/kore-routing-executor.test.ts` — new (INT-6)
- `apps/runtime/src/__tests__/integration/kore-message-bridge.test.ts` — new (INT-7, MessageBridge is in runtime)
- `packages/agent-transfer/src/__tests__/integration/kore-session-atomicity.test.ts` — new (INT-8)
- `packages/agent-transfer/src/__tests__/integration/kore-session-ttl.test.ts` — new (INT-9)
- `packages/agent-transfer/src/__tests__/integration/kore-tools.test.ts` — new (INT-10)
- `packages/agent-transfer/src/__tests__/integration/kore-precheck-flow.test.ts` — new (INT-11)
- `packages/agent-transfer/src/__tests__/integration/kore-orgid-resolution.test.ts` — new (INT-12)
- `packages/agent-transfer/src/__tests__/integration/kore-singleton-isolation.test.ts` — new (INT-13)

**Exit Criteria**:

- [ ] INT-1 through INT-12 pass with `pnpm test --filter=@agent-platform/agent-transfer`
- [ ] INT-13 fails (expected — GAP-008 fix not yet applied)
- [ ] INT-4, INT-8, INT-9 pass with `AGENT_TRANSFER_E2E=1` (require real Redis)
- [ ] No `vi.mock()` of codebase components in any integration test
- [ ] All 13 integration scenarios from test spec covered

**Test Strategy**:

- INT-1,2,3,5,6,7,10,11,12,13: DI-injected mocks, no real Redis needed
- INT-4,8,9: Real Redis required (gated by `AGENT_TRANSFER_E2E=1`)

**Rollback**: Delete new test files. No production code modified.

---

### Phase 3: GAP-008 Config Snapshot Mitigation

**Goal**: Prevent singleton adapter from leaking stale orgId across project re-initializations.

**Tasks**:

3.1. In `KoreAdapter.execute()`, capture a local config snapshot at method entry. **Note**: This changes the guard from checking only `this.client` to also checking `this.smartAssistConfig`, which is strictly safer — if config is missing, the client cannot function correctly anyway:

```typescript
async execute(payload: TransferPayload): Promise<TransferResult> {
  const config = this.smartAssistConfig ? { ...this.smartAssistConfig } : undefined;
  if (!config || !this.client) {
    return { success: false, status: 'failed', error: { code: 'ADAPTER_NOT_CONFIGURED', message: '...' } };
  }
  // Use `config` instead of `this.smartAssistConfig` throughout execute()
  ...
}
```

3.2. **Scope limitation**: The config snapshot protects `execute()` only. Two other methods — `sendUserMessage()` and `endSession()` — also access `this.smartAssistConfig` directly but are called mid-transfer (not at re-initialization boundary), so the stale-config window is negligible. Log this as a known limitation for future Option B (per-execution clone) work.

3.3. Verify INT-13 (singleton isolation) now passes.

3.4. Verify all existing tests still pass (`pnpm test --filter=@agent-platform/agent-transfer`).

**Files Touched**:

- `packages/agent-transfer/src/adapters/kore/index.ts` — modify `execute()` method (~5 lines)

**Exit Criteria**:

- [ ] INT-13 passes (singleton isolation — no stale orgId leak)
- [ ] All existing 86+ tests pass (no regressions)
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` succeeds with 0 errors
- [ ] Config snapshot used consistently in `execute()` — `this.smartAssistConfig` not accessed after snapshot

**Test Strategy**:

- Unit: Existing KoreAdapter tests validate no regression
- Integration: INT-13 validates the fix

**Rollback**: Revert the ~5 line change in `execute()`. INT-13 will fail again.

---

### Phase 4: E2E Tests

**Goal**: Implement all 7 E2E test scenarios from the test spec. Real Express servers, real Redis, SmartAssist mocked via DI only.

**Tasks**:

4.1. Implement E2E-1: Webhook inbound — agent message delivery via real Express server. POST webhook with valid HMAC, assert message bridge callback received, session TTL extended.

4.2. Implement E2E-2: HMAC verification and tenant isolation. Valid HMAC → 200, wrong orgId → 404, invalid HMAC → 401, missing HMAC without secret → pass, replayed nonce → rejected.

4.3. Implement E2E-3: Post-agent return — session preserved for AI resumption. `postAgentAction: 'return'` + `closed` event → session NOT ended, transitions to `post_agent` state.

4.4. Implement E2E-4: Session management endpoints — list and end via HTTP. GET sessions → 200 with array, POST end → session deleted, wrong projectId → 404. **Note**: This test needs auth middleware — may require bearer token mock or test auth bypass.

4.5. Implement E2E-5: Cross-tenant webhook isolation. Valid orgId → 200, attacker orgId → 404, nonexistent conversationId → 404, missing HMAC with secret → 401.

4.6. Implement E2E-6: Boot guard — 503 before initialization. Webhook route returns 503 before boot, 200 after.

4.7. Implement E2E-7: Event type mapping — full pipeline. Post 5 different XO event types through HTTP, verify each maps correctly. `closed` with `postAgentAction: 'end'` triggers session cleanup.

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/kore-webhook.e2e.test.ts` — new (E2E-1,2,3,5,6,7)
- `apps/runtime/src/__tests__/e2e/kore-session-mgmt.e2e.test.ts` — new (E2E-4)

**Exit Criteria**:

- [ ] All 7 E2E scenarios pass with `AGENT_TRANSFER_E2E=1`
- [ ] Each E2E test uses real Express on random port (`app.listen(0)`)
- [ ] Each E2E test uses real Redis (from test-redis helper)
- [ ] SmartAssist mocked only via DI constructor injection — zero `vi.mock()` calls
- [ ] Tenant isolation verified: cross-tenant returns 404, not 403
- [ ] HMAC verification verified: invalid signature → 401
- [ ] No direct Redis queries in test assertions — only via session store API
- [ ] `pnpm build --filter=runtime` succeeds

**Test Strategy**:

- All E2E tests exercise the real HTTP → middleware → adapter → session → bridge pipeline
- Real Redis for session persistence
- Real Express with full middleware chain

**Rollback**: Delete new E2E test files. No production code modified.

---

### Phase 5: Unit Test Gap Closure and Doc Sync

**Goal**: Fill remaining unit test gaps, update coverage matrix, sync docs.

**Tasks**:

5.1. Implement UT-1: `getAccountIdByBotId` — success, fallback to accountId, empty body, timeout, 401.

5.2. Implement UT-2: `createSyntheticUser` — success, 409 conflict, server error.

5.3. Implement UT-3: `resolveOrgId` private method — skip when orgId present, skip when accountId present, call when missing, no appId warning, callback invocation, callback error caught.

5.4. Implement UT-4: Channel→source and channel→conversationType mapping — 6 known channels + unknown default.

5.5. Implement UT-5: ABL tools unit tests — check-hours and set-queue happy/error paths.

5.6. Extend UT-6 if needed: Event handler with structured content (attachment extraction from XO events). May already be covered by `event-handler-attachments.test.ts`.

5.7. Update test spec coverage matrix — mark all scenarios as PASS.

5.8. Update feature spec testing section — reference new test files.

**Files Touched**:

- `packages/agent-transfer/src/__tests__/unit/kore-orgid-unit.test.ts` — new (UT-1, UT-2, UT-3)
- `packages/agent-transfer/src/__tests__/unit/kore-channel-mapping.test.ts` — new (UT-4)
- `packages/agent-transfer/src/__tests__/unit/kore-tools-unit.test.ts` — new (UT-5)
- `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts` — extend if needed (UT-6)
- `docs/testing/sub-features/kore-adapter.md` — update coverage matrix
- `docs/features/sub-features/kore-adapter.md` — update testing section

**Exit Criteria**:

- [ ] UT-1 through UT-6 pass
- [ ] All 86+ existing tests still pass
- [ ] Coverage matrix in test spec updated: all FRs show green
- [ ] Feature spec testing section references new test files
- [ ] `pnpm build && pnpm test` succeeds across all packages

**Test Strategy**:

- All unit tests use DI-injected mocks
- No `vi.mock()` of codebase components

**Rollback**: Delete new unit test files, revert doc changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] **Test helpers imported by test files**: `mock-smartassist.ts`, `mock-session-store.ts`, `test-redis.ts` imported in integration/E2E tests
- [ ] **E2E server factory used by E2E tests**: `kore-e2e-harness.ts` imported in `kore-webhook.e2e.test.ts` and `kore-session-mgmt.e2e.test.ts`
- [ ] **GAP-008 config snapshot**: `execute()` uses local `config` variable, not `this.smartAssistConfig`
- [ ] **No new production exports needed**: All changes are test files + one internal code modification
- [ ] **No new routes needed**: All endpoints already exist
- [ ] **No new models needed**: No MongoDB changes
- [ ] **No new middleware needed**: Existing middleware chain used as-is
- [ ] **No Dockerfile changes needed**: No new packages or dependencies
- [ ] **Five9 mock deduplication**: After Phase 1, update `five9-adapter-cleanup.integration.test.ts` to import from shared `mock-session-store.ts`
- [ ] **Note**: Existing `kore-adapter-wiring.test.ts` uses `vi.mock()` — this is existing tech debt, NOT introduced by this LLD. Do not refactor it in this scope.

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No MongoDB schema changes.

### Feature Flags

None. The `AGENT_TRANSFER_ENABLED` env var controls the entire subsystem. No Kore-specific flag needed.

### Configuration Changes

No new env vars. Existing `AGENT_TRANSFER_E2E=1` gates E2E test execution.

### Test Execution Tiers

| Tier        | Tests                         | Requires        | Run Command                                                              |
| ----------- | ----------------------------- | --------------- | ------------------------------------------------------------------------ |
| No-Redis    | UT-1..6, INT-1..3, INT-10..13 | Nothing         | `pnpm test --filter=@agent-platform/agent-transfer`                      |
| Runtime-Int | INT-5, INT-6, INT-7           | Redis for INT-5 | `pnpm test --filter=runtime`                                             |
| Redis       | INT-4, INT-8, INT-9           | Redis on 6379   | `AGENT_TRANSFER_E2E=1 pnpm test --filter=@agent-platform/agent-transfer` |
| E2E         | E2E-1..7                      | Redis on 6379   | `AGENT_TRANSFER_E2E=1 pnpm test --filter=runtime`                        |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 7 E2E test scenarios pass (E2E-1 through E2E-7)
- [ ] All 13 integration test scenarios pass (INT-1 through INT-13)
- [ ] All 6 unit test groups pass (UT-1 through UT-6)
- [ ] GAP-008 mitigated: INT-13 validates no stale orgId leak
- [ ] No `vi.mock()` of codebase components in any E2E or integration test
- [ ] All existing 86+ tests pass (no regressions)
- [ ] `pnpm build && pnpm test` succeeds across all packages
- [ ] Coverage matrix in test spec updated: all 22 FRs green
- [ ] Feature spec testing section references new test files
- [ ] HLD status updated to APPROVED

---

## 7. Open Questions

1. ~~**E2E auth middleware**~~: RESOLVED — E2E-4 auth follows the `runtime-api-harness.ts` pattern: set `JWT_SECRET` env var to a test value and generate real JWT tokens via `jwt.sign()`. See `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`.
2. ~~**INT-5 scope**~~: RESOLVED — INT-5 uses in-memory session store and real Express (minimal setup, not full E2E server) per task 2.5.
3. **UT-6 deduplication**: `event-handler-attachments.test.ts` already covers attachment extraction. UT-6 may only need structured content additions rather than a new file.

---

## 8. FR → Task Traceability

| FR    | Phase(s) | Task(s)                    | Test Coverage                                                     |
| ----- | -------- | -------------------------- | ----------------------------------------------------------------- |
| FR-1  | 2        | 2.3 (INT-3)                | Integration: credential header selection                          |
| FR-2  | 2        | 2.3 (INT-3)                | Integration: koreApiKey fallback                                  |
| FR-3  | 2        | 2.11 (INT-11)              | Integration: business hours pre-check                             |
| FR-4  | 2        | 2.11 (INT-11)              | Integration: agent availability                                   |
| FR-5  | 2        | 2.11 (INT-11)              | Integration: queue validation                                     |
| FR-6  | 5        | 5.2 (UT-2)                 | Unit: createSyntheticUser                                         |
| FR-7  | 2,3,5    | 2.12,2.13,3.1,5.1,5.3      | INT-12, INT-13, UT-1, UT-3                                        |
| FR-8  | 2        | 2.1,2.2 (INT-1,INT-2)      | Integration: initTransfer flow                                    |
| FR-9  | 2        | 2.3 (INT-3)                | Integration: metaInfo.abl embedding                               |
| FR-10 | 4        | 4.1 (E2E-1)                | E2E: webhook agent message delivery                               |
| FR-11 | 2        | 2.7 (INT-7)                | Integration: control events via bridge                            |
| FR-12 | 4        | 4.1,4.2,4.5,4.6 (E2E-1..6) | E2E: webhook HMAC + pipeline                                      |
| FR-13 | 4,5      | 4.7 (E2E-7), 5.6 (UT-6)    | E2E: 5 representative XO events of 22 total; UT-6 covers full map |
| FR-14 | 2,4      | 2.4 (INT-4), 4.4 (E2E-4)   | Integration: alias index, E2E: sessions                           |
| FR-15 | 2,4      | 2.8,2.9 (INT-8,9), 4.4     | Integration: atomicity, E2E: TTL                                  |
| FR-16 | 2,5      | 2.10 (INT-10), 5.5 (UT-5)  | Integration + unit: check-hours tool                              |
| FR-17 | 2,5      | 2.10 (INT-10), 5.5 (UT-5)  | Integration + unit: set-queue tool                                |
| FR-18 | 4        | 4.3,4.7 (E2E-3,7)          | E2E: post-agent return + end                                      |
| FR-19 | 5        | 5.4 (UT-4)                 | Unit: channel→source mapping                                      |
| FR-20 | 2        | 2.3 (INT-3)                | Integration: LANGUAGE_MAP                                         |
| FR-21 | 2        | 2.3 (INT-3)                | Integration: updateTransfer                                       |
| FR-22 | 4        | 4.2,4.5 (E2E-2,5)          | E2E: tenant isolation on webhook                                  |
