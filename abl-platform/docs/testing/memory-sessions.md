# Feature Test Guide: Memory & Session Management

**Feature**: Session lifecycle, session stores (Redis/Memory/Tiered), conversation management, memory (REMEMBER/RECALL), session resolution, isolation, cleanup
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/memory-sessions.md](../features/memory-sessions.md)
**Last updated**: 2026-03-22
**Overall status**: STABLE

---

## Current State (as of 2026-03-22)

The Memory & Session Management feature has extensive unit and integration test coverage across the runtime, studio, and shared packages. Over 1,198 test cases across 57 test files cover session CRUD, Redis store operations, conversation sliding windows, session resolution, forking, cleanup/retention, security/isolation, memory executor, and Studio UI components.

### Quick Health Dashboard

| Area                           | Status | Tests | Notes                                                |
| ------------------------------ | ------ | ----- | ---------------------------------------------------- |
| Session Service (core)         | PASS   | 148   | CRUD, IR caching, conversation windows, factory      |
| Redis Session Store E2E        | PASS   | 66    | Full Redis integration with Lua scripts              |
| Redis Store Compression        | PASS   | 13    | Gzip compression for large fields                    |
| Redis Store Conversation       | PASS   | 20    | Conversation list operations, sliding window         |
| Tiered Session Store           | PASS   | 16    | Hot/cold tiering, rehydration from MongoDB           |
| Session Rehydration            | PASS   | 10    | Cold restore and data integrity                      |
| Session Routes API             | PASS   | 45    | REST endpoints for session CRUD + traces             |
| Session Resolver               | PASS   | 13    | Explicit ID, artifact, new session paths             |
| Session Resolver Gaps          | PASS   | 21    | Edge cases in resolution                             |
| Session Fork                   | PASS   | 12    | Thread-boundary forking                              |
| Session Factory                | PASS   | 16    | Transport-agnostic creation                          |
| Session Security               | PASS   | 32    | Encryption, tenant isolation, auth                   |
| Session Isolation (Repo)       | PASS   | 8     | Repository-level tenant scoping                      |
| Session Ownership Authz        | PASS   | 15    | User-level ownership verification                    |
| Chat Session Ownership         | PASS   | 8     | Chat endpoint ownership checks                       |
| Sessions Authz                 | PASS   | 88    | Authorization matrix for session operations          |
| Session Cleanup/Retention      | PASS   | 19    | Per-tenant retention, idle timeout, cleanup batching |
| Session TTL (Dynamic)          | PASS   | 17    | Max-age and idle-timeout TTL computation             |
| Session Metadata               | PASS   | 6     | Custom dimensions, tags, disposition                 |
| Session Counting               | PASS   | 8     | Message/token/error count tracking                   |
| Session Conversation Sync      | PASS   | 26    | Conversation history synchronization                 |
| Session Threading/Context      | PASS   | 35    | Multi-thread context management                      |
| Session Tracing/Logging        | PASS   | 34    | Trace event emission from sessions                   |
| Session Policy                 | PASS   | 6     | Guardrail policy enforcement                         |
| Session Policy Cache           | PASS   | 9     | Policy cache with TTL                                |
| Session Policy Inheritance     | PASS   | 4     | Policy inheritance across agent handoffs             |
| Session Health Entry           | PASS   | 4     | Health status tracking                               |
| Session Identity Integration   | PASS   | 9     | Identity tier, verification, caller context          |
| Session LLM Client Timeout     | PASS   | 10    | LLM client timeout handling per session              |
| Session PII Vault              | PASS   | 24    | PII redaction and vault persistence                  |
| Stale Session Reaper           | PASS   | 13    | Stale session detection and cleanup                  |
| Session Lifecycle (Legacy)     | PASS   | 29    | Pre-refactor lifecycle tests                         |
| Rate Limiter (Session)         | PASS   | 12    | Per-session message rate limiting                    |
| NLU Sidecar (Session)          | PASS   | 5     | Per-session NLU sidecar management                   |
| Channel Session Resolver       | PASS   | 10    | Channel-specific session resolution                  |
| HTTP Async Session Key         | PASS   | 3     | Async session key for HTTP transport                 |
| Admin Sessions Routes          | PASS   | 22    | Admin dashboard API                                  |
| Sessions Platform Events       | PASS   | 15    | Platform event emission from session routes          |
| Messages Cursor Pagination     | PASS   | ~10   | Cursor-based message pagination                      |
| Initialize Session             | PASS   | 17    | Session initialization use case                      |
| Initialize Session Prepopulate | PASS   | 15    | Pre-populated session context                        |
| Back-link Sessions             | PASS   | 16    | Session back-linking for orchestration               |
| Resolve Session (Identity)     | PASS   | 5     | Identity-context session resolution                  |
| Memory Executor                | PASS   | 21    | REMEMBER trigger evaluation                          |
| Memory Executor Events         | PASS   | 11    | Event matching for memory triggers                   |
| Memory Integration             | PASS   | 18    | End-to-end REMEMBER/RECALL integration               |
| Memory Scope Integration       | PASS   | 8     | Scoped memory isolation                              |
| Memory Decision Traces         | PASS   | 14    | Trace emission for memory decisions                  |
| Tool Memory Bridge             | PASS   | 19    | Sandbox-accessible memory bridge                     |
| Session Store (Studio)         | PASS   | 60    | Zustand store for chat session state                 |
| Session Store EndStreaming     | PASS   | 7     | Streaming end-state edge cases                       |
| Session Hooks (Studio)         | PASS   | 49    | SWR hooks for session data fetching                  |
| Session Pages (Studio)         | PASS   | 21    | SessionsListPage and SessionDetailPage rendering     |
| Session Model (Database)       | PASS   | 41    | Mongoose schema validation and indexes               |
| Session Ownership (Shared)     | PASS   | 15    | Shared session ownership middleware                  |
| Session Ownership Middleware   | PASS   | 8     | Middleware unit tests                                |
| Session Memory Validation      | PASS   | 17    | Compiler-level memory config validation              |

