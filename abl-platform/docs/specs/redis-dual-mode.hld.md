# HLD: Redis Dual-Mode Support (Standalone + Cluster)

**Feature Spec**: `docs/features/redis-dual-mode.md`
**Test Spec**: `docs/testing/redis-dual-mode.md`
**Status**: APPROVED
**Author**: Platform team (Pattabhi)
**Date**: 2026-05-04
**Approved**: 2026-05-05 (5 pr-reviewer rounds + 8-round LLD audit complete; Phases 0-4 implemented)

---

## 1. Problem Statement

The ABL Platform cannot operate against a true Redis Cluster topology today. Helm values for tiers M / L / XL already provision Redis Cluster (3+3, 6+6, 12+24 masters/replicas; `cluster-enabled: 'yes'`) but `REDIS_CLUSTER=true` is never set. Five categories of incompatibility prevent flipping the flag:

1. `packages/redis/src/connection.ts:202` hard-casts the client to `Redis` when calling `.duplicate()` — `Cluster` doesn't expose that method.
2. ~25 production call sites across `apps/runtime` (~16), `apps/workflow-engine` (~7), and `packages/redis/src/bullmq.ts` (2) invoke `.duplicate()`.
3. Multi-key Lua in `packages/circuit-breaker`, `packages/agent-transfer`, `packages/execution` spans different cluster slots → `CROSSSLOT`. `redis-fan-out-barrier.ts:99,112` uses the `KEYS` command **inside Lua** (forbidden in cluster mode).
4. 10 production call sites across 8 files use top-level `KEYS` — partial-result silent data loss in cluster. (The feature spec references 12 sites including two paths — `packages/shared-auth/src/idp/idp-token-validator.ts:407` and `apps/search-ai-runtime/src/routes/auth-oauth.ts:394` — that do not exist on disk; verified absent during HLD audit Round 2. The 10 real sites are listed in feature spec §4 FR-7 and §10 with corrected paths.)
5. Three services bypass the shared connection factory entirely (`apps/workflow-engine`, `apps/search-ai/connector-presence`, `apps/search-ai-runtime`).

The goal is to make `@agent-platform/redis` mode-aware so flipping `REDIS_CLUSTER=true|false` transparently switches modes — service code stays mode-agnostic, all branching lives inside the shared package, and standalone behavior is byte-for-byte identical.

---

## 2. Alternatives Considered

### Option A — Mode-aware abstraction in `@agent-platform/redis` (RECOMMENDED)

- **Description**: Add 5 mode-aware helpers (`createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys`) to the shared package. Helpers branch on `instanceof Cluster` once at construction. Migrate every consumer to the helpers. Redesign 3 Lua-script families to use hash tags. Migrate 3 bypass services back to the factory.
- **Pros**:
  - Single point of branching → no service-level conditionals leak.
  - Reuses existing `RedisClient = Redis | Cluster` union already exported from `packages/redis/src/types.ts`.
  - Connection factory + config schema already 30% support cluster (`packages/redis/src/connection.ts:171-185`, `packages/config/src/schemas/redis.schema.ts:34`).
  - Backward compatible: standalone mode delegates to `.duplicate()` verbatim, no behavior change.
  - Lint hooks block regression.
- **Cons**:
  - Requires touching ~30 files for `.duplicate()` migration and ~12 files for `KEYS` migration.
  - Recovery gap in agent-transfer split-Lua (acceptable per FR-9: indexes are advisory, TTL self-cleans).
- **Effort**: M (6–8 weeks, 6 phases)

### Option B — Per-service Cluster usage (REJECTED)

- **Description**: Each consumer service constructs its own `Redis | Cluster` via `instanceof` checks inline. No shared helpers — services individually call `.duplicate()` (standalone) or `new Cluster(...)` (cluster).
- **Pros**:
  - No shared-package version coupling during migration.
- **Cons**:
  - Branches `instanceof Cluster` in ~30 files. CROSSSLOT regressions become "any service developer's problem" indefinitely.
  - Violates the existing pattern of consolidating Redis concerns in `@agent-platform/redis`.
  - Triples lint surface (one rule per service to enforce).
  - No way to ship Phase 0 → Phase 1 incrementally.
- **Effort**: L (~10 weeks; high regression risk)

### Option C — Migrate all tiers to Redis Sentinel (REJECTED)

- **Description**: Tier-S already uses Sentinel (`redis-sentinel.abl-data.svc:26379`). Extend Sentinel to tiers M / L / XL; abandon Cluster.
- **Pros**:
  - Sentinel already works transparently with `.duplicate()` — no code change.
  - No Lua redesign, no `KEYS` migration.
- **Cons**:
  - **Forfeits horizontal write scaling** — Sentinel is HA, not sharded. Single-master ceiling at tier-XL is ~25k ops/sec; cluster scales linearly.
  - Throws away the helm-provisioned Cluster topology in M/L/XL (sunk infrastructure cost).
  - SIT environment is being stood up with Cluster as a deliberate platform standard — Sentinel is the wrong long-term direction.
- **Effort**: L (infra rework + tier migration)

### Recommendation: Option A

Option A wins because it (1) leverages the ~30% foundation already in place, (2) confines complexity to the shared package, (3) preserves byte-for-byte standalone behavior, and (4) unblocks SIT and tier-M/L/XL Cluster usage with a single env-flag flip per environment. Trade-off: the agent-transfer split-Lua introduces a recovery gap window where a session could be visible in `agent_transfer:*` but missing from `at_active_sessions` if a process crashes between the Lua call and the pipelined SADD. The TTL self-cleans within minutes; an operator-tool SCAN snippet covers incident response. This is acceptable because the indexes are advisory (recovery scans, pod-crash cleanup), not on the request critical path.

