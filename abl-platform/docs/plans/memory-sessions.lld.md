# Low-Level Design: Memory & Session Management

**Feature**: Memory & Session Management
**Status**: STABLE (documenting gaps and hardening plan)
**Feature Spec**: [docs/features/memory-sessions.md](../features/memory-sessions.md)
**Test Spec**: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
**HLD**: [docs/specs/memory-sessions.hld.md](../specs/memory-sessions.hld.md)
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                      | Rationale                                                                       | Alternatives Rejected                                |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D1  | Focus LLD on gap closure, not new features    | Feature is STABLE with ~1,210 tests. Primary value is closing HIGH/MEDIUM gaps. | Full rewrite, adding new features                    |
| D2  | Phase security fixes (GAP-007, GAP-008) first | HIGH severity gaps affect production security posture.                          | Deferring security to later sprint                   |
| D3  | Use real Redis/MongoDB for E2E gap tests      | E2E tests must exercise real infrastructure per CLAUDE.md E2E standards.        | Mock Redis/MongoDB (prohibited)                      |
| D4  | Fix messageType bypass by requiring it        | Simplest fix that maintains fail-closed behavior.                               | Adding a new middleware layer                        |
| D5  | Add tenantId to Redis Pub/Sub channel key     | Prevents cross-tenant event leakage in shared Redis.                            | Separate Redis instances per tenant (overengineered) |
| D6  | Defer compaction enablement to separate LLD   | CompactionEngine exists but needs its own test/rollout plan.                    | Enabling it in this LLD                              |

### Key Interfaces (Existing, No Changes)

```typescript
// SessionStore interface — stability contract (no changes planned)
interface SessionStore {
  create(session: SessionData): Promise<void>;
  load(sessionId: string): Promise<SessionData | null>;
  getVersion(sessionId: string): Promise<number | null>;
  save(session: SessionData): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
  appendMessages(sessionId: string, messages: Message[]): Promise<void>;
  getConversationHistory(sessionId: string, limit?: number): Promise<Message[]>;
  replaceConversation(sessionId: string, messages: Message[]): Promise<void>;
  saveAndReplaceConversation?(session: SessionData, messages: Message[]): Promise<boolean>;
  trimConversation(sessionId: string, maxMessages: number): Promise<void>;
  getAgentIR(sourceHash: string): Promise<AgentIR | null>;
  setAgentIR(sourceHash: string, ir: AgentIR): Promise<void>;
  getCompilationOutput(hash: string): Promise<CompilationOutput | null>;
  setCompilationOutput(hash: string, output: CompilationOutput): Promise<void>;
  setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void>;
  getAgentRegistry(sessionId: string): Promise<Record<string, string> | null>;
  acquireLock(sessionId: string, ttlMs?: number): Promise<boolean>;
  releaseLock(sessionId: string): Promise<void>;
  touch(sessionId: string): Promise<void>;
  setResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
    sessionId: string,
    ttlSeconds: number,
  ): Promise<void>;
  getResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<string | null>;
  deleteResolutionKey(tenantId: string, channelId: string, artifactHash: string): Promise<void>;
}
```

### Module Boundaries

| Module             | Package                             | Responsibility             | Changes in LLD                            |
| ------------------ | ----------------------------------- | -------------------------- | ----------------------------------------- |
| Session ownership  | `packages/shared-auth`              | Tiered identity matching   | Fix messageType bypass (Phase 1)          |
| Redis Pub/Sub      | `apps/runtime`                      | Cross-pod session events   | Add tenantId to channel keys (Phase 1)    |
| E2E tests          | `apps/runtime/src/__tests__`        | Infrastructure-level tests | Add cold restore + cross-tenant (Phase 2) |
| MemorySessionStore | `apps/runtime/src/services/session` | In-memory fallback         | Replace console.warn (Phase 3)            |

---

## 2. File-Level Change Map

### Phase 1: Security Fixes (GAP-007, GAP-008)

| File                                                                                                     | Action | What Changes                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/identity/session-access.ts` (or wherever `getAuthorizedRuntimeSession` lives) | MODIFY | Require `messageType` parameter; if falsy, default to strictest ownership check instead of skipping |
| `apps/runtime/src/__tests__/session-ownership-authz.test.ts`                                             | MODIFY | Add regression test for falsy messageType — verify ownership check is NOT skipped                   |
| `apps/runtime/src/services/session/redis-pubsub.ts` (or wherever Pub/Sub channels are defined)           | MODIFY | Change channel key format from `session:{sessionId}` to `session:{tenantId}:{sessionId}`            |
| `apps/runtime/src/__tests__/session-security.test.ts`                                                    | MODIFY | Add test verifying Pub/Sub channel keys include tenantId                                            |

**Exit Criteria**:

- `getAuthorizedRuntimeSession` never skips ownership check regardless of messageType value
- Redis Pub/Sub channel keys include tenantId in all codepaths
- Regression tests pass for both fixes
- `pnpm build --filter=@abl/runtime` passes
- `pnpm test --filter=@abl/runtime` passes

### Phase 2: E2E Gap Closure (GAP-001, GAP-006)

| File                                                          | Action | What Changes                                                                                                      |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/session-cold-restore-e2e.test.ts` | CREATE | E2E test: create session, persist to cold, delete Redis keys, load from cold, verify data integrity + rehydration |
| `apps/runtime/src/__tests__/session-cross-tenant-e2e.test.ts` | CREATE | E2E test: two tenant contexts, verify cross-tenant list/get/delete/resume all return 404                          |