---

## Coverage Matrix: Functional Requirements to Test Types

| FR   | Requirement                                       | Unit | Integration | E2E | Manual |
| ---- | ------------------------------------------------- | ---- | ----------- | --- | ------ |
| FR-1 | Tiered storage (Redis hot + MongoDB cold restore) | PASS | PASS        | GAP | N/A    |
| FR-2 | Session resolution (explicit, artifact, new)      | PASS | PASS        | N/A | N/A    |
| FR-3 | Conversation sliding window management            | PASS | PASS        | N/A | N/A    |
| FR-4 | Distributed locks + optimistic concurrency        | PASS | PASS        | N/A | N/A    |
| FR-5 | Long-term memory (REMEMBER/RECALL, FactStore)     | PASS | PASS        | N/A | N/A    |
| FR-6 | Session management APIs + Studio UI               | PASS | PASS        | N/A | PASS   |
| FR-7 | Session forking at thread boundaries              | PASS | N/A         | N/A | N/A    |
| FR-8 | Encryption at rest + gzip compression             | PASS | PASS        | N/A | N/A    |
| FR-9 | Periodic cleanup with per-tenant retention        | PASS | N/A         | N/A | N/A    |

**Legend**: PASS = covered and passing, GAP = missing coverage, N/A = not applicable for this test type

---

## E2E Test Scenarios (Minimum 5 Required)

E2E tests exercise the real system through HTTP API calls without mocks or direct DB access.

### E2E-1: Session CRUD Through REST API

**Status**: PASS (partial — `session-redis.e2e.test.ts`)
**What it tests**: Create a session via POST, list via GET, inspect via GET /:id, delete via DELETE /:id, verify 404 after deletion.
**Preconditions**: Redis available, authenticated user with project scope.
**Assertions**:

- POST returns 201 with session ID
- GET list includes the created session
- GET detail returns full session state
- DELETE returns 200
- GET detail returns 404 after deletion

### E2E-2: Session Cold Restore After Redis TTL Expiry

**Status**: NOT TESTED (GAP-001)
**What it tests**: Create a session, write to cold storage, expire the Redis key, load session from cold storage, verify data integrity after rehydration.
**Preconditions**: Redis + MongoDB available, TieredSessionStore configured.
**Assertions**:

- Session loads successfully after Redis key is deleted
- Conversation history is intact after cold restore
- Session state (dataValues, threads, handoffStack) matches pre-expiry state
- Rehydrated session is written back to Redis for subsequent fast access

### E2E-3: Cross-Tenant Session Isolation

**Status**: NOT TESTED (GAP-006)
**What it tests**: Create sessions for two different tenants, attempt cross-tenant access, verify 404 responses.
**Preconditions**: Two tenant contexts with separate auth credentials.
**Assertions**:

- Tenant A cannot list Tenant B's sessions
- Tenant A cannot access Tenant B's session by ID (returns 404, not 403)
- Tenant A cannot resume Tenant B's session via WebSocket
- Tenant A cannot delete Tenant B's session
- Redis keys are properly scoped with tenant prefix

### E2E-4: Session Ownership and Identity Tiers

**Status**: PASS (via `sessions-authz.test.ts`, `session-ownership-authz.test.ts`)
**What it tests**: SDK user creates a session, different SDK user attempts access, verify tiered identity matching.
**Preconditions**: Multiple user contexts (anonymous, unverified, verified).
**Assertions**:

- Tier 0: Session token holder can access own session
- Tier 1: Same channel artifact can resume session
- Tier 2: Verified contact can access linked sessions
- Unknown identity returns 404
- Fail-closed: error in ownership check results in denial

### E2E-5: Session Cleanup and Retention

**Status**: PARTIAL (unit tests in `session-cleanup-retention.test.ts`, no real E2E)
**What it tests**: Create sessions, fast-forward retention clock, run cleanup job, verify sessions are properly deleted based on plan tier.
**Preconditions**: Database with sessions across multiple status/age combinations.
**Assertions**:

- Terminal sessions past retention TTL are deleted
- Active sessions past idle timeout are marked as ended with appropriate disposition
- Batch deletion processes in 500-session chunks
- Sessions within retention window are preserved
- TTL safety net index is respected

### E2E-6: Memory REMEMBER/RECALL Through Execution

**Status**: PASS (via `memory-integration.test.ts`, `memory-scope-integration.test.ts`)
**What it tests**: Agent with REMEMBER triggers processes a conversation, verify facts are stored, start new session, verify RECALL loads saved facts.
**Preconditions**: Agent DSL with REMEMBER/RECALL config, FactStore available.
**Assertions**:

- REMEMBER trigger fires when condition matches
- Fact is stored with correct key and scoped to (tenantId, userId, projectId)
- RECALL loads facts on session_start
- Facts are injected into session context at the specified path
- Memory errors are traced but never throw

### E2E-7: Session Resolution via Channel Artifact

**Status**: PARTIAL (unit tests in `session-resolver.test.ts`)
**What it tests**: Client connects with a channel artifact, session is created with resolution key, client reconnects with same artifact, session resumes.
**Preconditions**: Redis available, channel artifact hash registered.
**Assertions**:

- First connection creates new session and registers resolution key
- Second connection with same artifact resumes existing session
- Resolution key with expired TTL triggers new session creation
- Different tenant with same artifact cannot resolve the session

---

## Integration Test Scenarios (Minimum 5 Required)

Integration tests test real service boundaries without mocking codebase components.

### INT-1: Redis Session Store Full Lifecycle

**Status**: PASS (`session-redis.e2e.test.ts` — 66 tests)
**What it tests**: Session CRUD with real Redis commands, Lua script execution, encryption/compression, TTL management.
**Service boundaries**: Redis client, EncryptionService, compression pipeline.

### INT-2: Session Conversation Synchronization

**Status**: PASS (`session-conversation-sync.test.ts` — 26 tests)
**What it tests**: Append messages, trim sliding window, save+replace conversation atomically, verify consistency between in-memory and store state.
**Service boundaries**: SessionService, SessionStore, conversation window config.

### INT-3: Session Identity and Ownership

**Status**: PASS (`session-identity-integration.test.ts` — 9 tests)
**What it tests**: Session creation with CallerContext, identity tier assignment, verification method recording, channel artifact hashing.
**Service boundaries**: SessionResolver, SessionBootstrap, shared-auth middleware.