---

## 3. Architecture

### 3.1 System Context Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          ABL Platform Services                            │
│                                                                          │
│  apps/runtime     apps/workflow-engine    apps/search-ai(-runtime)       │
│  apps/studio      packages/{circuit-breaker, agent-transfer, execution,  │
│                              shared, pipeline-engine}                    │
│                                                                          │
│  All Redis I/O goes through ─────────────────┐                          │
└───────────────────────────────────────────────┼──────────────────────────┘
                                                │
                                                ▼
                          ┌──────────────────────────────────────┐
                          │      @agent-platform/redis           │
                          │                                      │
                          │   createRedisConnection(opts)        │
                          │   createSubscriber(handle)    NEW    │
                          │   createBullMQPair(handle)    NEW    │
                          │   runLuaScript(client, …)     NEW    │
                          │   hashTag(...parts)           NEW    │
                          │   scanKeys(client, pattern)   NEW    │
                          │                                      │
                          │   Branches on instanceof Cluster     │
                          │   once at construction time          │
                          └──────────────┬───────────────────────┘
                                         │
                       REDIS_CLUSTER=false │ true
                                         │
                ┌────────────────────────┼─────────────────────────────────┐
                ▼                                                          ▼
        ┌───────────────────┐                            ┌──────────────────────────────┐
        │  ioredis Redis    │                            │     ioredis Cluster          │
        │  (standalone)     │                            │  3+3 / 6+6 / 12+24 nodes     │
        │                   │                            │  cluster-require-full-       │
        │  tier-XS/S        │                            │   coverage: no               │
        │  + Sentinel for S │                            │  cluster-node-timeout: 5000  │
        │                   │                            │  retryDelayOnFailover: 500   │
        │                   │                            │  maxRedirections: 16         │
        └───────────────────┘                            └──────────────────────────────┘
```

### 3.2 Component Diagram (`@agent-platform/redis` internals)

```
┌────────────────────────────── @agent-platform/redis ──────────────────────────────┐
│                                                                                   │
│  src/types.ts                                                                     │
│    export type RedisClient = Redis | Cluster                                      │
│                                                                                   │
│  src/connection.ts            ◄──── existing — fix duplicate/isReady/disconnect   │
│    createRedisConnection()    ◄──── existing factory (cluster path already wired) │
│    resolveRedisOptionsFromEnv() ◄── extend to read REDIS_CLUSTER                  │
│                                                                                   │
│  src/subscriber.ts (NEW)                                                          │
│    createSubscriber(handle)                                                       │
│      standalone → handle.client.duplicate()                                       │
│      cluster    → new Cluster(handle.nodes, handle.opts) + reconnect watchdog     │
│                                                                                   │
│  src/bullmq.ts (existing, widened)                                                │
│    createBullMQPair(handle)                                                       │
│      standalone → { queueConn, workerConn } via .duplicate()                      │
│      cluster    → { queueConn, workerConn } via two new Cluster instances        │
│      Both : maxRetriesPerRequest=null, enableReadyCheck=false on worker side     │
│                                                                                   │
│  src/lua.ts (NEW)                                                                 │
│    runLuaScript(client, script, keys, args)                                       │
│      → client.eval(body, keys.length, ...keys, ...args)                           │
│      ioredis manages EVALSHA + NOSCRIPT fallback transparently                   │
│      Increments redis.crossslot.errors counter on CROSSSLOT ReplyError           │
│                                                                                   │
│  src/keys.ts (NEW)                                                                │
│    hashTag(...parts) → '{p1:p2:...}'                                              │
│    scanKeys(client, pattern) : AsyncIterable<string>                              │
│      standalone → cursor SCAN until 0                                             │
│      cluster    → for node of client.nodes('master') → SCAN per node + dedupe   │
│                  → on stale-node retry once                                       │
│                                                                                   │
│  src/index.ts → re-export all of the above                                        │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Data Flow — Pub/Sub Connection (FR-1, FR-15)

```
   ┌──── Service code (apps/runtime/.../message-bridge.ts) ────┐
   │                                                            │
   │  const sub = createSubscriber(redisHandle)                 │
   │  await sub.subscribe('agent-transfer.events')              │
   │  sub.on('message', (channel, msg) => …)                    │
   │                                                            │
   └─────────────────┬──────────────────────────────────────────┘
                     │
                     ▼
   ┌─── @agent-platform/redis/subscriber.ts ──────────────────┐
   │                                                           │
   │  if (handle.client instanceof Cluster) {                  │
   │     const sub = new Cluster(handle.nodes, handle.opts)    │
   │     sub.on('+node', () => emit redis.cluster.failover)    │
   │     sub.on('error', () => attemptReconnect(sub))          │
   │     return sub                                            │
   │  } else {                                                 │
   │     return handle.client.duplicate()  // unchanged        │
   │  }                                                        │
   │                                                           │
   │  attemptReconnect(): re-instantiate up to 30 s; emit      │
   │    eventType: 'redis.subscriber.reconnect' on every retry │
   │                                                           │
   └───────────────────────────────────────────────────────────┘
```

### 3.4 Sequence Diagram — Agent Transfer Session Create (FR-9)

