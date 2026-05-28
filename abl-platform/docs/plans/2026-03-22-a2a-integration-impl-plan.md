# LLD: A2A Integration -- Implementation Plan

**Feature**: [docs/features/a2a-integration.md](../features/a2a-integration.md)
**HLD**: [docs/specs/a2a-integration.hld.md](../specs/a2a-integration.hld.md)
**Test Spec**: [docs/testing/a2a-integration.md](../testing/a2a-integration.md)
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| Decision                                                   | Rationale                                                                                        | Alternatives Rejected                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Close GAP-001 (cross-tenant isolation) first               | Highest severity gap; blocks STABLE promotion                                                    | Deferring to later sprint                            |
| Use real Redis for cross-tenant tests                      | Platform invariant requires tenant isolation at query level; in-memory cannot verify key-scoping | Mock Redis (loses real isolation guarantees)         |
| Add tasks/cancel E2E via test agent with delay tool        | Need a cancellable in-progress task                                                              | Mock execution (violates E2E rules)                  |
| Replace globalThis.fetch patching with per-request headers | Global mutation is unsafe in concurrent multi-tenant environments                                | Keep patching (risk of cross-tenant credential leak) |
| Keep sendTaskStreaming disabled until SDK fix              | Generator cleanup hang blocks event loop                                                         | Custom generator wrapper (high complexity, fragile)  |

### Key Interfaces & Types

No new interfaces are required. All domain ports (`AgentExecutionPort`, `A2ATracingPort`, `A2ASessionResolverPort`, `EndpointValidator`) are already defined in `packages/a2a/src/domain/ports.ts`.

The only new type is for the authenticated client refactoring:

```typescript
// packages/a2a/src/infrastructure/authenticated-client-factory.ts
// BEFORE: patches globalThis.fetch
// AFTER: returns a client with auth headers injected per-request

export interface OutboundAuthConfig {
  type: 'api_key' | 'bearer';
  header?: string;
  value: string;
}

// New: createAuthenticatedFetch returns a scoped fetch function
export function createAuthenticatedFetch(auth: OutboundAuthConfig): typeof globalThis.fetch;
```

### Module Boundaries

```
packages/a2a/
  domain/ports.ts           -- Port contracts (unchanged)
  application/              -- Use cases (unchanged)
  infrastructure/
    authenticated-client-factory.ts  -- MODIFIED: per-request auth injection
    agent-executor-adapter.ts        -- UNCHANGED
    express-handlers.ts              -- UNCHANGED
    redis-task-store.ts              -- UNCHANGED
    a2a-callback-handler.ts          -- UNCHANGED

apps/runtime/src/
  server.ts                          -- UNCHANGED
  services/execution/routing-executor.ts  -- UNCHANGED
```

---

## 2. File-Level Change Map

### New Files

| File                                                              | Purpose                                                                                | LOC Estimate |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `packages/a2a/src/__tests__/cross-tenant-isolation.test.ts`       | Integration test: tenant isolation for session resolver, task store, and context index | ~150         |
| `packages/a2a/src/__tests__/cancel-task-lifecycle.test.ts`        | Integration test: cancel task state transitions and event emission                     | ~100         |
| `packages/a2a/src/__tests__/callback-handler-integration.test.ts` | Integration test: callback claim, token verification, resume enqueue, re-registration  | ~120         |

### Modified Files

| File                                                              | Change Description                                                                       | Risk   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| `packages/a2a/src/infrastructure/authenticated-client-factory.ts` | Replace globalThis.fetch patching with per-request auth headers via custom fetch wrapper | Medium |
| `packages/a2a/src/infrastructure/client-factory.ts`               | Accept optional custom fetch function parameter                                          | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Cross-Tenant Isolation Verification (GAP-001)

**Goal**: Verify that A2A session resolution, task storage, and context indexing are correctly isolated across tenants at the Redis key level.

**Tasks**:

1.1. Write `cross-tenant-isolation.test.ts` that creates two `RedisA2ATaskStore` instances with different tenantIds and verifies:

- Task saved by tenant-A is not loadable by tenant-B's store
- `listByContext` with same contextId returns different results per tenant
- Push notification config is scoped to taskId (tenant-neutral but task-scoped)

  1.2. Add session resolver isolation test: same contextId with different tenantIds maps to different sessionIds using `a2a:session:{tenantId}:{contextId}` key pattern.

  1.3. Verify that `RedisA2ATaskStore.listByContext` filters by tenant in the ZSET key (`a2a:ctx-tasks:{tenantId}:{contextId}`).

**Files Touched**:

- `packages/a2a/src/__tests__/cross-tenant-isolation.test.ts` -- new test file

**Exit Criteria**:

- [ ] `cross-tenant-isolation.test.ts` has 5+ test cases covering task save/load, context listing, session resolution, and push config isolation
- [ ] `pnpm test --filter=@agent-platform/a2a` passes with 0 failures
- [ ] Tests use real Redis key patterns (not mocked) via a mock Redis client that validates key scoping

**Test Strategy**:

- Integration: Real `RedisA2ATaskStore` with mock Redis client that records all keys used. Verify tenantId is present in every key.

