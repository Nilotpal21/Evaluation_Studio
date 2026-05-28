# Feature: Redis Dual-Mode Support (Standalone + Cluster)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `enterprise`, `admin operations`, `observability`
**Package(s)**: `@agent-platform/redis`, `@agent-platform/circuit-breaker`, `@agent-platform/agent-transfer`, `@agent-platform/execution`, `apps/runtime`, `apps/search-ai`, `apps/search-ai-runtime`, `apps/studio`, `apps/workflow-engine`
**Owner(s)**: Platform team (primary), with per-package subteam involvement during consumer migration
**Testing Guide**: `../testing/redis-dual-mode.md`
**Last Updated**: 2026-05-10

---

## 1. Introduction / Overview

### Problem Statement

The ABL Platform cannot operate against a true Redis Cluster topology today. Helm values for tiers M / L / XL already provision Redis Cluster (tier-M: 3 masters + 3 replicas; tier-L: 6 + 6; tier-XL: 12 + 24) with `cluster-enabled: 'yes'`, but `REDIS_CLUSTER=true` is never set in any environment (`deploy/helm-values/tier-{m,l,xl}/values.yaml`). The runtime services connect to those cluster endpoints in standalone/proxy mode, which forfeits horizontal write scaling and prevents the SIT environment (which is being stood up with Redis Cluster as part of the common stack) from coming online.

Five categories of incompatibility prevent flipping the flag today:

1. `packages/redis/src/connection.ts:202` hard-casts the client to `Redis` when calling `.duplicate()` — `Cluster` instances do not expose that method.
2. ~25 production call sites — `apps/runtime` (~13), `apps/workflow-engine` (~10), `packages/redis/src/bullmq.ts` (1) — invoke `.duplicate()` on the shared client (BullMQ pairs, pub/sub subscribers). Verified by `grep -rn '\.duplicate(' apps packages --include='*.ts' | grep -v __tests__`.
3. Multi-key Lua scripts in `packages/circuit-breaker`, `packages/agent-transfer`, and `packages/execution` operate on keys that hash to different cluster slots, producing `CROSSSLOT` errors. `packages/execution/src/redis-fan-out-barrier.ts:99,112` also uses the `KEYS` command **inside Lua**, which is forbidden in cluster mode.
4. 10 production files (12 call sites) use the top-level `KEYS` command:
   - `packages/shared/src/services/lambda/lambda-deployment-store.ts:111`
   - `packages/shared-auth/src/idp/idp-token-validator.ts:407`
   - `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts:109`
   - `packages/pipeline-engine/src/pipeline/services/definition-cache.ts:93`
   - `apps/studio/src/lib/invalidate-definition-cache.ts:21`
   - `apps/search-ai/src/routes/intelligence.ts:966`
   - `apps/search-ai-runtime/src/routes/auth-oauth.ts:394`
   - `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332`
   - `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130, :194` (2 calls)
   - `apps/search-ai-runtime/src/services/query/query-cache.ts:123, :147` (2 calls)
     In cluster mode, `KEYS` only scans the local node and returns partial results — silent data loss.
5. Three services bypass the shared connection factory entirely: `apps/workflow-engine/src/services/redis.ts`, `apps/search-ai/src/services/connector-presence.service.ts`, `apps/search-ai-runtime/src/services/cache/redis-client.ts`.

Today this hits **Platform Engineers** (cannot enable cluster), **SRE / Operators** (SIT setup blocked, paying for unused cluster capacity in M/L/XL tiers), **Service Developers** (no shared abstraction to write cluster-safe code), and **On-call** (would face CROSSSLOT and partial-result errors with no clear remediation if the flag were flipped).

### Goal Statement

Make `@agent-platform/redis` a mode-aware abstraction so that flipping a single environment flag (`REDIS_CLUSTER=true|false`) transparently switches the entire abl-platform between Redis standalone (current default) and Redis Cluster, with byte-for-byte identical behavior in standalone mode and full functional parity in cluster mode. Service code stays mode-agnostic; all branching lives inside the shared package.

### Summary

Add a small set of mode-aware helpers to `@agent-platform/redis` (`createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys`) that internally branch on `RedisClient = Redis | Cluster`. Migrate every consumer (apps + packages) to use these helpers instead of raw `.duplicate()`, raw `KEYS`, and raw multi-key Lua. Redesign three Lua-script families (circuit-breaker, agent-transfer, fan-out-barrier) to use Redis hash tags so all keys in any single script land in the same slot. Migrate three bypass services to the shared factory. Add a 6-node Redis Cluster Docker Compose harness for local testing and CI. Roll out additively in six phases — every phase keeps standalone working unchanged; cluster gets enabled in SIT only after the migration is complete.

---

## 2. Scope

### Goals

- **G1** — Expose mode-aware helpers in `@agent-platform/redis` (`createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys`) that handle the `Redis | Cluster` union internally.
- **G2** — Eliminate all uses of `.duplicate()` outside `@agent-platform/redis` (27+ call sites) by routing through the new helpers.
- **G3** — Eliminate the `KEYS` command across the codebase (12+ call sites), replacing with cursor-based `scanKeys`.
- **G4** — Redesign multi-key Lua scripts in circuit-breaker, agent-transfer, and fan-out-barrier so all keys in any single script hash to the same slot (via `hashTag`), and remove the forbidden in-Lua `KEYS` command in fan-out-barrier.
- **G5** — Migrate the three services that bypass the shared factory (`apps/workflow-engine`, `apps/search-ai/connector-presence`, `apps/search-ai-runtime`) onto `@agent-platform/redis`.
- **G6** — Add a 6-node Redis Cluster Docker Compose harness (`docker-compose.cluster.yml`) and a `pnpm test:cluster` target for parity testing.
- **G7** — Validate `REDIS_CLUSTER=true` end-to-end in SIT before promoting to production tiers.
- **G8** — Default behavior in standalone mode is byte-for-byte identical to today; no opt-in required for existing standalone deployments.

### Non-Goals (Out of Scope)

- **NG-1** — Redis Sentinel changes. Tier-S already uses `redis://redis-sentinel.abl-data.svc:26379` and works transparently; this feature does not modify Sentinel behavior.
- **NG-2** — Redis Enterprise / CRDB / Active-Active replication. Vendor-neutral approach using OSS Redis Cluster only.
- **NG-3** — In-memory pod-local caches (LRUs, etc.) — unrelated to the Redis transport layer.
- **NG-4** — MongoDB sharding, replication, or topology changes.
- **NG-5** — BullMQ Flows orchestration redesign. BullMQ supports Cluster natively; the only change is feeding it a `Cluster` instance.
- **NG-6** — BullMQ worker concurrency tuning or queue throughput changes.
- **NG-7** — Data migration tooling. All affected keys carry TTLs (seconds to minutes) and self-expire; old/new key formats coexist safely during rollout.
- **NG-8** — Cluster topology management or slot rebalancing (infrastructure concern, owned by SRE).
- **NG-9** — Multi-region Redis replication.
- **NG-10** — Pub/Sub channel namespace redesign. Existing channels work unchanged.

---

## 3. User Stories

1. **As a Platform Engineer**, I want a single mode-aware abstraction in `@agent-platform/redis` so that I can land cluster support without spreading conditional logic across every service.
2. **As a Service Developer (runtime, search-ai, studio, workflow-engine)**, I want to write Redis code that works identically in standalone and cluster modes without ever having to know which mode is active, so I am never the source of a `CROSSSLOT` regression.
3. **As an SRE / Operator**, I want to flip `REDIS_CLUSTER=true` in a SIT or production helm values file and have every service connect to the cluster correctly, so SIT setup and tier-M/L/XL prod can leverage the Redis Cluster topology that the helm charts already provision.
4. **As an On-call Engineer**, I want clear metrics (CROSSSLOT count, MOVED/ASK redirects, slot distribution, pub/sub reconnect duration) and known-failure-mode runbooks so that a Redis node failover or partition is a 60-second incident, not a 60-minute outage.
5. **As a Local Developer**, I want a `pnpm test:cluster` target that boots a real 6-node Redis Cluster in Docker so I can validate cluster-mode behavior on my laptop before opening a PR.