The most architecturally novel change. Pre-redesign: a single Lua script atomically writes the session hash, provider index, global active-sessions set, and pod set. Post-redesign: Lua handles only same-slot keys (session hash + provider index, sharing `{tenantId:contactId:channel}` hash tag); cross-slot index updates move outside the Lua boundary as pipelined commands.

```
Service                          @agent-platform/redis              Redis (Cluster)
  │                                       │                                │
  │ createSession(tenantId, contactId)    │                                │
  ├──────────────────────────────────────►│                                │
  │                                       │  runLuaScript(LUA_CREATE,      │
  │                                       │     [sess_key, provider_key],  │
  │                                       │     [...args])                 │
  │                                       ├───────────────────────────────►│
  │                                       │   EVAL → HSET sess_key + ...   │
  │                                       │   HSET provider_key (same slot)│
  │                                       │◄───────────────────────────────┤
  │                                       │   OK                           │
  │                                       │                                │
  │                                       │  pipeline.exec([               │
  │                                       │    SADD at_active_sessions,    │
  │                                       │    SADD at_pod:{hostname}      │
  │                                       │  ])                            │
  │                                       ├───────────────────────────────►│
  │                                       │  ioredis Cluster auto-routes   │
  │                                       │  per-key by slot (no atomicity)│
  │                                       │◄───────────────────────────────┤
  │                                       │                                │
  │  return {sessionId, ownerPod}         │                                │
  │◄──────────────────────────────────────┤                                │
  │                                       │                                │

Recovery gap: if process crashes between EVAL and SADD pipeline,
session hash exists but indexes do not. TTL (per-session, default 30 min)
self-cleans. Operator-tool SCAN under agent_transfer:* reconciles during
incident response.
```

### 3.5 Data Flow — `scanKeys` in Cluster (FR-5, GAP-005)