**Exit Criteria**:

- Cold restore E2E test creates a real session, persists to MongoDB, manually expires Redis, loads via TieredSessionStore, verifies all fields match
- Cross-tenant E2E test uses two separate tenant auth contexts, verifies every session route returns 404 for cross-tenant access
- No `vi.mock()` or `jest.mock()` in E2E test files
- All interactions via HTTP API (no direct DB access in tests)
- `pnpm test --filter=@abl/runtime` passes

### Phase 3: Implementation Debt (GAP-005)

| File                                                        | Action | What Changes                                                                 |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/memory-session-store.ts` | MODIFY | Replace all `console.warn` calls with `createLogger('memory-session-store')` |
| `apps/runtime/src/__tests__/session-service.test.ts`        | VERIFY | Existing tests still pass (no behavioral change)                             |

**Exit Criteria**:

- Zero `console.warn` calls in `memory-session-store.ts`
- All logging uses structured `createLogger` pattern
- No behavioral changes to MemorySessionStore
- `pnpm test --filter=@abl/runtime` passes

### Phase 4: Documentation Sync

| File                                | Action | What Changes                                                         |
| ----------------------------------- | ------ | -------------------------------------------------------------------- |
| `docs/features/memory-sessions.md`  | MODIFY | Update GAP-007 and GAP-008 status to "Resolved". Update test counts. |
| `docs/testing/memory-sessions.md`   | MODIFY | Add new E2E test files to inventory. Update gap statuses.            |
| `docs/specs/memory-sessions.hld.md` | MODIFY | Update known limitations table.                                      |

**Exit Criteria**:

- All gap statuses reflect actual implementation state
- Test inventory includes new E2E files
- All doc dates updated

---

## 3. Wiring Checklist

### Phase 1 Wiring

- [ ] `getAuthorizedRuntimeSession` callers: verify all call sites pass `messageType` (search for function name across codebase)
- [ ] Redis Pub/Sub subscribers: verify all subscriber channel patterns include `tenantId` wildcard
- [ ] WebSocket handler: verify Pub/Sub publish calls use new channel key format

### Phase 2 Wiring

- [ ] Cold restore E2E: wire `TieredSessionStore` with real Redis + MongoDB connections (not mocks)
- [ ] Cross-tenant E2E: wire two separate auth middleware contexts
- [ ] Both E2E tests: wire into test suite execution (vitest config includes new files)

### Phase 3 Wiring

- [ ] Logger import: add `import { createLogger } from '@abl/compiler/platform'` to memory-session-store.ts
- [ ] Logger instantiation: `const log = createLogger('memory-session-store')` at module level

---

## 4. Database Migration Plan

**No database migrations required.** All changes are to application logic, Redis key formats, and test files.

For the Redis Pub/Sub channel key change (Phase 1):

- Old format: `session:{sessionId}`
- New format: `session:{tenantId}:{sessionId}`
- Migration strategy: Deploy atomically. Redis Pub/Sub has no persistent state — subscribers re-subscribe on reconnect. A rolling restart ensures all pods use the new format.

---

## 5. Test Implementation Plan

### Phase 1 Tests

| Test                            | Type | File                              | What to Assert                                                                                     |
| ------------------------------- | ---- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| messageType bypass regression   | Unit | `session-ownership-authz.test.ts` | Calling `getAuthorizedRuntimeSession` with `messageType: undefined` still enforces ownership check |
| messageType bypass regression   | Unit | `session-ownership-authz.test.ts` | Calling `getAuthorizedRuntimeSession` with `messageType: null` still enforces ownership check      |
| messageType bypass regression   | Unit | `session-ownership-authz.test.ts` | Calling `getAuthorizedRuntimeSession` with `messageType: ''` still enforces ownership check        |
| Pub/Sub tenantId in channel key | Unit | `session-security.test.ts`        | Published channel key matches `session:{tenantId}:{sessionId}` format                              |
| Pub/Sub tenantId in channel key | Unit | `session-security.test.ts`        | Subscriber pattern includes tenantId                                                               |

### Phase 2 Tests

| Test                             | Type | File                               | What to Assert                                                       |
| -------------------------------- | ---- | ---------------------------------- | -------------------------------------------------------------------- |
| Cold restore data integrity      | E2E  | `session-cold-restore-e2e.test.ts` | Session fields match after cold restore                              |
| Cold restore rehydration         | E2E  | `session-cold-restore-e2e.test.ts` | Rehydrated session is writable (save returns true)                   |
| Cold restore conversation        | E2E  | `session-cold-restore-e2e.test.ts` | Conversation history is intact (including multimodal ContentBlock[]) |
| Cross-tenant list isolation      | E2E  | `session-cross-tenant-e2e.test.ts` | Tenant A list does not include Tenant B sessions                     |
| Cross-tenant get isolation       | E2E  | `session-cross-tenant-e2e.test.ts` | GET Tenant B session from Tenant A returns 404                       |
| Cross-tenant delete isolation    | E2E  | `session-cross-tenant-e2e.test.ts` | DELETE Tenant B session from Tenant A returns 404                    |
| Cross-tenant resume isolation    | E2E  | `session-cross-tenant-e2e.test.ts` | Session resolver refuses cross-tenant resume                         |
| Cross-tenant Redis key isolation | E2E  | `session-cross-tenant-e2e.test.ts` | Redis keys for Tenant A are not accessible to Tenant B               |

### Phase 3 Tests

| Test               | Type   | File                      | What to Assert                                                       |
| ------------------ | ------ | ------------------------- | -------------------------------------------------------------------- |
| Logger replacement | Verify | `session-service.test.ts` | All existing MemorySessionStore tests still pass after logger change |

---

## 6. Rollback Strategy

### Phase 1 (Security Fixes)

- **messageType fix**: Revert the single function to restore optional messageType behavior. Risk: re-opens GAP-007.
- **Pub/Sub fix**: Revert channel key format. Risk: re-opens GAP-008. Requires rolling restart.

### Phase 2 (E2E Tests)

- **No rollback needed**: E2E tests are additive (new files only). Deleting the test files is sufficient.

### Phase 3 (Logger Fix)

- **Revert**: Replace `log.warn()` back to `console.warn()`. Zero behavioral impact.

### General

- All phases are independently deployable and reversible.
- No database schema changes to roll back.
- Feature flags not required (changes are surgical and low-risk after Phase 1 security fixes).

---

## 7. Risk Assessment

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                            |
| ------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------- |
| messageType fix breaks an existing handler that intentionally omits messageType | Low        | Medium | Search all call sites before changing; add fallback to strictest check, not rejection |
| Pub/Sub key change causes missed events during rolling restart                  | Medium     | Low    | Redis Pub/Sub is best-effort; missed events during restart window are acceptable      |
| Cold restore E2E test is flaky due to Redis/MongoDB timing                      | Medium     | Low    | Use deterministic Redis key deletion instead of TTL-based expiry                      |
| Cross-tenant E2E requires two separate auth tokens in test harness              | Medium     | Low    | Create test helper that generates tenant-scoped JWT tokens                            |

---

## 8. Implementation Order

```
Phase 1: Security Fixes (GAP-007, GAP-008)     ← Start here
  └─ Phase 2: E2E Gap Closure (GAP-001, GAP-006)
       └─ Phase 3: Implementation Debt (GAP-005)
            └─ Phase 4: Documentation Sync
