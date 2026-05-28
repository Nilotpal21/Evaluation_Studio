# Oracle Answers: Redis Dual-Mode Support (Standalone + Cluster)

**Date**: 2026-05-04
**Phase**: Feature Spec — Clarifying Questions
**Oracle**: product-oracle

## Context Consulted

- `CLAUDE.md` — Core invariants (#3 Stateless Distributed, #1 Resource Isolation)
- `packages/redis/src/connection.ts` — Current connection factory, cluster path (L171-185), duplicate() (L197-203)
- `packages/redis/src/bullmq.ts` — BullMQ pair helper, duplicate() calls (L128-129)
- `packages/redis/src/singleton.ts` — Singleton manager, duplicateRedisClient() (L108-113)
- `packages/redis/src/types.ts` — RedisClient = Redis | Cluster union type (L17)
- `packages/redis/src/index.ts` — Public API surface
- `packages/config/src/schemas/redis.schema.ts` — `cluster: z.boolean().default(false)` (L34)
- `packages/config/src/env-mapping.ts` — `REDIS_CLUSTER` maps to `redis.cluster` (L78)
- `packages/circuit-breaker/src/lua/record-failure.lua` — 5-key Lua script (CROSSSLOT risk)
- `packages/circuit-breaker/src/scripts.ts` — Lua loader + defineCommand (standalone-only)
- `packages/agent-transfer/src/session/lua-scripts.ts` — 4-key LUA_CREATE_SESSION (CROSSSLOT risk)
- `packages/execution/src/redis-fan-out-barrier.ts` — KEYS command inside Lua (L99, L112), 2-key completeBranch Lua
- `deploy/helm-values/tier-s/values.yaml` — Sentinel architecture, redis://redis-sentinel:26379
- `deploy/helm-values/tier-m/values.yaml` — Cluster architecture, redis://redis-cluster.abl-data.svc:6379
- `deploy/helm-values/tier-l/values.yaml` — Cluster architecture, 6 masters + 6 replicas
- `deploy/helm-values/tier-xl/values.yaml` — Cluster architecture, 12 masters + 24 replicas
- `apps/workflow-engine/src/services/redis.ts` — Direct ioredis `new Redis()` bypass
- `apps/search-ai/src/services/connector-presence.service.ts` — Direct ioredis `new Redis()` bypass
- `apps/search-ai-runtime/src/services/cache/redis-client.ts` — Wrapper accepting raw ioredis Redis type
- Codebase-wide grep for `.duplicate()` — 27+ call sites
- Codebase-wide grep for `.keys()` — 12+ production call sites using KEYS command
- `docker-compose.yml` — Single standalone Redis container

---

## Answers

### Q1: What specific problem does this solve, in business + technical terms? Who experiences it today?

**Classification**: INFERRED
**Answer**:

**Business problem**: ABL Platform cannot deploy to SIT (System Integration Testing) environments or production tiers M/L/XL with true Redis Cluster mode enabled. The helm values for tiers M, L, and XL already reference `redis-cluster.abl-data.svc:6379` and define cluster topology (tier-M: 3 masters + 3 replicas; tier-L: 6+6; tier-XL: 12+24), but `REDIS_CLUSTER=true` is never set anywhere. This means those tiers run against the cluster endpoint in standalone/proxy mode, defeating the purpose of the cluster (no slot-based sharding, no horizontal write scaling, single-node bottleneck behind a proxy). Enterprise customers on tier-L/XL with high conversation volumes (50K-500K/day for tier-L, 500K+ for tier-XL) cannot leverage Redis Cluster's horizontal scaling.

**Technical problem**: Five categories of incompatibility prevent `REDIS_CLUSTER=true` from working:

1. **`duplicate()` hard-cast**: `connection.ts:202` casts `client as Redis` then calls `.duplicate()`. ioredis `Cluster` has no `.duplicate()` method -- this throws at runtime.
2. **27+ `duplicate()` call sites** in BullMQ pairs, pub/sub subscribers, and queue workers across runtime, workflow-engine, and search-ai.
3. **CROSSSLOT Lua scripts**: Circuit-breaker uses 5 KEYS per script (`breaker:{level}:{key}:failures`, `:successes`, `:state`, `:opened_at`, `:half_open_count`). These keys hash to different slots unless wrapped in a hash tag. Agent-transfer `LUA_CREATE_SESSION` uses 4 keys spanning different key families.
4. **KEYS command in production**: 12+ sites use `redis.keys(pattern)` which returns partial results in Cluster (only scans the node the client connects to). This causes silent data loss in cache invalidation, presence, and query caching.
5. **3 services bypass the shared factory**: `apps/workflow-engine/src/services/redis.ts`, `apps/search-ai/src/services/connector-presence.service.ts`, and `apps/search-ai-runtime/src/middleware/rate-limit.ts` create raw `new Redis()` directly, ignoring any cluster configuration.

**Who experiences it**: Platform/SRE team deploying to SIT and production; service developers who unknowingly write cluster-incompatible code; on-call engineers who would face CROSSSLOT errors and silent data loss if cluster mode were enabled today.

**Source**: Helm values analysis (tier-M L779-704, tier-L L779-829, tier-XL L887-951) + codebase grep results + `connection.ts:202` + `bullmq.ts:128-129`
**Confidence**: HIGH

---

### Q2: What is explicitly OUT of scope for this feature?

**Classification**: DECIDED
**Answer**:

Out of scope:

1. **Redis Sentinel changes** — Tier-S uses Sentinel (redis-sentinel:26379). Sentinel topology is transparent to ioredis and works today. No changes needed.
2. **Redis Enterprise / CRDB** — Active-active geo-replication is a separate concern; tier-XL values mention ElastiCache Global Datastore as a managed alternative but that is a deploy-time choice, not an app-code concern.
3. **In-memory caches** (Map/LRU within process) — These are pod-local and unrelated to Redis mode.
4. **MongoDB changes** — Not related.
5. **BullMQ Flows orchestration redesign** — BullMQ natively supports Cluster when given proper connection options. The scope is providing correct connections, not redesigning flow patterns.
6. **BullMQ Worker concurrency tuning** — Performance tuning is a separate operational concern.
7. **Redis data migration** — Circuit breaker and lock keys have TTLs (reset_timeout \* 2 per `record-failure.lua:92`). No migration needed; keys self-expire during rollout.
8. **Cluster topology management / slot rebalancing** — That is an infrastructure/operator concern, not app-code.
9. **Multi-region Redis replication** — Tier-XL cross-region replication is an infrastructure concern handled by ElastiCache Global Datastore or equivalent.
10. **Pub/Sub channel namespace redesign** — Redis Cluster pub/sub is node-local by default; ioredis Cluster handles broadcasting. No channel rename needed unless we want shard-channel optimization (future).

**Source**: Feature summary provided + helm values analysis + ioredis Cluster documentation knowledge
**Confidence**: HIGH

---

### Q3: What is the priority/timeline driver?

**Classification**: AMBIGUOUS
**Answer**: The feature summary mentions "SIT readiness" and "tier-m/l/xl SaaS prod" as the target environments. However, no specific SIT readiness date or production rollout timeline is stated in any existing documentation. The helm values for tiers M/L/XL already describe cluster topology with `cluster-enabled: 'yes'`, suggesting the infrastructure is provisioned but the app layer is the blocker.

**Source**: Helm values tiers M/L/XL all have `cluster-enabled: 'yes'` in Redis config; no feature spec or plan doc exists yet for this feature.
**Confidence**: LOW

---

### Q4: Are there competing approaches considered?

**Classification**: DECIDED
**Answer**: Four alternatives were considered; the mode-aware abstraction approach (proposed) is the correct choice:

| Approach                                 | Pros                                                                                                        | Cons                                                                                                                                       | Verdict          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **A. Proxy-only (Envoy/Twemproxy)**      | Zero app-code changes                                                                                       | Cannot fix CROSSSLOT Lua scripts (proxy forwards EVAL to one node); KEYS still broken; adds latency + operational complexity; masks errors | Rejected         |
| **B. Key-prefix sharding (manual)**      | Simple concept                                                                                              | Doesn't solve CROSSSLOT; requires rewriting all key schemas; no ioredis native support                                                     | Rejected         |
| **C. Redis Enterprise CRDB**             | Transparent multi-key, KEYS works                                                                           | Vendor lock-in; expensive; not available on-prem; still needs app-layer hash tags for optimal slot distribution                            | Rejected for now |
| **D. Stay single-node**                  | No work                                                                                                     | Tier-L at 6 replicas with 32GB/node would bottleneck on a single write primary; tier-XL at 500K+ conv/day cannot scale writes              | Rejected         |
| **E. Mode-aware abstraction (proposed)** | Fix at source; zero runtime overhead in standalone; ioredis Cluster is production-grade; one-time migration | Requires touching Lua scripts and migrating consumers                                                                                      | **Selected**     |

The proposed approach is correct because it solves the problem at the right layer (app abstraction), the foundational types already exist (`RedisClient = Redis | Cluster` in `types.ts:17`), and the config schema already has the `cluster` flag (`redis.schema.ts:34`).

**Source**: Analysis of `packages/redis/src/types.ts:17` (union type exists), `packages/config/src/schemas/redis.schema.ts:34` (config flag exists), circuit-breaker Lua structure, ioredis documentation
**Confidence**: HIGH

---

### Q5: Is this an enhancement to `@agent-platform/redis` or a net-new feature?

**Classification**: ANSWERED
**Answer**: Enhancement to the existing `@agent-platform/redis` package. The foundation is already partially built:

- `RedisClient = Redis | Cluster` union type exists in `types.ts:17`
- `RedisConnectionOptions.cluster` flag exists in `types.ts:54`
- `RedisConfigSchema.cluster` exists in `redis.schema.ts:34` with `z.boolean().default(false)`
- `REDIS_CLUSTER` env var mapping exists in `env-mapping.ts:78`
- `createRedisConnection()` already has a cluster branch at `connection.ts:171-185` that creates a `Cluster` instance

What is MISSING from the existing foundation:

- `duplicate()` in `connection.ts:202` hard-casts to `Redis` (breaks Cluster)
- `resolveRedisOptionsFromEnv()` at `connection.ts:230-254` does NOT read `REDIS_CLUSTER` env var
- `singleton.ts:71` hard-casts to `Redis` for `.connect()`
- `bullmq.ts:128-129` hard-casts to `Redis` for `.duplicate()`
- No `createSubscriber()`, `runLuaScript()`, `hashTag()`, or `scanKeys()` helpers exist
- `scripts.ts:54` in circuit-breaker uses `redis.defineCommand()` (standalone-only, per its own comment at L82)

**Source**: `packages/redis/src/types.ts:17`, `packages/redis/src/connection.ts:171-185,197-203`, `packages/config/src/schemas/redis.schema.ts:34`, `packages/config/src/env-mapping.ts:78`, `packages/redis/src/singleton.ts:71`, `packages/circuit-breaker/src/scripts.ts:82`
**Confidence**: HIGH

---

### Q6: Primary personas?

**Classification**: INFERRED
**Answer**:

1. **Platform Engineer** (primary consumer) — Writes the mode-aware helpers, migrates consumers, validates parity. Needs clear APIs (`createSubscriber`, `createBullMQPair`, `hashTag`, `scanKeys`, `runLuaScript`) that work identically in both modes.
2. **Service Developer** (ongoing consumer) — Writes new features that use Redis. Needs to call shared helpers from `@agent-platform/redis` and never think about cluster vs standalone. Must not be able to accidentally use `KEYS` or raw `.duplicate()`.
3. **SRE/Operator** (deployment) — Flips `REDIS_CLUSTER=true` in helm values, monitors rollout. Needs observability dashboards and a clear runbook for failover behavior.
4. **On-call Engineer** (incident response) — Troubleshoots MOVED/ASK errors, CROSSSLOT errors, pub/sub reconnection. Needs documented failure modes and error metrics.

**Source**: CLAUDE.md platform principles (Stateless Distributed, Traceability) + helm values showing SRE-managed tiers
**Confidence**: HIGH

---

### Q7: What are the must-have vs nice-to-have requirements?

**Classification**: DECIDED
**Answer**:

**Must-haves (P0)**:

1. Full functional parity for runtime, search-ai, search-ai-runtime, studio, workflow-engine in cluster mode
2. `createSubscriber()` helper — mode-aware pub/sub subscriber creation (replaces 6+ `duplicate()` call sites for pub/sub)
3. `createBullMQPair()` helper — mode-aware BullMQ connection pair (replaces 12+ `duplicate()` call sites for queue/worker)
4. `scanKeys()` helper — mode-aware SCAN (replaces 12+ `redis.keys()` call sites)
5. `hashTag()` helper — wraps key segments in `{...}` for Lua scripts that need co-located keys
6. `runLuaScript()` helper — mode-aware EVAL/EVALSHA (handles `defineCommand` for standalone vs raw `eval` for Cluster)
7. Circuit-breaker Lua scripts rewritten with hash-tagged keys
8. Agent-transfer Lua scripts rewritten with hash-tagged keys
9. Fan-out-barrier Lua scripts rewritten (eliminate KEYS inside Lua, use hash-tagged keys)
10. All 3 bypass services migrated to shared factory (workflow-engine, connector-presence, search-ai-runtime rate-limit)
11. `resolveRedisOptionsFromEnv()` reads `REDIS_CLUSTER` env var
12. `duplicate()` in connection.ts/singleton.ts/bullmq.ts handles Cluster mode
13. Standalone mode works unchanged (zero config change for existing deployments)
14. Backward-compatible key format (old standalone keys with TTLs self-expire; new hash-tagged keys are additive)

**Nice-to-haves (P1)**:

1. Cluster-aware load test suite (k6 + Redis Cluster docker-compose)
2. Slot distribution monitoring dashboard (Grafana)
3. MOVED/ASK/CROSSSLOT error counters in observability
4. Lint rule / hook that warns on raw `.duplicate()` or `.keys()` usage
5. Per-node command rate dashboard

**Source**: Codebase analysis of all incompatibility sites + CLAUDE.md invariant #3 (Stateless Distributed)
**Confidence**: HIGH

---

### Q8: Performance/scale requirements?

**Classification**: DECIDED
**Answer**:

- **Standalone mode**: Zero regression. The `REDIS_CLUSTER=false` (default) code path must produce identical ioredis calls as today. No new abstraction layers in the hot path.
- **Cluster mode**: p95 latency must not exceed 2x standalone for single-key operations (ioredis Cluster adds one MOVED redirect on first access per slot, then caches the slot mapping; steady-state should be near-identical). Lua scripts with hash tags should have identical latency since all keys land on the same slot.
- **Throughput**: Cluster mode should demonstrate linear write scaling with additional masters. Tier-L (6 masters) should handle 6x the write throughput of a single standalone node.
- **SCAN operations**: `scanKeys()` in cluster mode iterates all masters (ioredis `Cluster.scanStream` does this automatically). Acceptable to be N-masters times slower than standalone SCAN, since SCAN is used only for cache invalidation and cleanup (not hot path).
- **BullMQ**: No performance difference expected. BullMQ natively supports Cluster connections.

**Source**: ioredis Cluster architecture (MOVED/ASK redirect handling), BullMQ Cluster support documentation, helm values showing tier-L at 6 masters
**Confidence**: MEDIUM (exact thresholds need validation via load test)

---

### Q9: What existing features does this interact with?

**Classification**: ANSWERED
**Answer**:

| Feature                                                                                                               | Redis Usage                                                                                 | Cluster Impact                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Sessions** (runtime)                                                                                                | HASH per session, pub/sub for sync                                                          | `duplicate()` for pub/sub subscriber breaks; HASH is single-key (OK) |
| **BullMQ Queues** (runtime, workflow-engine, search-ai)                                                               | Queue + Worker pairs                                                                        | `duplicate()` breaks; BullMQ needs Cluster-aware connections         |
| **Circuit Breaker** (`packages/circuit-breaker`)                                                                      | 5-key Lua scripts (failures, successes, state, opened_at, half_open_count)                  | CROSSSLOT error — keys hash to different slots                       |
| **Agent Transfer** (`packages/agent-transfer`)                                                                        | 4-key `LUA_CREATE_SESSION` (session, index, active set, pod set); 3-key `LUA_CLAIM_SESSION` | CROSSSLOT error                                                      |
| **Execution Fan-Out Barrier** (`packages/execution`)                                                                  | 2-key Lua + `KEYS` command inside Lua                                                       | CROSSSLOT + KEYS returns partial results                             |
| **Pub/Sub** (trace streams, WebSocket handler, sync-execution, auth-profile paused-execution, keyspace notifications) | `duplicate()` for subscriber connections                                                    | `duplicate()` breaks on Cluster                                      |
| **Rate Limiting** (agent-transfer, search-ai-runtime)                                                                 | Single-key Lua (ZADD/ZCARD)                                                                 | OK for single-key; search-ai-runtime bypasses factory                |
| **Distributed Locks** (shared, runtime)                                                                               | SET NX PX (single-key)                                                                      | OK for single-key operations                                         |
| **Cache Invalidation** (studio, search-ai, search-ai-runtime, pipeline-engine, lambda-deployment-store)               | `redis.keys(pattern)`                                                                       | Partial results in Cluster (silent data loss)                        |
| **Connector Presence** (search-ai)                                                                                    | HASH + EXPIRE per connector                                                                 | Bypasses shared factory; uses `new Redis()` directly                 |
| **Message Persistence Queue** (runtime)                                                                               | BullMQ Queue + Worker                                                                       | `duplicate()` breaks                                                 |
| **KMS Re-encryption Queue** (runtime)                                                                                 | BullMQ Queue + Worker                                                                       | `duplicate()` breaks                                                 |
| **LLM Queue** (runtime)                                                                                               | BullMQ Queue + Worker                                                                       | `duplicate()` breaks                                                 |

**Source**: Full codebase grep for `.duplicate()`, `.keys()`, Lua KEYS usage, and direct ioredis imports
**Confidence**: HIGH

---

### Q10: Backwards compatibility -- must existing standalone deployments work without ANY config change?

**Classification**: ANSWERED
**Answer**: Yes. Absolute requirement. `REDIS_CLUSTER` defaults to `false` per `redis.schema.ts:34` (`z.boolean().default(false)`). No helm values in any tier currently set `REDIS_CLUSTER=true`. The default behavior must be byte-for-byte identical to today's behavior. This is enforced by:

1. Config schema default: `cluster: z.boolean().default(false)`
2. Env mapping: `REDIS_CLUSTER` is optional; if unset, `false`
3. `createRedisConnection()` only enters the cluster branch when `opts.cluster && opts.url` at `connection.ts:171`

The helpers (`createSubscriber`, `createBullMQPair`, `scanKeys`, etc.) must produce the same underlying ioredis calls when `cluster=false` as the current raw `.duplicate()` / `.keys()` calls.

Hash-tagged key formats (e.g., `breaker:{level:key}:state`) work identically in standalone mode -- the `{...}` characters are just literal characters in standalone Redis. No behavioral difference.

**Source**: `packages/config/src/schemas/redis.schema.ts:34`, `packages/redis/src/connection.ts:171`, `packages/config/src/env-mapping.ts:78`
**Confidence**: HIGH

---

### Q11: Which packages/services are affected?

**Classification**: ANSWERED
**Answer**:

**Core package (primary changes)**:

- `packages/redis` — New helpers, fix `duplicate()`, fix `resolveRedisOptionsFromEnv()`

**Packages with Lua script changes**:

- `packages/circuit-breaker` — Hash-tag all 4 Lua scripts (5 KEYS each), update `scripts.ts` for Cluster-compatible defineCommand/eval
- `packages/agent-transfer` — Hash-tag `LUA_CREATE_SESSION` (4 keys), `LUA_END_SESSION` (2 keys), `LUA_CLAIM_SESSION` (3 keys), `LUA_EXTEND_TTL` (2 keys)
- `packages/execution` — Hash-tag fan-out-barrier keys, replace KEYS command in `LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` with SCAN or hash-tag approach

**Packages with KEYS command removal**:

- `packages/shared` — `lambda-deployment-store.ts:111`
- `packages/pipeline-engine` — `analytics-cache.ts:109`

**Apps with duplicate() migration**:

- `apps/runtime` — `server.ts:2004`, `websocket/handler.ts:781`, `services/sync-execution.ts`, `services/message-persistence-queue.ts:904,1002`, `services/kms/reencryption-queue.ts:88-89`, `services/llm/llm-queue.ts:196,206`, `services/trace/redis-trace-store.ts:510`, `services/agent-transfer/index.ts:448`, `services/auth-profile/paused-execution-store.ts:583`

**Apps with factory bypass migration**:

- `apps/workflow-engine` — `services/redis.ts` (replace `new Redis()` with shared factory), `index.ts:733,736,809`, `services/callback-delivery-worker.ts:51-52`, `services/trigger-scheduler.ts:64-65`
- `apps/search-ai` — `services/connector-presence.service.ts` (replace `new Redis()`)
- `apps/search-ai-runtime` — `middleware/rate-limit.ts:120` (dynamic `import('ioredis')`)

**Apps with KEYS command removal**:

- `apps/search-ai` — `routes/intelligence.ts:966`
- `apps/search-ai-runtime` — `services/idp/idp-token-validator.ts:332`, `services/cache/group-membership-cache.ts:130,194`, `services/query/query-cache.ts:123,147`
- `apps/studio` — `lib/invalidate-definition-cache.ts:21`

**Not affected** (no Redis usage or already compatible):

- `apps/admin` — Uses Redis through shared packages only
- `packages/shared-auth` — No direct Redis calls found in grep
- `packages/database` — MongoDB only

**Source**: Comprehensive codebase grep for `.duplicate()`, `.keys()`, `from 'ioredis'`, Lua KEYS references
**Confidence**: HIGH

---

### Q12: What data models change? Any data migration required?

**Classification**: DECIDED
**Answer**:

**Key shape changes** (hash-tag wrapping for Lua co-location):

| Package         | Current Key Pattern                                                                                                              | New Key Pattern                                                                | Change                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| circuit-breaker | `breaker:{level}:{key}:failures`                                                                                                 | `breaker:{<level>:<key>}:failures`                                             | Hash-tag wraps the discriminating segment            |
| circuit-breaker | `breaker:{level}:{key}:state`                                                                                                    | `breaker:{<level>:<key>}:state`                                                | Same                                                 |
| agent-transfer  | `agent_transfer:{tenantId}:{contactId}:{channel}` + `at_by_provider:{provider}:...` + `at_active_sessions` + `at_pod:{hostname}` | All 4 keys need a shared hash tag like `{at:<tenantId>:<contactId>:<channel>}` | Requires design decision on hash-tag scope (see Q13) |
| execution       | `barrier:{barrierId}` + `barrier:{barrierId}:result:{branchKey}`                                                                 | `barrier:{<barrierId>}` + `barrier:{<barrierId>}:result:{branchKey}`           | Hash-tag on barrierId ensures co-location            |

**No data migration required**. Rationale:

- Circuit-breaker keys have TTL = `reset_timeout * 2` (per `record-failure.lua:92`), typically seconds to minutes. Old keys expire naturally.
- Agent-transfer session keys have TTL set at creation (`ARGV[1]` in `LUA_CREATE_SESSION`). Sessions are short-lived.
- Fan-out-barrier keys have TTL = timeout seconds. Barriers are ephemeral.
- During rollout, old-format keys will coexist briefly with new-format keys. Since each key is independent (not cross-referenced by format), this is safe. A breaker might "reset" for a brief window when the new code creates keys with the new format, but the monitoring window is typically seconds.

**Brief TTL-flush is acceptable** for all affected key families. No explicit migration job needed.

**Source**: `record-failure.lua:92-98` (TTL = reset_timeout \* 2), `lua-scripts.ts:34` (TTL from ARGV[1]), `redis-fan-out-barrier.ts:28` (TTL from KEYS[2])
**Confidence**: HIGH

---

### Q13: Security/isolation implications?

**Classification**: DECIDED
**Answer**:

**Tenant isolation is preserved**. The key concern is: hash tags must not create a "hot slot" where all of one tenant's keys land on the same Redis Cluster node, creating imbalanced load.

Analysis per key family:

1. **Circuit Breaker** (`breaker:{<level>:<key>}:*`): The `level` is one of `tenant`, `project`, `model`, `provider`. The `key` includes tenant/model/provider identifiers. Hash-tagging on `{level:key}` means all 5 breaker keys for a single circuit land on the same slot. This is correct -- a tenant's breaker keys are few (one set per circuit) and short-lived. Different tenants' breakers hash to different slots due to different key content. **Safe**.

2. **Agent Transfer** (`LUA_CREATE_SESSION` uses 4 keys): The problematic set is `at_active_sessions` (global) and `at_pod:{hostname}` (per-pod). These cannot share a hash tag with the per-session key because they are cross-session. **Design decision**: Refactor `LUA_CREATE_SESSION` to split the SADD operations out of the Lua script into separate pipelined commands. The session hash + provider index can share a hash tag. The global set and pod set operations are idempotent and can be non-atomic. This avoids a global hot slot.

3. **Fan-Out Barrier** (`barrier:{<barrierId>}:*`): Hash-tagging on `barrierId` (a UUID) ensures all keys for one barrier land on the same slot. Different barriers hash uniformly across slots due to UUID randomness. **Safe**.

4. **Per-session pub/sub subscribers**: Already keyed by session/channel. Sessions are distributed across slots. **Safe**.

**Tenant isolation invariant**: Tenant IDs remain embedded in key names. The hash tag does not change the logical isolation -- it only controls which slot the key lands in. Cross-tenant access is impossible because each service still queries by its own key (which includes tenantId).

**Source**: CLAUDE.md invariant #1 (Resource Isolation), circuit-breaker key patterns from `record-failure.lua:5-9`, agent-transfer key patterns from `lua-scripts.ts:17-24`
**Confidence**: HIGH

---

### Q14: Deployment/migration strategy -- phased rollout?

**Classification**: DECIDED
**Answer**:

Phased, additive rollout. Each phase is independently deployable and backward-compatible:

| Phase | Name               | Scope                                                                                                                                                                                                       | Exit Criteria                                                                                     |
| ----- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **0** | Foundation Helpers | Add `createSubscriber()`, `createBullMQPair()`, `scanKeys()`, `hashTag()`, `runLuaScript()` to `packages/redis`. Fix `resolveRedisOptionsFromEnv()` to read `REDIS_CLUSTER`. Fix `duplicate()` for Cluster. | Helpers pass unit tests. Standalone mode unchanged (regression test).                             |
| **1** | KEYS Removal       | Replace all 12+ `redis.keys(pattern)` sites with `scanKeys()`.                                                                                                                                              | Zero `redis.keys()` calls in production code (grep-verified). Standalone behavior unchanged.      |
| **2** | Lua Redesign       | Hash-tag circuit-breaker (4 scripts), agent-transfer (5 scripts), fan-out-barrier (4 scripts). Replace KEYS inside Lua with hash-tag-aware SCAN or enumeration.                                             | All Lua scripts pass with both standalone and 6-node cluster in CI.                               |
| **3** | Consumer Migration | Replace all `duplicate()` call sites with `createSubscriber()` / `createBullMQPair()`. Migrate 3 bypass services to shared factory.                                                                         | Zero raw `.duplicate()` or `new Redis()` outside `packages/redis`.                                |
| **4** | SIT Validation     | Enable `REDIS_CLUSTER=true` in SIT environment. Run full E2E suite.                                                                                                                                         | All E2E tests pass. Circuit breaker, agent transfer, fan-out-barrier verified under cluster mode. |
| **5** | Prod Enable        | Enable `REDIS_CLUSTER=true` in tier-M first, then tier-L, then tier-XL.                                                                                                                                     | 30-day soak period per tier with zero CROSSSLOT errors.                                           |

Each phase ships as one or more additive commits per the commit discipline rules.

**Source**: CLAUDE.md commit discipline (additive, max 40 files, max 3 packages), SDLC feature status lifecycle (PLANNED -> ALPHA -> BETA -> STABLE)
**Confidence**: HIGH

---

### Q15: External dependencies?

**Classification**: ANSWERED
**Answer**:

| Dependency                          | Status                                                  | Notes                                                                               |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ioredis`                           | Already used (`packages/redis/package.json`)            | ioredis Cluster is built-in, no additional dep. Version should be 5.x (verify).     |
| `bullmq`                            | Already used across runtime, workflow-engine, search-ai | BullMQ 4.x+ natively accepts ioredis Cluster instance as `connection`.              |
| Docker (local cluster test harness) | New dev dependency                                      | Need a `docker-compose.cluster.yml` with 6-node Redis Cluster for CI/local testing. |

No new npm dependencies required. The `ioredis` package's `Cluster` class is the entire cluster implementation. BullMQ accepts any ioredis-compatible connection (Redis or Cluster).

**Source**: `packages/redis/package.json` (ioredis already listed), BullMQ documentation, ioredis documentation
**Confidence**: HIGH

---

### Q16: Observability -- what metrics/dashboards must exist before flipping cluster mode in prod?

**Classification**: DECIDED
**Answer**:

**Must-have before Phase 4 (SIT)**:

1. **CROSSSLOT error counter** — Any CROSSSLOT error is a P0 bug. Alert on count > 0.
2. **MOVED redirect counter** — Expected during slot migration/failover; alert if sustained > 100/min (indicates misconfigured slot mapping).
3. **ASK redirect counter** — Expected during live resharding; alert if sustained.
4. **Connection count per node** — Detect imbalanced connections.
5. **Redis Cluster `CLUSTER INFO` metrics** — `cluster_state`, `cluster_slots_ok`, `cluster_slots_fail`, `cluster_known_nodes`.

**Must-have before Phase 5 (Prod)**: 6. **Slot distribution heatmap** — Keys per slot, identify hot slots. 7. **Per-node command rate** — Detect imbalanced load from bad hash-tag design. 8. **Failover detection** — Time from node failure to MOVED redirect resolution. 9. **Pub/sub subscriber reconnection time** — Duration of pub/sub gap during failover.

These can be implemented as Prometheus metrics scraped from Redis Cluster via `redis_exporter` (already configured in helm values: `monitoring.enabled: true`).

**Source**: Helm values (`monitoring.enabled: true` across all tiers), CLAUDE.md invariant #4 (Traceability)
**Confidence**: MEDIUM (exact dashboard layout TBD)

---

### Q17: Failure modes -- cluster node failover behavior?

**Classification**: DECIDED
**Answer**:

| Failure Mode                          | Expected Behavior                                                                                                                                              | Blip Duration                                                                  | Impact                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single master fails**               | ioredis Cluster receives MOVED, redirects to new master (promoted replica). Automatic.                                                                         | 1-15 seconds (Redis Cluster failover time: `cluster-node-timeout` default 15s) | Brief ECONNREFUSED for in-flight commands to that node; ioredis retries automatically                                                         |
| **Replica fails**                     | No impact on writes. Reads from that replica fail; ioredis routes to other replicas or master.                                                                 | 0 seconds                                                                      | None for writes; brief blip for read replicas                                                                                                 |
| **Pub/Sub subscriber on failed node** | ioredis Cluster's pub/sub is node-specific. Subscriber must reconnect. `createSubscriber()` should register `error` and `close` event handlers that reconnect. | 15-30 seconds                                                                  | Missed pub/sub messages during reconnection. Consumers must tolerate this (they already do -- per CLAUDE.md #3, no pod-local state as truth). |
| **Slot migration (resharding)**       | ASK redirects during migration. ioredis handles transparently.                                                                                                 | 0 seconds (transparent)                                                        | None                                                                                                                                          |
| **Network partition (split-brain)**   | `cluster-require-full-coverage: 'no'` (set in all tier helm values) means available partitions continue serving their slots.                                   | 0 for available slots; unavailable slots return CLUSTERDOWN                    | Partial degradation -- circuit breaker may miss updates for affected slots                                                                    |
| **BullMQ during failover**            | BullMQ retries indefinitely (`maxRetriesPerRequest: null`). Jobs are not lost (persisted in Redis).                                                            | 15-30 seconds                                                                  | Job processing pauses, resumes after failover                                                                                                 |

**Key design requirement for `createSubscriber()`**: Must attach `error` and `close` handlers that auto-reconnect. Must log reconnection events for observability.

**Source**: Helm values `cluster-require-full-coverage: 'no'` (tier-M L703, tier-L L813, tier-XL L921), ioredis Cluster documentation, BullMQ Cluster support
**Confidence**: HIGH

---

### Q18: Testing -- real cluster or mocking?

**Classification**: ANSWERED
**Answer**: Must be a real Redis Cluster. Per CLAUDE.md "Test Architecture" and "E2E Test Standards":

> "No mocking platform components in ANY test" -- `vi.mock()` / `jest.mock()` of `@agent-platform/*`, `@abl/*`, or relative imports is FORBIDDEN

A mocked cluster would miss the exact errors this feature fixes (CROSSSLOT, partial KEYS results, MOVED redirects). The test must exercise real slot routing.

**Implementation**: A `docker-compose.cluster.yml` with a 6-node Redis Cluster (3 masters + 3 replicas) for local/CI testing. This mirrors the tier-M topology. Tests should:

1. Verify all Lua scripts execute without CROSSSLOT errors
2. Verify `scanKeys()` returns complete results across all nodes
3. Verify `createSubscriber()` receives messages
4. Verify `createBullMQPair()` produces working Queue + Worker
5. Verify standalone mode still works (separate test run without cluster)

**Source**: CLAUDE.md "Test Architecture" section, CLAUDE.md "E2E Test Standards" section
**Confidence**: HIGH

---

### Q19: Rollout safety -- kill-switch to fall back?

**Classification**: DECIDED
**Answer**: "Redeploy with `REDIS_CLUSTER=false`" is sufficient. A runtime kill-switch (hot-swap from cluster to standalone without restart) is not recommended because:

1. ioredis `Cluster` and `Redis` are different classes with different connection pools. Swapping at runtime would require disconnecting all connections and re-establishing them, which is equivalent to a restart.
2. BullMQ connections are established at startup and held for the process lifetime. Changing the underlying connection requires worker/queue restart.
3. The helm values already support `REDIS_CLUSTER` as an env var. Changing it and redeploying is a standard Kubernetes rolling update (PDB ensures min availability).
4. Rolling update with `REDIS_CLUSTER=false` reverts to the pre-feature behavior identically, since the default code path is unchanged.

**Risk mitigation**: Phase 4 (SIT) and Phase 5 (Prod) should start with a single service (e.g., runtime in tier-M) and expand pod-by-pod, verifying metrics at each step.

**Source**: CLAUDE.md invariant #3 (Stateless Distributed -- no pod-local state), helm values `podDisruptionBudget` settings
**Confidence**: HIGH

---

### Q20: Status flow -- PLANNED -> ALPHA -> BETA -> STABLE?

**Classification**: DECIDED
**Answer**:

| Status      | Gate                  | Criteria                                                                                                                                          |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PLANNED** | Feature spec approved | This document accepted                                                                                                                            |
| **ALPHA**   | Phase 0-1 complete    | Helpers land in `packages/redis`. All `redis.keys()` replaced. Standalone unchanged. Unit + integration tests pass.                               |
| **BETA**    | Phase 2-4 complete    | Lua scripts redesigned. All consumers migrated. 6-node cluster docker-compose CI green. SIT validated with `REDIS_CLUSTER=true`.                  |
| **STABLE**  | Phase 5 soak          | One production tier (tier-M) runs with `REDIS_CLUSTER=true` for 30 days. Zero CROSSSLOT errors. Zero data loss. p95 latency within 2x standalone. |

This aligns with the SDLC pipeline feature status lifecycle from `docs/sdlc/pipeline.md`.

**Source**: CLAUDE.md "Feature Status Lifecycle" section
**Confidence**: HIGH

---

## Decisions Made (for DECIDED items)

| #    | Decision                                                                                           | Rationale                                                                                                                                | Risk                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D-2  | Out of scope includes Sentinel, Redis Enterprise, BullMQ Flows redesign, data migration            | Sentinel already works; Enterprise is vendor lock-in; BullMQ natively supports Cluster; TTL-flush is sufficient for key format migration | Low                                                                                        |
| D-4  | Mode-aware abstraction selected over proxy/Enterprise/single-node                                  | Only approach that fixes CROSSSLOT at source; types already exist; ioredis Cluster is production-grade                                   | Low                                                                                        |
| D-7  | Requirements split into P0 (14 must-haves) and P1 (5 nice-to-haves)                                | P0 = everything needed for functional cluster mode; P1 = operational excellence                                                          | Low                                                                                        |
| D-8  | p95 latency must not exceed 2x standalone; zero regression for standalone                          | Cluster adds one MOVED redirect on first access; steady-state near-identical                                                             | Medium (needs load test validation)                                                        |
| D-12 | No data migration; TTL-flush for all affected key families                                         | All affected keys have TTLs (seconds to minutes); brief coexistence of old/new format is safe                                            | Low                                                                                        |
| D-13 | Agent-transfer LUA_CREATE_SESSION: split SADD into pipelined commands; hash-tag session+index only | Global set + pod set cannot share hash tag with session without creating hot slot                                                        | Medium (atomicity slightly reduced for set membership; acceptable since sets are advisory) |
| D-14 | 6-phase additive rollout                                                                           | Each phase independently deployable and backward-compatible per CLAUDE.md commit discipline                                              | Low                                                                                        |
| D-16 | CROSSSLOT error counter is alert-on-zero gate for prod                                             | Any CROSSSLOT error means a Lua script was missed                                                                                        | Low                                                                                        |
| D-17 | createSubscriber() must auto-reconnect on failover                                                 | Pub/sub is node-local in cluster; reconnection is mandatory                                                                              | Low                                                                                        |
| D-19 | No runtime kill-switch; redeploy with REDIS_CLUSTER=false is sufficient                            | Hot-swap requires disconnecting all connections = restart anyway                                                                         | Low                                                                                        |
| D-20 | ALPHA after Phase 0-1; BETA after Phase 2-4 + SIT; STABLE after 30-day prod soak                   | Aligns with SDLC lifecycle gates                                                                                                         | Low                                                                                        |

## Escalations (for AMBIGUOUS items -- requires user input)

| #   | Question                                                                                  | Why It's Ambiguous                                                                                                                                                                                                              | Options                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-3 | What is the priority/timeline driver? SIT readiness date? Production tier rollout target? | No timeline is specified in any existing documentation. Helm values show infrastructure is provisioned but app layer blocks cluster enablement. The urgency depends on when SIT or tier-M production deployments are scheduled. | **Option A**: SIT target within 2-4 weeks (aggressive -- Phase 0-2 in parallel) / **Option B**: SIT target within 6-8 weeks (standard SDLC pipeline with full audit rounds) / **Option C**: No hard deadline -- opportunistic improvement when capacity allows |