---

## 4. Functional Requirements

1. **FR-1** — The system must expose `createSubscriber(handle: RedisConnectionHandle): RedisClient` from `@agent-platform/redis` that returns a connection suitable for pub/sub. Internally it must call `.duplicate()` on standalone instances and instantiate a fresh `Cluster` (with the same node list and base options) on cluster instances. The companion `RedisConnectionHandle.isReady()` and `RedisConnectionHandle.disconnect()` methods (`packages/redis/src/connection.ts:194,207`) must also be cluster-aware — currently they hard-cast to `Redis`; both `Redis` and `Cluster` expose `.status` and `.quit()` but the cast is unsound and must be removed in the same change.
2. **FR-2** — The system must expose `createBullMQPair(handle: RedisConnectionHandle): BullMQConnectionPair` that returns two independent connections (queue + worker) with `maxRetriesPerRequest: null`. Standalone path uses `.duplicate()`; cluster path instantiates fresh `Cluster` instances.
3. **FR-3** — The system must expose `runLuaScript(client: RedisClient, script: { name: string; body: string; numberOfKeys: number }, keys: string[], args: (string | number)[])` that executes via `eval` on both `Redis` and `Cluster` (sidestepping `defineCommand` which is not Cluster-friendly). ioredis caches SHA1 internally on both classes.
4. **FR-4** — The system must expose `hashTag(...parts: string[]): string` that returns the parts joined by `:` and wrapped in `{}` (e.g., `hashTag('auth', 'tenant-1')` → `'{auth:tenant-1}'`). The braces are inert in standalone mode and force same-slot placement in cluster mode.
5. **FR-5** — The system must expose `scanKeys(client: RedisClient, pattern: string): AsyncIterable<string>` that iterates all matching keys using cursor-based `SCAN`. Standalone path scans the single node; cluster path iterates `client.nodes('master')` and yields keys from each.
6. **FR-6** — The system must replace every existing `.duplicate()` call site outside `@agent-platform/redis` with `createSubscriber()` or `createBullMQPair()`. No service-level code may call `.duplicate()` directly.
7. **FR-7** — The system must replace every existing top-level `KEYS` command with `scanKeys()`. A lint hook should block reintroduction.
8. **FR-8** — The circuit-breaker Lua scripts (`record-failure.lua`, `record-success.lua`, `check-state.lua`, `force-reset.lua`) must accept their existing 3–5 KEYS but the caller must construct those keys using `hashTag(level, key)` so all keys of a single breaker land in the same slot (e.g., `breaker:{auth:tenant-1}:state`, `breaker:{auth:tenant-1}:failures`). Lua bodies stay logically unchanged.
9. **FR-9** — The system must execute agent-transfer session create / end / claim / extend operations without `CROSSSLOT` errors in cluster mode while preserving the existing observable contract (per-session hash, provider index, global active-sessions set, per-pod set are all maintained correctly). Specifically:
   - **CREATE**: The `LUA_CREATE_SESSION` script's `SADD at_active_sessions` and `SADD at_pod:{hostname}` operations (currently inside Lua) must execute outside the Lua atomicity boundary as separate pipelined commands. The Lua retains only per-session keys (session hash + provider index, hash-tagged together).
   - **END**: The `LUA_END_SESSION` script's `DEL` of the dynamically-constructed provider index key (`at_by_provider:{provider}:{tenantId}:{providerSessionId}`) and `SREM` from `at_active_sessions` and `at_pod:{ownerPod}` (currently constructed inside Lua at `lua-scripts.ts:105,114`) must move outside the Lua boundary as pipelined commands. The Lua retains only the session-hash `DEL`.
   - **CLAIM**: The `LUA_CLAIM_SESSION` script's `SREM` from old pod set (`at_pod:{oldHostname}`) and `SADD` to new pod set (`at_pod:{newHostname}`) (3 keys spanning slots) must move outside the Lua boundary as pipelined commands. The Lua retains only the CAS on `ownerPod` (single-key HGET + HSET).
   - **EXTEND**: The `LUA_EXTEND_TTL` script (2 keys: session + provider index) must hash-tag both keys to share a slot.

   Atomicity of index updates with the per-session mutation is **not** required — eventual consistency within 5 s is acceptable since the indexes are advisory (recovery scans, pod-crash cleanup), not on the request critical path. **Recovery gap**: if a process crashes between the per-session Lua and the pipelined SADD/SREM, the session may be temporarily orphaned (visible in session hash but missing from the active-sessions set). TTL guarantees self-cleanup; an operator-tool SCAN under `agent_transfer:*` can reconcile during incident response.

10. **FR-10** — The fan-out-barrier (`packages/execution/src/redis-fan-out-barrier.ts:98-118`) must replace **both** `redis.call('KEYS', ...)` invocations inside Lua (`LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER`) with an explicit registry: a Redis SET (`barrier:{barrierId}:result-keys`) tracks branch result keys as they are written, and both Lua scripts iterate that SET instead of scanning. The barrier hash key, all per-branch result keys, and the result-keys registry SET share a hash tag (`{barrierId}`) so they all land in the same slot.
11. **FR-11** — `apps/workflow-engine/src/services/redis.ts`, `apps/search-ai/src/services/connector-presence.service.ts`, and `apps/search-ai-runtime/src/services/cache/redis-client.ts` must connect via `@agent-platform/redis`'s `createRedisConnection()` factory. Direct `new Redis()` / `new Cluster()` constructions outside the package are not allowed.
12. **FR-12** — `resolveRedisOptionsFromEnv()` must read `REDIS_CLUSTER` (boolean) and propagate it as `{ cluster: true }` when set. Today only `resolveRedisOptionsFromConfig()` reads cluster; env-based callers must also.
13. **FR-13** — When `REDIS_CLUSTER=false` (or unset), every code path must execute identically to today. A standalone deployment must require zero config or code changes.
14. **FR-14** — A `docker-compose.cluster.yml` must boot a 6-node Redis Cluster (3 masters + 3 replicas) configured with `cluster-enabled yes`, `cluster-require-full-coverage no`, `cluster-node-timeout 5000`. A `pnpm test:cluster` target must boot the cluster, run the integration suite tagged `cluster`, and tear down. The `ioredis.Cluster` constructor must be configured with `retryDelayOnFailover` and `maxRedirections` such that `retryDelayOnFailover * maxRedirections > cluster-node-timeout` (e.g., `retryDelayOnFailover: 500ms`, `maxRedirections: 16` → 8000 ms retry budget vs 5000 ms timeout). Without this, commands fail during failover. Reference: ioredis Cluster docs.
15. **FR-15** — Cluster mode failure handling: `createSubscriber()` must auto-reconnect on master failover within 30 seconds. Pub/sub gap must be logged with structured `eventType: 'redis.subscriber.reconnect'` so it is observable.
16. **FR-16** — Observability: emit metrics `redis.crossslot.errors` (counter, must stay 0 in steady state), `redis.moved.redirects` (counter, expected non-zero immediately after slot migration), `redis.cluster.failover` (counter, alert > 0). Wire into existing `redis_exporter` + Prometheus monitoring already enabled in helm values.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                       |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Project records live in MongoDB; Redis only carries derived/cache state.                    |
| Agent lifecycle            | SECONDARY    | Session and transfer state live in Redis; Lua-script changes affect agent handoff.          |
| Customer experience        | SECONDARY    | Failover blip during cluster node loss is the only customer-visible effect.                 |
| Integrations / channels    | NONE         | Channel adapters are stateless against Redis.                                               |
| Observability / tracing    | PRIMARY      | New cluster-mode metrics required; trace store uses Redis Streams (single-key, unaffected). |
| Governance / controls      | NONE         | No policy or governance surface change.                                                     |
| Enterprise / compliance    | PRIMARY      | Required for tier-L / tier-XL SaaS prod and SIT readiness.                                  |
| Admin / operator workflows | PRIMARY      | SRE flips `REDIS_CLUSTER` flag and consumes new dashboards / alerts.                        |

