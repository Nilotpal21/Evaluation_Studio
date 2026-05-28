# LLD + Implementation Plan: Agent Transfer

- **Feature ID:** F014
- **Feature Spec:** `docs/features/agent-transfer.md`
- **Test Spec:** `docs/testing/agent-transfer.md`
- **HLD:** `docs/specs/agent-transfer.hld.md`
- **Status:** ALPHA (voice + connection-backed desktop flows implemented; E2E with real Redis still needed for BETA)
- **Created:** 2026-03-23
- **Last Updated:** 2026-04-14

---

## 1. Implementation Context

The agent-transfer feature is at ALPHA status with substantial code already implemented across `packages/agent-transfer`, `apps/runtime`, and `apps/studio`. The gap closure plan (`docs/plans/2026-03-13-agent-transfer-gap-closure.md`) identified 47 findings (12 critical, 19 important, 8 moderate, 4 test gaps). Additional issues were found in `docs/plans/2026-03-10-call-control-review-findings-plan.md` (52 findings).

This implementation plan focuses on closing the gaps required to advance from ALPHA to BETA status.

### 1.1 Pre-Implementation Known Issues

| Issue                                                                   | Severity | Source      |
| ----------------------------------------------------------------------- | -------- | ----------- |
| TS2353 build errors in `ivr-digit-input.ts`, `ivr-menu.ts`              | HIGH     | MEMORY.md   |
| Type mismatch in `apps/runtime/src/services/agent-transfer/index.ts:96` | HIGH     | MEMORY.md   |
| Session key prefix mismatch in `KoreAdapter.execute()` (C6)             | CRITICAL | Gap closure |
| Double-delivery in webhook handler (C12)                                | CRITICAL | Gap closure |
| Non-atomic `extendTTL` creates ghost records (I8)                       | HIGH     | Gap closure |
| `at_active_sessions` unbounded growth (C9)                              | CRITICAL | Gap closure |
| CROSSSLOT violation in `LUA_CLAIM_SESSION` (I10)                        | HIGH     | Gap closure |

---

## 2. Phased Implementation Plan

### Phase 1: Build Fixes and Critical Correctness (2-3 days)

**Goal:** Make `packages/agent-transfer` compile cleanly and fix session store correctness bugs that break the transfer lifecycle.

#### 1.1 Fix TypeScript Build Errors

**Files:**

- `packages/agent-transfer/src/tools/ivr-digit-input.ts`
- `packages/agent-transfer/src/tools/ivr-menu.ts`
- `apps/runtime/src/services/agent-transfer/index.ts`

**Changes:**

- Resolve TS2353 errors in IVR tools (likely interface property conflicts)
- Fix type mismatch at index.ts:96 (TransferSessionData vs TransferSessionRecord)
- Verify with `pnpm build --filter=@agent-platform/agent-transfer`

#### 1.2 Fix Session Key Prefix Mismatch (C6)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts`

**Problem:** `execute()` returns `sessionId: "kore:..."` but session store expects `agent_transfer:{tenantId}:{contactId}:{channel}`.

**Fix:** Use `sessionKey()` from `session/types.ts` to generate the correct key in `execute()`.

#### 1.3 Fix Non-Atomic `extendTTL` (I8)

**File:** `packages/agent-transfer/src/session/transfer-session-store.ts`, `packages/agent-transfer/src/session/lua-scripts.ts`

**Problem:** Pipeline between `EXPIRE` and `HMSET` is not atomic. If key expires between them, `HMSET` creates a ghost record.

**Fix:** Add `LUA_EXTEND_TTL` Lua script that atomically checks existence, extends TTL, and updates heartbeat fields.

#### 1.4 Fix `LUA_END_SESSION` TOCTOU (C8)

**File:** `packages/agent-transfer/src/session/lua-scripts.ts`

**Problem:** Session can expire between `get()` and Lua execution, leaving orphaned index keys.

**Fix:** Move provider/index lookup inside the Lua script. Read `provider` and `providerSessionId` from the hash before deleting.

#### 1.5 Fix Empty `providerSessionId` Writing Blank Index Key (C7)

**File:** `packages/agent-transfer/src/session/lua-scripts.ts`

