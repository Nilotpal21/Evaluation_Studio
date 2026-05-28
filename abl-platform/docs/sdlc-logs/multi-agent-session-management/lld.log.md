# LLD Log — Multi-Agent Session Management

## Phase: LLD

### Timestamp: 2026-03-23

### Oracle Decisions

**Implementation Strategy:**

- ANSWERED: Data layer first (thread locks + data namespace), then wiring into routing executor, then graph/fan-out/cold-storage. Matches existing codebase layering.
- ANSWERED: Follow `RedisSessionStore` patterns — Redis `SET NX PX` for thread locks, Lua scripts where atomicity is needed.
- ANSWERED: Feature flag `MULTI_AGENT_SESSION_V2` for phased rollout, checked at handoff time.
- DECIDED: Phase 1 scope = thread locks + data namespace + routing wiring. Graph, fan-out, cold storage are follow-on phases.

**Technical Details:**

- ANSWERED: 7 new files, 12 modified files identified. Exact paths verified against source tree.
- ANSWERED: Test-after for Phase 1 (unit tests validate thread lock and namespace merge). Integration tests in Phase 3 after wiring.
- ANSWERED: `SessionStore` interface extended with `acquireThreadLock`/`releaseThreadLock`. Both `RedisSessionStore` and `MemorySessionStore` get implementations.
- ANSWERED: No database migration — `ISessionStateThread` already has `handoffFrom`, `parentThreadId`, `forkPoint` fields. Just need to populate them.
- ANSWERED: Data namespace merge is a pure function — no side effects, testable in isolation.

**Risk & Dependencies:**

- DECIDED: Biggest risk is concurrent handoff corruption during thread lock transition. Mitigated by session-level lock fallback when V2 disabled.
- ANSWERED: No conflicting ongoing changes identified.
- ANSWERED: `RoutingExecutor.handleHandoff()` is the critical integration point — ~400 LOC method that must be modified carefully.
- ANSWERED: Monitoring: TraceEvents for lock acquisition/release, participation graph mutations.

### Design Decisions

| #   | Decision                                   | Rationale                             |
| --- | ------------------------------------------ | ------------------------------------- |
| D-1 | Thread lock via Redis `SET NX PX`          | Matches existing session lock pattern |
| D-2 | Data namespace merge as pure function      | Testable, no side effects             |
| D-3 | Participation graph as embedded subdoc     | Append-only, no joins                 |
| D-4 | Feature flag `MULTI_AGENT_SESSION_V2`      | Zero-downtime rollout                 |
| D-5 | Fan-out result TTL = 2x session TTL        | Results survive parent session expiry |
| D-6 | Cold storage fix is behavioral, not schema | Fields already exist                  |

### Implementation Phases

1. **Phase 1: Thread-Level Locking Infrastructure** — 3 new files, 2 modified. Redis `SET NX PX` pattern.
2. **Phase 2: Thread Data Namespacing** — 2 new files, 3 modified. Pure function merge + data mapping.
3. **Phase 3: Wire Thread Locks into Routing Executor** — 0 new files, 3 modified. Integration point.
4. **Phase 4: Participation Graph** — 2 new files, 4 modified. Embedded subdoc on Session model.
5. **Phase 5: Fan-Out Recovery Enhancement** — 0 new files, 3 modified. TTL + result persistence.
6. **Phase 6: Cold Storage Thread Edge Fix** — 0 new files, 2 modified. Populate existing fields.

### Files Created

- `docs/plans/2026-03-23-multi-agent-session-management-impl-plan.md`
- `docs/sdlc-logs/multi-agent-session-management/lld.log.md`

### Audit Summary

**Round 1:** Architecture compliance verified — thread locks follow existing `acquireLock` pattern, data namespace merge is stateless, participation graph uses tenant isolation plugin. All 10 FRs mapped to implementation tasks.

**Round 2:** Pattern consistency verified — Redis key layout matches `sess:{tenantId}:{id}` prefix convention, Lua scripts follow `LUA_SAVE`/`LUA_APPEND_CONV` patterns, error handling uses `{ success, data, error: { code, message } }` envelope.

**Round 3:** Completeness verified — file paths checked against source tree, function signatures verified against actual code (`createThread`, `syncThreadToSession`, `tryThreadReturn`, `RoutingExecutor.handleHandoff`). Wiring checklist has 21 items.

**Round 4:** Cross-phase consistency — LLD implements all HLD design decisions, covers all 7 E2E + 7 integration + 8 unit test scenarios from test spec. Feature flag strategy consistent across all artifacts.

**Round 5:** Final sweep — all tasks independently completable in one session, wiring checklist addresses DI registration, route registration, model exports, type exports. No TODO stubs. Rollback strategy per phase.
