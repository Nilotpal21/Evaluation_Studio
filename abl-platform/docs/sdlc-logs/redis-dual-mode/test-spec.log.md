# Oracle Answers: Redis Dual-Mode Test Spec — Clarifying Questions

**Date**: 2026-05-04
**Phase**: 2 of 6 (Test Spec)
**Oracle**: product-oracle
**Feature**: Redis Dual-Mode Support (Standalone + Cluster)

## Context Consulted

- `docs/features/redis-dual-mode.md` — Full feature spec (16 FRs, 8 GAPs, 5 OQs)
- `docs/testing/redis-dual-mode.md` — Existing testing-guide placeholder (coverage matrix, 5 E2E, 6 INT scenarios)
- `CLAUDE.md` — "Test Architecture", "E2E Test Standards", "Core Invariants"
- `docker-compose.yml` — Current Redis container: standalone `redis:7-alpine` on `127.0.0.1:6380`
- `apps/runtime/src/__tests__/sessions/session-redis.e2e.test.ts` — Existing session E2E (standalone only, uses `RedisSessionStore`, `MemorySessionStore`, `SessionService`, direct Redis `new Redis()`)
- `apps/runtime/src/__tests__/helpers/redis-server-harness.ts` — Current test harness: spawns `redis-server` or reuses external Redis via `REDIS_URL`; DB-per-harness isolation via `nextDb++`
- `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.integration.test.ts` — Integration test: uses `RedisServerHarness`, `describeWithRedis` pattern, standalone only
- `packages/execution/src/__tests__/redis-fan-out-barrier.test.ts` — Uses `FakeRedis` in-memory mock (violates CLAUDE.md mock policy for new tests; existing test is grandfathered)
- `packages/agent-transfer/src/__tests__/session-lua-fixes.test.ts` — Existing Lua tests (standalone)
- `packages/redis/src/__tests__/connection.test.ts`, `bullmq.test.ts` — Existing Redis package tests
- `packages/redis/src/connection.ts` — `createRedisConnection()`, `resolveRedisOptionsFromEnv()`, `duplicate()` cast at L202
- `packages/redis/src/types.ts` — `RedisClient = Redis | Cluster` union, `RedisConnectionHandle` interface
- `packages/config/src/schemas/redis.schema.ts` — `cluster: z.boolean().default(false)`
- `packages/config/src/env-mapping.ts:78` — `REDIS_CLUSTER` -> `redis.cluster`
- `packages/agent-transfer/src/session/lua-scripts.ts` — 4 Lua scripts (`CREATE`, `END`, `CLAIM`, `EXTEND`) with 2-4 keys each spanning slots
- `packages/circuit-breaker/src/scripts.ts:79` — Author-acknowledged cluster gap
- `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md` — 5 audit passes, all resolved
- `docs/sdlc-logs/redis-dual-mode/feature-spec.oracle.md` — 19/20 questions answered, 1 AMBIGUOUS (timeline)

---

## Answers

### Test Scope & Priorities

#### Q1: Which FRs are highest risk and need the most coverage?

**Classification**: INFERRED
**Answer**: The risk ranking based on production blast radius, CROSSSLOT severity, and number of affected consumers:

| Risk Tier    | FRs                                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** | FR-8, FR-9, FR-10 (Lua redesign)                                                        | Production CROSSSLOT risk. These 3 families touch circuit-breaker (every model call), agent-transfer (every handoff), and fan-out-barrier (every parallel branch). A single regression means runtime failures in cluster mode. FR-9 is the most complex: 4 Lua scripts split into narrower Lua + pipelined index ops, with an intentional atomicity relaxation. FR-10 introduces a new data structure (registry SET) replacing a forbidden `KEYS` command inside Lua. |
| **HIGH**     | FR-1, FR-2 (subscriber + BullMQ pair)                                                   | Every queue consumer and every pub/sub subscriber across all 5 apps flows through these helpers. A regression means no BullMQ workers start and no pub/sub messages deliver. FR-1's cluster path instantiates a fresh `Cluster` (no `.duplicate()` analog) and must wire auto-reconnect (FR-15).                                                                                                                                                                      |
| **HIGH**     | FR-13 (standalone parity)                                                               | The regression guard. Every existing standalone test must continue to pass with zero behavior change. This is the "do no harm" gate.                                                                                                                                                                                                                                                                                                                                  |
| **MEDIUM**   | FR-3 (runLuaScript), FR-5 (scanKeys)                                                    | Foundation helpers consumed by FR-8/9/10 and FR-7 respectively. Bugs here cascade into every Lua and every KEYS-replacement consumer.                                                                                                                                                                                                                                                                                                                                 |
| **MEDIUM**   | FR-12 (resolveRedisOptionsFromEnv), FR-14 (test infra)                                  | FR-12 is the env-reading gap that prevents cluster mode from activating. FR-14 is the test harness itself — without it, no cluster tests run.                                                                                                                                                                                                                                                                                                                         |
| **LOWER**    | FR-4 (hashTag), FR-6, FR-7 (consumer migration), FR-11 (bypass migration), FR-15, FR-16 | FR-4 is a pure function (trivial to test). FR-6/7/11 are mechanical migrations. FR-15/16 are operational concerns validated in SIT.                                                                                                                                                                                                                                                                                                                                   |