### Related Feature Integration Matrix

| Related Feature                         | Relationship Type | Why It Matters                                                            | Key Touchpoints                                                                                             | Current State                     |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Memory & Sessions                       | depends on        | Session store uses pub/sub `duplicate()`; non-atomic pipelines in Cluster | `apps/runtime/src/services/session/redis-session-store.ts`                                                  | Standalone-only today             |
| Circuit Breaker                         | depends on        | 4 multi-key Lua scripts will throw `CROSSSLOT` in Cluster                 | `packages/circuit-breaker/src/lua/*.lua`, `packages/circuit-breaker/src/scripts.ts`                         | Standalone-only; author noted gap |
| Agent Transfer                          | depends on        | 4 multi-key Lua scripts; index keys constructed inside Lua                | `packages/agent-transfer/src/session/lua-scripts.ts`                                                        | Standalone-only today             |
| Execution Fan-Out Barrier               | depends on        | `KEYS` inside Lua (forbidden in Cluster)                                  | `packages/execution/src/redis-fan-out-barrier.ts:98-118`                                                    | Standalone-only today             |
| BullMQ Flows                            | depends on        | All queues use `.duplicate()` for Worker pairs                            | `packages/redis/src/bullmq.ts:128-129`                                                                      | Standalone-only today             |
| Trace Store                             | shares data with  | Redis Streams (`XADD`/`XRANGE`) are single-key, already cluster-safe      | `apps/runtime/src/services/trace/redis-trace-store.ts`                                                      | Compatible                        |
| Distributed Locks                       | shares data with  | All single-key `SET NX PX`; already cluster-safe                          | `packages/shared-observability/src/distributed-lock.ts`, `apps/runtime/src/services/queues/session-lock.ts` | Compatible                        |
| Rate Limiting                           | depends on        | search-ai-runtime bypasses shared factory                                 | `apps/search-ai-runtime/src/middleware/rate-limit.ts`                                                       | Bypass migration required         |
| Connector Presence (search-ai)          | depends on        | Bypasses shared factory                                                   | `apps/search-ai/src/services/connector-presence.service.ts`                                                 | Bypass migration required         |
| Workflow Engine Triggers                | depends on        | Bypasses shared factory; uses BullMQ                                      | `apps/workflow-engine/src/services/redis.ts`                                                                | Bypass migration required         |
| IDP Token Validator (shared-auth)       | shares data with  | Uses top-level `KEYS` for cache invalidation                              | `packages/shared-auth/src/idp/idp-token-validator.ts:407`                                                   | KEYS-removal required             |
| IDP Token Validator (search-ai-runtime) | shares data with  | Uses top-level `KEYS`                                                     | `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332`                                        | KEYS-removal required             |
| Pipeline Definition Cache               | shares data with  | Uses top-level `KEYS` for cache invalidation                              | `packages/pipeline-engine/src/pipeline/services/{definition-cache.ts:93,analytics-cache.ts:109}`            | KEYS-removal required             |
| Studio Definition Cache Invalidation    | shares data with  | Uses top-level `KEYS`                                                     | `apps/studio/src/lib/invalidate-definition-cache.ts:21`                                                     | KEYS-removal required             |
| SearchAI Intelligence Route             | shares data with  | Uses top-level `KEYS` for page-key scan                                   | `apps/search-ai/src/routes/intelligence.ts:966`                                                             | KEYS-removal required             |
| SearchAI-Runtime Group Membership Cache | shares data with  | Uses top-level `KEYS` for membership invalidation                         | `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130,194`                               | KEYS-removal required             |
| SearchAI-Runtime Query Cache            | shares data with  | Uses top-level `KEYS` for query invalidation                              | `apps/search-ai-runtime/src/services/query/query-cache.ts:123,147`                                          | KEYS-removal required             |
| SearchAI-Runtime OAuth Routes           | shares data with  | Uses top-level `KEYS`                                                     | `apps/search-ai-runtime/src/routes/auth-oauth.ts:394`                                                       | KEYS-removal required             |

---

## 6. Design Considerations

This feature is operator-facing and has no Studio UI or end-user surface. The "design" surface is the helper API in `@agent-platform/redis` and the operator-facing config / metrics surface (`REDIS_CLUSTER` env flag, `redis.crossslot.errors` metric, etc.). No mockups or accessibility considerations apply.

---

## 7. Technical Considerations

- **Connection factory foundation already exists** at `packages/redis/src/connection.ts:171-185`. Cluster nodes are parsed from a comma-separated `REDIS_URL` and an `ioredis.Cluster` is constructed. The first hardening is fixing the `duplicate()` cast at line 202.
- **Config schema already has `cluster: z.boolean().default(false)`** at `packages/config/src/schemas/redis.schema.ts:34` and env-mapping wires `REDIS_CLUSTER` → `redis.cluster` at `packages/config/src/env-mapping.ts:78`. The remaining gap is `resolveRedisOptionsFromEnv()` not reading the env var.
- **Hash tags are a Redis-native feature**: `{tag}` characters in a key force slot computation to use only the content inside `{}`. In standalone mode, the braces are literal characters with no special meaning — a key like `breaker:{auth:t1}:state` works identically in both modes, just stored with the literal braces.
- **Lua script execution under Cluster**: ioredis `Cluster` supports `eval`/`evalsha` directly with automatic slot routing based on the first key. `defineCommand` is **not** supported on Cluster (and the circuit-breaker code at `packages/circuit-breaker/src/scripts.ts:79` already has a comment acknowledging this). The `runLuaScript` helper standardizes on `eval` for both modes.
- **`KEYS` command in cluster** only scans the local node and silently returns partial results. `SCAN` is also node-local in cluster, but ioredis `Cluster` exposes `nodes('master')` so `scanKeys` can iterate every master and yield a complete result set.
- **BullMQ + Cluster**: BullMQ already wraps queue names in hash tags internally (e.g., `bull:{queueName}:wait`) so all per-queue keys land in the same slot. The only change required is feeding it a `Cluster` instance instead of `ConnectionOptions`.
- **Pub/Sub in Cluster**: Redis Cluster forwards pub/sub messages globally across nodes. ioredis `Cluster` handles subscribe/publish correctly. The complication is `.duplicate()` not existing on `Cluster` — `createSubscriber()` instantiates a fresh `Cluster` from the existing handle's node list and base options.
- **Agent-transfer hot-slot avoidance**: A naive hash-tag on `{tenantId}` would funnel all of one tenant's traffic into a single slot. The chosen design hash-tags on `{tenantId:contactId:channel}` which distributes per-conversation, and moves the global `at_active_sessions` set + per-pod `at_pod:{hostname}` set out of the Lua atomicity boundary into separate pipelined commands. Index updates become non-atomic with session creation; that's acceptable because the indexes are advisory (recovery scans + pod-crash cleanup), not on the critical path.
- **Backward-compatible key reshape**: Hash-tagged keys (`breaker:{auth:t1}:state`) are different _strings_ than today's keys (`breaker:auth:t1:state`), but both deployments coexist safely because all affected keys carry TTLs (circuit-breaker: `reset_timeout * 2`, agent-transfer: per-session TTL, fan-out-barrier: per-execution timeout). During rollout, old keys self-expire while new code writes new-format keys. No migration script needed.

---

## 8. How to Consume

### Studio UI

N/A — this feature has no Studio UI surface.

### Surface Semantics Matrix

N/A — this is an internal infrastructure feature with no design-time / runtime asset split.

### Design-Time vs Runtime Behavior

The only operator-facing surface is the `REDIS_CLUSTER` env flag, which is consumed at process startup (no hot-reload). Service code never branches on cluster vs standalone — the decision is encapsulated in `@agent-platform/redis`.