### INT-4: Session Routes with Full Middleware Chain

**Status**: PASS (`session-routes.test.ts` — 45 tests, `sessions-authz.test.ts` — 88 tests)
**What it tests**: REST endpoints with auth, rate limiting, project scope, session ownership, RBAC checks.
**Service boundaries**: Express middleware chain, session repos, auth middleware.

### INT-5: Admin Sessions Dashboard

**Status**: PASS (`admin-sessions.test.ts` — 22 tests)
**What it tests**: Admin list, detail, and stats endpoints with tenant-scoped access control.
**Service boundaries**: Admin routes, session repos, auth + permission middleware.

### INT-6: Tiered Session Store Cold Fallback

**Status**: PASS (`tiered-session-store.test.ts` — 16 tests)
**What it tests**: Hot read, cold fallback, rehydration to primary, fire-and-forget cold writes, delegated operations.
**Service boundaries**: TieredSessionStore, SessionStateRepo (MongoDB), primary store.

### INT-7: Memory Bridge for Sandbox Pods

**Status**: PASS (`tool-memory-bridge.test.ts` — 19 tests)
**What it tests**: JWT-authenticated memory API, bridge registration/lookup, get/set/delete operations, error handling.
**Service boundaries**: Memory API route, MemoryBridgeRegistry, ToolMemoryBridge.

---

## Existing Test File Inventory

### Runtime -- Session Core (`apps/runtime/src/__tests__/`)

| File                                      | Type        | Tests  | Coverage Area                            |
| ----------------------------------------- | ----------- | ------ | ---------------------------------------- |
| `session-service.test.ts`                 | Unit        | 148    | SessionService CRUD, IR caching, windows |
| `session-redis.e2e.test.ts`               | Integration | 66     | Full Redis session store integration     |
| `redis-session-store-compression.test.ts` | Unit        | 13     | Gzip compression for large fields        |
| `redis-session-store-conv.test.ts`        | Unit        | 20     | Conversation list operations             |
| `tiered-session-store.test.ts`            | Unit        | 16     | Hot/cold tiering, rehydration            |
| `session-rehydration.test.ts`             | Unit        | 10     | Cold restore data integrity              |
| `session-routes.test.ts`                  | Integration | 45     | REST API endpoints                       |
| `session-resolver.test.ts`                | Unit        | 13     | Session resolution paths                 |
| `session-resolver-gaps.test.ts`           | Unit        | 21     | Resolution edge cases                    |
| `session-fork.test.ts`                    | Unit        | 12     | Session forking                          |
| `session-factory.test.ts`                 | Unit        | 16     | Transport-agnostic creation              |
| `session-security.test.ts`                | Unit        | 32     | Encryption, tenant isolation             |
| `session-repo-isolation.test.ts`          | Unit        | 8      | Repository tenant scoping                |
| `session-ownership-authz.test.ts`         | Unit        | 15     | User ownership verification              |
| `session-ownership-validator.test.ts`     | Unit        | varies | Ownership validator functions            |
| `chat-session-ownership.test.ts`          | Unit        | 8      | Chat endpoint ownership                  |
| `sessions-authz.test.ts`                  | Integration | 88     | Authorization matrix                     |
| `session-cleanup-retention.test.ts`       | Unit        | 19     | Per-tenant retention                     |
| `session-ttl-dynamic.test.ts`             | Unit        | 17     | Dynamic TTL computation                  |
| `session-metadata.test.ts`                | Unit        | 6      | Custom dimensions, disposition           |
| `session-counting.test.ts`                | Unit        | 8      | Message/token counting                   |
| `session-conversation-sync.test.ts`       | Integration | 26     | Conversation synchronization             |
| `session-threading-context.test.ts`       | Unit        | 35     | Multi-thread context                     |
| `session-tracing-logging.test.ts`         | Unit        | 34     | Trace event emission                     |
| `session-identity-integration.test.ts`    | Integration | 9      | Identity tier, verification              |
| `session-llm-client-timeout.test.ts`      | Unit        | 10     | LLM client timeout per session           |
| `session-pii-vault.test.ts`               | Unit        | 24     | PII redaction and vault                  |
| `session-health-entry.test.ts`            | Unit        | 4      | Health status tracking                   |
| `stale-session-reaper.test.ts`            | Unit        | 13     | Stale session detection                  |
| `rate-limiter-session-message.test.ts`    | Unit        | 12     | Per-session rate limiting                |
| `nlu-sidecar-per-session.test.ts`         | Unit        | 5      | NLU sidecar management                   |
| `channels-session-resolver.test.ts`       | Unit        | 10     | Channel session resolution               |
| `http-async-session-key.test.ts`          | Unit        | 3      | Async session key                        |
| `repos-session.test.ts`                   | Unit        | 47     | Session repository CRUD                  |
| `sdk-session-token.test.ts`               | Unit        | varies | SDK session token handling               |
| `pre-refactor/session-lifecycle.test.ts`  | Unit        | 29     | Legacy lifecycle tests                   |