```
   ┌── Service code (cache invalidation) ──┐
   │  for await (const k of scanKeys(...)) │
   │     await client.del(k)               │
   └──────────────┬────────────────────────┘
                  │
                  ▼
   ┌── scanKeys(client, pattern) ────────────────────────────────────┐
   │                                                                  │
   │  if (!isCluster(client)) → cursor SCAN until 0                  │
   │                                                                  │
   │  else {                                                          │
   │    nodes = client.nodes('master')                                │
   │    seen = new Set<string>()  // dedupe across slot migration    │
   │    for (const node of nodes) {                                   │
   │      try {                                                       │
   │        cursor SCAN node until 0 → yield each key (skip if seen) │
   │      } catch (NodeStaleError) {                                  │
   │        nodes = client.nodes('master')  // refresh, retry once   │
   │      }                                                           │
   │    }                                                             │
   │  }                                                               │
   │                                                                  │
   └──────────────────────────────────────────────────────────────────┘
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Unchanged. Tenant ID remains in every Redis key. Hash-tag choices avoid creating tenant-wide hot slots: circuit-breaker tags on `{level:key}` (never `{tenantId}` alone), agent-transfer on `{tenantId:contactId:channel}`. No key reshape aggregates per-tenant state into a single slot. CLAUDE.md invariant #2 (Universal Tenant Isolation) preserved.                                                                                                                                                                                                                                                                                                                              |
| 2   | **Data Access Pattern** | Repository layer: `@agent-platform/redis` is the single ingress for all Redis I/O. Direct `new Redis()` / `new Cluster()` outside the package is forbidden (lint-blocked). Helpers expose `RedisClient = Redis \| Cluster` so consumers stay mode-agnostic. Caching strategy unchanged: TTLs on all reshaped keys (circuit-breaker `reset_timeout * 2`, agent-transfer per-session, fan-out-barrier per-execution). Note: `packages/circuit-breaker/src/scripts.ts:24-27` currently uses `readFileSync`, which violates CLAUDE.md "no sync I/O in server code"; remediated in Phase 2 step 3.1 by switching to `fs.promises.readFile` during the same edit that adopts `runLuaScript`. |
| 3   | **API Contract**        | No new HTTP / WebSocket endpoints. Library API additions only: `createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys` (signatures in §6). All changes are additive — no existing exports change shape. **OQ-T-0 resolution**: admin endpoints assumed by test spec (`/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/{invalidate,keys}`) are **deferred** to a follow-up feature; integration tests use direct package APIs (`TransferSessionStore`, `scanKeys` calls) and trace-store assertions instead.                                                                                                                                        |
| 4   | **Security Surface**    | TLS config flows through `redisOptions` for `Cluster` constructor unchanged (`packages/redis/src/connection.ts:163-167`). Password / username handling unchanged. No new secrets, no new attack surface. SSRF: `REDIS_URL` is operator-controlled via helm values, never user-supplied. Encryption-at-rest: per-tenant field encryption in `agent-transfer` is unchanged (Lua operates on pre-encrypted blobs).                                                                                                                                                                                                                                                                        |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | `runLuaScript` catches `ReplyError: CROSSSLOT` and increments `redis.crossslot.errors`; surfaces as `RedisCrossSlotError` (subclass of existing `RedisOperationError`). `scanKeys` catches per-node errors and retries once on stale node list before propagating. `createSubscriber` reconnect failures emit `redis.subscriber.reconnect` events. User-visible errors unchanged — service-level error envelopes (`{ success, data?, error? }`) are preserved.                                                                                                                                                                                                                                                                              |
| 6   | **Failure Modes** | (a) **Master failover**: ioredis Cluster handles MOVED/ASK redirects transparently. p95 blip 1–15 s; pub/sub gap up to 30 s recovered by `createSubscriber` watchdog. (b) **Partition** (`cluster-require-full-coverage: 'no'`): available shards keep serving; commands to unavailable slots return error. (c) **Slot migration in flight**: `scanKeys` may yield duplicates from migrating slot — dedupe with in-iterator `Set<string>`. (d) **BullMQ Worker stall after reconnect** (GAP-008): reconnect watchdog in `createBullMQPair` if needed.                                                                                                                                                                                       |
| 7   | **Idempotency**   | All reshaped Redis operations remain idempotent at the operation level. Agent-transfer split-Lua: per-session Lua is atomic (single slot); subsequent SADD/SREM on `at_active_sessions` and `at_pod:*` are naturally idempotent (set semantics). Repeated `createSession` for the same key yields the same final state. Fan-out-barrier registry SET is idempotent (SADD). No new dedup tokens required.                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Observability** | Four new metrics: `redis.crossslot.errors` (counter, alert > 0/5min), `redis.moved.redirects` (counter, informational), `redis.cluster.failover` (counter, alert > 0), `redis.subscriber.reconnect` (emitted as **both** a structured log event with `eventType: 'redis.subscriber.reconnect'` and a Prometheus counter `redis_subscriber_reconnect_total`; E2E tests assert the counter via `/metrics` once exposed, structured logs are observable in Grafana Loki). Trace events emitted via existing `TraceStore` only on `runLuaScript` **error** (preserves CLAUDE.md invariant #4 without flooding the trace stream on the happy path). Existing `redis_exporter` Grafana dashboard surfaces slot distribution + `cluster_slots_ok`. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | (a) Standalone: **0% regression** — helpers branch once at construction; standalone path delegates to `.duplicate()` verbatim. (b) Cluster steady state: p95 ≤ 2× standalone (tier-XL = 12 masters + 24 replicas as upper bound). p50 ≤ 1.1× standalone (validated in Phase 4 SIT via k6, not CI-gated; one MOVED redirect on first miss, then ioredis caches slot mapping). (c) Cluster failover: p95 blip ≤ 30 s end-to-end; pub/sub gap ≤ 30 s. (d) Slot-cache refresh after MOVED: ≤ 500 ms. (e) Write throughput during slot resharding: ≤ 20% degradation (validated in Phase 4 SIT via k6 + `CLUSTER RESHARD` injection, not CI-gated). (f) `scanKeys` cluster: O(N) slower than standalone (one cursor pass per master) — acceptable because all current `KEYS` users are off-hot-path (cache invalidation, sync workers).                                                      |
| 10  | **Migration Path**     | 6 phases (per feature spec §13): **Phase 0** foundation helpers in `@agent-platform/redis` (no consumer change yet). **Phase 1** eliminate top-level `KEYS` (10 real sites across 8 files per §1; lint-block reintroduction). **Phase 2** Lua redesign per family (circuit-breaker → agent-transfer → fan-out-barrier; each ships independently). **Phase 3** consumer migration off `.duplicate()` and factory bypass (split into ≤3-package commits per CLAUDE.md). **Phase 4** SIT validation (`REDIS_CLUSTER=true`, k6 load, chaos failover, runbook). **Phase 5** prod rollout: tier-M 7d soak → tier-L 7d → tier-XL 7d → 30d post-enable observation → STABLE. Each phase is additive — every commit keeps standalone working unchanged. No data migration: all reshaped keys carry TTLs (seconds–minutes) and self-expire; old/new key formats coexist safely during deployment. |
| 11  | **Rollback Plan**      | Per-tier rollback: redeploy with `REDIS_CLUSTER=false` in helm values. No runtime hot-swap — process restart required (PDBs cover availability). No data cleanup required because (a) all reshaped keys carry TTLs and self-expire within minutes after rollback, (b) old-format keys coexist with new-format keys during the transition, (c) MongoDB and other persistent stores are untouched. Per-PR rollback during Phase 0–3: revert the PR; standalone remained functional throughout. Worst-case escape valve at Phase 4 SIT validation: if cluster unblockable, ship Phase 0–3 changes (which are safe in standalone) and defer the cluster-on switch to a follow-up.                                                                                                                                                                                                           |
| 12  | **Test Strategy**      | Per `docs/testing/redis-dual-mode.md`: 14 integration scenarios + 7 E2E (real HTTP, real cluster — `docker-compose.cluster.yml` 6-node), 4 unit, 6 ERR rows in coverage matrix. **Standalone parity** (E2E-PARITY) — every existing test suite runs unchanged on the standalone Redis. **Cluster parity** — same suites tagged `cluster` run against `docker-compose.cluster.yml`. **Static-analysis tests** (INT-13/14) verify no `.duplicate()` or top-level `KEYS` reintroduction outside `@agent-platform/redis` (CI grep + ESLint custom rule). **Chaos** (INT-12, `@chaos`-tag): graceful failover via `CLUSTER FAILOVER`, ungraceful via `docker stop`. **Failure paths** in coverage matrix: GAP-002 multi-key DEL non-atomicity, GAP-003 session-store pipeline race, GAP-005 scanKeys mid-failover dedup, GAP-008 BullMQ Worker stall.                                        |

---

## 5. Data Model

**No new collections, no MongoDB changes, no field additions.** Redis key reshape only — three families introduce hash tags; all retain existing TTLs.

### Reshaped Key Families

| Family          | Old Key Pattern                                    | New Key Pattern                                                                                                        | Hash Tag Scope                                                                | TTL                 |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| Circuit Breaker | `breaker:<level>:<key>:state` (5 suffixes)         | `breaker:{<level>:<key>}:state` …                                                                                      | Per-breaker (state, failures, successes, opened_at, half_open_count one slot) | `reset_timeout * 2` |
| Agent Transfer  | `agent_transfer:<tenantId>:<contactId>:<channel>`  | `agent_transfer:<tenantId>:<contactId>:<channel>` (key shape unchanged; Lua narrowed to single-key per implementation) | Single-key Lua (no hash tag needed); cross-slot index writes pipelined        | per-session         |
| Fan-Out Barrier | `barrier:<id>` + `barrier:<id>:result:<branchKey>` | `barrier:{<id>}` + `barrier:{<id>}:result:<branchKey>` + `barrier:{<id>}:result-keys` (SET)                            | Per-barrier (registry SET added)                                              | per-execution       |

### Single-Key Families (no change)

Distributed locks (`lock:exec:*`), session hashes (`sess:<tenantId>:<id>`), session conversation lists, reverse session lookups (`sess-tid:<id>`), trace streams (`trace:stream:<sessionId>`), rate-limiter buckets — all single-key and naturally cluster-safe.

> **Implementation deviation (agent-transfer)**: the original design proposed hash-tagging the agent-transfer key family. During implementation we discovered that `getByProvider` lookups don't have `tenantId`/`contactId`/`channel` available at lookup time, which would force a wider hash tag and reduce slot distribution. Resolved by narrowing every agent-transfer Lua script to operate on the session hash only (single-key) and pipelining cross-slot index writes (`at_by_provider:*`, `at_active_sessions`, `at_pod:<host>`) from the TypeScript caller. Trade-off: cross-slot atomicity is replaced by best-effort pipelined writes; partial failures are tolerated because the indexes are advisory and TTLs self-clean. Recovery snippet in `docs/guides/redis-cluster-mode.md` §5.

### Out-of-Lua Index Keys (agent-transfer)

`at_active_sessions` (global SET) and `at_pod:<hostname>` (per-pod SET) **do not** share a hash tag with the per-session keys. Their slot placement is uniform-random. They are written outside the Lua atomicity boundary as pipelined SADD/SREM commands; eventual consistency within 5 s is acceptable per FR-9 because the indexes are advisory.

### Coexistence Guarantee

Old-format keys (`breaker:auth:t1:state`) and new-format keys (`breaker:{auth:t1}:state`) are **different strings** to Redis — both can coexist without conflict. During rollout, old keys self-expire while new code writes new-format keys. **No data migration script is required.**

---

## 6. API Design

### Library API — `@agent-platform/redis` (NEW exports)

| Function           | Signature                                                                                                                                          | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `createSubscriber` | `(handle: RedisConnectionHandle) => RedisClient`                                                                                                   | Pub/sub-ready connection; mode-aware; auto-reconnect on cluster.           |
| `createBullMQPair` | `(handle: RedisConnectionHandle) => BullMQConnectionPair`                                                                                          | `{queueConnection, workerConnection, disconnect}`; mode-aware.             |
| `runLuaScript`     | `<T>(client: RedisClient, script: { name: string; body: string; numberOfKeys: number }, keys: string[], args: (string \| number)[]) => Promise<T>` | Uniform Lua execution over `Redis \| Cluster` via `eval`.                  |
| `hashTag`          | `(...parts: string[]) => string`                                                                                                                   | Returns `'{p1:p2:...}'`; inert in standalone, slot-co-locating in cluster. |
| `scanKeys`         | `(client: RedisClient, pattern: string) => AsyncIterable<string>`                                                                                  | Cursor-based iteration; iterates all masters in cluster with dedupe.       |

### Library API — modified existing exports

| Function                             | Change                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisConnectionHandle.isReady()`    | Drop `as Redis` cast at `connection.ts:194`; both `Redis` and `Cluster` expose `.status`.                                                                                         |
| `RedisConnectionHandle.disconnect()` | Drop `as Redis` cast at `connection.ts:207`; both `Redis` and `Cluster` expose `.quit()`.                                                                                         |
| `resolveRedisOptionsFromEnv`         | Read `REDIS_CLUSTER` boolean; propagate as `{ cluster: true }`. Today only `resolveRedisOptionsFromConfig` reads cluster.                                                         |
| `BullMQConnectionPair`               | Widen `queueConnection` and `workerConnection` from `Redis` to `RedisClient = Redis \| Cluster`.                                                                                  |
| ioredis `Cluster` constructor        | Configure `retryDelayOnFailover: 500`, `maxRedirections: 16`. Retry budget (`500 * 16 = 8000 ms`) > `cluster-node-timeout: 5000 ms`. Without this, commands fail during failover. |