### API (Runtime)

N/A — no new HTTP / WebSocket endpoints. Existing endpoints continue to work unchanged.

### API (Studio)

N/A.

### Admin Portal

N/A — no admin surface change. Operators interact via helm values and Grafana dashboards.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — channels are stateless against Redis at this layer.

### Library API (`@agent-platform/redis`)

| Function                     | Signature                                                            | Purpose                                                                |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `createRedisConnection`      | existing — `(opts: RedisConnectionOptions) => RedisConnectionHandle` | Already supports cluster path (no change).                             |
| `resolveRedisOptionsFromEnv` | existing — extended to read `REDIS_CLUSTER`                          | Reads env vars including `REDIS_CLUSTER`.                              |
| `createSubscriber` (NEW)     | `(handle: RedisConnectionHandle) => RedisClient`                     | Returns a pub/sub-ready connection; mode-aware.                        |
| `createBullMQPair` (NEW)     | `(handle: RedisConnectionHandle) => BullMQConnectionPair`            | Returns `{queueConnection, workerConnection, disconnect}`; mode-aware. |
| `runLuaScript` (NEW)         | `<T>(client, {name, body, numberOfKeys}, keys, args) => Promise<T>`  | Uniform Lua execution over `Redis \| Cluster`.                         |
| `hashTag` (NEW)              | `(...parts: string[]) => string`                                     | Returns `'{p1:p2:...}'` for slot co-location; inert in standalone.     |
| `scanKeys` (NEW)             | `(client: RedisClient, pattern: string) => AsyncIterable<string>`    | Cursor-based key iteration; iterates all masters in cluster.           |

---

## 9. Data Model

### Key Reshape (no schema migration)

Three families of Redis key patterns are reshaped to introduce hash tags. No new collections, no MongoDB changes, no field additions.

| Family          | Old Key Pattern                                    | New Key Pattern                                                                             | TTL               |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| Circuit Breaker | `breaker:<level>:<key>:state` etc. (5 suffixes)    | `breaker:{<level>:<key>}:state` etc.                                                        | `reset_timeout*2` |
| Agent Transfer  | `agent_transfer:<tenantId>:<contactId>:<channel>`  | `agent_transfer:{<tenantId>:<contactId>:<channel>}` + matched index key                     | per-session TTL   |
| Fan-Out Barrier | `barrier:<id>` + `barrier:<id>:result:<branchKey>` | `barrier:{<id>}` + `barrier:{<id>}:result:<branchKey>` + `barrier:{<id>}:result-keys` (SET) | per-exec timeout  |

### Key Relationships

- Per-circuit-breaker keys (state, failures, successes, opened_at, half_open_count) all hash to the same slot via the shared `{<level>:<key>}` tag.
- Per-agent-transfer-session keys (the session hash + provider index) hash to the same slot via `{<tenantId>:<contactId>:<channel>}`. The `at_active_sessions` global set and `at_pod:<hostname>` per-pod set are written outside the Lua boundary; their slot placement is uniform-random and unrelated.
- Per-barrier keys (the barrier hash, the result-keys registry SET, and the per-branch result keys) all hash to the same slot via `{<barrierId>}`.

### Single-key key families (no change)