**Fix:** Add length check in `LUA_CREATE_SESSION` to skip index key creation when `providerSessionId` is empty.

#### 1.6 Fix `LUA_CLAIM_SESSION` CROSSSLOT Violation (I10)

**File:** `packages/agent-transfer/src/session/lua-scripts.ts`

**Fix:** Pass pod keys as `KEYS[2]` and `KEYS[3]` instead of ARGV to avoid CROSSSLOT errors in Redis Cluster.

**Exit Criteria:**

- [ ] `pnpm build --filter=@agent-platform/agent-transfer` succeeds with zero errors
- [ ] `pnpm test --filter=@agent-platform/agent-transfer` passes all existing tests
- [ ] Session key format is consistent across adapter execute, session store, and webhook handler
- [ ] `extendTTL` with expired key returns false without creating ghost records
- [ ] `end()` atomically cleans up all related keys

---

### Phase 2: Webhook and Message Bridge Correctness (2-3 days)

**Goal:** Fix the inbound webhook processing pipeline so agent messages reach the user.

#### 2.1 Fix Webhook Event Type Normalization (C11)

**File:** `apps/runtime/src/routes/agent-transfer-webhooks.ts`

**Problem:** Raw XO event type (`agent_message`) is passed to bridge which checks for `agent:message`.

**Status:** Already fixed in current code (line 141 calls `KoreEventHandler.mapEventType()`). Verify this path works E2E.

#### 2.2 Verify No Double-Delivery (C12)

**File:** `apps/runtime/src/routes/agent-transfer-webhooks.ts`

**Status:** Already fixed in current code. The webhook handler calls `adapter.handleInboundEvent()` only, which internally fires `onAgentMessage` callbacks that route through the message bridge.

#### 2.3 Fix `handleInboundEvent` Hardcoded Key Format (I2)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts`

**Fix:** Use `sessionKey()` instead of hardcoded key construction in `handleInboundEvent`.

#### 2.4 Wire User-to-Agent Message Forwarding (C1, C2)

**Files:**