### HTTP API

**No new HTTP / WebSocket endpoints.** Existing endpoints continue to work unchanged.

**OQ-T-0 resolution** (test-spec assumed admin endpoints): admin HTTP endpoints (`/api/admin/agent-transfer/active-sessions`, `/api/admin/cache/invalidate`, `/api/admin/cache/keys`) and `GET /metrics` Prometheus exposure are **out of scope** for this HLD. Test scenarios are restructured to exercise direct package APIs (`TransferSessionStore`, `scanKeys`) and to assert metric increments by reading the in-process counter directly. A follow-up feature ticket is filed for admin endpoints + `/metrics` exposure.

### Error Responses

No new error envelope changes. New internal error type:

```ts
// packages/redis/src/errors.ts
export class RedisCrossSlotError extends RedisOperationError {
  constructor(scriptName: string, keys: string[]) {
    super(`Lua script ${scriptName} keys span multiple slots: ${keys.join(', ')}`);
  }
}
```

This bubbles up as a 500 with the existing platform error envelope. Service-level handling is unchanged.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No new audit events. Operator changes to `REDIS_CLUSTER` are captured by the existing helm-values change audit trail (Argo / Bitbucket commit history).
- **Rate Limiting**: Unchanged. `apps/search-ai-runtime/src/middleware/rate-limit.ts` will work identically once it migrates off the bypass path to the shared factory in Phase 3.
- **Caching**: Unchanged. All TTLs preserved on reshaped keys.
- **Encryption**: Unchanged. TLS in transit (`redisOptions.tls` flows through to Cluster constructor); per-tenant at-rest encryption in agent-transfer operates on pre-encrypted blobs (Lua never sees plaintext).
- **Lint hooks**: Two new ESLint custom rules in `tools/eslint-rules/`:
  - `no-redis-duplicate`: blocks `.duplicate()` calls outside `packages/redis/`.
  - `no-redis-keys-command`: blocks top-level `client.keys(...)` outside `packages/redis/`.
  - Severity: **block** (not warn) per OQ-4 recommendation; introduced in Phase 1 (KEYS) and Phase 3 (duplicate) at the end of each phase to prevent regression.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                      | Type        | Risk                                                                                                                                                                   |