Distributed locks (`lock:exec:*`), session hashes (`sess:<tenantId>:<id>`), session conversation lists (`sess:<tenantId>:<id>:conv`), reverse session lookups (`sess-tid:<id>`), trace streams (`trace:stream:<sessionId>`), and rate-limiter buckets are all single-key and require no reshape.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/redis/src/connection.ts`                              | Fix `duplicate()` cast (line 202); existing cluster path stays.                                   |
| `packages/redis/src/subscriber.ts` (NEW)                        | `createSubscriber()` — mode-aware pub/sub connection.                                             |
| `packages/redis/src/bullmq.ts`                                  | Update `createBullMQPair()` to handle Cluster.                                                    |
| `packages/redis/src/lua.ts` (NEW)                               | `runLuaScript()` — uniform `eval` wrapper.                                                        |
| `packages/redis/src/keys.ts` (NEW)                              | `hashTag()`, `scanKeys()`.                                                                        |
| `packages/redis/src/index.ts`                                   | Export new helpers.                                                                               |
| `packages/redis/src/types.ts`                                   | Already exposes `RedisClient = Redis \| Cluster`.                                                 |
| `packages/circuit-breaker/src/lua/*.lua`                        | No body change — caller adopts hash-tagged keys.                                                  |
| `packages/circuit-breaker/src/redis-circuit-breaker.ts`         | Use `hashTag()` when building keys; switch to `runLuaScript()`.                                   |
| `packages/agent-transfer/src/session/lua-scripts.ts`            | Split SADD ops out of Lua; hash-tag session+index keys.                                           |
| `packages/agent-transfer/src/session/transfer-session-store.ts` | Pipeline the SADD ops alongside the now-narrower Lua call.                                        |
| `packages/execution/src/redis-fan-out-barrier.ts`               | Replace in-Lua `KEYS` with explicit registry SET.                                                 |
| `packages/shared/src/redis/distributed-lock.ts` (UPDATED)       | Uses `runLuaScript` + named `LuaScript` constants for `release`/`extend`; accepts `RedisClient`.  |
| `packages/redis/src/singleton.ts` (UPDATED)                     | Added `getRedisInitError()` export for health-check surfaces (returns last init failure or null). |

### Routes / Handlers

N/A — no HTTP route changes.

### UI Components

N/A.

### Jobs / Workers / Background Processes

| File                                                                                   | Purpose                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/redis/redis-client.ts`                                      | Replace `.duplicate()` with `createSubscriber()`.                                                                                                |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts:306`                       | Use `createSubscriber()` for cross-pod relay.                                                                                                    |
| `apps/runtime/src/services/session/redis-session-store.ts`                             | Audit pipelines for atomicity; add error checking.                                                                                               |
| `apps/workflow-engine/src/services/redis.ts`                                           | Migrate to `createRedisConnection()` (factory bypass).                                                                                           |
| `apps/workflow-engine/src/outbox/outbox-poller.ts` (UPDATED)                           | Added `createBullMQPairFn?` DI dep to `OutboxPollerDeps`; removes requirement to mock platform pkg.                                              |
| `apps/workflow-engine/src/services/trigger-scheduler.ts` (UPDATED)                     | Added `createBullMQPairFn?` DI dep to `TriggerSchedulerDeps`; same motivation as above.                                                          |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts` (UPDATED)              | Added `createBullMQPairFn?` DI dep to `CallbackDeliveryDeps`; same motivation (auditor round find).                                              |
| `apps/search-ai/src/services/connector-presence.service.ts`                            | Migrate to `createRedisConnection()` (factory bypass).                                                                                           |
| `apps/search-ai-runtime/src/services/cache/redis-client.ts` (UPDATED)                  | Cluster-safe per-key `del` loop (avoids CROSSSLOT on multi-key DEL); `getdel` type fix.                                                          |
| `apps/runtime/src/services/trace/redis-trace-store.ts` (UPDATED 2026-05-10)            | Split `xadd+expire` pipeline (streamKey) from separate `publish` (channelKey) — avoids CROSSSLOT in cluster mode.                                |
| `packages/agent-transfer/src/session/session-recovery-service.ts` (UPDATED 2026-05-10) | Replaced HGETALL + EXISTS pipelines with `Promise.all` over per-key independent commands (cross-tenant / cross-host slots).                      |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts` (UPDATED 2026-05-10)                 | Replaced per-URL checkpoint DEL pipeline with `Promise.all` (cross-URL slots).                                                                   |
| `apps/search-ai/src/routes/intelligence.ts` (UPDATED 2026-05-10)                       | Replaced per-page GET pipeline with `Promise.all` (cross-page slots).                                                                            |
| `packages/config/src/env-mapping.ts` (UPDATED 2026-05-10)                              | `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}` guard so `coerceValue` does not split a comma-separated cluster seed list into a `string[]`. |
| `apps/admin/src/app/api/config/route.ts` (UPDATED 2026-05-10)                          | Mirrored guard in inlined `coerceValue` copy (Turbopack workaround).                                                                             |
| `apps/admin/src/app/api/config/diff/route.ts` (UPDATED 2026-05-10)                     | Same.                                                                                                                                            |
| `packages/shared/src/services/lambda/lambda-deployment-store.ts:111`                   | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `packages/shared-auth/src/idp/idp-token-validator.ts:407`                              | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts:109`                | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `packages/pipeline-engine/src/pipeline/services/definition-cache.ts:93`                | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `apps/studio/src/lib/invalidate-definition-cache.ts:21`                                | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `apps/search-ai/src/routes/intelligence.ts:966`                                        | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `apps/search-ai-runtime/src/routes/auth-oauth.ts:394`                                  | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332`                   | Replace `KEYS` with `scanKeys()`.                                                                                                                |
| `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130,194`          | Replace `KEYS` with `scanKeys()` (2 call sites).                                                                                                 |
| `apps/search-ai-runtime/src/services/query/query-cache.ts:123,147`                     | Replace `KEYS` with `scanKeys()` (2 call sites).                                                                                                 |

### Tests

| File                                                                                      | Type                 | Coverage Focus                                                                                                                  |
| ----------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts` (NEW)                      | integration          | `createSubscriber`, `runLuaScript`, `scanKeys` against real Cluster (INT-2, INT-6, INT-7, INT-8, INT-9).                        |
| `packages/redis/src/__tests__/migration-completeness.static.test.ts` (NEW)                | static/unit          | FR-6 (no `.duplicate()`) and FR-7 (no top-level `KEYS`) grep guards — INT-13, INT-14.                                           |
| `packages/redis/src/__tests__/bullmq.test.ts` (updated)                                   | unit                 | `createBullMQPair` cluster path, `BullMQConnectionPair.disconnect()`, GAP-008 watchdog (21 tests: 6 watchdog + 15 BullMQ pair). |
| `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.cluster.test.ts` (NEW)      | integration          | Hash-tagged Lua execution under Cluster — no CROSSSLOT (INT-1).                                                                 |
| `packages/agent-transfer/src/__tests__/session-lua.cluster.test.ts` (NEW)                 | integration          | Narrowed single-key Lua + pipelined SADD/SREM/DEL for global sets (INT-4).                                                      |
| `packages/execution/src/__tests__/redis-fan-out-barrier.cluster.test.ts` (NEW)            | integration          | Registry-SET pattern under Cluster; no in-Lua KEYS (INT-5).                                                                     |
| `apps/runtime/src/__tests__/redis-cluster-wiring.cluster.test.ts` (NEW)                   | integration          | Runtime wiring smoke: `createSubscriber` + BullMQ pair construction under cluster mode.                                         |
| `docker-compose.cluster.yml` (NEW)                                                        | infra                | 6-node cluster harness for `pnpm test:cluster`.                                                                                 |
| `tools/cluster-test-harness.ts` (NEW)                                                     | helper               | `flushAllMasters()`, `forceFailover()`, `waitForClusterReady()` utilities.                                                      |
| `vitest.cluster.config.ts` (NEW)                                                          | infra                | Cluster-tagged test runner with 30 s timeout for failover scenarios.                                                            |
| `apps/runtime/src/__tests__/sessions/session-redis.cluster.e2e.test.ts` (NEW)             | e2e (cluster-layer)  | E2E-1: session lifecycle against real Cluster (create/load/save/lock/history/delete; 19 tests + 50-session×5-tenant).           |
| `apps/runtime/src/__tests__/cache/scan-keys.cluster.e2e.test.ts` (NEW)                    | e2e (cluster-layer)  | E2E-6: `scanKeys` completeness — 1000-key fan-out, invalidation, page-size invariance, multi-tenant isolation.                  |
| `apps/runtime/src/__tests__/sessions/session-resolve-race.cluster.test.ts` (NEW)          | integration          | INT-11 (GAP-003): `resolveTenantId` tight-loop ×1000 + jitter ×500 + concurrent 50-session multi-tenant.                        |
| `apps/runtime/src/__tests__/cache/scan-keys-failover.chaos.cluster.test.ts` (NEW)         | integration (@chaos) | INT-12 (GAP-005): `scanKeys` dedupe across graceful failover mid-scan; baseline + empty + cross-prefix isolation.               |
| `apps/workflow-engine/src/__tests__/triggers/trigger-roundtrip.cluster.e2e.test.ts` (NEW) | e2e (cluster-layer)  | E2E-WIRE-1: BullMQ pair enqueue+dequeue on real Cluster; disconnect teardown; queue isolation; delayed job create.              |
| `apps/workflow-engine/vitest.fast.config.ts` (UPDATED)                                    | infra                | Glob patterns corrected: `src/**/*.{e2e,cluster}.test.ts` + `src/routes/__tests__/**` excluded from threads tier.               |
| `apps/workflow-engine/vitest.http.config.ts` (UPDATED)                                    | infra                | HTTP tier (forks, sequential) now includes `src/routes/__tests__/**/*.test.ts` to cover Supertest route tests correctly.        |

---

## 11. Configuration

### Environment Variables

| Variable         | Default    | Description                                                                                                       |
| ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `REDIS_CLUSTER`  | `false`    | When `true`, treats `REDIS_URL` as comma-separated `host:port` node list and connects via `ioredis.Cluster`.      |
| `REDIS_URL`      | (existing) | In cluster mode: comma-separated `host1:port1,host2:port2,host3:port3`. In standalone mode: single `redis://...`. |
| `REDIS_ENABLED`  | (existing) | Unchanged.                                                                                                        |
| `REDIS_PASSWORD` | (existing) | Unchanged.                                                                                                        |

### Runtime Configuration

`@agent-platform/config` already exposes the `redis.cluster` boolean via `RedisConfigSchema` (`packages/config/src/schemas/redis.schema.ts:34`). No new tenant- or project-level settings.

### DSL / Agent IR / Schema

N/A — no DSL or compiler IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Unchanged. Project-scoped reads/writes already include `projectId`. Hash tags do not cross project boundaries because each key still includes the full project context.                             |
| Tenant isolation  | Unchanged. Tenant ID remains in every key. Hash tags chosen to avoid creating tenant-wide hot slots — circuit-breaker hash-tags on `{level:key}`, agent-transfer on `{tenantId:contactId:channel}`. |
| User isolation    | Unchanged. User-owned resources (API keys, personal credentials) keep their `userId` filter. No Redis key is reshaped in a way that aggregates per-user state into a single slot.                   |

### Security & Compliance

- TLS configuration in `createRedisConnection()` already supports cluster mode (`packages/redis/src/connection.ts:163-167`); the `tls` block flows through to `redisOptions` for the `Cluster` constructor.
- Password / username handling unchanged.
- No new secrets, no new audit events. Operator changes to `REDIS_CLUSTER` are captured by the existing helm-values change audit (Argo / Bitbucket).
- No PII or tenant data is moved to a different storage class.

### Performance & Scalability

- **Standalone mode**: zero regression. The mode-aware helpers branch on `instanceof Cluster` once at construction time; in standalone they delegate to the existing `.duplicate()` path verbatim.
- **Cluster mode steady state**: p95 latency for single-key operations must stay within 2× standalone (one MOVED redirect on first miss, then ioredis caches slot mapping).
- **Cluster mode under failover**: 1–15 s blip per master failover; pub/sub gap up to 30 s (recovered by `createSubscriber` auto-reconnect).
- **Cluster mode write scaling**: linear with master count (3 / 6 / 12 masters in tier-M / L / XL).
- **`scanKeys` in cluster** is N× slower than standalone `SCAN` (one cursor pass per master). All current `KEYS` users are off-hot-path (cache invalidation, sync workers).

### Reliability & Failure Modes