**Source**: Feature spec section 4 (FRs), section 5 (integration matrix — 15 related features), section 16 (8 GAPs), `packages/agent-transfer/src/session/lua-scripts.ts` (4 Lua scripts with 2-4 keys each), `packages/circuit-breaker/src/scripts.ts:79` (author-acknowledged gap).
**Confidence**: HIGH

---

#### Q2: Are there known edge cases or failure modes from production incidents?

**Classification**: ANSWERED
**Answer**: Yes, three are documented in the feature spec GAP table (section 16) and two more are inferred from the codebase:

1. **GAP-008 — BullMQ Worker stall after reconnect**: BullMQ Workers may stall after Redis reconnect because ioredis Cluster status returns `'connect'` not `'ready'`. Reference: `taskforcesh/bullmq#2964`. Test scenario: kill cluster master during BullMQ job processing, verify worker resumes after failover. Mitigation: verify BullMQ version or add reconnect-watchdog in `createBullMQPair`.

2. **GAP-003 — Pipeline write-ordering race in session store**: `redis-session-store.ts` writes 4+ keys with different prefixes (`sess:`, `sess-tid:`, `sess:conv`) that become non-atomic in cluster. The reverse-lookup key `sess-tid:{id}` may be written before the session hash `sess:{tid}:{id}`, causing `resolveTenantId` to find no session. Test scenario: concurrent session create + immediate `resolveTenantId` lookup under cluster mode.

3. **GAP-002 — Multi-key DEL/MGET non-atomicity**: ioredis Cluster auto-splits `DEL` with multiple keys into per-slot batches. For session cleanup at `redis-session-store.ts:319`, this may leave orphan keys (caught by TTL). Test scenario: multi-key DEL under cluster, verify all keys eventually deleted.

4. **GAP-005 — `scanKeys` mid-failover duplicates**: During slot migration, `scanKeys` iterating all masters may yield duplicate keys from the source and destination nodes. Test scenario: run `scanKeys` while a slot migration is in progress.

5. **Cross-pod pub/sub gap during failover**: When a cluster master dies, pub/sub subscribers lose their subscriptions. `createSubscriber()` must re-establish within 30s (FR-15). Test scenario: kill master holding a subscriber's connection, verify re-subscription and message delivery resumes.

**Source**: Feature spec section 16 (GAP-002, GAP-003, GAP-005, GAP-008), FR-15, `redis-session-store.ts` pipeline analysis.
**Confidence**: HIGH

---

#### Q3: What's the current test coverage baseline?

**Classification**: ANSWERED
**Answer**: Zero cluster-mode tests exist. The current standalone test surface is:

**`apps/runtime/src/__tests__/`** (standalone):

- `redis-execution-queue.test.ts` — Execution queue operations
- `redis-circuit-breaker.test.ts` — Circuit breaker via runtime
- `redis-session-store-conv.test.ts` — Session store conversation operations
- `redis-session-store-compression.test.ts` — Compression path
- `redis-fallback-metrics.test.ts` — Fallback metrics
- `redis-trace-store.test.ts` — Trace store stream ops
- `redis-connection-cleanup.test.ts` — Connection lifecycle
- `sessions/session-redis.e2e.test.ts` — Full session lifecycle E2E (standalone, uses direct `new Redis()`)
- `helpers/redis-server-harness.ts` — Shared harness (spawns `redis-server` or reuses `REDIS_URL`)
- `execution/contexts/identity/redis-verification-token-store.test.ts` — Token store

**`packages/circuit-breaker/src/__tests__/`** (standalone):

- `redis-circuit-breaker.integration.test.ts` — Real Redis integration via `RedisServerHarness`
- `redis-circuit-breaker.test.ts` — Unit-level
- `registry.test.ts` — Registry

**`packages/agent-transfer/src/__tests__/`** (standalone):