| ----------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ioredis@5.9.3` (already pinned)                | npm package | Low — version supports sharded pub/sub (out of scope) and the `Cluster` constructor options we need. Verified in `package.json`.                                       |
| `bullmq@^5.0.0` (already pinned)                | npm package | Medium — GAP-008 (taskforcesh/bullmq#2964) Worker stall on reconnect with Cluster. Validate fix presence in pinned version during Phase 4 SIT; add watchdog if absent. |
| `packages/redis/src/connection.ts` cluster path | internal    | Low — already 30% wired (`packages/redis/src/connection.ts:171-185`).                                                                                                  |
| `packages/config/src/schemas/redis.schema.ts`   | internal    | Low — `cluster: z.boolean().default(false)` already present at line 34.                                                                                                |
| `docker-compose.cluster.yml` (NEW, Phase 0)     | infra       | Low — standard Redis Cluster Docker recipe; pattern in use elsewhere.                                                                                                  |
| Helm cluster topology (already provisioned)     | infra       | Low — tier-M/L/XL already run `cluster-enabled: 'yes'`.                                                                                                                |

### Downstream (depends on this feature)

| Consumer                                                                          | Impact                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime` (~16 `.duplicate()` sites + session-store + agent-transfer bridge) | Phase 3 commits. Standalone-mode behavior byte-identical.                                                                                            |
| `apps/workflow-engine` (~7 `.duplicate()` sites + factory bypass)                 | Phase 3 commit. BullMQ pairs migrate to `createBullMQPair`; bypass migrates to `createRedisConnection`.                                              |
| `apps/search-ai` + `apps/search-ai-runtime` (factory bypass + 6 `KEYS` sites)     | Phase 1 (KEYS) + Phase 3 (factory). `idp-token-validator-compat.ts` and `end-user-auth.service.ts` work unchanged once wrapper delegates internally. |
| `apps/studio/src/lib/invalidate-definition-cache.ts:21`                           | Phase 1. One-line change to `scanKeys`.                                                                                                              |
| `packages/circuit-breaker`                                                        | Phase 2. Caller adopts `hashTag()`; Lua bodies unchanged.                                                                                            |
| `packages/agent-transfer`                                                         | Phase 2. Lua scripts split; non-atomic SADD pipelined; recovery-gap runbook added.                                                                   |
| `packages/execution`                                                              | Phase 2. Fan-out-barrier replaces in-Lua `KEYS` with explicit registry SET.                                                                          |
| `packages/shared`, `packages/pipeline-engine`                                     | Phase 1. Replace top-level `KEYS` with `scanKeys` (`shared-auth` previously listed in feature spec was a phantom path; verified no Redis usage).     |
| SRE / Operations                                                                  | Phase 4–5. Helm flag flip + dashboards + runbook; `docs/guides/redis-cluster-mode.md` (NEW).                                                         |

---

## 9. Open Questions & Decisions Needed