- `apps/runtime/src/services/execution/routing-executor.ts`
- `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

**Problem:** When a user sends a message during an active transfer, the message must be forwarded to the human agent via `adapter.sendUserMessage()`. This path is not wired in the execution pipeline.

**Fix:**

1. In `routing-executor.ts`, detect active transfer state and call `adapter.sendUserMessage()` instead of processing through the AI agent
2. In `smartassist-client.ts`, implement the `sendUserMessage()` HTTP call to SmartAssist API

#### 2.5 Add Attachment Handling for Inbound Events

**File:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

**Status:** Already partially implemented (lines 415-446). Verify file URL resolution works correctly.

**Exit Criteria:**

- [ ] Webhook events with XO event types are correctly normalized before bridge routing
- [ ] No duplicate message delivery in webhook processing
- [ ] User messages during active transfer are forwarded to human agent
- [ ] Agent messages with attachments are delivered to user channels

---

### Phase 3: Security Hardening (1-2 days)

**Goal:** Close security gaps identified in the review.

#### 3.1 Enforce Auth on Settings Route (C10)

**File:** `apps/runtime/src/routes/agent-transfer-settings.ts`

**Status:** Already has `authMiddleware` and `requireProjectPermission`. Verify `tenantId` is extracted from authenticated context (not just header).

**Current Issue:** Line 35 reads `tenantId` from `req.headers['x-tenant-id']` directly instead of from `req.tenantContext.tenantId` (set by authMiddleware). This is inconsistent with the sessions route which uses `req.tenantContext.tenantId`.

**Fix:** Use `(req as any).tenantContext?.tenantId` consistently across all routes.

#### 3.2 Implement Auth Token Refresh (I9)

**Files:**

- `packages/agent-transfer/src/adapters/auth/jwt.ts`
- `packages/agent-transfer/src/adapters/auth/oauth2-client.ts`

**Fix:** Implement actual token refresh logic in `JWTAuth.refresh()` and `OAuth2ClientAuth.refresh()`.

#### 3.3 Add Input Validation for Session Operations

**Files:**

- `apps/runtime/src/routes/agent-transfer-sessions.ts`
- `apps/runtime/src/routes/agent-transfer-webhooks.ts`

**Fix:** Add Zod validation for query parameters, session IDs, and webhook payloads. Use `z.string().min(1)` for ID fields.

**Exit Criteria:**

- [ ] All routes use authenticated tenant context (not raw headers)
- [ ] Auth token refresh works for JWT and OAuth2 adapters
- [ ] Input validation rejects malformed session IDs and query parameters

---

### Phase 4: E2E Test Coverage (3-4 days)

**Goal:** Implement the 10 E2E test scenarios from the test spec.

#### 4.1 Test Infrastructure Setup

**File:** `apps/runtime/src/__tests__/e2e/agent-transfer-e2e-setup.ts` (create)

- Real Express server on random port with full middleware chain
- Real Redis (or ioredis for CI environments)
- nock mocks for SmartAssist API (external service)
- Utility functions for session creation, webhook posting, assertion helpers

#### 4.2 Implement E2E Tests

**File:** `apps/runtime/src/__tests__/e2e/agent-transfer-lifecycle.e2e.test.ts` (create)

Implement test scenarios E2E-01 through E2E-10 as defined in the test spec:

1. Complete transfer lifecycle (chat channel)
2. Webhook signature verification
3. Tenant isolation in session operations
4. Session timeout and TTL expiry
5. Transfer tool execution pipeline
6. Voice channel tool restrictions
7. Rate limiting on transfer initiation
8. Project-level settings CRUD
9. Durable event queue reliability
10. Session recovery after pod crash

**Rules:**

- NO mocking of codebase components (`vi.mock()` is FORBIDDEN)
- API-only interaction (seed via POST, assert via GET)
- Real Express server with full middleware chain
- Only SmartAssist API is mocked (external service, via nock)

#### 4.3 Implement Integration Tests

**File:** `packages/agent-transfer/src/__tests__/integration/` (extend existing)

Implement scenarios INT-01 through INT-08 from the test spec.

**Exit Criteria:**

- [ ] All 10 E2E test scenarios pass
- [ ] All 8 integration test scenarios pass
- [ ] No `vi.mock()` in E2E tests
- [ ] All tests use real Express servers on random ports
- [ ] Test coverage for agent-transfer package reaches 80%+

---

### Phase 5: Remaining Gap Closure (2-3 days)

**Goal:** Close important and moderate findings from the gap analysis.

#### 5.1 Fix Dead Pod SET Keys Never Deleted (I11)

**File:** `packages/agent-transfer/src/session/session-recovery-service.ts`

**Fix:** In `stop()`, delete pod SET and heartbeat keys after draining sessions.

#### 5.2 Fix `initPromise` Not Cleared on Failure (I18)

**File:** `apps/runtime/src/services/agent-transfer/index.ts`

**Status:** Already fixed in current code (line 104-106). Verify this pattern works correctly.

#### 5.3 Add `handleInboundEvent` to Adapter Interface

**File:** `packages/agent-transfer/src/adapters/interface.ts`

**Status:** Already added (line 29). Verify all adapters implement it.

#### 5.4 Implement Missing Event Types (I3)

Map additional XO event types: `agent_typing_stop`, `agent_queued`, `agent_joined`, `agent_exited`.

#### 5.5 Add Session State Transition Validation (M3)

**File:** `packages/agent-transfer/src/session/transfer-session-store.ts`

**Fix:** Add state machine validation in `update()`: only allow valid transitions (pending -> queued -> active -> post_agent -> ended).

**Exit Criteria:**

- [ ] All HIGH findings from gap closure resolved
- [ ] Session state transitions are validated
- [ ] Recovery service properly cleans up pod resources on shutdown
- [ ] All event types are mapped

---

### Phase 6: Documentation and BETA Promotion (1 day)

**Goal:** Update all SDLC artifacts and promote to BETA.

#### 6.1 Update Feature Spec Status

- Update status from ALPHA to BETA
- Document resolved gaps
- Update known gaps section

#### 6.2 Update Test Spec Coverage

- Update coverage matrix with actual numbers
- Close test gap entries
- Add any new test scenarios discovered during implementation

#### 6.3 Run Post-Implementation Sync

- Verify all cross-references between feature spec, test spec, HLD, and LLD
- Update architecture diagrams if any structural changes were made

**Exit Criteria:**

- [ ] Feature status is BETA in all artifacts
- [ ] All CRITICAL gaps resolved
- [ ] All HIGH gaps resolved or logged with justification
- [ ] E2E test suite passes in CI
- [ ] `pnpm build` succeeds for all affected packages

---

## 3. Wiring Checklist

Every implementation phase must verify these integration points:

| Wiring Point                         | Packages                                           | Verification                                               |
| ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- |
| Boot service -> Session store        | `apps/runtime` -> `packages/agent-transfer`        | `initializeAgentTransfer()` creates `TransferSessionStore` |
| Boot service -> Adapter registry     | `apps/runtime` -> `packages/agent-transfer`        | `KoreAdapter` registered with session store handle         |
| Boot service -> Message bridge       | `apps/runtime` -> `apps/runtime`                   | `koreAdapter.onAgentMessage()` wired to bridge             |
| Webhook route -> Adapter             | `apps/runtime` routes -> `packages/agent-transfer` | `adapter.handleInboundEvent()` called on webhook           |
| Execution pipeline -> Transfer tools | `apps/runtime` -> `packages/agent-transfer`        | `TransferToolExecutor` instantiated with adapter + client  |
| Transfer tool -> Session store       | `packages/agent-transfer`                          | `execute()` creates session via Lua scripts                |
| Message bridge -> Channel adapters   | `apps/runtime` -> `apps/runtime` channels          | `deliverViaChatChannel()` resolves adapter and connection  |
| Message bridge -> Voice gateway      | `apps/runtime` -> `packages/agent-transfer` voice  | `deliverViaVoiceGateway()` uses VoiceGatewayRegistry       |
| Session routes -> Session store      | `apps/runtime` routes -> `packages/agent-transfer` | `getTransferSessionStore()` for list and end operations    |
| Settings routes -> MongoDB           | `apps/runtime` routes -> `packages/database`       | `ProjectSettings.findOneAndUpdate()` for settings CRUD     |
| Studio API -> Runtime proxy          | `apps/studio` -> `apps/runtime`                    | Studio proxy routes forward to runtime API                 |

---

## 4. Risk Mitigation

| Risk                                                | Mitigation                                                                    | Phase |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| Lua script changes break existing tests             | Run `pnpm test --filter=@agent-platform/agent-transfer` after each Lua change | 1     |
| Build fix introduces regressions                    | Run full build + test suite before committing                                 | 1     |
| E2E tests flaky due to Redis timing                 | Use deterministic Redis operations, avoid sleep-based assertions              | 4     |
| Session recovery test requires multi-pod simulation | Use hostname mocking to simulate different pods                               | 4     |
| SmartAssist API contract changes                    | nock mocks capture current contract; update on API changes                    | 4     |

---

## 5. Dependencies Between Phases

```
Phase 1 (Build Fixes) ──→ Phase 2 (Webhook/Bridge) ──→ Phase 3 (Security)
                                                              │
                                                              ▼
Phase 1 ──────────────────────────────────────────→ Phase 4 (E2E Tests)
                                                              │
                                                              ▼
                                                    Phase 5 (Gap Closure)
                                                              │
                                                              ▼
                                                    Phase 6 (BETA Promotion)
```

Phase 1 must complete before Phases 2-5. Phase 2 and 3 can run in parallel. Phase 4 depends on Phases 1-3. Phase 5 can overlap with Phase 4. Phase 6 requires all prior phases.

---

## 6. Effort Estimate

| Phase                                       | Effort         | Confidence                         |
| ------------------------------------------- | -------------- | ---------------------------------- |
| Phase 1: Build Fixes + Critical Correctness | 2-3 days       | High                               |
| Phase 2: Webhook/Bridge Correctness         | 2-3 days       | High                               |
| Phase 3: Security Hardening                 | 1-2 days       | High                               |
| Phase 4: E2E Test Coverage                  | 3-4 days       | Medium (test infrastructure setup) |
| Phase 5: Remaining Gap Closure              | 2-3 days       | Medium                             |
| Phase 6: Documentation + BETA               | 1 day          | High                               |
| **Total**                                   | **11-16 days** | -                                  |