```

Each phase is independently committable and testable. Phase 1 should be prioritized due to HIGH severity of GAP-007.

---

## 9. Estimated Effort

| Phase                        | Effort         | Complexity                            | Risk                       |
| ---------------------------- | -------------- | ------------------------------------- | -------------------------- |
| Phase 1: Security Fixes      | 2-4 hours      | Medium (need to trace all call sites) | Medium (behavioral change) |
| Phase 2: E2E Gap Closure     | 4-8 hours      | Medium (infrastructure setup for E2E) | Low (additive tests)       |
| Phase 3: Implementation Debt | 30 minutes     | Low (mechanical replacement)          | Very Low                   |
| Phase 4: Documentation Sync  | 30 minutes     | Low (update gap statuses)             | Very Low                   |
| **Total**                    | **7-13 hours** |                                       |                            |

---

## 10. Success Criteria

After all phases are complete:

- [ ] Zero HIGH severity gaps in feature spec (GAP-007 resolved)
- [ ] Zero MEDIUM severity gaps related to security (GAP-008 resolved)
- [ ] Cold restore E2E test passes with real Redis + MongoDB
- [ ] Cross-tenant isolation E2E test passes with two tenant contexts
- [ ] No `console.warn` in production session code
- [ ] All documentation reflects current state
- [ ] `pnpm build --filter=@abl/runtime` passes
- [ ] `pnpm test --filter=@abl/runtime` passes with no regressions
- [ ] Test count increases by ~15-20 tests (Phase 1 + Phase 2)

---

## 11. References

- Feature Spec: [docs/features/memory-sessions.md](../features/memory-sessions.md)
- Test Spec: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
- HLD: [docs/specs/memory-sessions.hld.md](../specs/memory-sessions.hld.md)
- Session Compaction LLD: [docs/plans/session-compaction.lld.md](session-compaction.lld.md)
- Platform Principles: CLAUDE.md Core Invariants