**Rollback**: Delete test file; no production code changes.

---

### Phase 2: Task Cancel Lifecycle Verification (GAP-002)

**Goal**: Verify that `tasks/cancel` correctly transitions task state and emits the right events through the `AgentExecutorAdapter`.

**Tasks**:

2.1. Write `cancel-task-lifecycle.test.ts` that tests `AgentExecutorAdapter.cancelTask`:

- Emits `status-update(canceled, final=true)` event
- Calls `eventBus.finished()`
- Handles non-existent task gracefully

  2.2. Add outbound `cancelRemoteTask` integration test verifying:

- SSRF validation on endpoint
- Client.cancelTask called with correct params
- Tracing records success/error
- JSON-RPC error from remote agent is wrapped correctly

**Files Touched**:

- `packages/a2a/src/__tests__/cancel-task-lifecycle.test.ts` -- new test file

**Exit Criteria**:

- [ ] `cancel-task-lifecycle.test.ts` has 4+ test cases covering adapter cancel, outbound cancel, error handling, and tracing
- [ ] `pnpm test --filter=@agent-platform/a2a` passes with 0 failures
- [ ] Cancel state transition matches A2A protocol spec (submitted/working -> canceled)

**Test Strategy**:

- Integration: Mock execution event bus, real adapter. Verify event sequence.
- Unit: Mock A2A client for outbound cancel.

**Rollback**: Delete test file; no production code changes.

---

### Phase 3: Callback Handler Integration Tests (GAP-009 from test spec)

**Goal**: Add integration-level tests for the A2A callback handler covering atomic claim, Bearer token verification, BullMQ enqueue, and failure recovery.

**Tasks**:

3.1. Write `callback-handler-integration.test.ts` using supertest against a real Express router created by `createA2ACallbackRouter`:

- First callback claim succeeds, enqueues resume job
- Second callback for same callbackId returns `already_processed` (idempotent)
- Bearer token mismatch returns 401; callback re-registered
- BullMQ enqueue failure returns 503; callback re-registered
- Tracing records successful callback

  3.2. Verify that `deps.suspensionLookup.decryptSecret` path is exercised when available.

**Files Touched**:

- `packages/a2a/src/__tests__/callback-handler-integration.test.ts` -- new test file

**Exit Criteria**:

- [ ] `callback-handler-integration.test.ts` has 5+ test cases covering claim, idempotency, token verification, enqueue failure, and tracing
- [ ] `pnpm test --filter=@agent-platform/a2a` passes with 0 failures
- [ ] Tests use real Express router with supertest (not mocking the router itself)

**Test Strategy**:

- Integration: Real Express router via supertest. Mock registry, queue, and suspension lookup via dependency injection.

**Rollback**: Delete test file; no production code changes.

---

### Phase 4: Authenticated Client Factory Hardening (GAP-010)

**Goal**: Replace the `globalThis.fetch` patching in `authenticated-client-factory.ts` with a scoped fetch wrapper that injects auth headers per-request without mutating globals.

**Tasks**:

4.1. Create `createAuthenticatedFetch(auth: OutboundAuthConfig): typeof fetch` function that returns a new fetch function wrapping the original with auth headers injected.

4.2. Update `createA2AClientWithAuth` to use the scoped fetch wrapper instead of patching `globalThis.fetch`.

4.3. Update `client-factory.ts` to accept an optional custom fetch parameter and pass it to the SDK client constructor.

4.4. Add unit tests verifying:

- Auth headers are injected on every request
- Original globalThis.fetch is not modified
- API key and Bearer token auth types work
- Custom header names are respected

  4.5. Update `apps/runtime/src/services/execution/routing-executor.ts` to use the new `createA2AClientWithAuth` signature (if interface changed).

**Files Touched**:

- `packages/a2a/src/infrastructure/authenticated-client-factory.ts` -- refactor to per-request auth
- `packages/a2a/src/infrastructure/client-factory.ts` -- accept optional custom fetch
- `packages/a2a/src/__tests__/traced-client.test.ts` -- update if client-factory signature changed

**Exit Criteria**:

- [ ] `globalThis.fetch` is never mutated in the authenticated client factory
- [ ] Existing unit tests for traced-client, send-task, and discover-agent still pass
- [ ] New unit tests verify per-request auth header injection for both api_key and bearer types
- [ ] `pnpm build --filter=@agent-platform/a2a` succeeds with 0 type errors
- [ ] `pnpm test --filter=@agent-platform/a2a` passes with 0 failures

**Test Strategy**:

- Unit: Mock fetch to verify header injection. Verify globalThis.fetch is unchanged.

**Rollback**: Revert `authenticated-client-factory.ts` and `client-factory.ts` to previous versions. No data migration.

---

### Phase 5: Session Restart Persistence Verification (GAP-003)

**Goal**: Verify that A2A sessions persisted in Redis survive runtime restarts and can be used for multi-turn continuation.

**Tasks**:

5.1. Write a test scenario document (in `docs/testing/a2a-integration.md`) describing the manual verification procedure:

- Create an A2A session via `message/send` with contextId
- Note the sessionId mapping in Redis (`a2a:session:{tenantId}:{contextId}`)
- Restart the runtime process
- Send a follow-up `message/send` with the same contextId
- Verify the response references prior conversation context (session was reloaded)

  5.2. Verify that `LazyTaskStore` upgrade path does not lose pre-upgrade InMemory tasks (documented as ephemeral -- verify the documented behavior is correct).

  5.3. If automated testing is feasible (PM2 restart + API call), add to the E2E test suite. Otherwise, document as a manual verification step.

**Files Touched**:

- `docs/testing/a2a-integration.md` -- add restart persistence verification procedure

**Exit Criteria**:

- [ ] Restart persistence procedure documented in test spec
- [ ] At least one manual verification recorded (or automated test added)
- [ ] LazyTaskStore ephemeral-data behavior documented and verified

**Test Strategy**:

- Manual E2E: Requires runtime restart between API calls. PM2-based or Docker-based restart.

**Rollback**: Revert doc changes. No production code changes.

---

## 4. Wiring Checklist

- [x] A2A use cases exported from `packages/a2a/src/index.ts` -- all exports verified
- [x] Express handlers registered in `apps/runtime/src/server.ts` -- `a2aHandlers.setupRoutes(app)` called
- [x] Callback router registered at `/a2a/callbacks` -- both placeholder and real router wired
- [x] `LazyTaskStore` upgrade wired in `wireAsyncInfra()` -- verified in server.ts
- [x] Outbound A2A use cases imported in `routing-executor.ts` -- `sendTask`, `sendTaskAsync`, `discoverAgent`, `cancelRemoteTask`, `AgentCardCache` imported
- [x] `@agent-platform/a2a` dependency declared in `apps/runtime/package.json` -- verified
- [x] A2A channel type registered in Studio `channel-registry.tsx` -- verified
- [ ] New test files added to vitest configuration -- Phase 1-3 test files will be auto-discovered by vitest glob
- [ ] Updated authenticated client factory signature reflected in routing-executor imports -- Phase 4

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. All changes are additive (new test files) or in-place refactoring (authenticated client factory).

### Feature Flags

None required. The authenticated client factory refactoring (Phase 4) is a direct replacement -- no feature flag needed because the external API is unchanged.

### Configuration Changes

None required. No new environment variables or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] E2E-1 through E2E-7 from test spec either passing or documented with manual verification results
- [ ] INT-1 through INT-7 from test spec either covered by existing tests or new Phase 1-3 tests
- [ ] No regressions in existing `packages/a2a` tests (currently passing)
- [ ] No regressions in `apps/runtime` tests
- [ ] Feature spec `docs/features/a2a-integration.md` updated with closed gaps
- [ ] Testing matrix `docs/testing/a2a-integration.md` updated with actual coverage
- [ ] GAP-001 (cross-tenant isolation) closed
- [ ] GAP-002 (tasks/cancel) closed
- [ ] GAP-003 (restart persistence) closed or documented with manual verification
- [ ] GAP-010 (globalThis.fetch patching) closed

---

## 7. Post-Implementation Notes (2026-04-14)

### Per-Message Metadata Parity (ABLP-133, added post-plan)

Two commits under ABLP-133 added per-message metadata parity across A2A, REST chat, and WebSocket SDK channels. This work was not in the original LLD phases (which focused on closing GAPs 1-3 and hardening the auth client factory) but is an additive enhancement to the A2A integration surface:

- **New port field**: `A2ARequestContext.messageMetadata` in `packages/a2a/src/domain/ports.ts`
- **Adapter extraction**: `extractInboundMessageMetadata` in `agent-executor-adapter.ts` -- extracts `message.metadata.messageMetadata` without leaking the reserved `history` key
- **Runtime validation**: `normalizeSdkMessageMetadata` shared across A2A (`server.ts`), REST chat (`chat.ts`), and WebSocket (`sdk-handler.ts`) paths
- **Test coverage**: Unit tests in `agent-executor-adapter.test.ts` (metadata forwarding without history leakage) and `chat-routes.test.ts` (metadata validation and rejection)
- **Documentation**: Updated `channels.mdx`, `conversation-api.mdx`, `sdks.mdx` in Studio content

Original LLD phases (1-5) remain unchanged in status. This enhancement does not close any of the planned gaps.

---

## 8. Open Questions

1. **Redis test infrastructure**: Do integration tests in `packages/a2a` have access to a real or mock Redis instance in CI? The existing `redis-task-store.test.ts` appears to use a mock Redis client -- can we use the same pattern for cross-tenant tests?
2. **SDK `@a2a-js/sdk` client constructor**: Does the SDK client accept a custom `fetch` parameter? This determines the refactoring approach for Phase 4. If not, we may need to wrap at the transport level instead.
3. **PM2 restart in CI**: Can we automate the restart persistence test (Phase 5) in CI, or should it remain a manual verification step?
4. **Streaming re-enablement**: When the SDK generator issue is fixed, should Phase 4 also wire `sendTaskStreaming` back into the routing executor, or should that be a separate task?
5. **Test execution order**: Phases 1-3 are independent (test-only). Phase 4 modifies production code and should run after Phase 3 to establish a regression baseline.