### Runtime -- Contexts (`apps/runtime/src/__tests__/contexts/`)

| File                                                   | Type | Tests | Coverage Area                 |
| ------------------------------------------------------ | ---- | ----- | ----------------------------- |
| `orchestration/initialize-session.test.ts`             | Unit | 17    | Session initialization        |
| `orchestration/initialize-session-prepopulate.test.ts` | Unit | 15    | Pre-populated session context |
| `orchestration/back-link-sessions.test.ts`             | Unit | 16    | Session back-linking          |
| `identity/resolve-session.test.ts`                     | Unit | 5     | Identity-context resolution   |

### Runtime -- Guardrails / Execution (`apps/runtime/src/`)

| File                                                        | Type | Tests  | Coverage Area             |
| ----------------------------------------------------------- | ---- | ------ | ------------------------- |
| `__tests__/guardrails/session-policy-inheritance.test.ts`   | Unit | 4      | Policy inheritance        |
| `services/execution/__tests__/session-policy.test.ts`       | Unit | 6      | Policy enforcement        |
| `services/execution/__tests__/session-policy-cache.test.ts` | Unit | 9      | Policy cache              |
| `__tests__/middleware/session-access.test.ts`               | Unit | varies | Session access middleware |
| `services/session/__tests__/session-store-modules.test.ts`  | Unit | varies | Store module loading      |

### Runtime -- Routes (`apps/runtime/src/routes/__tests__/`)

| File                               | Type        | Tests | Coverage Area           |
| ---------------------------------- | ----------- | ----- | ----------------------- |
| `admin-sessions.test.ts`           | Integration | 22    | Admin dashboard API     |
| `sessions-platform-events.test.ts` | Integration | 15    | Platform event emission |

### Runtime -- Memory (`apps/runtime/src/__tests__/`)

| File                               | Type        | Tests | Coverage Area               |
| ---------------------------------- | ----------- | ----- | --------------------------- |
| `memory-executor.test.ts`          | Unit        | 21    | REMEMBER trigger evaluation |
| `memory-executor-events.test.ts`   | Unit        | 11    | Event matching              |
| `memory-integration.test.ts`       | Integration | 18    | End-to-end REMEMBER/RECALL  |
| `memory-scope-integration.test.ts` | Integration | 8     | Scoped memory isolation     |
| `memory-decision-traces.test.ts`   | Unit        | 14    | Memory decision traces      |
| `tool-memory-bridge.test.ts`       | Unit        | 19    | Sandbox memory bridge       |

### Studio (`apps/studio/src/__tests__/`)

| File                                 | Type | Tests | Coverage Area                  |
| ------------------------------------ | ---- | ----- | ------------------------------ |
| `session-store.test.ts`              | Unit | 60    | Zustand session store          |
| `session-store-endstreaming.test.ts` | Unit | 7     | Streaming end-state edge cases |
| `session-hooks.test.ts`              | Unit | 49    | SWR hooks for session data     |

### Packages

| File                                                                | Type | Tests | Coverage Area                     |
| ------------------------------------------------------------------- | ---- | ----- | --------------------------------- |
| `packages/database/src/__tests__/model-session.test.ts`             | Unit | 41    | Mongoose schema validation        |
| `packages/shared-auth/src/__tests__/session-ownership.test.ts`      | Unit | 15    | Session ownership middleware      |
| `packages/compiler/src/__tests__/session-memory-validation.test.ts` | Unit | 17    | Memory config compiler validation |