- ioredis `Cluster` handles MOVED / ASK redirects transparently — service code does not see them.
- `cluster-require-full-coverage: 'no'` is set in all tier helm values — partition-tolerance is on; available shards keep serving.
- BullMQ Workers retry indefinitely (`maxRetriesPerRequest: null`) — survive 15–30 s reconnect.
- Pub/Sub subscribers must auto-reconnect; `createSubscriber()` wires a `node:error` handler that re-instantiates the underlying `Cluster` if the original disconnects.
- Rollback path: redeploy with `REDIS_CLUSTER=false`. No runtime hot-swap kill-switch (would require restart anyway; PDBs cover availability).

### Observability

| Metric / Event                     | Source                            | Alert Threshold              |
| ---------------------------------- | --------------------------------- | ---------------------------- |
| `redis.crossslot.errors`           | `runLuaScript` error handler      | `> 0` over 5 min → page      |
| `redis.moved.redirects`            | ioredis Cluster events            | none — informational         |
| `redis.cluster.failover`           | ioredis `+node` / `-node` events  | `> 0` → notify on-call       |
| `redis.subscriber.reconnect`       | `createSubscriber` reconnect path | `> 5 / hour` → investigate   |
| `redis_exporter` slot distribution | infra (already deployed)          | std-dev > 30 % → rebalance   |
| `redis_exporter` cluster_slots_ok  | infra                             | < cluster_slots_total → page |