1. **OQ-1 (timeline confirmation)** — Carried forward from feature-spec. Assumed 6–8 week schedule (Option B in oracle log). User confirmation needed before committing in delivery tracking. Reference: `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md` A-3.
2. **OQ-2 (tier-S Sentinel direction)** — Tier-S uses `redis-sentinel.abl-data.svc:26379`. Long-term direction: keep Sentinel for tier-S, or migrate to Cluster too? Current scope: keep Sentinel.
3. **OQ-4 (lint hook severity)** — `block` recommended at Phase 1 (KEYS) and Phase 3 (duplicate) end. Confirm with team.
4. **OQ-5 (slot-distribution dashboard ownership)** — Platform owns dashboard JSON; SRE owns alert routing. Confirm split with SRE.
5. **OQ-T-0 (admin endpoints + /metrics) — RESOLVED in this HLD**: admin endpoints and `/metrics` exposure are out of scope; test scenarios use direct package APIs and in-process counter assertions. Follow-up feature ticket required for admin endpoints + Prometheus `/metrics` exposure.
6. **OQ-H-1 (BullMQ #2964 fix verification)** — GAP-008 Worker stall: confirm `bullmq@5.x` pinned version contains the reconnect fix; if not, add a watchdog inside `createBullMQPair`. Watchdog behavior: poll `Worker.isRunning()` every 5 s after a `'reconnecting'`/`'connect'` event; if the Worker remains stalled (ioredis status is `'connect'` not `'ready'`) for > 30 s, close the stale Worker and re-instantiate it with a fresh Cluster connection from the handle. Validate during Phase 4 SIT.
7. **OQ-H-2 (canary path Phase 0 → tier-M)** — Is there a pre-prod environment between SIT and tier-M production? If yes, recommend 7d soak there before tier-M. If no, document the SIT → tier-M direct path as the canary.
8. **OQ-H-3 (operator reconciliation tool)** — Recovery gap in agent-transfer split-Lua: TTL self-cleanup is sufficient for steady state. If operators need manual reconciliation during incident response, ship an operator-tool SCAN snippet in `docs/guides/redis-cluster-mode.md`. Confirm scope: snippet only, or proper CLI tool?

---

## 10. References

- Feature spec: `docs/features/redis-dual-mode.md`
- Test spec: `docs/testing/redis-dual-mode.md`
- Feature-spec audit log: `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md`
- Test-spec audit log: `docs/sdlc-logs/redis-dual-mode/test-spec-phase.log.md`
- Connection factory: `packages/redis/src/connection.ts`
- BullMQ wiring: `packages/redis/src/bullmq.ts`
- Type union: `packages/redis/src/types.ts` (`RedisClient = Redis | Cluster`)
- Config schema: `packages/config/src/schemas/redis.schema.ts:34`
- Circuit-breaker scripts: `packages/circuit-breaker/src/scripts.ts:79` (author noted cluster gap)
- Agent-transfer Lua: `packages/agent-transfer/src/session/lua-scripts.ts:105,114`
- Fan-out-barrier: `packages/execution/src/redis-fan-out-barrier.ts:99,112`
- Helm values: `deploy/helm-values/tier-{s,m,l,xl}/values.yaml`
- Existing Redis config guide: `docs/guides/redis-config.md`
- New operator runbook (Phase 4): `docs/guides/redis-cluster-mode.md`
- Prior art (related HLDs): `docs/specs/agent-transfer.hld.md`
- Platform invariants: `CLAUDE.md` (#2 Universal Tenant Isolation, #3 Stateless Distributed, #4 Traceability, #6 Performance)
- Design quality gate: `.claude/skills/design-quality-gate.md`
- ioredis Cluster docs (external): https://github.com/redis/ioredis#cluster
- BullMQ Cluster docs (external): https://docs.bullmq.io/guide/connections#cluster

---

## Post-Implementation Notes (2026-05-05)

Phases 0-4 implemented across 36 commits on `worktree-redis-cluster-dual-mode` (PR #885 → develop).

### Key design deviations from HLD

1. **Agent-transfer session-key shape unchanged**: HLD prescribed hash-tagged keys `agent_transfer:{tenantId:contactId:channel}`. Keys kept in original un-tagged shape — hash tagging unnecessary since all Lua scripts are now single-key. Avoids breaking ~20 test fixtures.

2. **Provider-index key kept un-tagged**: `at_by_provider:{provider}:{tenantId}:{providerSessionId}` cross-slot writes moved outside Lua to caller-side `pipeline()`. Atomicity traded for cluster safety; eventual consistency within TTL window (acceptable per FR-9).

3. **`getRedisClient()` return type kept at `any | null`**: Widening to `RedisClient | null` cascaded type errors across ~20 unrelated callers. New `getRedisHandle()` accessor is the cluster-aware path; legacy callers continue to work unchanged.

4. **`message-persistence-queue.ts` / `channel-queues.ts` use `handle.duplicate()`** instead of `createBullMQPair` — deferred, as Queue and Worker are constructed at different call-times and eager pairing would waste a connection per Worker recreation.

5. **`startWorkerWatchdog()`** added to `createBullMQPair` as GAP-008 mitigation — not in original HLD §12. Cluster mode default-on with 30 s threshold; counter `redis.bullmq.watchdog.recover` observable via OTel.

6. **`subscriber.ts` does not implement a custom reconnect loop**: ioredis Cluster handles auto-reconnect + resubscribe internally; `reconnecting` / `node error` listeners emit the metric and let ioredis drive recovery. Custom backoff would race with ioredis internals.

7. **`trigger-scheduler.ts` / `callback-delivery-worker.ts` retain a backward-compat `Redis | RedisConnectionHandle` constructor shim** instead of migrating fully to `createBullMQPair(handle)`. When a raw `Redis` instance is passed, an inline shim wraps it in a synthetic handle and calls `(redisOrHandle as Redis).duplicate(...)` — this path only executes in standalone mode with a legacy caller. Callers in `apps/workflow-engine/src/index.ts:593,720` pass the real `RedisConnectionHandle` via `getRedisHandle()` and take the cluster-safe `createBullMQPair` path.

### Open questions resolved

- OQ-1 (timeline): 6–8 week schedule confirmed.
- OQ-3 (`evalsha` SHA1 caching): resolved — `client.eval()` with ioredis EVALSHA/NOSCRIPT fallback.
- OQ-4 (lint hooks block vs warn): implemented as `block` (ESLint `no-restricted-syntax` errors in `.eslintrc.base.json`).
- OQ-5 (slot-distribution dashboard ownership): Platform owns dashboard JSON; SRE owns alert routing — documented in `docs/guides/redis-cluster-mode.md §9`.

## Post-Implementation Notes (2026-05-06) — Phase B PR-Review Fixes

Phase B applied 5 of 6 findings from the PR #885 review (1 finding non-actionable due to exemption):

1. **DI pattern for `createBullMQPair`** — `OutboxPollerDeps.createBullMQPairFn?` and `TriggerSchedulerDeps.createBullMQPairFn?` injectable deps allow workflow-engine unit tests to provide a synthetic `BullMQConnectionPair` without mocking `@agent-platform/redis`. Resolves `vi.mock` prohibition in 4 test files.

2. **Sync TLS I/O exemption** (not fixed) — `packages/redis/src/connection.ts` uses `fs.readFileSync` for TLS cert loading. `sync-io-lint.sh` explicitly exempts `*/redis/src/connection*`; sync I/O at connection-setup time is acceptable. Making it async would require breaking the synchronous `createRedisConnection` public API.

3. **`getdel` type fix** — `apps/search-ai-runtime/src/services/cache/redis-client.ts`: removed `as any` cast; ioredis v5.7 properly types `getdel` on both `Redis` and `Cluster`.

4. **Cluster-safe `del` loop** — `redis-client.ts` `del(...keys)` now deletes one key at a time. Multi-key `DEL` in cluster mode throws `CROSSSLOT` if keys span different slots. Loop is O(N) but all current callers delete ≤ 3 keys.

5. **`LuaScript` type in distributed-lock** — `packages/shared/src/redis/distributed-lock.ts` `release()` and `extend()` use named `RELEASE_SCRIPT`/`EXTEND_SCRIPT` constants of type `LuaScript = { name, body, numberOfKeys }`. `runLuaScript` requires this structured type, not a raw string.

6. **`getRedisInitError()` added** — `packages/redis/src/singleton.ts` now exports `getRedisInitError(): Error | null` for health-check endpoints that need to surface the root cause when Redis is unavailable.

7. **Vitest tier corrections** — `apps/workflow-engine/vitest.fast.config.ts` exclusion globs corrected from `src/__tests__/*.e2e.test.ts` (non-recursive) to `src/**/*.e2e.test.ts`, `src/**/*.cluster.test.ts`, `src/**/*.cluster.e2e.test.ts` (recursive). `src/routes/__tests__/**` added to fast-tier exclusions and http-tier includes so Supertest route tests run sequentially in the forks pool.

---

## Post-Implementation Notes (2026-05-10) — Whole-Codebase Data-Flow Audit (Rounds 3 + 4)

The earlier audit rounds (1+2, 2026-05-09) covered the dual-mode feature surface (the `@agent-platform/redis` package and its direct consumers). On 2026-05-10 the audit was re-run **across every package and app** at user request to ensure both modes are toggleable without regression. Two more rounds (3+4) found six additional issues — five CRITICAL pipelines and one HIGH config-coercion bug — none of which were on the original feature surface. All were fixed in the same change set.

| Site                                                                      | Issue                                                                                                         | Fix                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/trace/redis-trace-store.ts:247`                | Pipeline mixed `trace:stream:…` (slot A) + `trace:channel:…` (slot B)                                         | Split into `xadd+expire` pipeline on `streamKey`, then a separate top-level `publish(channelKey)` (already used in the parallel memory-pressure path).                                                      |
| `packages/agent-transfer/src/session/session-recovery-service.ts:245,299` | HGETALL pipeline across per-tenant session keys; EXISTS pipeline across per-host heartbeat keys               | Both replaced with `Promise.all` over independent commands. ioredis Cluster routes each call to its owning master.                                                                                          |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts:834`                     | Per-URL DEL pipeline                                                                                          | `Promise.all` over independent DELs. Best-effort cleanup; no ordering requirement.                                                                                                                          |
| `apps/search-ai/src/routes/intelligence.ts:994`                           | Per-page GET pipeline                                                                                         | `Promise.all` with `[err, val]`-shaped tuples preserved for downstream destructure.                                                                                                                         |
| `packages/config/src/env-mapping.ts` (+ 2 admin Turbopack copies)         | `coerceValue` split a comma-separated `REDIS_URL` (cluster seed list) into `string[]`; rejected by Zod schema | Added `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}` exemption. `mapEnvToConfig` threads `envKey` into `coerceValue`. Admin Turbopack copies updated to match with an explicit "keep in sync" comment. |
| `apps/runtime/src/services/agent-transfer/index.ts:702` (HIGH)            | `CONFIG SET notify-keyspace-events Ex` reaches one master in cluster mode                                     | Documented runbook step (configure in cluster parameter group); already commented at the call site. The keyspace **subscriber** was already cluster-aware via `createSubscriber(handle)`.                   |

**Standalone parity**: All six fixes are mechanically equivalent in standalone mode (no behavior change). Cluster mode now routes per-key as ioredis Cluster guarantees by contract. Verified by running unit tests on the modified call sites: `env-mapping.test.ts` 19/19 (with 2 new regression tests), `recovery-sscan-pipeline.test.ts` 6/6 (assertions rewritten), `redis-trace-store.test.ts` 32/32 (mock updated for split publish). `pnpm build --filter` is green for `redis`, `config`, `agent-transfer`, `runtime`, `search-ai`, `admin`.

**Status**: Feature stays at ALPHA pending Phase 5 helm flip and SIT chaos validation.

**Audit log**: `docs/sdlc-logs/redis-dual-mode/data-flow-audit.md` (Rounds 3+4 appended; previous Rounds 1+2 retained above).