---

## Summary Statistics

| Category                   | Test Files | Total Tests |
| -------------------------- | ---------- | ----------- |
| Runtime -- Session Core    | 36         | ~815        |
| Runtime -- Contexts        | 4          | ~53         |
| Runtime -- Guardrails/Exec | 5          | ~25         |
| Runtime -- Routes          | 2          | ~37         |
| Runtime -- Memory          | 6          | ~91         |
| Studio                     | 3          | ~116        |
| Packages                   | 3          | ~73         |
| **Total**                  | **59**     | **~1,210**  |

---

## Open Gaps

### High Severity

- **GAP-006**: Cross-tenant isolation not E2E tested with real multi-tenant credentials
  - **Severity**: High
  - **Reason**: Only unit tests verify tenant scoping; need separate tenants with own auth
  - **Recommendation**: Create E2E-3 scenario with two tenant contexts

- **GAP-007**: `getAuthorizedRuntimeSession` messageType optional bypass
  - **Severity**: High
  - **Reason**: Ownership check can be skipped when messageType is falsy
  - **Recommendation**: Fix code + add regression test

### Medium Severity

- **GAP-001**: No E2E tests for session persistence across runtime restarts
  - **Severity**: Medium
  - **Reason**: Requires orchestrating runtime restart during test (Redis TTL expiry -> cold restore -> new pod)
  - **Recommendation**: Create E2E-2 scenario

- **GAP-003**: WebSocket session reconnection not integration tested
  - **Severity**: Medium
  - **Reason**: Requires WS client lifecycle testing
  - **Recommendation**: Add WS reconnect scenario

- **GAP-008**: Redis Pub/Sub tenantId gap
  - **Severity**: Medium
  - **Reason**: Cross-pod session event delivery uses channel keys without tenantId
  - **Recommendation**: Fix channel key format + add regression test

### Low Severity

- **GAP-004**: Session forking not tested with TieredSessionStore (cold persistence of forks)
  - **Severity**: Low
  - **Reason**: Unit tests use MemorySessionStore; needs Redis + MongoDB setup

- **GAP-005**: Auto-compaction not tested (feature not yet enabled)
  - **Severity**: Low
  - **Reason**: `compactionEnabled: false` by default

---

## Test Environment Requirements

### Infrastructure

- **Redis**: Required for integration tests (`session-redis.e2e.test.ts`). Tests connect to local Redis instance.
- **MongoDB**: Required for cold storage tests. Uses MongoMemoryServer in some tests.
- **Docker**: Not required for unit tests; recommended for full integration suite.

### Configuration

```bash
# Minimum env for running session tests
SESSION_STORE=redis        # or 'memory' for unit-only
REDIS_URL=redis://localhost:6379
MONGODB_URI=mongodb://localhost:27017/test
```

### Running Tests

```bash
# All session-related tests
pnpm test --filter=@abl/runtime -- --grep "session"

# Specific test files
pnpm test --filter=@abl/runtime -- session-service
pnpm test --filter=@abl/runtime -- session-redis-e2e
pnpm test --filter=@abl/runtime -- sessions-authz

# Studio session tests
pnpm test --filter=@abl/studio -- session

# Database model tests
pnpm test --filter=@agent-platform/database -- model-session
```

---

## Pending / Future Work

- [ ] E2E session persistence across runtime restart (cold restore) — E2E-2
- [ ] Cross-tenant isolation E2E with two fully separate tenants — E2E-3
- [ ] WebSocket reconnect integration test
- [ ] Session forking with TieredSessionStore
- [ ] Auto-compaction tests (when enabled)
- [ ] Load testing with concurrent sessions at scale
- [ ] Studio session sidebar E2E tests
- [ ] Memory API (sandbox bridge) integration test with real sandbox JWT
- [ ] Fix GAP-007 (messageType bypass) + regression test
- [ ] Fix GAP-008 (Redis Pub/Sub tenantId) + regression test
