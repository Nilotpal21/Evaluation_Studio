# High-Level Design: Memory & Session Management

**Feature**: Memory & Session Management
**Status**: BETA (documenting existing architecture plus active lifecycle gaps)
**Feature Spec**: [docs/features/memory-sessions.md](../features/memory-sessions.md)
**Test Spec**: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
**Date**: 2026-03-30

---

## 1. Problem Statement

Conversational AI agents require persistent, isolated, low-latency state management that survives across messages, transport reconnections, pod restarts, and channel switches. The system must balance sub-millisecond hot-path access during active conversations with durable cold-path recovery when Redis TTLs expire, while enforcing strict tenant/project/user isolation at every data-access layer.

The current implementation is a mature subsystem, but timeout and disposition behavior still have active unification gaps across runtime sessions, channel disconnect handling, and agent-transfer flows. This HLD documents the existing architecture and the major constraints the streamlining work must preserve.

---

## 2. Alternatives Considered

### Alternative A: Single-Tier MongoDB-Only Storage

**Description**: Store all session state directly in MongoDB, using read-through caching at the application layer.

**Pros**:

- Simpler architecture (one storage tier)
- No Redis dependency
- Durable by default

**Cons**:

- Higher latency for hot-path reads (5-20ms vs <1ms for Redis)
- MongoDB write amplification on every turn (full document updates)
- No built-in TTL with sub-second precision for execution locks
- Connection pooling pressure under high session concurrency

**Why rejected**: Sub-millisecond session access is critical for the execution hot path. MongoDB's write-then-read latency would add 10-40ms per turn, which compounds across multi-turn conversations and handoff chains.

### Alternative B: Pod-Local In-Memory State (No Redis)

**Description**: Keep session state in process memory, replicate via gossip protocol or sticky sessions.

**Pros**:

- Zero-latency reads (in-process)
- No external dependency

**Cons**:

- Violates the "no pod-local state as truth" invariant (CLAUDE.md #3)
- Session loss on pod restart
- Sticky sessions break horizontal scaling
- No distributed lock mechanism

**Why rejected**: Fundamentally incompatible with the platform's stateless distributed architecture. Pod-local state cannot be the source of truth in a multi-pod deployment.

### Alternative C (Chosen): Tiered Redis + MongoDB with Cold Restore

**Description**: Redis as the hot store for active sessions, MongoDB as the cold store for durable persistence. Automatic rehydration from cold to hot on cache miss.

**Pros**:

- Sub-millisecond hot-path access via Redis
- Durable persistence via MongoDB with configurable TTLs
- Automatic cold restore eliminates session loss
- Native distributed locks (SET NX PX)
- Transparent tiering via `TieredSessionStore` wrapper

**Cons**:

- Two storage systems to manage
- Fire-and-forget cold writes may lag behind hot state briefly
- Cold restore adds ~100-200ms latency on first access after Redis eviction

**Why chosen**: Best balance of latency, durability, and architectural fit. The `TieredSessionStore` wrapper makes tiering transparent to callers.

---

## 3. System Context

```
                    ┌─────────────┐
                    │   Studio    │
                    │  (Next.js)  │
                    └──────┬──────┘
                           │ HTTP proxy
                           ▼
┌──────────┐     ┌─────────────────┐     ┌──────────┐
│  SDK/Web │────►│     Runtime     │◄────│  Voice   │
│  Client  │ WS  │   (Express)    │ WS  │  Client  │
└──────────┘     └────────┬────────┘     └──────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │SessionService│ │  Memory     │ │  Session    │
   │   + Store   │ │  Executor   │ │  Resolver   │
   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
          │               │               │
          ▼               ▼               │
   ┌─────────────────────────────┐        │
   │    TieredSessionStore       │        │
   │  ┌────────┐  ┌──────────┐  │        │
   │  │ Redis  │  │ MongoDB  │  │        │
   │  │ (Hot)  │  │ (Cold)   │  │        │
   │  └────────┘  └──────────┘  │        │
   └─────────────────────────────┘        │
                                          │
   ┌─────────────────────────────┐        │
   │       FactStore             │◄───────┘
   │  (Long-term Memory)         │
   └─────────────────────────────┘
```

### Component Responsibilities

| Component                    | Responsibility                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------- |
| **SessionService**           | Orchestration: session lifecycle, IR resolution (L1+L2), conversation windows   |
| **SessionStore** (interface) | Contract for session state persistence (CRUD, conversation, locks, resolution)  |
| **RedisSessionStore**        | Hot store: Lua atomic saves, encryption, compression, tenant-prefixed keys      |
| **MemorySessionStore**       | Fallback: in-memory LRU (10K max), single-pod only                              |
| **TieredSessionStore**       | Wrapper: hot primary + cold MongoDB with auto-rehydration                       |
| **SessionStateRepo**         | MongoDB CRUD for `session_states` cold storage                                  |
| **SessionResolver**          | Determines whether to resume or create: explicit ID, artifact, or new           |
| **SessionBootstrap**         | Deployment-aware session creation (agent loading, compilation, tool resolution) |
| **SessionFactory**           | Transport-agnostic session creation for WS/HTTP/SDK handlers                    |
| **MemoryExecutor**           | REMEMBER trigger evaluation and RECALL instruction execution                    |
| **MemoryIntegration**        | Facade connecting FactStore to execution pipeline (fire-and-forget safe)        |
| **ToolMemoryBridge**         | Memory API bridge for sandbox pod callbacks                                     |
| **MemoryBridgeRegistry**     | Maps sessionId to in-process bridge (bounded, 10K max, 1h TTL)                  |
| **CompactionEngine**         | Context window compaction (planned, not yet enabled)                            |
| **SessionCleanupJob**        | Periodic cleanup with per-tenant retention policies                             |

---

## 4. Component Architecture

### Session Store Hierarchy

```
SessionStore (interface)
  ├── MemorySessionStore (in-process LRU, 10K cap)
  ├── RedisSessionStore (Lua scripts, encryption, compression)
  └── TieredSessionStore (wraps any primary + MongoDB cold)
          ├── primary: RedisSessionStore | MemorySessionStore
          └── cold: SessionStateRepo (MongoDB)
```

### Session Lifecycle State Machine

```
                     ┌───────────┐
  SessionBootstrap──►│  Created  │
                     └─────┬─────┘
                           │ ON_START
                           ▼
                     ┌───────────┐
              ┌─────►│  Active   │◄─────┐
              │      └─────┬─────┘      │
              │            │            │
     resume   │      ┌─────┼─────┐      │ handoff
              │      │     │     │      │ return
              │      ▼     ▼     ▼      │
         ┌────┴─┐ ┌────┐ ┌────┐ ┌──────┴─┐
         │ Idle │ │Fork│ │Esc │ │Handoff  │
         └──────┘ └────┘ └────┘ └────────┘
              │                      │
              │     timeout/         │ complete
              │     cleanup          │
              ▼                      ▼
         ┌──────────┐         ┌───────────┐
         │ Abandoned │         │ Completed │
         └──────────┘         └───────────┘
              │                      │
              └──────────┬───────────┘
                         ▼
                   ┌───────────┐
                   │ Archived  │
                   └───────────┘
```

### IR Resolution Cache Layers

```
L1: Pod-local LRU (50 entries, in-process)
  ↓ miss
L2: Redis (2h TTL, shared across pods)
  ↓ miss
L3: Recompile from DSL/deployment
```

### Conversation Sliding Window

```
Before trim (41 messages, window=40):
  [system] [user1] [asst1] [user2] [asst2] ... [user20] [asst20] [userN]

After trim (40 messages):
  [system] [user2] [asst2] [user3] [asst3] ... [user20] [asst20] [userN]

Rule: Keep first message (system/bootstrap) + last (N-1) messages
Lua script: LINDEX first, LTRIM to window, LPUSH first back
```

---

## 5. Data Flow Diagrams

### Session Creation Flow

```
Client ──► WS/HTTP Handler
                │
                ▼
         SessionBootstrap
                │
          ┌─────┼─────┐
          │            │
          ▼            ▼
   DeploymentResolver  DSL Compilation
          │            │
          └─────┬──────┘
                │ ResolvedAgent
                ▼
         SessionService.createSession()
                │
          ┌─────┼─────┐
          │            │
          ▼            ▼
    Cache IR/Comp   Create SessionData
    (L1 + L2)       (version: 0)
                │
                ▼
         SessionStore.create()
                │
          ┌─────┼─────┐
          │            │
          ▼            ▼
     Redis HSET    Cold persist
     + RPUSH       (fire-and-forget)
```

### Session Load + Execution Flow

```
Incoming Message
      │
      ▼
SessionResolver.resolveSession()
      │
  ┌───┼───────┐──────────┐
  │           │           │
  ▼           ▼           ▼
Explicit   Artifact    New Session
Session ID  Lookup
  │           │           │
  └─────┬─────┘           │
        │                 │
        ▼                 │
SessionService.loadSession()
        │                 │
  ┌─────┼─────┐           │
  │           │           │
  ▼           ▼           │
Redis       Cold          │
(hot)     Restore         │
  │           │           │
  └─────┬─────┘           │
        │                 │
        ▼                 │
  Resolve IR (L1→L2)     │
        │                 │
        ▼                 │
  HydratedSession ◄──────┘
        │
        ▼
  acquireLock() ── Redis SET NX PX
        │
        ▼
  Execute Turn (RuntimeExecutor)
        │
        ▼
  appendToConversation() + trimConversation()
        │
        ▼
  saveSession() ── Lua version check
        │
        ▼
  releaseLock()
```

### Memory (REMEMBER/RECALL) Flow

```
Session Start
      │
      ▼
initializeAllMemory()
      │
  ┌───┼───────────┐
  │               │
  ▼               ▼
Load Persistent  Execute RECALL
Defaults         (session_start)
(getMany, 1 RT)  from FactStore
  │               │
  └───────┬───────┘
          │
          ▼
  Inject into session.data.values

                    ...turns execute...

After State Change (entity/tool/SET)
      │
      ▼
evaluateRememberTriggers()
      │
      ▼
  Condition match? ─── No ──► skip
      │ Yes
      ▼
  factStore.set(key, value, {ttl})
  (fire-and-forget, isolated errors)
      │
      ▼
  Emit memory_remember trace
```

---

## 6. Twelve Architectural Concerns

### 6.1 Isolation

**Tenant isolation**: Every Redis key is tenant-prefixed (`sess:{tenantId}:{id}`). Every MongoDB query includes `tenantId` in the filter. The `tenantIsolationPlugin` Mongoose plugin enforces this at the ORM level. Cross-tenant access returns 404, not 403.

**Project isolation**: Session routes are under `/api/projects/:projectId/sessions`. The `requireProjectScope` middleware verifies project membership. Sessions are queried with `{ tenantId, projectId }` compound filters.

**User isolation**: Session ownership middleware (`createRequireSessionOwnership`) implements tiered identity matching (Tier 0: session token, Tier 1: channel artifact, Tier 2: verified contact). Fail-closed: any error or indeterminate match results in 404.

### 6.2 Security

- Encryption at rest via `EncryptionService` with per-tenant keys for sensitive fields
- Gzip compression before encryption for fields > 1KB
- Execution locks prevent concurrent modification (Redis `SET NX PX`)
- PII vault with encrypted vault data per session
- Sandbox JWT authentication for memory API bridge
- Admin routes gated by `tenant:manage_settings` permission
- Session ownership middleware on all `:id`-parameterized routes

### 6.3 Performance

- **Hot path**: Redis `HGETALL` + `LRANGE` in one pipeline (< 1ms)
- **Lua scripts**: Atomic version-check-then-save eliminates race conditions without application-level retries
- **L1 cache**: Pod-local LRU (50 entries) for IR resolution, avoiding Redis round-trip
- **Compression**: Gzip for large fields (threads, dataValues) reduces Redis memory footprint
- **Conversation window**: Default 40 messages with sliding window to bound token costs
- **Cold persistence**: Fire-and-forget MongoDB writes to avoid hot-path latency impact
- **Batch cleanup**: 500-session deletion batches prevent table-level MongoDB locks

### 6.4 Reliability

- **Tiered storage**: Redis failure falls back to MemorySessionStore. Cold storage failure is non-blocking.
- **Optimistic concurrency**: Version conflicts return false; callers reload and retry.
- **Memory error isolation**: All REMEMBER/RECALL operations wrap in try/catch; emit `memory_error` trace but never throw.
- **Stale session reaper**: Periodic detection and cleanup of orphaned sessions.
- **TTL safety net**: MongoDB TTL index (400 days on `sessions.endedAt`) catches sessions that escape retention scheduler.

### 6.5 Observability

- Structured logging via `createLogger('module-name')` with contextual fields (sessionId, tenantId)
- Trace events emitted to TraceStore: `session_start`, `session_end`, `session_fork`, `memory_recall`, `memory_remember`, `memory_error`
- Memory decision traces include fact keys, values, outcomes, and timing
- Studio hooks (`useSessionHealth`, `useSessionDetail`) surface session state to operators
- Admin dashboard provides aggregate statistics (sessions by status/channel, total messages/tokens/cost)

### 6.6 Data Lifecycle

- Hot storage: Redis TTL (default 24h, configurable per-tenant via `maxAgeSeconds` and `idleSeconds`) governs hot-store eviction, not a guaranteed final session end if cold restore is enabled
- Cold storage: MongoDB TTL via `expiresAt` index (default 90 days)
- Cleanup job: Periodic with per-tenant plan-based retention
- Safety net: MongoDB `endedAt` TTL (400 days) on `sessions` collection
- Right to erasure: Session delete cascades across Redis + MongoDB + resolution keys
- Active gap: project-level timeout/disconnect settings and agent-level timeout overrides are not yet unified across runtime, SDK, channel disconnect, and transfer-session paths; see [Session Timeout & Disposition Unification](../features/sub-features/session-timeout-disposition-unification.md)

### 6.7 Deployment

- Redis and MongoDB are external infrastructure; session service runs within the Runtime pod
- `ensureSessionService()` async factory auto-detects Redis availability and wraps with TieredSessionStore
- `MemorySessionStore` serves as zero-dependency fallback for development/testing
- No separate deployment artifact; session management is an integral part of the Runtime service

### 6.8 Migration

- No active migration needed (STABLE feature)
- Schema changes to `session_states` require forward-compatible additions (new optional fields)
- Redis key format changes require coordinated rollout (current format: `sess:{tenantId}:{id}`)
- If Redis Pub/Sub channel keys add `tenantId` (GAP-008), old subscribers will stop receiving on old channels — requires rolling restart

### 6.9 Backwards Compatibility

- `SessionStore` interface is the stability contract; new stores must implement all methods
- `saveAndReplaceConversation` is optional (indicated by `?` in interface) — non-implementing stores fall back to sequential calls
- Cold storage format is versioned via `version` field on `session_states`
- MemorySessionStore maintains API parity for testing without Redis

### 6.10 Testing Strategy

- **Unit tests** (~780 runtime, ~137 studio, ~81 packages): Cover all service methods, store operations, and component rendering
- **Integration tests** (~200): Cover Redis operations, route middleware chains, admin API, conversation sync
- **E2E gap**: Cold restore across restart (GAP-001) and cross-tenant isolation (GAP-006) need real infrastructure tests
- See [test spec](../testing/memory-sessions.md) for full inventory

### 6.11 Monitoring

- Redis key count and memory usage (via Redis INFO)
- MongoDB collection sizes and index hit ratios
- Session creation rate, cold restore frequency, lock contention rate (via trace events)
- Cleanup job execution frequency and deleted session counts (via structured logs)
- Stale session reaper detection rate

### 6.12 Error Handling

- All session store operations use structured error logging, never bare `console.log`
- Memory operations use fire-and-forget with isolated error tracing (never throw)
- Version conflicts are expected (optimistic concurrency) — callers handle retries
- Cold storage failures are logged as warnings and do not block hot-path operations
- Session resolution failures fall through to "new session" creation
- Admin endpoints return standardized error envelopes: `{ success: false, error: { code, message } }`

---

## 7. API Design

### Session Resolution Algorithm

```
Input: { tenantId, channelId?, explicitSessionId?, callerContext, resolutionStrategy? }

1. if strategy === 'always_new' → return { outcome: 'new' }
2. if explicitSessionId:
   a. load from store
   b. if found AND tenantId matches → return { outcome: 'existing', sessionId }
   c. if found AND tenantId mismatch → return { outcome: 'new', reason: 'tenant_mismatch' }
   d. if not found → fall through
3. if channelId AND callerContext.channelArtifact:
   a. compute artifactHash
   b. look up resolution key: resolve:{tenantId}:{channelId}:{hash}
   c. if found → verify session exists → return { outcome: 'existing', sessionId }
   d. if not found → fall through
4. return { outcome: 'new' }
```

### Optimistic Save Protocol (Lua Script)

```
KEYS[1] = sess:{tenantId}:{id}
ARGV[1] = expected version
ARGV[2] = TTL in seconds
ARGV[3..N] = field/value pairs

1. HGET KEYS[1] version
2. if current version != expected → return 0 (conflict)
3. HMSET KEYS[1] field/value pairs
4. HINCRBY KEYS[1] version 1
5. EXPIRE KEYS[1] TTL
6. return 1 (success)
```

### Conversation Trim Algorithm (Lua Script)

```
After append:
1. LLEN list
2. if len <= maxMessages → done
3. Save LINDEX 0 (first message)
4. LTRIM to keep last (maxMessages - 1)
5. LPUSH first message back

Result: [first_msg, msg_(N-window+2), ..., msg_N]
```

---

## 8. Data Model Summary

| Collection       | Purpose                                     | Key Indexes                                                | TTL                                            |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `sessions`       | Lifecycle records (authoritative DB record) | `{tenantId, projectId, status, lastActivityAt}`            | 400-day safety net on `endedAt`                |
| `session_states` | Cold snapshots (compressed, encrypted)      | `{tenantId, _id}`, `{tenantId, projectId, lastActivityAt}` | Configurable via `expiresAt` (default 90 days) |

| Redis Key Pattern                       | Purpose           | TTL                               |
| --------------------------------------- | ----------------- | --------------------------------- |
| `sess:{tenantId}:{id}`                  | Session hash      | 24h default (per-tenant override) |
| `sess:{tenantId}:{id}:conv`             | Conversation list | Same as session                   |
| `ir:{hash}`                             | AgentIR cache     | 2h                                |
| `lock:exec:{tenantId}:{id}`             | Execution mutex   | 5s                                |
| `resolve:{tenantId}:{channelId}:{hash}` | Resolution key    | Configurable                      |

---

## 9. Security Model

### Authentication Matrix

| Endpoint Type          | Auth Method                             | Permission Required        |
| ---------------------- | --------------------------------------- | -------------------------- |
| Project session routes | JWT/API key + `requireProjectScope`     | Project membership         |
| Session `:id` routes   | Above + `createRequireSessionOwnership` | Session ownership (tiered) |
| Admin routes           | JWT + `requirePermission`               | `tenant:manage_settings`   |
| Memory API             | Sandbox JWT                             | Valid sandbox token        |

### Encryption Layers

| Layer             | Mechanism                                | Scope                                                              |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Redis at-rest     | `EncryptionService` with per-tenant keys | authToken, state, dataValues, callerContext, threads, piiVaultData |
| Redis compression | Gzip for fields > 1KB                    | Same fields (before encryption)                                    |
| MongoDB at-rest   | `encryptionPlugin` on schema             | stateData, irData, compilationData                                 |
| Transit           | TLS (HTTPS/WSS)                          | All network traffic                                                |

---

## 10. Known Limitations & Open Issues

| Issue                                                        | Severity | Mitigation                                                               |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| Cold restore does not rehydrate IR/compilation (only hashes) | Medium   | IR re-resolved from deployment; compilation re-triggered if needed       |
| `saveAndReplaceConversation` not fully atomic (2 trips)      | Low      | Version check on first trip catches conflicts; second trip is idempotent |
| Auto-compaction disabled                                     | Low      | Feature-gated; CompactionEngine ready for activation                     |
| `MemorySessionStore` uses `console.warn`                     | Low      | Functional but violates logging standard                                 |
| `getAuthorizedRuntimeSession` messageType bypass             | High     | Needs code fix: require messageType or default to strict                 |
| Redis Pub/Sub lacks tenantId in channel key                  | Medium   | Needs key format change + rolling restart                                |

---

## 11. References

- Feature Spec: [docs/features/memory-sessions.md](../features/memory-sessions.md)
- Test Spec: [docs/testing/memory-sessions.md](../testing/memory-sessions.md)
- Session Compaction HLD: [docs/specs/session-compaction.hld.md](session-compaction.hld.md)
- Omnichannel Session Continuity HLD: [docs/specs/omnichannel-session-continuity.hld.md](omnichannel-session-continuity.hld.md)
- A2A Multi-Turn Session Management: [docs/plans/2026-03-17-a2a-multi-turn-session-management.md](../plans/2026-03-17-a2a-multi-turn-session-management.md)