Trace events emitted via existing `TraceStore` for any `runLuaScript` failure (preserves CLAUDE.md invariant #4).

### Data Lifecycle

- All reshaped keys retain their existing TTLs (circuit-breaker: `reset_timeout * 2`; agent-transfer: per-session; fan-out-barrier: per-execution).
- During rollout, old-format keys naturally expire within minutes.
- No archival, no audit-trail key changes.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 0 — Foundation helpers in `@agent-platform/redis`**
   1.1 Fix `duplicate()`, `isReady()`, and `disconnect()` casts in `connection.ts:194,202,207` to handle `Cluster` (remove `as Redis` casts)
   1.2 Add `createSubscriber(handle)` helper (mode-aware) with auto-reconnect on cluster failover
   1.3 Add `createBullMQPair(handle)` cluster path; widen `BullMQConnectionPair.{queueConnection,workerConnection}` from `Redis` to `RedisClient`
   1.4 Add `runLuaScript(client, script, keys, args)` helper using `eval` (ioredis handles `EVALSHA`/`NOSCRIPT` fallback transparently on both modes)
   1.5 Add `hashTag(...parts)` helper
   1.6 Add `scanKeys(client, pattern)` async iterator with per-node error handling, retry on stale node list, and dedupe across slot migration
   1.7 Extend `resolveRedisOptionsFromEnv()` to read `REDIS_CLUSTER`; extend `resolveBullMQConnectionFromEnv()` to propagate cluster mode
   1.8 Configure ioredis `Cluster` constructor with `retryDelayOnFailover: 500`, `maxRedirections: 16` (retry budget > cluster-node-timeout)
   1.9 Author `docker-compose.cluster.yml` and `pnpm test:cluster` script
   1.10 Add cluster-mode integration tests for the helpers themselves

2. **Phase 1 — Eliminate `KEYS` command (no Lua changes yet)**
   2.1 Migrate `packages/shared/src/services/lambda/lambda-deployment-store.ts:111` to `scanKeys`
   2.2 Migrate `packages/shared-auth/src/idp/idp-token-validator.ts:407` to `scanKeys`
   2.3 Migrate `packages/pipeline-engine/src/pipeline/services/{analytics-cache.ts:109, definition-cache.ts:93}`
   2.4 Migrate `apps/studio/src/lib/invalidate-definition-cache.ts:21`
   2.5 Migrate `apps/search-ai/src/routes/intelligence.ts:966`
   2.6 Migrate `apps/search-ai-runtime/src/routes/auth-oauth.ts:394`
   2.7 Migrate `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332`
   2.8 Migrate `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130,194` (2 call sites)
   2.9 Migrate `apps/search-ai-runtime/src/services/query/query-cache.ts:123,147` (2 call sites)
   2.10 Add lint hook blocking new `.keys(` introduction outside `@agent-platform/redis`

3. **Phase 2 — Lua redesign** (each script family ships and validates independently per Sidekiq-style phased adoption)
   3.1 Circuit-breaker: widen `RedisCircuitBreaker` constructor type from `Redis` to `RedisClient`; introduce `hashTag` in key construction (e.g., `breaker:{<level>:<key>}:state`); switch from `defineCommand` to `runLuaScript`; convert `scripts.ts:24-27` `readFileSync` to lazy `fs.promises.readFile`
   3.2 Agent-transfer: widen `TransferSessionStore` constructor type from `Redis` to `RedisClient`; split `LUA_CREATE_SESSION` / `LUA_END_SESSION` / `LUA_CLAIM_SESSION` / `LUA_EXTEND_TTL` per FR-9; hash-tag per-session keys; pipeline the SADD/SREM/DEL of global+pod sets and provider index outside the Lua boundary; document recovery gap and add operator-tool SCAN snippet to runbook
   3.3 Fan-out-barrier: replace **both** in-Lua `KEYS` invocations (`LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` at `redis-fan-out-barrier.ts:99,112`) with explicit `barrier:{<id>}:result-keys` SET registry; hash-tag all barrier-related keys (barrier hash, registry SET, per-branch result keys) under `{<barrierId>}`

4. **Phase 3 — Consumer migration off `.duplicate()` and factory bypass** (split into sub-commits respecting max-3-packages-per-commit rule)
   4.1 (commit a) Replace `.duplicate()` in `apps/runtime/src/services/redis/redis-client.ts:186` and `agent-transfer/message-bridge.ts:306` with `createSubscriber()`
   4.2 (commit b) Replace `.duplicate()` in remaining `apps/runtime` BullMQ + pub/sub call sites (~10 sites)
   4.3 (commit c) Replace `.duplicate()` in `apps/workflow-engine` (~10 sites) and migrate `apps/workflow-engine/src/services/redis.ts` to `createRedisConnection()`
   4.4 (commit d) Migrate `apps/search-ai/src/services/connector-presence.service.ts`
   4.5 (commit e) Migrate `apps/search-ai-runtime/src/services/cache/redis-client.ts`. Note: this wrapper is consumed by `idp-token-validator-compat.ts:36` and `end-user/end-user-auth.service.ts:89` adapter classes; their `.keys()` adapter methods will work correctly once the wrapper internally delegates to `scanKeys()`.
   4.6 (commit f) Audit session-store pipelines (`redis-session-store.ts`) for slot-write-ordering races; hash-tag reverse lookup or add retry-on-miss in `resolveTenantId` (GAP-003)
   4.7 (commit g) Add lint hook blocking new `.duplicate()` calls outside `@agent-platform/redis`

5. **Phase 4 — SIT validation**
   5.1 Stand up SIT with `REDIS_CLUSTER=true` and 6-node Redis Cluster
   5.2 Run full E2E suite, k6 load tests via `load-test-analysis` skill
   5.3 Validate: zero `redis.crossslot.errors`; pub/sub reconnect ≤ 30 s; p95 ≤ 2× standalone
   5.4 Force a master failover; validate recovery
   5.5 Document operational runbook in `docs/guides/redis-cluster-mode.md`

6. **Phase 5 — Production rollout**
   6.1 Enable `REDIS_CLUSTER=true` in `tier-m/values.yaml`; soak 7 days
   6.2 Enable for tier-L; soak 7 days
   6.3 Enable for tier-XL; soak 7 days
   6.4 30-day post-enable observation; promote feature to `STABLE`

---

## 14. Success Metrics

| Metric                                                        | Baseline             | Target                            | How Measured                                                     |
| ------------------------------------------------------------- | -------------------- | --------------------------------- | ---------------------------------------------------------------- |
| Cluster CROSSSLOT error count                                 | N/A (cluster off)    | 0 / day in steady state           | `redis.crossslot.errors` Prometheus counter                      |
| Standalone p95 regression                                     | current p95          | 0 % regression                    | k6 baseline vs post-Phase 0 build                                |
| Cluster p95 vs standalone p95                                 | N/A                  | ≤ 2× standalone                   | k6 against `docker-compose.cluster.yml` and standalone baselines |
| Cluster p50 vs standalone p50 (dual-threshold per Redis blog) | N/A                  | ≤ 1.1× standalone                 | k6 dual-threshold report                                         |
| Write throughput degradation during slot resharding           | N/A                  | ≤ 20 %                            | k6 + cluster `CLUSTER RESHARD` injection                         |
| p95 slot-cache refresh after MOVED                            | N/A                  | ≤ 500 ms                          | ioredis MOVED event timestamp distribution                       |
| Time to enable cluster in a new tier                          | undefined (blocked)  | ≤ 1 helm-values change + redeploy | SRE runbook                                                      |
| `.duplicate()` call sites outside `@agent-platform/redis`     | ~25 production       | 0                                 | Lint hook + CI grep                                              |
| Top-level `KEYS` call sites (production)                      | 12 (across 10 files) | 0                                 | Lint hook + CI grep                                              |
| Lua scripts spanning multiple slots without hash tag          | 9 (counted)          | 0                                 | Static review + cluster integration tests                        |
| Failover blip duration (p95)                                  | N/A                  | ≤ 30 s end-to-end                 | Chaos test in SIT; `redis.subscriber.reconnect` distribution     |

---

## 15. Open Questions

1. **OQ-1 (timeline)** — The product-oracle flagged the SIT/prod timeline as AMBIGUOUS. We've assumed a 6–8 week schedule (Option B in the oracle log). User confirmation needed before committing in delivery tracking. Reference: `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md` A-3.
2. **OQ-2** — Tier-S currently uses Redis Sentinel (`redis-sentinel.abl-data.svc:26379`). Is the long-term direction to keep Sentinel for tier-S or migrate it to Cluster too? Current scope: keep Sentinel; flag here in case future work changes direction.
3. ~~OQ-3 — `evalsha` SHA1 caching~~ — **RESOLVED**: Use `client.eval()` (ioredis internally manages `EVALSHA` with transparent `NOSCRIPT` fallback to `EVAL` on both `Redis` and `Cluster` classes — including across node restarts when the script cache is empty). No custom caching needed. Documented in FR-3 and section 7.
4. **OQ-4** — Should the lint hooks (block `.duplicate()` and top-level `.keys()` outside the shared package) be `block` or `warn` initially? (Recommend `block` to prevent regression.)
5. **OQ-5** — Slot-distribution dashboard ownership — Platform or SRE? (Recommend Platform owns the dashboard JSON; SRE owns the alert routing.)

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Severity | Status     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| GAP-001 | No automated chaos / failover test in CI; failover validation is manual in SIT. `benchmarks/system/redis-cluster-chaos.ts` ships as runnable code but requires SIT + k8s credentials; CI wiring is pending SRE (no `.bitbucket-pipelines.yml` exists yet).                                                                                                                                                                                                                                                                                                                                                                                                                 | Medium   | Open       |
| GAP-002 | Multi-key `DEL`/`MGET` (~15 sites) becomes non-atomic in cluster mode. ioredis Cluster auto-splits these into per-slot batches, so they don't error, but lose atomicity. For cache invalidation this is acceptable; for session cleanup at `redis-session-store.ts:319` may leave orphan keys (caught by TTL). Multi-key `MULTI`/`EXEC` transactions, in contrast, do throw `CROSSSLOT` and must be audited separately as part of Phase 3.                                                                                                                                                                                                                                 | High     | Open       |
| GAP-003 | Session-store reverse-lookup race: `sess-tid:{id}` written before `sess:{tid}:{id}` could cause `resolveTenantId` to miss. **Mitigated in Phase 3**: `apps/runtime/src/services/session/redis-session-store.ts:243` retry-on-miss applied — `resolveTenantId` retries once after a short backoff if the session hash is not found on first lookup. Verified by integration test `INT-11` harness pattern.                                                                                                                                                                                                                                                                  | Medium   | Mitigated  |
| GAP-004 | `defineCommand` is not used in cluster mode; `runLuaScript` standardizes on `eval` for both modes. **Mitigated**: `runLuaScript` ships in Phase 0; `defineCommand` removed from all Lua callers in Phase 2. ioredis handles EVALSHA/NOSCRIPT fallback internally on both `Redis` and `Cluster`.                                                                                                                                                                                                                                                                                                                                                                            | Low      | Mitigated  |
| GAP-005 | `scanKeys` mid-failover may yield duplicate keys (slot-migrating nodes). **Mitigated in Phase 0**: `packages/redis/src/keys.ts` `scanKeys` implementation includes per-node error handling (skips dead nodes with structured log `redis.scanKeys.nodeError`) and a `Set`-based deduplication step across all master results. Residual risk: a key written during a scan that hasn't yet been seen by any master may be missed once; TTL guarantees self-cleanup.                                                                                                                                                                                                           | Medium   | Mitigated  |
| GAP-006 | BullMQ queue keys all share `{queueName}` hash tag (BullMQ internal). At tier-XL (12 masters), 3-4 high-throughput queues hit only 3-4 nodes; remaining masters idle. Queue-sharding is out of scope (NG-5/NG-6) — flagged for follow-up feature. Reference: Langfuse scaling pattern.                                                                                                                                                                                                                                                                                                                                                                                     | Medium   | Open       |
| GAP-007 | Pub/sub broadcast scales O(N) with cluster size in traditional pub/sub. At tier-XL (36 nodes) every message replicates 35× across cluster bus. Sharded pub/sub (Redis 7.0+ `SSUBSCRIBE`/`SPUBLISH`, ioredis support merged Mar 2025) is the long-term fix; out of scope here (NG-10).                                                                                                                                                                                                                                                                                                                                                                                      | Medium   | Open       |
| GAP-008 | BullMQ Worker stall after Redis reconnect. **Mitigated in Phase 0** (cluster-mode default-on per LLD D-12; monitoring wired in Phase 4): `packages/redis/src/bullmq.ts` `startWorkerWatchdog()` function — enabled by default in cluster mode — polls connection status every 5 s and forces a `disconnect()` + ioredis reconnect if the worker's connection remains in a non-healthy state for > 30 s. Counter `redis.bullmq.watchdog.recover` observable via OTel. 6 watchdog-specific unit tests + 15 additional BullMQ pair tests in `packages/redis/src/__tests__/bullmq.test.ts` (21 tests total).                                                                   | Medium   | Mitigated  |
| GAP-009 | Pipelines that span keys with **different slots** would CROSSSLOT in cluster mode. Five sites identified by 2026-05-10 data-flow audit: `redis-trace-store.ts:247` (stream+channel), `session-recovery-service.ts:245,299` (per-tenant HGETALL, per-host EXISTS), `bulk-crawl-worker.ts:834` (per-URL DEL), `intelligence.ts:994` (per-page GET). **Mitigated 2026-05-10**: each replaced with `Promise.all` over independent per-key commands (or split into per-slot pipelines for the trace-store stream pair). ioredis Cluster routes each to its owning master; standalone is unchanged. Audit log: `docs/sdlc-logs/redis-dual-mode/data-flow-audit.md` (Rounds 3+4). | Critical | Mitigated  |
| GAP-010 | `packages/config/src/env-mapping.ts` `coerceValue` split any comma-separated env value into `string[]`. A cluster-mode `REDIS_URL` (comma-separated seed list) was rejected by Zod's `redis.url: z.string()` schema, breaking startup for Runtime / Studio when going through the centralized config path. Two stale duplicate copies in `apps/admin/src/app/api/config/{route,diff/route}.ts` (Turbopack workaround) had the same bug. **Mitigated 2026-05-10**: `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}` guard added; admin copies updated to match with cross-references. Regression test in `packages/config/src/__tests__/env-mapping.test.ts`.            | High     | Mitigated  |
| GAP-011 | `CONFIG SET notify-keyspace-events Ex` in `apps/runtime/src/services/agent-transfer/index.ts:702` only reaches one master in cluster mode. **Documented runbook step 2026-05-10**: configure `notify-keyspace-events=Ex` in the cluster parameter group at provisioning. The keyspace **subscriber** (built via `createSubscriber(handle)`) already listens on every master, so once notifications are enabled cluster-wide, expired events from any shard are received.                                                                                                                                                                                                   | High     | Documented |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                               | Coverage Type       | Status        | Test File / Note                                                                                                 |
| --- | -------------------------------------------------------------------------------------- | ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `createSubscriber` round-trip pub/sub on Cluster                                       | integration         | TESTED ✅     | `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts`                                                   |
| 2   | `createBullMQPair` queue+worker on Cluster + watchdog                                  | unit                | TESTED ✅     | `packages/redis/src/__tests__/bullmq.test.ts` (21 tests: 6 watchdog + 15 BullMQ pair)                            |
| 3   | `runLuaScript` with hash-tagged keys executes without CROSSSLOT                        | integration         | TESTED ✅     | `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.cluster.test.ts` (INT-1)                           |
| 4   | `scanKeys` returns complete results across all masters + deduplication                 | integration         | TESTED ✅     | `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts` (INT-2, 1000-key fan-out)                         |
| 5   | Agent-transfer session create/end with split SADD path                                 | integration         | TESTED ✅     | `packages/agent-transfer/src/__tests__/session-lua.cluster.test.ts` (INT-4)                                      |
| 6   | Fan-out-barrier with registry SET (no in-Lua KEYS)                                     | integration         | TESTED ✅     | `packages/execution/src/__tests__/redis-fan-out-barrier.cluster.test.ts` (INT-5)                                 |
| 7   | Runtime wiring smoke (cluster-wiring): createSubscriber + BullMQ under cluster         | integration         | TESTED ✅     | `apps/runtime/src/__tests__/redis-cluster-wiring.cluster.test.ts`                                                |
| 8   | FR-6/FR-7 migration completeness (no .duplicate(), no KEYS outside package)            | static (grep)       | TESTED ✅     | `packages/redis/src/__tests__/migration-completeness.static.test.ts` (INT-13, INT-14)                            |
| 9   | Standalone parity — every existing test suite still passes                             | unit + integration  | TESTED ✅     | Pre-push gate confirms all 611+ runtime tests pass; pnpm test 100% green on worktree                             |
| 10  | Full session lifecycle against Cluster (create/load/save/lock/history/delete)          | e2e (cluster-layer) | TESTED ✅     | `apps/runtime/src/__tests__/sessions/session-redis.cluster.e2e.test.ts` — 19 tests incl. 50-session×5-tenant     |
| 10a | `scanKeys` completeness — 1000-key fan-out across all masters + invalidation           | e2e (cluster-layer) | TESTED ✅     | `apps/runtime/src/__tests__/cache/scan-keys.cluster.e2e.test.ts` (E2E-6)                                         |
| 10b | Session-store pipeline race — GAP-003 `resolveTenantId` tight-loop x1000               | integration         | TESTED ✅     | `apps/runtime/src/__tests__/sessions/session-resolve-race.cluster.test.ts` (INT-11)                              |
| 10c | `scanKeys` mid-failover dedupe — GAP-005 graceful failover (@chaos)                    | integration         | TESTED ✅     | `apps/runtime/src/__tests__/cache/scan-keys-failover.chaos.cluster.test.ts` (INT-12)                             |
| 10d | BullMQ pair enqueue+dequeue round-trip on Cluster (workflow-engine)                    | e2e (cluster-layer) | TESTED ✅     | `apps/workflow-engine/src/__tests__/triggers/trigger-roundtrip.cluster.e2e.test.ts` (E2E-WIRE-1)                 |
| 11  | Master failover blip — pub/sub reconnect within 30 s                                   | manual / e2e        | NOT TESTED ❌ | SIT chaos test; runbook in `docs/guides/redis-cluster-mode.md`; `benchmarks/system/redis-cluster-chaos.ts` ready |
| 12  | k6 load test — cluster p95 ≤ 2× standalone                                             | manual              | NOT TESTED ❌ | `benchmarks/integration/redis-cluster-validation.ts` ready; requires SIT environment                             |
| 13  | `coerceValue` preserves comma-separated `REDIS_URL` / `MONGODB_URI` as a single string | unit                | TESTED ✅     | `packages/config/src/__tests__/env-mapping.test.ts` (2 regression tests added 2026-05-10)                        |
| 14  | Trace-store split pipeline: `xadd+expire` on streamKey + separate `publish`            | unit                | TESTED ✅     | `apps/runtime/src/__tests__/redis-trace-store.test.ts` (mock + assertion updated 2026-05-10)                     |
| 15  | Session-recovery parallel HGETALL / EXISTS (no pipeline; cluster-safe)                 | unit                | TESTED ✅     | `packages/agent-transfer/src/__tests__/unit/recovery-sscan-pipeline.test.ts` (assertions rewritten 2026-05-10)   |
| 16  | Bulk-crawl checkpoint DEL parallel cleanup (cluster-safe)                              | unit                | NOT TESTED ❌ | Best-effort cleanup; documented gap. No regression test exercising the per-URL DEL path.                         |
| 17  | Intelligence page-key GET parallel reader (cluster-safe)                               | unit                | NOT TESTED ❌ | No regression test exercising the per-page GET path.                                                             |

### Testing Notes

- Cluster integration tests require a real 6-node cluster (`docker-compose.cluster.yml`). Per `CLAUDE.md` **Test Architecture** and **E2E Test Standards**: mocking of platform components (`vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports) is forbidden in all test files.
- E2E tests must interact only via HTTP API: seed data via `POST` endpoints, assert via `GET` responses. No direct Mongoose model imports, no Redis client construction in test files.
- Real servers must be used (Express on `{ port: 0 }`) so the full middleware chain executes.
- Standalone test suites continue to run on the existing single-Redis `docker-compose.yml` with no change.
- **DI pattern for BullMQ pair** (Phase B fix): `OutboxPollerDeps.createBullMQPairFn?` and `TriggerSchedulerDeps.createBullMQPairFn?` allow tests to inject a synthetic pair without mocking `@agent-platform/redis` — resolves `vi.mock` prohibition in 4 workflow-engine test files.
- **Vitest tier corrections** (Phase B fix): `vitest.fast.config.ts` exclusion globs updated from `src/__tests__/*.e2e.test.ts` to `src/**/*.{e2e,cluster}.test.ts` to cover subdirectory cluster tests; `src/routes/__tests__/**` added to exclusions and to `vitest.http.config.ts` includes so Supertest route tests run in the correct forks-pool tier.

> Full testing details: `../testing/redis-dual-mode.md`

---

## 18. References

- Audit log: `docs/sdlc-logs/redis-dual-mode/feature-spec.log.md`
- Existing Redis config guide: `docs/guides/redis-config.md`
- Helm values: `deploy/helm-values/tier-{s,m,l,xl}/values.yaml`
- Connection factory: `packages/redis/src/connection.ts`
- BullMQ config: `packages/redis/src/bullmq.ts`
- Circuit-breaker scripts: `packages/circuit-breaker/src/scripts.ts` (see line 79 — author already noted cluster gap)
- Agent-transfer Lua: `packages/agent-transfer/src/session/lua-scripts.ts`
- Fan-out-barrier: `packages/execution/src/redis-fan-out-barrier.ts`
- Related core invariants: `CLAUDE.md` (#3 Stateless Distributed, #4 Traceability, #6 Performance)
- ioredis Cluster docs (external): https://github.com/redis/ioredis#cluster
- BullMQ Cluster docs (external): https://docs.bullmq.io/guide/connections#cluster