- `session-lua-fixes.test.ts` — Lua script fix verification
- 15+ unit tests covering metrics, security, concurrency, etc.

**`packages/execution/src/__tests__/`** (standalone):

- `redis-fan-out-barrier.test.ts` — Uses `FakeRedis` in-memory mock (pre-existing; grandfathered)
- `fan-out-barrier-contract.test.ts` — Contract tests
- `redis-callback-registry.test.ts` — Callback registry

**`packages/redis/src/__tests__/`** (standalone):

- `connection.test.ts` — Connection factory tests
- `bullmq.test.ts` — BullMQ pair tests

All tests connect to standalone Redis (docker-compose.yml `redis:7-alpine` on port 6380 or spawned `redis-server`). No `docker-compose.cluster.yml` exists yet (FR-14).

**Source**: `find` results across test directories, `apps/runtime/src/__tests__/helpers/redis-server-harness.ts`.
**Confidence**: HIGH

---

#### Q4: External dependencies needing mocking vs real integration?

**Classification**: ANSWERED
**Answer**: Per CLAUDE.md "Test Architecture" and "E2E Test Standards", **no mocking of platform components** is allowed. The rules are:

- **Real Redis required for ALL tests**: Both standalone (`docker-compose.yml`) and cluster (`docker-compose.cluster.yml`) modes must use real Redis instances. The existing `RedisServerHarness` pattern (spawns `redis-server` or reuses `REDIS_URL`) is the established pattern for standalone.
- **Real Express servers for E2E**: Start on `{ port: 0 }` with full middleware chain (auth, rate limiting, tenant isolation, validation).
- **No `vi.mock()` / `jest.mock()`**: Forbidden for `@agent-platform/*`, `@abl/*`, or relative imports in all test files (unit, integration, E2E).
- **Only external third-party mocking via DI**: If an LLM provider or external HTTP service must be mocked, use dependency injection (constructor parameter), not module-level mocking.

For cluster tests specifically:

- Real 6-node Redis Cluster via `docker-compose.cluster.yml` (FR-14)
- ioredis `Cluster` constructor with `retryDelayOnFailover: 500`, `maxRedirections: 16` (FR-14)
- Failover simulation via `redis-cli CLUSTER FAILOVER` or container kill/restart

**Note**: The existing `redis-fan-out-barrier.test.ts` uses a `FakeRedis` in-memory mock. This is a pre-existing pattern that should NOT be replicated. New fan-out-barrier cluster tests (INT-5) must use real Redis.

**Source**: CLAUDE.md "Test Architecture" rules 1-5, "E2E Test Standards" rules 1-6, `redis-server-harness.ts` pattern.
**Confidence**: HIGH

---

#### Q5: Test environment setup — Docker, local services, CI?

**Classification**: ANSWERED
**Answer**:

**Standalone (existing, no change)**:

- `docker-compose.yml` service `redis`: `redis:7-alpine`, port `127.0.0.1:6380:6379`, password `${REDIS_PASSWORD:-localdev}`
- Test harness: `redis-server-harness.ts` — tries `REDIS_URL` / `REDIS_HOST:REDIS_PORT` env vars, then falls back to spawning local `redis-server`
- DB isolation: each harness gets a unique `nextDb++ % 16` database number

**Cluster (new, FR-14)**:

- `docker-compose.cluster.yml` (NEW): 6 nodes (3 masters + 3 replicas)
- Config per node: `cluster-enabled yes`, `cluster-require-full-coverage no`, `cluster-node-timeout 5000`
- ioredis `Cluster` config: `retryDelayOnFailover: 500`, `maxRedirections: 16` (retry budget 8000ms > 5000ms node-timeout)
- `pnpm test:cluster` target: boots cluster compose, runs `vitest` with `--testPathPattern='cluster'` (or tag filter), tears down
- Cluster harness needs a new `RedisClusterHarness` helper analogous to `RedisServerHarness` but connecting via `ioredis.Cluster` constructor with node list from compose ports
- Isolation between tests: `FLUSHALL` on each master node (iterate `client.nodes('master')`) before each test, since cluster mode does not support `SELECT` (no per-DB isolation like standalone)

**CI integration**: See Q16.

**Source**: `docker-compose.yml` (lines 87-103), `redis-server-harness.ts`, feature spec FR-14.
**Confidence**: HIGH

---

### E2E Scenarios

#### Q6: Critical user journeys for E2E?

**Classification**: INFERRED
**Answer**: Five critical E2E journeys are needed. The testing placeholder (`docs/testing/redis-dual-mode.md`) already defines E2E-1 through E2E-5. Validating those are correct and complete:

1. **E2E-1 — Full Session Lifecycle Against Cluster**: Session create -> 5 messages (tools, handoff, agent transfer) -> transcript retrieval. Covers the cross-product of session pipeline, agent-transfer Lua, circuit-breaker Lua, and BullMQ. This is the highest-value single test.

2. **E2E-2 — Cross-Pod Pub/Sub with Subscriber Reconnect**: Two runtime pods + cluster. Pod A creates session, pod B receives WebSocket events. Kill master, verify reconnect within 30s (FR-15). This is the only test that exercises the cluster failover path end-to-end.

3. **E2E-3 — Agent Transfer with Split SADD Path**: Handoff mid-conversation with cluster mode. Verifies the non-atomic index update path (FR-9's intentional relaxation). Kill handoff target pod, verify recovery.

4. **E2E-4 — Standalone Parity (Regression Guard)**: Run the entire existing E2E suite with `REDIS_CLUSTER=false`. Must be 100% pass. This is the FR-13 gate.

5. **E2E-5 — Workflow Engine BullMQ Trigger Round-Trip**: Workflow trigger with delay, verify callback fires in cluster mode. Validates BullMQ's internal hash-tagging works with the `Cluster` instance from `createBullMQPair`.

**Additional E2E to consider (recommended)**:

6. **E2E-6 — scanKeys completeness under cluster via HTTP API**: Use an admin or diagnostic endpoint that performs key enumeration (e.g., cache invalidation). Verify all keys are found, not just those on one node. This is the only way to E2E-test the `scanKeys` helper through a real HTTP surface.

**Source**: `docs/testing/redis-dual-mode.md` (E2E-1 through E2E-5), feature spec FR-1 through FR-16 cross-referenced with integration matrix.
**Confidence**: HIGH

---

#### Q7: Auth/permission combinations needing E2E?

**Classification**: INFERRED
**Answer**: Minimal auth-specific scenarios needed. Redis is a layer below the auth boundary. The reasoning:

- All Redis key prefixes already include `tenantId` (e.g., `sess:{tenantId}:{id}`, `agent_transfer:{tenantId}:{contactId}:{channel}`, `breaker:{level}:{key}`). Tenant isolation is enforced by key naming, not by Redis ACLs.
- The `requireAuth` middleware operates at the HTTP layer, before any Redis operation. Redis tests inherit auth context from the session/request setup, not from Redis configuration.
- Hash tags do NOT change the tenant isolation property. `breaker:{auth:tenant-1}:state` still contains `tenant-1` in the key; the braces just force slot co-location.

**Test approach**: Each E2E scenario uses a single freshly-created tenant + project + agent IR. No cross-tenant E2E scenarios are needed specifically for Redis dual-mode because:

1. Existing tenant-isolation E2E tests (in `apps/runtime/src/__tests__/`) already cover cross-tenant access control at the HTTP layer.
2. The hash tag change does not alter which keys a given tenant can reach.

**One exception**: Add a sanity assertion in INT-13 (slot-distribution check) that keys for two different tenants with different hash tags land in different slots. This is an integration test, not E2E.

**Source**: CLAUDE.md Core Invariant #1 (Resource Isolation), feature spec section 12 (Isolation & Multitenancy), key patterns in section 9.
**Confidence**: HIGH

---

#### Q8: Cross-feature interactions for E2E?

**Classification**: ANSWERED
**Answer**: The feature spec integration matrix (section 5) identifies 15 related features. The critical cross-feature interaction chain for E2E is:

**Primary chain (E2E-1 covers this)**:
`Session Create` (redis-session-store) -> `Circuit Breaker` (Lua check-state) -> `LLM Queue` (BullMQ enqueue via `createBullMQPair`) -> `Model Call` -> `Circuit Breaker` (Lua record-success/failure) -> `Agent Transfer` (Lua create/end session) -> `Pub/Sub` (session events via `createSubscriber`) -> `Trace Store` (Redis Streams XADD) -> `Session Update` (pipeline write)

**Secondary interactions**:

- `Workflow Engine` (BullMQ) -> `Runtime` (callback via pub/sub) — covered by E2E-5
- `Fan-Out Barrier` (parallel branches) -> `Circuit Breaker` (per-branch model calls) — covered by INT-5 + INT-1

**Not needing E2E** (already cluster-safe or single-key):

- Distributed Locks (`SET NX PX` — single-key, already cluster-safe)
- Rate Limiting (single-key counters)
- Trace Store (single-stream XADD/XRANGE — already cluster-safe)

**Source**: Feature spec section 5 (integration matrix), section 10 (implementation files), section 9 (key relationships).
**Confidence**: HIGH

---

#### Q9: Data seeding required?

**Classification**: INFERRED
**Answer**: Minimal seeding per test. Specifically:

- **Per E2E test**: Fresh tenant + project + compiled agent IR (via HTTP POST to `/api/projects` and agent compilation endpoint). Use `uniqueId()` prefixes per test to avoid key collision.
- **Per integration test**: Direct Redis key writes via `ioredis` client (no HTTP layer). Pre-populate hash-tagged keys for Lua tests; pre-populate 1000+ keys for `scanKeys` completeness test.
- **No persistent seed data**: All Redis keys carry TTLs (circuit-breaker: `reset_timeout * 2`, agent-transfer: per-session, fan-out-barrier: per-execution). `FLUSHALL` between tests is the isolation mechanism.
- **MongoDB seeding** (E2E only): Tenant, project, and agent definition documents needed for session creation. Use the existing `makeSessionData()` / `makeAgentIR()` / `makeCompilationOutput()` helpers from `session-redis.e2e.test.ts`.

**Source**: Existing patterns in `session-redis.e2e.test.ts` (lines 29-67), `redis-circuit-breaker.integration.test.ts` (lines 39-41), feature spec section 12 (data lifecycle).
**Confidence**: HIGH

---

#### Q10: Performance/load scenarios?

**Classification**: ANSWERED
**Answer**: Performance testing is out of scope for this test spec (unit + integration + E2E). It belongs in Phase 4 (SIT validation) per the feature spec delivery plan section 13.

Specifically:

- **k6 load tests**: Phase 4.2 — "Run full E2E suite, k6 load tests via `load-test-analysis` skill"
- **Targets**: cluster p95 <= 2x standalone; p50 <= 1.1x standalone; write throughput during resharding <= 20% degradation (section 14 success metrics)
- **Reference**: The `load-test-analysis` and `saturation-finder` skills handle k6 Cloud + Coroot metrics

The test spec should **reference** these performance targets and note that they are validated in Phase 4, but should NOT define k6 test scenarios. The test spec scope is: unit tests, integration tests (real Redis), and E2E tests (real HTTP API).

**Source**: Feature spec section 13 (Phase 4.2, 4.3), section 14 (success metrics table), CLAUDE.md skills table (`load-test-analysis`, `saturation-finder`).
**Confidence**: HIGH

---

### Integration Boundaries

#### Q11: Service boundaries needing integration tests?

**Classification**: ANSWERED
**Answer**: Six integration boundaries, each with its own test file. The testing placeholder already defines INT-1 through INT-6:

1. **Helpers <-> ioredis Cluster client** (`packages/redis/src/__tests__/cluster-helpers.cluster.test.ts`):
   - `createSubscriber()`: round-trip pub/sub on cluster
   - `createBullMQPair()`: job enqueue/process on cluster
   - `runLuaScript()`: single-key and multi-key (hash-tagged) script execution
   - `scanKeys()`: completeness across all masters (1000+ keys)
   - `hashTag()`: pure function (unit test, no Redis needed)

2. **Circuit-breaker Lua <-> ioredis Cluster `eval`** (`packages/circuit-breaker/src/__tests__/redis-circuit-breaker.cluster.test.ts`):
   - All 4 Lua scripts (`record-failure`, `record-success`, `check-state`, `force-reset`) with hash-tagged keys
   - Verify via `CLUSTER KEYSLOT` that all 5 per-breaker keys land in the same slot
   - Negative test: un-tagged keys produce CROSSSLOT error

3. **Agent-transfer Lua + pipelined index ops <-> ioredis Cluster** (`packages/agent-transfer/src/__tests__/session-lua.cluster.test.ts`):
   - CREATE: narrower Lua (session hash + provider index) + pipelined SADD to global/pod sets
   - END: narrower Lua (session hash DEL) + pipelined SREM/DEL for index/sets
   - CLAIM: narrower Lua (CAS on ownerPod) + pipelined SREM/SADD for pod sets
   - EXTEND: hash-tagged 2-key Lua (session + provider index)
   - Partial pipeline failure: verify logged warning, verify session hash still correct

4. **Fan-out-barrier Lua + registry SET <-> ioredis Cluster** (`packages/execution/src/__tests__/redis-fan-out-barrier.cluster.test.ts`):
   - 4-branch fan-out: all branch result keys recorded in registry SET
   - Barrier-complete Lua iterates registry SET (no `KEYS` command)
   - Cleanup removes all keys (barrier hash + registry SET + branch result keys)
   - Verify all keys share same slot via `CLUSTER KEYSLOT`

5. **BullMQ <-> Cluster** (covered by helper test INT-3):
   - Job survives master failover
   - `disconnect()` cleans up both connections

6. **`resolveRedisOptionsFromEnv` <-> env reading** (`packages/redis/src/__tests__/connection.test.ts` — extend existing):
   - `REDIS_CLUSTER=true` produces `{ cluster: true }` in options
   - `REDIS_CLUSTER` unset produces `{ cluster: false }` (default)
   - `REDIS_CLUSTER=false` produces `{ cluster: false }`

**Source**: Feature spec section 10 (test files table), `docs/testing/redis-dual-mode.md` (INT-1 through INT-6).
**Confidence**: HIGH

---

#### Q12: Webhook / event-driven flows needing integration coverage?

**Classification**: INFERRED
**Answer**: Three event-driven flows need cluster-mode integration coverage:

1. **Pub/Sub publish -> subscribe across cluster nodes**:
   - Test: publish on one node, subscribe on another (ioredis Cluster routes internally), verify message delivery
   - Covered by: INT-1 (`createSubscriber` round-trip) and E2E-2 (cross-pod)
   - Edge case: subscribe, kill master, verify re-subscription after failover

2. **BullMQ enqueue -> worker process**:
   - Test: enqueue job on queue connection, process on worker connection (both `Cluster` instances)
   - Covered by: INT-3 (`createBullMQPair`) and E2E-5 (workflow trigger)
   - Edge case: enqueue, kill master holding queue slot, verify worker processes after failover

3. **Trace stream `XADD` -> consumer group read**:
   - Already cluster-safe (single-key per stream). No cluster-specific test needed beyond verifying `XADD`/`XRANGE` work on a `Cluster` instance.
   - Covered implicitly by E2E-1 (session lifecycle includes trace events)

**No webhook flows** are affected by Redis dual-mode. Webhooks are HTTP-based and do not flow through Redis.

**Source**: Feature spec section 5 (Trace Store row: "single-key, already cluster-safe"), `redis-trace-store.ts` (uses `XADD`/`XRANGE` on single stream key).
**Confidence**: HIGH

---

#### Q13: Tenant/project isolation scenarios?

**Classification**: INFERRED
**Answer**: Existing tenant-isolation tests already cover the HTTP-layer enforcement. For Redis dual-mode, add ONE integration-level sanity check:

**Slot-distribution sanity check** (add to cluster helpers integration test):

- Create keys for two different tenants with different hash tags: `breaker:{auth:tenant-A}:state` and `breaker:{auth:tenant-B}:state`
- Assert via `CLUSTER KEYSLOT` that they land in different slots (they will, because `{auth:tenant-A}` and `{auth:tenant-B}` hash differently)
- This verifies that hash tags do not accidentally funnel all tenants into one slot

**Agent-transfer hot-slot avoidance** (add to agent-transfer integration test):

- Create sessions for same tenant but different contacts: `agent_transfer:{t1:c1:web}` and `agent_transfer:{t1:c2:web}`
- Assert different slots (different `contactId` -> different hash tag content -> different slot)

**No new E2E isolation scenarios needed**: The hash tag change is purely a slot-placement optimization. It does not alter which tenant can access which keys — that is enforced by key naming (tenantId in every key) and HTTP-layer auth middleware.

**Source**: Feature spec section 7 ("Agent-transfer hot-slot avoidance"), section 12 (Isolation & Multitenancy table).
**Confidence**: HIGH

---

#### Q14: Race conditions / concurrency scenarios?

**Classification**: ANSWERED
**Answer**: Three concurrency scenarios are critical, all documented in the feature spec GAPs:

1. **Master failover mid-Lua execution** (GAP-001 related):
   - Scenario: Start a `runLuaScript` call, kill the master node holding the target slot mid-execution
   - Expected: ioredis retries with `retryDelayOnFailover: 500ms`, `maxRedirections: 16`; total retry budget 8000ms > 5000ms `cluster-node-timeout`
   - Test: Deterministic via `redis-cli -h <master> CLUSTER FAILOVER` (graceful) or `docker stop <master-container>` (ungraceful)
   - This is an integration test, not E2E

2. **Pipelined SADD partial-failure recovery for agent-transfer** (GAP related to FR-9):
   - Scenario: `LUA_CREATE_SESSION` succeeds (session hash created), but the subsequent pipelined `SADD at_active_sessions` fails (e.g., target node temporarily unreachable)
   - Expected: Session exists but is temporarily missing from active-sessions set. TTL self-cleans. Warning logged.
   - Test: Inject a connection error after the Lua call but before pipeline execution (via DI on the pipeline step). Verify session hash exists, SADD eventually succeeds on retry, warning was logged.

3. **BullMQ Worker reconnect after master loss** (GAP-008):
   - Scenario: Worker is processing a job. Kill the master node. Worker's ioredis Cluster reconnects.
   - Expected: Worker resumes processing after reconnect. If BullMQ version has the `#2964` bug (status = `'connect'` not `'ready'`), the reconnect-watchdog in `createBullMQPair` must intervene.
   - Test: Integration test — enqueue 10 jobs, kill master after job 3, verify all 10 eventually complete.

4. **Concurrent `scanKeys` during slot migration** (GAP-005):
   - Scenario: Run `scanKeys` while `CLUSTER SETSLOT MIGRATING` is in progress
   - Expected: May yield duplicate keys from source and destination nodes. `scanKeys` must dedupe.
   - Test: Difficult to make deterministic in CI. Recommend: write the test but mark it `@tag:chaos` for manual SIT execution only.

**Source**: Feature spec section 16 (GAP-001, GAP-003, GAP-005, GAP-008), FR-9 (atomicity relaxation), FR-14 (retry budget).
**Confidence**: HIGH

---

#### Q15: Error/failure paths for integration testing?

**Classification**: INFERRED
**Answer**: Five negative-path integration tests:

1. **CROSSSLOT detection on un-tagged Lua keys** (negative test):
   - Call `runLuaScript` with 3 keys that do NOT share a hash tag (e.g., `key:a`, `key:b`, `key:c`)
   - Assert: error thrown with CROSSSLOT in message
   - Purpose: Proves hash tags are required; guards against regression if someone adds a new Lua script without hash-tagging

2. **KEYS command returning partial results** (negative test against cluster):
   - Populate 100 keys across cluster, call `redis.keys('test:*')` directly (NOT via `scanKeys`)
   - Assert: returned count < 100 (only local-node keys returned)
   - Purpose: Demonstrates why `KEYS` is forbidden; validates the lint hook rationale

3. **`duplicate()` failure on Cluster instance** (negative test):
   - Call `connectionHandle.duplicate()` where `connectionHandle.client` is a `Cluster` instance (before the fix)
   - Assert: error thrown (`.duplicate is not a function` or similar)
   - Purpose: Validates that the migration to `createSubscriber()` / `createBullMQPair()` is necessary
   - Note: This test validates the BEFORE state. After the fix, `duplicate()` on the handle should either work (by instantiating a fresh Cluster) or be removed from the interface entirely.

4. **Connection refused during cluster init** (error handling):
   - Construct `ioredis.Cluster` with a dead node list
   - Assert: error is surfaced cleanly, not swallowed; structured log emitted
   - Purpose: Validates `createRedisConnection` error path for cluster mode

5. **Lua script timeout under cluster** (edge case):
   - Run a deliberately slow Lua script (busy-wait loop) that exceeds `lua-time-limit`
   - Assert: `BUSY` error is returned, not hung forever
   - Purpose: Validates that cluster mode handles `BUSY` the same as standalone

**Source**: Feature spec section 4 (CROSSSLOT risk description), section 1 (KEYS partial results), `connection.ts:202` (duplicate cast), CLAUDE.md Core Invariant #4 (Traceability — no swallowed errors).
**Confidence**: HIGH

---

### Test Infrastructure

#### Q16: CI integration — should `pnpm test:cluster` run on every PR or nightly?

**Classification**: DECIDED
**Answer**: **Nightly + opt-in PR via label**. Rationale:

- **6 containers for cluster** (3 masters + 3 replicas) adds significant CI resource cost and ~30-60s bootstrap time
- **Standalone tests run on every PR** — these are the regression guard (FR-13, E2E-4)
- **Cluster tests run nightly** — catches regressions within 24 hours
- **Opt-in on PR**: A CI label (e.g., `run:cluster-tests`) triggers cluster tests for PRs touching `packages/redis/`, `packages/circuit-breaker/`, `packages/agent-transfer/`, `packages/execution/`, or any file matching `*cluster*`
- **Auto-trigger on file paths**: CI config can use path filters — if any changed file is in the above packages, automatically add the cluster test job

This matches the pattern used by other infrastructure projects (e.g., ioredis itself runs cluster tests only on specific CI targets, not every push).

**Source**: No explicit guidance in codebase or docs. Decision based on: (1) existing CI uses `pnpm test` for standard tests, no cluster variant exists; (2) 6-container overhead is disproportionate for small changes; (3) nightly + path-triggered opt-in balances safety and cost.
**Confidence**: MEDIUM (reasonable default, adjustable based on team preference)

---

#### Q17: Test isolation between runs — flush all keys between tests?

**Classification**: DECIDED
**Answer**: Yes, `FLUSHALL` on each master node before each test. Implementation:

```
async function flushCluster(client: Cluster): Promise<void> {
  const masters = client.nodes('master');
  await Promise.all(masters.map(node => node.flushall()));
}
```

**Why iterate masters**: ioredis `Cluster` does not expose a cluster-wide `FLUSHALL`. The `FLUSHALL` command is per-node. Replica nodes replicate from their masters, so flushing masters is sufficient.

**Why not DB-per-test** (like standalone harness): Redis Cluster does not support `SELECT` — all data lives in DB 0. The standalone harness's `nextDb++ % 16` isolation trick is not available in cluster mode. `FLUSHALL` is the only isolation mechanism.

**Test ordering**: Use `describe.sequential` for cluster tests (same pattern as `redis-circuit-breaker.integration.test.ts:23`) to prevent parallel tests from interfering with each other's flush operations.

**Source**: ioredis Cluster API (`.nodes('master')` returns `Redis[]`), Redis Cluster specification (no `SELECT` support), existing pattern in `redis-circuit-breaker.integration.test.ts:23` (`describe.sequential`).
**Confidence**: HIGH

---

#### Q18: How to simulate failover deterministically?

**Classification**: DECIDED
**Answer**: Two approaches, use both depending on test type:

**1. Graceful failover (recommended for most integration tests)**:

```
docker exec redis-cluster-1 redis-cli -p 6379 CLUSTER FAILOVER
```

- The target node (a replica) sends `CLUSTER FAILOVER` to its master
- Master stops accepting writes, replica promotes itself
- Deterministic, clean, ~2-5 second completion
- Use for: pub/sub reconnect tests, BullMQ worker stall tests, Lua retry tests

**2. Ungraceful failover (for chaos/resilience tests)**:

```
docker stop redis-cluster-1  # kill the master container
# wait for cluster-node-timeout (5000ms) + election
docker start redis-cluster-1  # bring it back as replica
```

- Simulates a real crash or network partition
- Takes `cluster-node-timeout` (5s) + election time (~1-3s)
- Use for: E2E-2 (pub/sub gap measurement), GAP-008 (BullMQ stall), worst-case latency tests

**Helper utility**: Create a `ClusterFailoverHelper` in the test harness:

```typescript
interface ClusterFailoverHelper {
  gracefulFailover(masterNodeId: string): Promise<void>;
  killMaster(containerName: string): Promise<void>;
  restartNode(containerName: string): Promise<void>;
  waitForClusterReady(timeoutMs: number): Promise<void>;
}
```

`waitForClusterReady` polls `CLUSTER INFO` until `cluster_state:ok` and all slots are assigned.

**Source**: Redis Cluster specification (CLUSTER FAILOVER command), feature spec FR-14 (`cluster-node-timeout 5000`), docker-compose container naming convention.
**Confidence**: HIGH

---

## Decisions Made (for DECIDED items)

| #   | Decision                                                                                 | Rationale                                                                                                                                   | Risk                                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Nightly + opt-in PR (label or path-trigger) for `pnpm test:cluster` (Q16)                | 6 containers too heavy for every PR; nightly catches regressions within 24h; path-filter auto-triggers for relevant packages                | Low — standalone parity tests still run on every PR; cluster regressions caught within 24h    |
| D-2 | `FLUSHALL` on each master + `describe.sequential` for cluster test isolation (Q17)       | Cluster mode has no `SELECT` (no DB-per-test); iterating `nodes('master')` is the only isolation mechanism; sequential prevents flush races | Low — well-established pattern in Redis testing; matches existing `describe.sequential` usage |
| D-3 | Graceful (`CLUSTER FAILOVER`) + ungraceful (`docker stop`) for failover simulation (Q18) | Graceful is deterministic and fast for most tests; ungraceful simulates real crashes for chaos tests; both are needed for complete coverage | Low — both are standard Redis Cluster testing techniques                                      |

## Escalations (for AMBIGUOUS items — requires user input)

None. All 18 questions were answerable from the feature spec, existing codebase patterns, and architectural principles. No AMBIGUOUS items.
