# LLD: Redis Dual-Mode Support (Standalone + Cluster)

**Feature Spec**: [`../features/redis-dual-mode.md`](../features/redis-dual-mode.md)
**HLD**: [`../specs/redis-dual-mode.hld.md`](../specs/redis-dual-mode.hld.md)
**Test Spec**: [`../testing/redis-dual-mode.md`](../testing/redis-dual-mode.md)
**Status**: IN PROGRESS (Phases 0-4 DONE; Phase 5 PENDING operator action; whole-codebase data-flow audit Rounds 3+4 closed 2026-05-10)
**Date**: 2026-05-04
**Author**: Platform team
**Last Updated**: 2026-05-10

---

## 0. Scope of this LLD

This LLD decomposes the HLD into file-level tasks with line-anchored patches. It covers six implementation phases (P0 foundation → P5 prod rollout) and two ESLint `no-restricted-syntax` selectors. Every functional requirement (FR-1 .. FR-16) and every gap (GAP-001 .. GAP-008) is mapped to at least one task with measurable exit criteria.

The HLD's `runLuaScript`, `createSubscriber`, `createBullMQPair`, `hashTag`, and `scanKeys` API surfaces are taken as fixed contracts. This document specifies their internal implementation, the migration patches for ~25 `.duplicate()` sites and 10 `KEYS` sites, the agent-transfer split-Lua semantics, the fan-out-barrier registry-SET design, and the Docker Compose + CI test harness.

### Scope additions discovered during LLD authoring

- **Fourth factory bypass** at `apps/runtime/src/services/redis/redis-client.ts:91-100` (constructs `Redis.Cluster` and `Redis` directly). Not listed in the feature spec or HLD. Addressed in Phase 3 task 3a.1.
- **Fifth factory bypass** at `apps/runtime/src/services/queues/redis-utils.ts` consumed by `apps/runtime/src/services/queues/channel-queues.ts` (local `parseRedisUrl` building BullMQ `ConnectionOptions`). Not listed in the feature spec or HLD. Addressed in Phase 3 task 3b.5.
- **HLD deviation**: D-7 changes the ESLint approach from "custom plugin files in `tools/eslint-rules/`" (HLD §7) to "two `no-restricted-syntax` selectors in `.eslintrc.base.json`" (LLD D-7). Rationale captured in D-7.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Alternatives Rejected                                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Implement `createSubscriber` / `createBullMQPair` / `runLuaScript` / `hashTag` / `scanKeys` as **named exports** in three new files (`subscriber.ts`, `lua.ts`, `keys.ts`) and one extended file (`bullmq.ts`); re-export through `index.ts`.                                                                                                                                                                                                                                                                                                                                                                                                              | Mirrors the existing module shape (`connection.ts`, `bullmq.ts`, `singleton.ts`, `types.ts`); each helper is independently importable; tree-shakeable for consumer bundles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Single `helpers.ts` aggregator (rejected — opaque diffs, harder to test in isolation); class-based `RedisFacade` (rejected — adds state where none is needed; helpers are pure functions over `RedisClient`).                                                                                             |
| D-2  | `createSubscriber` instantiates a fresh `Cluster` (in cluster mode) by storing **node list + base options** on the `RedisConnectionHandle` at construction time and replaying them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `Cluster.duplicate()` does not exist on ioredis; the only correct way to create an independent pub/sub Cluster is `new Cluster(nodes, opts)`. Capturing the inputs avoids reflection on the existing instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Reflect on `client.startupNodes` / `client.options` (rejected — not part of ioredis stable API; broke between minor versions historically).                                                                                                                                                               |
| D-3  | `runLuaScript` uses `client.eval()` exclusively (not `client.evalsha`); ioredis manages `EVALSHA` + `NOSCRIPT` fallback transparently on both `Redis` and `Cluster`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Removes the need for explicit SHA1 caching; verified for ioredis 5.9.3 (`Cluster.prototype.eval` uses `EvalshaCommand` internally with a `NOSCRIPT` retry that re-uploads the script). Behavior is consistent across node restarts (per-node script cache cold-start handled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Custom SHA1 cache + manual `EVALSHA` (rejected — duplicates ioredis's existing logic and adds a class of "script not found on this node" bugs).                                                                                                                                                           |
| D-4  | `scanKeys` cluster path uses `client.nodes('master')` + per-node `SCAN` with an in-iterator `Set<string>` for dedupe across slot migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `KEYS` is forbidden on `Cluster` (per-node only). `SCAN` is also per-node; iterating masters yields a complete result set. Dedupe SET handles GAP-005: during slot migration, a key may be visible on both source and target master temporarily.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Iterate every node (master + replica) (rejected — stale-replica reads return inconsistent snapshots; replica may not yet have the latest slot mapping).                                                                                                                                                   |
| D-5  | Agent-transfer split-Lua: only the per-session keys (session hash + provider index, hash-tagged on `{tenantId:contactId:channel}`) execute inside Lua. Global `at_active_sessions` SET and `at_pod:{hostname}` SET are written outside via cluster-safe `pipeline()` (NOT `multi()` — see below).                                                                                                                                                                                                                                                                                                                                                          | Avoids `CROSSSLOT` while preserving per-session atomicity. Indexes are advisory (recovery scans, pod-crash cleanup), not on the request critical path. Recovery gap is acceptable per FR-9: TTL self-cleans within minutes; operator SCAN snippet covers incident response. **Critical**: cross-slot writes use `client.pipeline()` (per-key auto-routing, no atomicity guarantee) — NEVER `client.multi()` (which throws CROSSSLOT for cross-slot keys in cluster mode). To preserve TOCTOU safety on END/CLAIM/EXTEND, the narrowed Lua reads the needed fields (provider/providerSessionId/ownerPod) inside the same Lua via `HGETALL` BEFORE the `DEL`/CAS, returning them to the caller so the caller can pipeline cross-slot cleanup using the values atomically read. | Hash-tag everything on `{tenantId}` (rejected — funnels per-tenant traffic into one slot; hot-slot risk per HLD §4 Concern #1); two-stage Lua with rollback (rejected — adds complexity without atomicity gain); use `multi()` for the cross-slot pipeline (rejected — throws CROSSSLOT in cluster mode). |
| D-6  | Fan-out-barrier replaces both in-Lua `KEYS` invocations (`LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER`) with an explicit `barrier:{<id>}:result-keys` SET registry. Branch writers `SADD` their key when writing the result; collectors / cleaners iterate the SET via `SMEMBERS`.                                                                                                                                                                                                                                                                                                                                                                       | `KEYS` is forbidden inside Lua on Cluster. Hash-tagging the barrier hash + registry SET + per-branch result keys under `{<barrierId>}` keeps everything in one slot. Idempotent: repeated `SADD` of the same branch key is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `SCAN` inside Lua (rejected — cursor-based; cannot complete inside a Lua script's atomicity boundary); enumerate branches by index 0..N-1 (rejected — N is dynamic and not always known to the script caller).                                                                                            |
| D-7  | Two new `no-restricted-syntax` selectors added directly to the existing `.eslintrc.base.json` (mirroring the file's existing `findById` / `findByIdAndUpdate` / `findByIdAndDelete` selectors at `.eslintrc.base.json:7-21`): one for `.duplicate()`, one for `.keys()`. Severity `error` (the default for `no-restricted-syntax`). An `overrides` block excludes `packages/redis/**` and `**/__tests__/**`. **No custom ESLint plugin is required**. _Deviation from HLD §7 which originally specified custom plugin files at `tools/eslint-rules/`; the simpler selector approach is adopted here for the reasons below and supersedes the HLD wording._ | Lint catches at edit time; INT-13/14 static-grep catches in CI as backstop. Severity `error` (block) per HLD OQ-4 recommendation. The existing `findById`-prevention pattern proves this approach is already accepted in the codebase. Avoids the operational overhead of authoring + maintaining a custom ESLint plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Custom AST plugin in `tools/eslint-rules/` (rejected — adds plugin packaging + tsconfig + ESLint version compatibility burden; existing `no-restricted-syntax` pattern is sufficient and already used in the codebase); severity `warn` (rejected — historical evidence that `warn` rules are ignored).   |
| D-8  | Cluster constructor configured with `redisOptions` (TLS, password, base options) **plus** `clusterRetryStrategy` and top-level `maxRedirections: 16` and the **per-redirect** retry delay tuned via `slotsRefreshTimeout` and the ioredis-internal MOVED/ASK retry (which bypasses `retryDelayOnFailover` in modern ioredis; the constant is still honored when present and documented for clarity).                                                                                                                                                                                                                                                       | Retry budget (`maxRedirections * cluster-internal-retry-delay`) must exceed `cluster-node-timeout` (5000 ms) so commands survive a master flip. ioredis 5.x semantics: `maxRedirections` caps per-command MOVED hops, `slotsRefreshTimeout` (default 1000 ms) bounds slot-map refresh after MOVED. Setting `maxRedirections: 16` gives 16 hops × ~500 ms refresh ≈ 8 s budget — safely above the 5 s node timeout.                                                                                                                                                                                                                                                                                                                                                           | `maxRedirections: 5` (rejected — only 5 × 500 ms = 2.5 s, fails during a 5-s node-timeout window); custom retry strategy at the application layer (rejected — duplicates ioredis's built-in slot-redirect logic).                                                                                         |
| D-9  | `BullMQConnectionPair.queueConnection` and `workerConnection` types widen from `Redis` to `RedisClient = Redis \| Cluster`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Required for cluster path. Existing standalone consumers receive `Redis` at runtime via the union; no behavior change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Two separate types (`Redis` for standalone; `Cluster` for cluster) (rejected — every consumer would need a discriminated-union check).                                                                                                                                                                    |
| D-10 | `RedisConnectionHandle` gains two read-only fields: `nodes: ClusterNode[]` and `baseOptions: Partial<RedisOptions>` (populated only when `cluster: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Required by `createSubscriber` and `createBullMQPair` cluster paths to build new `Cluster` instances without re-parsing `REDIS_URL`. Hidden behind a new union type so standalone consumers see no shape change at the type level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Re-parse `REDIS_URL` in each helper (rejected — duplicates parsing; source of drift); reach into `client.options` (rejected — ioredis private API).                                                                                                                                                       |
| D-11 | Lint rules and static-grep CI tests (INT-13/14) introduced **at the end of Phase 1** (KEYS) and **end of Phase 3** (duplicate) — not at Phase 0 — so the migration phases themselves can land without lint noise.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Introducing the rules before migration would block the very PRs that fix the violations. The end-of-phase introduction is a one-line ESLint config change after the last violation is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Introduce rules in Phase 0 with allow-list (rejected — allow-list rots; new files default-allowed defeats the purpose).                                                                                                                                                                                   |
| D-12 | `createBullMQPair` watchdog (per HLD OQ-H-1 / GAP-008): scaffold lives in Phase 0; **default `false` for standalone, default `true` for cluster mode** (revised after round-7 industry research). BullMQ #2964 reliably manifests on Redis reconnect with cluster-mode workers; shipping cluster-mode without watchdog enabled-by-default would defer the first failover test to Phase 4 SIT and risk Phase 5 incidents. Callers can opt out with `{ watchdog: false }` if they have alternative monitoring.                                                                                                                                               | Industry research documents #2964 is not intermittent — it reliably manifests on every Redis restart/failover with cluster-mode BullMQ workers per BullMQ "Going to Production" docs. Polling cost (5 s interval, status check only) is negligible; the watchdog is cheap insurance against a known-severe failure mode. Standalone mode does not exhibit #2964, so default-off there preserves zero-overhead in the unaffected path.                                                                                                                                                                                                                                                                                                                                        | Always-on regardless of mode (rejected — cost without verified need in standalone); always-off (rejected per round-7 industry findings on #2964 severity).                                                                                                                                                |
| D-13 | `convertReadFileSync` to `fs.promises.readFile` in `packages/circuit-breaker/src/scripts.ts:24-27` is bundled into Phase 2 step 3.1 (the same edit that switches from `defineCommand` to `runLuaScript`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  | CLAUDE.md "no sync I/O in server code" is a real violation. Bundling avoids re-touching the file twice. The new path is async (`async loadLuaScript()`) which fits naturally with `runLuaScript`'s async signature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Separate PR (rejected — small enough to bundle; reduces churn).                                                                                                                                                                                                                                           |
| D-14 | Test harness `ClusterTestHarness` lives in `tools/cluster-test-harness.ts` (NEW) and exposes `boot()`, `flushAllMasters()`, `forceFailover(masterPort, mode: 'graceful' \| 'ungraceful')`, `tearDown()`. Used across `*.cluster.test.ts` files.                                                                                                                                                                                                                                                                                                                                                                                                            | Centralizes the boot/flush/failover dance; per-file harnesses would duplicate the wait-for-`cluster_state:ok` polling and shell-out logic. `tools/` location matches existing platform patterns (`tools/design-lint.sh`, `tools/eslint-rules/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Per-file harness (rejected — duplication); ioredis programmatic-only (rejected — ungraceful failover requires shelling out to `docker stop` per HLD INT-12).                                                                                                                                              |

### Key Interfaces & Types

**File: `packages/redis/src/types.ts`** — extend `RedisConnectionHandle`:

```typescript
export interface RedisConnectionHandle {
  client: RedisClient;
  isReady(): boolean;
  duplicate(overrides?: Partial<RedisConnectionOptions>): RedisClient;
  disconnect(): Promise<void>;
  // NEW — populated only when client is a Cluster; read-only:
  readonly nodes?: ClusterNode[];
  readonly baseOptions?: Partial<RedisOptions>;
}
```

**File: `packages/redis/src/lua.ts`** (NEW):

```typescript
export interface LuaScript {
  name: string;
  body: string;
  numberOfKeys: number;
}

export async function runLuaScript<T = unknown>(
  client: RedisClient,
  script: LuaScript,
  keys: string[],
  args: ReadonlyArray<string | number>,
): Promise<T>;
```

**File: `packages/redis/src/keys.ts`** (NEW):

```typescript
export function hashTag(...parts: string[]): string;
export function scanKeys(
  client: RedisClient,
  pattern: string,
  count?: number,
): AsyncIterable<string>;
```

**File: `packages/redis/src/subscriber.ts`** (NEW):

```typescript
export function createSubscriber(handle: RedisConnectionHandle): RedisClient;
```

**File: `packages/redis/src/bullmq.ts`** (extend):

```typescript
export interface BullMQConnectionPair {
  queueConnection: RedisClient; // widened from Redis
  workerConnection: RedisClient;
  disconnect(): void;
}

export function createBullMQPair(
  handle: RedisConnectionHandle,
  opts?: { watchdog?: boolean },
): BullMQConnectionPair;
```

**File: `packages/redis/src/errors.ts`** (NEW) — extends the platform's centralized `AppError` base class (per CLAUDE.md structured-error-envelope invariant; existing pattern in `packages/circuit-breaker/src/types.ts:104` `CircuitOpenError extends AppError`):

```typescript
import { AppError } from '@agent-platform/shared-kernel';

export class RedisOperationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: 'REDIS_OPERATION_ERROR', message, cause });
  }
}

export class RedisCrossSlotError extends RedisOperationError {
  constructor(scriptName: string, keys: string[]) {
    super(`Lua script ${scriptName} keys span multiple slots: ${keys.join(', ')}`);
    (this as unknown as { code: string }).code = 'REDIS_CROSSSLOT_ERROR';
  }
}
```

The exact `AppError` constructor shape should be confirmed against `packages/shared-kernel/src/errors.ts` during implementation; the LLD locks the intent (extend platform base, populate `code`), not the literal constructor signature.

### Module Boundaries

| Module                                      | Responsibility                                                                                                                                                                                                                         | Depends On                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/redis/src/connection.ts`          | Factory; populate handle's `nodes` + `baseOptions` on cluster path; remove `as Redis` casts.                                                                                                                                           | `ioredis` types only.       |
| `packages/redis/src/subscriber.ts`          | `createSubscriber()` — branch on `handle.client instanceof Cluster`; reconnect watchdog.                                                                                                                                               | `connection.ts` types.      |
| `packages/redis/src/bullmq.ts`              | `createBullMQPair()` — both paths; optional reconnect watchdog gated by `D-12`.                                                                                                                                                        | `connection.ts`, `ioredis`. |
| `packages/redis/src/lua.ts`                 | `runLuaScript()` — `client.eval()` wrapper; surface `CROSSSLOT` as `RedisCrossSlotError`.                                                                                                                                              | `errors.ts`, `ioredis`.     |
| `packages/redis/src/keys.ts`                | `hashTag()` (pure); `scanKeys()` — single vs multi-master branch.                                                                                                                                                                      | `ioredis`.                  |
| `packages/redis/src/errors.ts`              | Error type hierarchy.                                                                                                                                                                                                                  | none.                       |
| `packages/redis/src/observability.ts` (NEW) | In-process counters: `redis.crossslot.errors`, `redis.moved.redirects`, `redis.cluster.failover`, `redis.subscriber.reconnect`. Pluggable sink (no-op default; runtime / workflow-engine wire to their existing OpenTelemetry meters). | none.                       |
| `.eslintrc.base.json` (extend existing)     | Add two new `no-restricted-syntax` selectors for `.duplicate()` and `client.keys(...)` (using the same pattern as the existing `findById` / `findByIdAndUpdate` / `findByIdAndDelete` selectors). No custom plugin needed.             | ESLint legacy config.       |

---

## 2. File-Level Change Map

### New Files

| File                                                                                | Purpose                                                                                                               | LOC est. |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/redis/src/subscriber.ts`                                                  | `createSubscriber()` mode-aware pub/sub; reconnect watchdog.                                                          | ~120     |
| `packages/redis/src/lua.ts`                                                         | `runLuaScript()` wrapper over `client.eval`; `CROSSSLOT` translation.                                                 | ~80      |
| `packages/redis/src/keys.ts`                                                        | `hashTag()` (pure); `scanKeys()` async iterator.                                                                      | ~120     |
| `packages/redis/src/errors.ts`                                                      | `RedisOperationError`, `RedisCrossSlotError`.                                                                         | ~30      |
| `packages/redis/src/observability.ts`                                               | In-process counter registry; pluggable sink interface.                                                                | ~80      |
| `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts`                      | Integration: `createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys` (INT-2/6/7/8/9; UT-1/2/3). | ~400     |
| `packages/redis/src/__tests__/migration-completeness.static.test.ts`                | INT-13 (`.duplicate()`) + INT-14 (top-level `KEYS`) static-grep guards.                                               | ~80      |
| `packages/circuit-breaker/src/__tests__/redis-circuit-breaker.cluster.test.ts`      | INT-1, INT-7 subset, INT-10.                                                                                          | ~250     |
| `packages/agent-transfer/src/__tests__/session-lua.cluster.test.ts`                 | INT-4, INT-7 subset, ERR-4.                                                                                           | ~280     |
| `packages/execution/src/__tests__/redis-fan-out-barrier.cluster.test.ts`            | INT-5.                                                                                                                | ~220     |
| `apps/runtime/src/__tests__/sessions/session-redis.cluster.e2e.test.ts`             | E2E-1.                                                                                                                | ~350     |
| `apps/runtime/src/__tests__/redis-failover.chaos.cluster.test.ts`                   | E2E-2 + INT-3 failover + ERR-5.                                                                                       | ~250     |
| `apps/runtime/src/__tests__/agent-transfer/handoff.cluster.e2e.test.ts`             | E2E-3.                                                                                                                | ~200     |
| `apps/runtime/src/__tests__/sessions/session-resolve-race.cluster.test.ts`          | INT-11 (GAP-003).                                                                                                     | ~150     |
| `apps/runtime/src/__tests__/cache/scan-keys.cluster.e2e.test.ts`                    | E2E-6.                                                                                                                | ~180     |
| `apps/runtime/src/__tests__/cache/scan-keys-failover.chaos.cluster.test.ts`         | INT-12 (GAP-005, `@chaos`).                                                                                           | ~200     |
| `apps/studio/e2e/workflows/trigger-form-errors-cluster.spec.ts`                     | E2E-ERR-1.                                                                                                            | ~150     |
| `apps/workflow-engine/src/__tests__/triggers/trigger-roundtrip.cluster.e2e.test.ts` | E2E-WIRE-1 + INT-3 happy path.                                                                                        | ~220     |
| `tools/cluster-test-harness.ts`                                                     | `boot()`, `flushAllMasters()`, `forceFailover()`, `tearDown()`.                                                       | ~200     |

<!-- (no new files — both rules implemented as `no-restricted-syntax` selectors in the existing `.eslintrc.base.json`, mirroring the existing `findById`-prevention pattern) -->

| `docker-compose.cluster.yml` | 6-node cluster (3M + 3R) on ports 7000-7005. | ~80 |
| `vitest.cluster.config.ts` | Cluster-tagged suite config; longer timeouts. | ~30 |
| `docs/guides/redis-cluster-mode.md` | Operator runbook (Phase 4). | ~250 |

### Modified Files (line-anchored)

| File                                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Risk |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/redis/src/connection.ts`                                                 | (a) populate `handle.nodes` + `handle.baseOptions` on cluster path (after L185); (b) drop `as Redis` cast at `:194` (`isReady`); (c) make `duplicate()` mode-aware at `:197-203`; (d) drop cast at `:207` (`disconnect`); (e) widen the `ClusterClass` cast at `:181-185` to include top-level `ClusterOptions` fields (`maxRedirections`, `slotsRefreshTimeout`, `retryDelayOnFailover`, `scaleReads`) — preferably by importing `ClusterOptions` from ioredis instead of an `as unknown as` cast.              | Med  |
| `packages/redis/src/singleton.ts:71`                                               | Drop `as Redis` cast on `handle.client.connect()` — both `Redis` and `Cluster` expose `.connect()`. Add `getRedisHandle(): RedisConnectionHandle \| null` accessor (returns the internal handle so consumers can pass it to `createSubscriber` / `createBullMQPair`). Re-export from `index.ts`.                                                                                                                                                                                                                 | Low  |
| `packages/redis/src/connection.ts:230-254`                                         | `resolveRedisOptionsFromEnv()`: read `REDIS_CLUSTER` env var; propagate as `{ cluster: true }`. Mirror logic in `bullmq.ts:resolveBullMQConnectionFromEnv` (or extract shared helper).                                                                                                                                                                                                                                                                                                                           | Low  |
| `packages/redis/src/types.ts`                                                      | Add `nodes` + `baseOptions` optional fields to `RedisConnectionHandle`.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Low  |
| `packages/redis/src/index.ts`                                                      | Re-export `createSubscriber`, `runLuaScript`, `hashTag`, `scanKeys`, `RedisOperationError`, `RedisCrossSlotError`, `createBullMQPair`, `LuaScript`.                                                                                                                                                                                                                                                                                                                                                              | Low  |
| `packages/redis/src/bullmq.ts:127-139`                                             | (a) Rename existing `createBullMQConnectionPair` → keep as deprecated re-export; (b) add `createBullMQPair(handle, opts)` that branches on cluster; (c) widen `BullMQConnectionPair.{queueConnection,workerConnection}` types.                                                                                                                                                                                                                                                                                   | Med  |
| `packages/redis/src/bullmq.ts:156-168`                                             | `resolveBullMQConnectionFromEnv()`: read `REDIS_CLUSTER`; if set, return `ConnectionOptions` shape that BullMQ accepts for cluster (BullMQ accepts a `Cluster` instance at `connection`, but the env-resolver returns options — document that callers in cluster mode must construct a `Cluster` and pass it). Path-of-least-friction: this resolver returns `null` when `REDIS_CLUSTER=true` and the doc directs callers to `createBullMQPair`.                                                                 | Med  |
| `packages/circuit-breaker/src/scripts.ts:24-27`                                    | Replace `readFileSync` with `await fs.promises.readFile`; convert `loadLuaScript` to async (D-13).                                                                                                                                                                                                                                                                                                                                                                                                               | Low  |
| `packages/circuit-breaker/src/scripts.ts:57-77`                                    | Remove `redis.defineCommand(...)` block; replace with `LuaScript` constants exported from this file.                                                                                                                                                                                                                                                                                                                                                                                                             | Med  |
| `packages/circuit-breaker/src/redis-circuit-breaker.ts`                            | Constructor type `Redis` → `RedisClient`; replace `(this.redis as any).breakerRecordFailure(...)` etc. with `runLuaScript(this.redis, BREAKER_RECORD_FAILURE, [...hashTag-keys], [...args])`.                                                                                                                                                                                                                                                                                                                    | High |
| `packages/circuit-breaker/src/redis-circuit-breaker.ts` key construction           | Wrap key construction with `hashTag(level, key)` so `breaker:{<level>:<key>}:state` (etc.) all share a slot.                                                                                                                                                                                                                                                                                                                                                                                                     | Med  |
| `packages/agent-transfer/src/session/lua-scripts.ts:29-75` (`LUA_CREATE_SESSION`)  | Remove `SADD at_active_sessions` and `SADD at_pod:<hostname>` from Lua body; Lua keeps only HSET on session hash + provider index (both tagged `{tenantId:contactId:channel}`).                                                                                                                                                                                                                                                                                                                                  | High |
| `packages/agent-transfer/src/session/lua-scripts.ts:85-125` (`LUA_END_SESSION`)    | Move `DEL at_by_provider:...`, `SREM at_active_sessions`, `SREM at_pod:<hostname>` out of Lua; Lua keeps only `DEL` of session hash.                                                                                                                                                                                                                                                                                                                                                                             | High |
| `packages/agent-transfer/src/session/lua-scripts.ts:137-178` (`LUA_CLAIM_SESSION`) | Move `SREM`/`SADD` on old/new pod sets out of Lua; Lua keeps single-key CAS on `ownerPod` (HGET + HSET on session hash).                                                                                                                                                                                                                                                                                                                                                                                         | High |
| `packages/agent-transfer/src/session/lua-scripts.ts:179-200` (`LUA_EXTEND_TTL`)    | Hash-tag both keys (session + provider index) under `{tenantId:contactId:channel}`.                                                                                                                                                                                                                                                                                                                                                                                                                              | Med  |
| `packages/agent-transfer/src/session/transfer-session-store.ts`                    | Pipeline non-Lua `SADD`/`SREM`/`DEL` after each Lua call; emit structured log on pipeline partial failure (`redis.agent-transfer.index-pipeline.partial-failure`).                                                                                                                                                                                                                                                                                                                                               | High |
| `packages/agent-transfer/src/session/transfer-session-store.ts` constructor        | Type `Redis` → `RedisClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Low  |
| `packages/execution/src/redis-fan-out-barrier.ts:99` (`LUA_SCAN_RESULT_KEYS`)      | Replace `redis.call('KEYS', KEYS[1] .. ':result:*')` with `redis.call('SMEMBERS', KEYS[2])` where `KEYS[2] = barrier:{<id>}:result-keys`.                                                                                                                                                                                                                                                                                                                                                                        | Med  |
| `packages/execution/src/redis-fan-out-barrier.ts:112` (`LUA_DELETE_BARRIER`)       | Same replacement as `:99`; iterate registry SET; finally `DEL` the SET itself + barrier hash.                                                                                                                                                                                                                                                                                                                                                                                                                    | Med  |
| `packages/execution/src/redis-fan-out-barrier.ts:write-result path`                | After `SET barrier:{<id>}:result:<branchKey>`, also `SADD barrier:{<id>}:result-keys <branchKey-or-fullkey>`.                                                                                                                                                                                                                                                                                                                                                                                                    | Med  |
| `packages/execution/src/redis-fan-out-barrier.ts` constructor                      | Type `Redis` → `RedisClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Low  |
| `apps/runtime/src/services/redis/redis-client.ts:97-100`                           | **Fourth factory bypass** (in addition to the three named in the feature spec): replace `new Redis.Cluster(nodes, { redisOptions: options })` and `new Redis(config.redis.url, options)` with `createRedisConnection(opts)` from `@agent-platform/redis`. Preserve the file's existing `getRedisClient()` API surface (return type widened to `RedisClient \| null`). Add `getRedisHandle(): RedisConnectionHandle \| null` accessor so the file's other helper at `:174` can use the shared `createSubscriber`. | High |
| `apps/runtime/src/services/redis/redis-client.ts:174`                              | `client.duplicate()` → `createSubscriber(handle)` using the local `getRedisHandle()` accessor added at `:97-100`.                                                                                                                                                                                                                                                                                                                                                                                                | Med  |
| `apps/runtime/src/server.ts:2004`                                                  | `redis.duplicate({ maxRetriesPerRequest: null })` (used as BullMQ worker conn) → `createBullMQPair(handle).workerConnection`. Audit caller: this is a single-purpose connection; may consume the queue side too.                                                                                                                                                                                                                                                                                                 | Med  |
| `apps/runtime/src/websocket/handler.ts:781`                                        | `redis.duplicate()` → `createSubscriber(handle)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Med  |
| `apps/runtime/src/services/message-persistence-queue.ts:904,1002`                  | Two `.duplicate({ maxRetriesPerRequest: null })` (BullMQ pair) → single `createBullMQPair(handle)` call; assign `.queueConnection`/`.workerConnection` to existing fields.                                                                                                                                                                                                                                                                                                                                       | Med  |
| `apps/runtime/src/services/kms/reencryption-queue.ts:88-89`                        | Two `.duplicate({ maxRetriesPerRequest: null })` → `createBullMQPair(handle)`.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Med  |
| `apps/runtime/src/services/llm/llm-queue.ts:196,206`                               | Two `.duplicate({ maxRetriesPerRequest: null })` → `createBullMQPair(handle)`. Update `:548` shutdown comment + cleanup.                                                                                                                                                                                                                                                                                                                                                                                         | Med  |
| `apps/runtime/src/services/queues/channel-queues.ts:8` (and call sites)            | Migrate to `createBullMQPair(handle)`. (Comment header reference at `:8` documents the pattern; actual `.duplicate()` calls are inside the file at the queue-construction sites.)                                                                                                                                                                                                                                                                                                                                | Med  |
| `apps/runtime/src/services/trace/redis-trace-store.ts:510`                         | `this.redis.duplicate()` → `createSubscriber(handle)`. Update doc comment at `:9`.                                                                                                                                                                                                                                                                                                                                                                                                                               | Med  |
| `apps/runtime/src/services/agent-transfer/index.ts:448`                            | `redis.duplicate()` (keyspace subscriber) → `createSubscriber(handle)`.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Med  |
| `apps/runtime/src/services/auth-profile/paused-execution-store.ts:583`             | `redis.duplicate()` → `createSubscriber(handle)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Med  |
| `apps/runtime/src/services/sync-execution.ts:18`                                   | Comment-only update to reference `createSubscriber`. (No code change at this line; the call site is elsewhere — search for `.duplicate()` in this file and convert.)                                                                                                                                                                                                                                                                                                                                             | Low  |

<!-- (removed) `apps/runtime/src/services/agent-transfer/message-bridge.ts:306` was referenced in the feature spec / HLD as a `.duplicate()` site, but verified absent: that file contains zero `.duplicate()` calls. The cross-pod relay subscriber lives elsewhere in the agent-transfer subsystem (see `agent-transfer/index.ts:448`). -->

| `apps/runtime/src/services/session/redis-session-store.ts` | Audit pipelines for slot-write-ordering races; hash-tag `sess-tid:{id}` with `sess:{tid}:{id}` OR add retry-on-miss in `resolveTenantId(sessionId)` (GAP-003 mitigation per Phase 3 step 4.6). Decision: hash-tag (preferred — eliminates race entirely; `sess-tid:` becomes `sess-tid:{<sessionId>}:` and stores `{tid}` as value; lookup is single-key GET). | Med |
| `apps/workflow-engine/src/index.ts:733,736,809` | Three `.duplicate({ maxRetriesPerRequest: null })` (BullMQ Queue + 2 Workers) → `createBullMQPair(handle)` (one pair per queue+worker tuple). | Med |
| `apps/workflow-engine/src/services/trigger-scheduler.ts:64-65` | Two `.duplicate({ maxRetriesPerRequest: null })` → `createBullMQPair(handle)`. | Med |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts:51-52` | Two `.duplicate({ maxRetriesPerRequest: null })` → `createBullMQPair(handle)`. | Med |
| `apps/workflow-engine/src/services/redis.ts` | Replace `new Redis(...)` direct construction with `createRedisConnection(opts)`; export the same `getRedisClient()` API consumers use today (signature unchanged, return type widened to `RedisClient \| null`). | High |
| `apps/search-ai/src/services/connector-presence.service.ts` | Replace `new Redis(...)` direct construction with `createRedisConnection(opts)` from `@agent-platform/redis`. Existing service interface unchanged. | High |
| `apps/search-ai-runtime/src/services/cache/redis-client.ts` | Replace direct construction with `createRedisConnection(opts)`. The wrapper internally exposes `.keys(pattern)` to legacy adapters (`idp-token-validator-compat.ts:36`, `end-user-auth.service.ts:89`) — the wrapper's `.keys()` method delegates to `scanKeys()` so adapters work unchanged. | High |
| `packages/shared/src/services/lambda/lambda-deployment-store.ts:111` | `await this.redis.keys(pattern)` → collect from `for await (const k of scanKeys(this.redis, pattern))`. | Low |
| `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts:109` | Same pattern. | Low |
| `packages/pipeline-engine/src/pipeline/services/definition-cache.ts:93` | Same pattern. | Low |
| `apps/studio/src/lib/invalidate-definition-cache.ts:21` | Same pattern. | Low |
| `apps/search-ai/src/routes/intelligence.ts:966` | Same pattern. | Low |
| `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332` | Same pattern. | Low |
| `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130,194` | Two call sites — same pattern at each. | Low |
| `apps/search-ai-runtime/src/services/query/query-cache.ts:123,147` | Two call sites — same pattern at each. | Low |
| `package.json` (root) | Add `"test:cluster": "docker compose -f docker-compose.cluster.yml up -d --wait && pnpm vitest --config vitest.cluster.config.ts && docker compose -f docker-compose.cluster.yml down"`. | Low |
| `.eslintrc.base.json` | Add two `no-restricted-syntax` selectors: (a) `CallExpression[callee.property.name='duplicate']` with message pointing to `createSubscriber` / `createBullMQPair`; (b) `CallExpression[callee.property.name='keys'][arguments.length=1]` with message pointing to `scanKeys`. Excluded paths handled per-package via `overrides[].files: ['packages/redis/**', '**/__tests__/**']` with `'no-restricted-syntax': 'off'` for those globs. Severity `error` (default for `no-restricted-syntax`). | Low |
| `deploy/helm-values/tier-{m,l,xl}/values.yaml` | Phase 5 only — flip `REDIS_CLUSTER: 'true'`. SIT values changed in Phase 4. | Low |

### Deleted Files

| File   | Reason                       |
| ------ | ---------------------------- |
| (none) | All migrations are in-place. |

### Note: feature-spec phantom paths

Two paths listed in the feature spec do not exist on disk and are **not** included above:

- `packages/shared-auth/src/idp/idp-token-validator.ts:407` — verified absent during HLD audit Round 2.
- `apps/search-ai-runtime/src/routes/auth-oauth.ts:394` — verified absent.

The 10 real `KEYS` sites across 8 files in the modified-files table match the HLD §1 corrected count.

---

## 3. Implementation Phases

> Every phase is independently shippable and keeps standalone working unchanged. The earliest cluster validation runs only when Phase 0 helpers and `docker-compose.cluster.yml` land — before any consumer migrations.

### Phase 0 — Foundation helpers in `@agent-platform/redis`

**Goal**: Add the 5 mode-aware helpers, fix the `as Redis` casts, and stand up the cluster Docker harness so subsequent phases have a verified contract to migrate against.

**Tasks**:

0.1 **Extend `RedisConnectionHandle`** (`packages/redis/src/types.ts`): add optional `nodes: ClusterNode[]` and `baseOptions: Partial<RedisOptions>`. No behavior change to existing consumers (extra fields ignored).

0.2 **Fix `connection.ts` casts** (`packages/redis/src/connection.ts`):

- `:194` `isReady`: `(client as Redis).status` → `client.status` (both `Redis` and `Cluster` expose `.status`).
- `:197-203` `duplicate`: replace single-line `(client as Redis).duplicate(dupOpts)` body with `if (client instanceof Redis.Cluster) { ... rebuild Cluster with overrides ... } else { return client.duplicate(dupOpts); }`. The cluster path uses `new Cluster(handle.nodes, { ...handle.baseOptions, ...overrides })`.
- `:207` `disconnect`: `(client as Redis).quit()` → `client.quit()` (both expose `.quit()`).
- After `:185` cluster construction: capture `nodes` and `baseOptions` into the returned handle so downstream helpers can reuse them.

  0.2b **Expose `getRedisHandle` and fix singleton cast** (`packages/redis/src/singleton.ts`):

- `:71`: drop `as Redis` cast on `handle.client.connect()` (both classes expose `.connect()`).
- Add `export function getRedisHandle(): RedisConnectionHandle | null { return handle; }` so consumers can obtain the handle (with `nodes`/`baseOptions`) for `createSubscriber` / `createBullMQPair`.
- Re-export `getRedisHandle` from `packages/redis/src/index.ts`.

  0.3 **Configure ioredis `Cluster` constructor** (`connection.ts:181-185`):

- Pass `{ redisOptions: baseOpts, maxRedirections: 16, slotsRefreshTimeout: 1000, retryDelayOnFailover: 500, retryDelayOnMoved: 50, scaleReads: 'master', enableOfflineQueue: true }`.
- **`retryDelayOnFailover` (500 ms)** governs retries when the _target node is disconnected_; combined with `maxRedirections: 16` gives an 8 s budget that exceeds the 5 s `cluster-node-timeout` (per D-8).
- **`retryDelayOnMoved` (50 ms)** is set explicitly (ioredis default 0 ms causes ping-pong redirect storms during slot transitions per ioredis #1189). 50 ms is a small back-off that avoids storms without materially hurting steady-state latency.
- **`slotsRefreshTimeout` (1000 ms)** is the ioredis default; awareness of ioredis #1766 (slots-cache infinite loop) and #2071 (refresh failures after 5.9.x upgrade) is logged in the operator runbook (Phase 4.5). If symptoms appear in SIT, evaluate adding `slotsRefreshInterval` (proactive periodic refresh) as a mitigation.
- **`enableOfflineQueue: true`** matches the standalone default. Under sustained partitions this can cause unbounded application-side memory growth (ioredis #581). Phase 4 runbook documents the trade-off; if production reveals memory pressure during partition events, consider `enableOfflineQueue: false` with explicit error-handling at consumers.
- Cluster events: subscribe to `+node`, `-node`, and `error`; increment `redis.cluster.failover` and `redis.moved.redirects` counters via `observability.ts`.

  0.4 **Implement `createSubscriber`** (`packages/redis/src/subscriber.ts` NEW):

- If `handle.client instanceof Cluster`: `new Cluster(handle.nodes!, handle.baseOptions!)` → attach `'error'` and `'+node'` handlers; on persistent error (no `'ready'` within 5 s), schedule reconnect via `setTimeout(retry, expBackoff(attempt))`; cap at 30 s total budget; emit `redis.subscriber.reconnect` per attempt.
- Else: `return handle.client.duplicate()` (verbatim existing path).
- Returns `RedisClient`.

  0.5 **Implement `createBullMQPair`** (extend `packages/redis/src/bullmq.ts`):

- Standalone path: call `handle.client.duplicate({ maxRetriesPerRequest: null })` twice (queue + worker), wrap into existing `BullMQConnectionPair` shape.
- Cluster path: instantiate two new `Cluster(handle.nodes, { ...handle.baseOptions, maxRetriesPerRequest: null })` instances.
- Widen `BullMQConnectionPair.{queueConnection,workerConnection}` from `Redis` to `RedisClient`. Note: this is a breaking change at the type level (consumers that declared their queue/worker connections as `Redis` will get type errors); BullMQ accepts `Cluster` at runtime, so the type-only break is the only effect.
- **BullMQ queue prefix hash-tag (cluster requirement, per BullMQ docs)**: BullMQ's per-queue keys must share a hash tag for cluster mode. Default BullMQ behavior wraps queue names in `{queueName}` internally, but the `prefix` option does NOT auto-tag. Document in `createBullMQPair` JSDoc that callers constructing Queue/Worker with a custom `prefix` must use brace-wrapped form (e.g., `prefix: '{bull}'` instead of `prefix: 'bull'`). Phase 3 sub-3b/3c PRs must verify each migrated queue's `prefix` (or accept the BullMQ default).
- Watchdog scaffolding (D-12): if `opts.watchdog === true`, start a 5 s interval that polls `worker._connecting` / `'ready'` status; if stuck > 30 s, replace the worker connection. Default `opts.watchdog === false` for now; **see D-12 update below — Phase 4 SIT may flip the default to `true` for cluster mode given GAP-008 severity per BullMQ #2964**.
- Keep the existing `createBullMQConnectionPair(redis)` export as a deprecated re-export that delegates to `createBullMQPair` for back-compat with apps not yet migrated.

  0.6 **Implement `runLuaScript`** (`packages/redis/src/lua.ts` NEW):

- Body: `return await client.eval(script.body, script.numberOfKeys, ...keys, ...args.map(String)) as T`.
- Catch `ReplyError`; if `err.message.startsWith('CROSSSLOT')`: increment `redis.crossslot.errors`; emit a structured TraceEvent if a tracing context is available on the call stack (best-effort — many Redis ops occur outside session scope, so emission is conditional via the existing `TraceStore.tryEmit(...)` pattern); then rethrow as `RedisCrossSlotError(script.name, keys)`.
- Returns `Promise<T>`.
- **Retry policy**: `runLuaScript` does NOT retry on CROSSSLOT. CROSSSLOT is a programming error indicating wrong key tagging, not a transient cluster event. Counter `redis.crossslot.errors` alerts on this as a code defect (>0 over 5 min → page per HLD §12 Concern #8). Callers must NOT wrap `runLuaScript` in a CROSSSLOT-retry loop — the call would just fail again. Other `ReplyError`s (e.g., `BUSY`, `NOSCRIPT`) propagate as-is; `NOSCRIPT` is handled internally by ioredis transparently.
- **ARGV normalization**: `runLuaScript` calls `client.eval(body, n, ...keys, ...args.map(String))`. The `.map(String)` coercion ensures all ARGV values are strings (Redis protocol requirement; ARGV is always string in Lua). Existing `eval()` call sites in the codebase mix string and number args (Redis silently coerces); this wrapper normalizes upfront for clarity. Document in the function JSDoc.

  0.7 **Implement `hashTag`** (`packages/redis/src/keys.ts` NEW):

- `export function hashTag(...parts: string[]): string { return '{' + parts.join(':') + '}'; }` — pure; no validation needed (callers control the parts).

  0.8 **Implement `scanKeys`** (`packages/redis/src/keys.ts`):

- Generator function `async function* scanKeys(client, pattern, count = 1000): AsyncIterable<string>`.
- If `client instanceof Cluster`:
  1. `nodes = client.nodes('master')`.
  2. `seen = new Set<string>()` (in-memory dedupe across slot migration; bounded by current scan's working set).
  3. For each `node`:
     - Wrap in try/catch — on per-node failure, log structured event `redis.scanKeys.nodeError` (no exception propagation), refresh `nodes = client.nodes('master')` once, retry the failed node; if it fails again, skip it.
     - Cursor-loop: `cursor = '0'`; do `[cursor, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count)`; for each key, if `!seen.has(key)`, `seen.add(key)` and `yield key`.
     - Until `cursor === '0'`.
- Else: single-node cursor loop on `client` (no `seen` Set needed — single node yields each key exactly once).
- **Memory caveat (per CLAUDE.md "in-memory Map needs max size, TTL, eviction")**: the cluster-mode `seen` Set is bounded by the scan's working set. All current `KEYS`-replaced call sites scan bounded patterns (cache invalidation, sync workers — counts in low thousands). The function's JSDoc must document: "intended for bounded key sets; for unbounded scans, callers should use the underlying ioredis cursor API directly and accept potential duplicates during slot migration." Callers in this codebase do NOT need this caveat in practice; the JSDoc is preventive guidance for future consumers.

  0.9 **Implement `observability.ts`** (`packages/redis/src/observability.ts` NEW) — uses `@opentelemetry/api` directly (matches existing platform pattern in `packages/agent-transfer/src/observability/metrics.ts` and `packages/pipeline-engine/src/pipeline/services/eval/eval-metrics.ts`):

```ts
import { metrics } from '@opentelemetry/api';
const meter = metrics.getMeter('@agent-platform/redis', '1.0.0');
export const crossslotErrors = meter.createCounter('redis.crossslot.errors', {
  description: 'Lua scripts whose KEYS span multiple cluster slots',
});
export const movedRedirects = meter.createCounter('redis.moved.redirects', {
  description: 'ioredis MOVED redirect count',
});
export const clusterFailover = meter.createCounter('redis.cluster.failover', {
  description: '+node / -node events from ioredis Cluster',
});
export const subscriberReconnect = meter.createCounter('redis.subscriber.reconnect', {
  description: 'createSubscriber reconnect attempts',
});
```

When no SDK is registered (e.g., in integration tests), `@opentelemetry/api` returns the NoopMeterProvider whose counters are silent — exactly the "no-op default" behavior. Tests that need to read counters use `metrics.getMeterProvider().getMeter(...)` against an in-memory test SDK if needed; for most cluster integration tests, asserting no-throw + structured-log emission is sufficient. **No custom `Counter` interface, `getCounter()`, or `setMetricsSink()` is needed** — `@opentelemetry/api` is the pluggable sink.

0.10 **Errors** (`packages/redis/src/errors.ts` NEW): `RedisOperationError`, `RedisCrossSlotError`.

0.11 **Extend env-resolvers** (`packages/redis/src/connection.ts:230-254`, `bullmq.ts:156-168`):

- `resolveRedisOptionsFromEnv`: read `REDIS_CLUSTER`; propagate as `cluster: true`.
- `resolveBullMQConnectionFromEnv`: in cluster mode, return `null` and document that callers must use `createBullMQPair` (the pair-from-handle path).

  0.12 **Re-exports** (`packages/redis/src/index.ts`): export everything new; keep existing exports unchanged.

  0.13 **Docker harness** (`docker-compose.cluster.yml` NEW):

- 6 services `redis-cluster-{0..5}` from `redis:7-alpine`, ports 7000-7005.
- Each: `--cluster-enabled yes --cluster-require-full-coverage no --cluster-node-timeout 5000 --cluster-config-file nodes.conf --appendonly yes`.
- One-shot `redis-cluster-init` service runs `redis-cli --cluster create 127.0.0.1:7000..7005 --cluster-replicas 1 --cluster-yes` after the 6 nodes start.
- Healthcheck on each: `redis-cli -p <port> CLUSTER INFO | grep cluster_state:ok`.

  0.14 **`pnpm test:cluster` script** (`package.json`): `docker compose -f docker-compose.cluster.yml up -d --wait && pnpm vitest --config vitest.cluster.config.ts && docker compose -f docker-compose.cluster.yml down -v`.

  0.15 **`vitest.cluster.config.ts`** (NEW): test-name filter `*.cluster.test.ts`; testTimeout 30000; teardownTimeout 60000.

  0.16 **Cluster test harness** (`tools/cluster-test-harness.ts` NEW): expose `boot()`, `flushAllMasters()`, `forceFailover(masterPort, mode: 'graceful' | 'ungraceful')`, `tearDown()`, and `getNodes(): ClusterNode[]` returning the 3 master node addresses (so tests can `createRedisConnection({ url: 'h:p,h:p,h:p', cluster: true })`). Optional convenience: `getUrl(): string` returns the comma-joined `host:port` list. The API intentionally diverges from the standalone `redis-server-harness.ts` ({ url, clear(), close() }) because cluster boot/failover semantics differ; the divergence is documented in the file's JSDoc.

  0.17 **Helper integration tests** (`packages/redis/src/__tests__/cluster-helpers.cluster.test.ts` NEW): cover INT-2, INT-6, INT-7 subset, INT-8, INT-9, plus unit tests UT-1, UT-2, UT-3, UT-ERR-3.

**Files Touched**:

- `packages/redis/src/{connection,bullmq,index,types,singleton}.ts`
- `packages/redis/src/{subscriber,lua,keys,errors,observability}.ts` (NEW)
- `packages/redis/src/__tests__/cluster-helpers.cluster.test.ts` (NEW)
- `tools/cluster-test-harness.ts` (NEW)
- `docker-compose.cluster.yml` (NEW)
- `vitest.cluster.config.ts` (NEW)
- `package.json` (root) — add `test:cluster` script

**Exit Criteria**:

- [ ] `pnpm --filter=@agent-platform/redis build` succeeds with 0 TypeScript errors.
- [ ] `pnpm --filter=@agent-platform/redis test` passes (unit-level helpers + UT-1/2/3/ERR-3).
- [ ] `pnpm test:cluster` boots a 6-node cluster and the helper integration suite (INT-2/6/7-subset/8/9) passes 100%.
- [ ] `docker compose -f docker-compose.cluster.yml up -d --wait` returns success and `redis-cli -p 7000 CLUSTER INFO | grep cluster_state:ok` matches.
- [ ] All existing standalone tests in the repository pass (`pnpm test`) — zero regression.
- [ ] No new ESLint warnings introduced (rules not yet active).
- [ ] `RedisConnectionHandle.duplicate()` works against a `Cluster` instance (UT-2 validates).

**Test Strategy**:

- Unit: UT-1 (`hashTag`), UT-2 (cluster handle methods), UT-3 (env), UT-ERR-3 (`.duplicate()` direct on `Cluster` throws).
- Integration: INT-2 (`scanKeys`), INT-6 (`resolveRedisOptionsFromEnv`), INT-7 subset (standalone-mode parity for each helper), INT-8 (CROSSSLOT negative), INT-9 (`KEYS` partial-result negative).

**Rollback**: revert the PR. No other phase depends on Phase 0 being deployed — the helpers are dead code until consumers adopt them in P1+.

---

### Phase 1 — Eliminate top-level `KEYS` (no Lua changes yet)

**Goal**: Replace 10 production `KEYS` call sites across 8 files with `scanKeys`. Land the ESLint rule + INT-14 static guard at the end of the phase to prevent regression.

**Tasks**:

1.1 `packages/shared/src/services/lambda/lambda-deployment-store.ts:111` — change `const keys = await this.redis.keys(pattern);` to `const keys: string[] = []; for await (const k of scanKeys(this.redis, pattern)) keys.push(k);`. Add `import { scanKeys } from '@agent-platform/redis';`.

1.2 `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts:109` — same pattern.

1.3 `packages/pipeline-engine/src/pipeline/services/definition-cache.ts:93` — same pattern.

1.4 `apps/studio/src/lib/invalidate-definition-cache.ts:21` — same pattern. (Studio uses Node-side Redis access only; not a client component.)

1.5 `apps/search-ai/src/routes/intelligence.ts:966` — same pattern.

1.6 `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts:332` — same pattern.

1.7 `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:130` — same pattern.

1.8 `apps/search-ai-runtime/src/services/cache/group-membership-cache.ts:194` — same pattern.

1.9 `apps/search-ai-runtime/src/services/query/query-cache.ts:123` — same pattern.

1.10 `apps/search-ai-runtime/src/services/query/query-cache.ts:147` — same pattern.

1.11 **ESLint rule** — extend `.eslintrc.base.json` with a new `no-restricted-syntax` selector (mirrors the existing `findById` pattern at `.eslintrc.base.json:7-21`). The naive `[callee.property.name='keys']` selector would match `Object.keys(obj)` and produce widespread false positives. Narrow the receiver name to known Redis-client identifiers:

```json
{
  "selector": "CallExpression[callee.type='MemberExpression'][callee.property.name='keys'][arguments.length=1]:matches([callee.object.name='redis'], [callee.object.name='client'], [callee.object.name='redisClient'], [callee.object.property.name='redis'], [callee.object.property.name='client'], [callee.object.property.name='redisClient'])",
  "message": "Use scanKeys() from @agent-platform/redis instead of .keys(pattern). Top-level KEYS returns partial results in Redis Cluster (silent data loss)."
}
```

This selector matches `redis.keys(p)`, `client.keys(p)`, `redisClient.keys(p)`, `this.redis.keys(p)`, `this.client.keys(p)`, `this.redisClient.keys(p)` — the receiver-name patterns observed in the 10 production sites in section 2. Severity `error`. INT-14 (static-grep CI test) is the authoritative backstop for any pattern the selector misses; ESLint catches the common cases at edit time. For any unavoidable false positive, add a per-line `// eslint-disable-next-line no-restricted-syntax` with justification.

1.12 **Scope exclusions** — add an `overrides` block to `.eslintrc.base.json` that disables `no-restricted-syntax` for `packages/redis/**/*.ts` and `**/__tests__/**/*.ts` (the helpers themselves use `.keys()`, and tests intentionally exercise the violations — e.g., INT-9 verifies raw `KEYS` returns partial results).

1.13 **Static-grep guard** (`packages/redis/src/__tests__/migration-completeness.static.test.ts` NEW, INT-14 portion): unit test that runs `grep -rn '\.keys(' apps packages --include='*.ts' | grep -v __tests__ | grep -v 'packages/redis/src/' | grep -E '(redis|redisClient|client)\.keys'` and asserts empty output.

**Files Touched**: 8 files modified + ESLint rule + guard test. No `@agent-platform/redis` source changes (helpers were landed in Phase 0).

**Exit Criteria**:

- [ ] All 10 `KEYS` call sites removed; grep returns empty.
- [ ] `pnpm test` passes for each affected package.
- [ ] ESLint reports zero violations of the new `no-restricted-syntax` `.keys()` selector across the repo.
- [ ] INT-14 static-grep test passes.
- [ ] Existing standalone E2E suite passes 100%.

**Test Strategy**:

- Unit: each affected service's existing unit tests cover the cache-invalidation flow; assert behavioral parity (same set of keys deleted).
- Integration: existing integration suites (`*-cache.integration.test.ts`, `idp-token-validator.test.ts`) exercise the new `scanKeys` path against single-Redis. Cluster path is validated via INT-2 + per-package cluster tests in later phases.
- Static: INT-14 fails the build if any new `.keys(` call sneaks in.

**Rollback**: revert per-file PRs. Standalone behavior unchanged — `scanKeys` against single-Redis behaves identically to `KEYS` (returns same key set).

---

### Phase 2 — Lua redesign per family

**Goal**: Eliminate `CROSSSLOT` errors in cluster mode by hash-tagging keys and (for agent-transfer) splitting cross-slot writes outside the Lua boundary. Each family ships independently.

#### Phase 2.1 — Circuit-breaker

**Tasks**:

2.1.1 `packages/circuit-breaker/src/scripts.ts:19-28` (the function is named `loadLua`, not `loadLuaScript`): Replace `readFileSync` (lines 24, 26) with `await fs.promises.readFile`. Convert `loadLua` to async; cascade `getScripts()` (lines 33-43) and `registerScripts()` to async. The `LuaScript` constants exported in task 2.1.2 are populated at module scope via a top-level `await` (Node 18+ supports top-level await in ESM packages — confirm this package's `package.json` has `"type": "module"` and ESM build target during implementation; if not, switch to lazy resolution: export an `async getLuaScripts(): Promise<{ BREAKER_RECORD_FAILURE, ... }>` that `runLuaScript` callers await on first use). The decision (top-level await vs lazy resolution) is locked during the Phase 2.1 PR based on the build target verified at edit time.

2.1.2 `packages/circuit-breaker/src/scripts.ts:57-77`: Remove `redis.defineCommand(...)` block. Export the four scripts as `LuaScript` constants with their **exact existing `numberOfKeys`** (verified against `scripts.ts`):

```ts
export const BREAKER_RECORD_FAILURE: LuaScript = { name: 'breakerRecordFailure', body: <existing lua>, numberOfKeys: 5 };
export const BREAKER_RECORD_SUCCESS: LuaScript = { name: 'breakerRecordSuccess', body: <existing lua>, numberOfKeys: 5 };
export const BREAKER_CHECK_STATE:    LuaScript = { name: 'breakerCheckState',    body: <existing lua>, numberOfKeys: 3 };
export const BREAKER_FORCE_RESET:    LuaScript = { name: 'breakerForceReset',    body: <existing lua>, numberOfKeys: 5 };
```

The check-state script takes only 3 keys (state, opened_at, half_open_count) — the failures/successes counters aren't needed for the read-only state check.

2.1.3 `packages/circuit-breaker/src/redis-circuit-breaker.ts`: Constructor signature `Redis` → `RedisClient`. Replace each `(this.redis as any).breakerRecordFailure(k1, k2, k3, k4, k5, ...args)` with `runLuaScript(this.redis, BREAKER_RECORD_FAILURE, [k1, k2, k3, k4, k5], args)`.

2.1.4 Update the authoritative key builder `breakerKeys()` in `packages/circuit-breaker/src/types.ts:157-166` (this function is consumed by `redis-circuit-breaker.ts` and is the source of truth for breaker key strings). Replace `breaker:${level}:${key}:<suffix>` with `breaker:${hashTag(level, key)}:<suffix>` → `breaker:{<level>:<key>}:<suffix>`. Apply to all 5 suffixes (state, failures, successes, opened_at, half_open_count). Callers (`redis-circuit-breaker.ts`) consume `breakerKeys()` output unchanged — single edit point keeps the keyspace contract centralized.

**Files Touched**: `packages/circuit-breaker/src/scripts.ts`, `packages/circuit-breaker/src/redis-circuit-breaker.ts`, `packages/circuit-breaker/src/types.ts` (the authoritative `breakerKeys()` builder per task 2.1.4).

**Exit Criteria**:

- [ ] All 4 Lua scripts execute via `runLuaScript`; `defineCommand` removed.
- [ ] All 5 breaker keys for any single (level, key) pair return identical `CLUSTER KEYSLOT`.
- [ ] INT-1 passes (cluster: zero CROSSSLOT, breaker state transitions correct).
- [ ] INT-7 subset passes (standalone parity).
- [ ] Existing circuit-breaker unit + integration tests pass.
- [ ] `readFileSync` removed (CLAUDE.md "no sync I/O" violation closed).

**Test Strategy**:

- Integration: INT-1 (cluster + standalone), INT-10 (`BUSY` Lua script timeout).
- Unit: existing `redis-circuit-breaker.unit.test.ts` keeps passing.

**Rollback**: revert PR. Old `defineCommand` path remains in git; standalone deployments are unaffected by hash-tag adoption (braces are inert characters).

#### Phase 2.2 — Agent-transfer

**Tasks**:

2.2.1 `packages/agent-transfer/src/session/lua-scripts.ts:29-75` (`LUA_CREATE_SESSION`): Lua body keeps only `HSET` on session hash + `HSET` on provider index (both keys passed as `KEYS[1]`/`KEYS[2]`, hash-tagged with the same tag by the caller). Remove `redis.call('SADD', 'at_active_sessions', ...)` and `redis.call('SADD', 'at_pod:' .. hostname, ...)` from the body.

2.2.2 `packages/agent-transfer/src/session/lua-scripts.ts:85-125` (`LUA_END_SESSION`): **Preserve the existing TOCTOU safety**. The current Lua reads `provider`, `providerSessionId`, and `ownerPod` from the session hash via `HGET` BEFORE `DEL` so the caller cannot race a concurrent expiry. Narrowed Lua (use `or ''` fallbacks matching the existing pattern in the original Lua at L96-98 — `HGET` returns Lua `false` for missing fields):

```lua
local provider = redis.call('HGET', KEYS[1], 'provider') or ''
local providerSessionId = redis.call('HGET', KEYS[1], 'providerSessionId') or ''
local ownerPod = redis.call('HGET', KEYS[1], 'ownerPod') or ''
redis.call('DEL', KEYS[1])
return {provider, providerSessionId, ownerPod}
```

The TypeScript caller must handle empty-string returns (means the field was missing from the hash — session may already have been partially cleaned up; skip the corresponding pipeline op). All four ops touch only `KEYS[1]` (session hash) — single slot, no CROSSSLOT. The caller uses the returned tuple to construct the cross-slot index-cleanup pipeline (DEL provider index + SREM `at_active_sessions` + SREM `at_pod:<ownerPod>`). The TOCTOU window is closed because the Lua atomically reads-then-deletes; the subsequent index cleanup is best-effort and tolerates partial failure (TTL self-cleans).

2.2.3 `packages/agent-transfer/src/session/lua-scripts.ts:137-178` (`LUA_CLAIM_SESSION`): Reduce `numberOfKeys` from 3 to 1. Lua keeps only the CAS on `ownerPod` against `KEYS[1]` (session hash): `local current = redis.call('HGET', KEYS[1], 'ownerPod'); if current == ARGV[1] then redis.call('HSET', KEYS[1], 'ownerPod', ARGV[2]); return 1; else return 0; end`. ARGV stays `[oldPod, newPod, ...]`. The caller (which already knows `oldPod` and `newPod` since they are passed as ARGV) pipelines `SREM at_pod:<oldPod>, sessionKey` + `SADD at_pod:<newPod>, sessionKey` AFTER the Lua returns 1 (CAS succeeded). If the CAS returns 0, no pod-set updates are issued. Note: the original file's comment block (L127-131) lists the pod set keys as ARGV but the Lua body actually reads them as KEYS — the new narrowed Lua makes the pod sets fully external (neither KEYS nor ARGV), which fixes the doc/code mismatch as a side effect.

2.2.4 `packages/agent-transfer/src/session/lua-scripts.ts:179-200` (`LUA_EXTEND_TTL`): caller passes both keys hash-tagged together (`KEYS[1]` = session hash, `KEYS[2]` = provider index, both wrapped in `{tenantId:contactId:channel}`). Lua body unchanged.

2.2.4b `packages/agent-transfer/src/session/lua-scripts.ts:201-215` (`LUA_UPDATE_SESSION`): **No change required**. This script operates on a single key (`KEYS[1]` = session hash, `numberOfKeys: 1`) and is already cluster-safe.

2.2.5 `packages/agent-transfer/src/session/transfer-session-store.ts`: Constructor type `Redis` → `RedisClient`. After each Lua call, run a cluster-safe **`pipeline()`** (NOT `multi()` — see D-5):

```ts
// CREATE: after successful Lua (which wrote session hash + provider index, both in {tenantId:contactId:channel} slot)
// pipeline() auto-routes each command to its correct node in cluster mode; no atomicity, no CROSSSLOT.
const p = this.redis.pipeline();
p.sadd('at_active_sessions', sessionKey);
p.sadd(`at_pod:${this.hostname}`, sessionKey);
const results = await p.exec();
if (results?.some(([err]) => err != null)) {
  log.warn(
    { eventType: 'redis.agent-transfer.index-pipeline.partial-failure', sessionKey },
    'index pipeline partial failure',
  );
  // session hash is created; indexes self-clean via TTL within session lifetime
}

// END: after narrowed Lua returns [provider, providerSessionId, ownerPod]
const [provider, providerSessionId, ownerPod] = await runLuaScript<[string, string, string]>(
  this.redis,
  LUA_END_SESSION,
  [sessionKey],
  [],
);
const indexKey = `at_by_provider:{${tenantId}:${contactId}:${channel}}:${provider}:${providerSessionId}`;
const cleanup = this.redis.pipeline();
cleanup.del(indexKey);
cleanup.srem('at_active_sessions', sessionKey);
cleanup.srem(`at_pod:${ownerPod}`, sessionKey);
await cleanup.exec(); // partial failure tolerated; TTL self-cleans

// CLAIM: only when narrowed Lua returns 1 (CAS succeeded)
const ok = await runLuaScript<number>(
  this.redis,
  LUA_CLAIM_SESSION,
  [sessionKey],
  [oldPod, newPod /*...*/],
);
if (ok === 1) {
  const podSwitch = this.redis.pipeline();
  podSwitch.srem(`at_pod:${oldPod}`, sessionKey);
  podSwitch.sadd(`at_pod:${newPod}`, sessionKey);
  await podSwitch.exec();
}

// EXTEND: no cross-slot work; LUA_EXTEND_TTL keys are session + provider index, both in same hash-tagged slot.
```

**Key correctness rule**: every cross-slot pipeline uses `client.pipeline()` (per-key auto-routing) and tolerates partial failure. Never use `client.multi()` for these — `multi()` requires same-slot keys in cluster mode and will throw CROSSSLOT.

2.2.6 Build hash-tagged keys at the call site:

- Session hash: `agent_transfer:{${tenantId}:${contactId}:${channel}}` — using `hashTag(tenantId, contactId, channel)`.
- Provider index: `at_by_provider:{${tenantId}:${contactId}:${channel}}:${provider}:${providerSessionId}` — same hash tag, suffix preserved.
- This ensures session + provider index share a slot for the per-session Lua.

  2.2.7 Document recovery gap in `docs/guides/redis-cluster-mode.md` (Phase 4 deliverable; runbook stub created here): operator-tool snippet to reconcile orphan sessions:

```bash
# Run on a runtime pod
redis-cli --cluster call <node:port> --no-auth-warning <<<'SCAN 0 MATCH agent_transfer:* COUNT 1000' | xargs -I {} redis-cli SADD at_active_sessions {}
```

(Implementation note: this is a placeholder; the runbook in `docs/guides/redis-cluster-mode.md` will contain the actual command tuned to the deployed cluster.)

**Files Touched**: `packages/agent-transfer/src/session/lua-scripts.ts`, `packages/agent-transfer/src/session/transfer-session-store.ts`.

**Exit Criteria**:

- [ ] All 4 Lua scripts execute without `CROSSSLOT` against the cluster harness (INT-4 passes).
- [ ] Pipelined `SADD`/`SREM` succeed in steady state; partial-failure path emits structured log.
- [ ] Session-hash + provider-index keys share `CLUSTER KEYSLOT` for any (tenantId, contactId, channel) triple.
- [ ] `at_active_sessions` and `at_pod:*` slot placement is non-uniform (verified to NOT share the per-session slot — confirms hot-slot avoidance).
- [ ] INT-7 subset (standalone parity) passes.
- [ ] Recovery-gap operator snippet documented in runbook draft.

**Test Strategy**:

- Integration: INT-4 (happy + simulated crash path), ERR-4 (pipeline partial failure recovery).
- Unit: existing agent-transfer unit tests keep passing.
- E2E: deferred to E2E-3 in Phase 4 SIT validation.

**Rollback**: revert PR. Old keys (un-tagged) self-expire within session TTL; no data cleanup.

#### Phase 2.3 — Fan-out-barrier

**Tasks**:

2.3.0 **`LUA_CREATE_BARRIER` CROSSSLOT fix** (`packages/execution/src/redis-fan-out-barrier.ts:24-30` body, `:163` call site): the current Lua passes the TTL string (e.g., `"300"`) as `KEYS[2]` and parses with `tonumber(KEYS[2])`. In cluster mode, ioredis computes the slot for both `KEYS[1]` (the barrier hash, slotted by `{barrierId}`) and `KEYS[2]` (`"300"`, slotted by hashing the literal string) — virtually always different slots → CROSSSLOT on every `create()`. Move TTL out of KEYS into ARGV. New body:

```lua
  local ttl = tonumber(ARGV[#ARGV])
  for i = 1, #ARGV - 1, 2 do
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
  end
  redis.call('EXPIRE', KEYS[1], ttl)
  return 1
```

Update call site at `:163` from `this.redis.eval(LUA_CREATE_BARRIER, 2, key, String(ttlSeconds), ...fields)` to `this.redis.eval(LUA_CREATE_BARRIER, 1, key, ...fields, String(ttlSeconds))`.

2.3.1 `packages/execution/src/redis-fan-out-barrier.ts:99` (`LUA_SCAN_RESULT_KEYS`): change body to iterate registry SET:

```lua
local keys = redis.call('SMEMBERS', KEYS[2])  -- KEYS[2] = barrier:{<id>}:result-keys
local results = {}
for _, branchKey in ipairs(keys) do
  local fullKey = KEYS[1] .. ':result:' .. branchKey  -- KEYS[1] = barrier:{<id>}
  local value = redis.call('GET', fullKey)
  if value then
    table.insert(results, fullKey)
    table.insert(results, value)
  end
end
return results
```

All 3 keys (barrier hash, registry SET, per-branch result GET) share `{<id>}` — same slot. Update the `getResults()` eval call site (around `:252`): `this.redis.eval(LUA_SCAN_RESULT_KEYS, 1, this.getBarrierKey(barrierId))` → `this.redis.eval(LUA_SCAN_RESULT_KEYS, 2, this.getBarrierKey(barrierId), this.getRegistryKey(barrierId))`. Add a private helper `getRegistryKey(barrierId): string` that returns `${this.prefix}:{${barrierId}}:result-keys`.

2.3.2 `packages/execution/src/redis-fan-out-barrier.ts:112` (`LUA_DELETE_BARRIER`): same iteration; `DEL` each branch key, then `DEL KEYS[2]` (registry SET), then `DEL KEYS[1]` (barrier hash). Update the `delete()` eval call site (around `:306`) the same way: `numberOfKeys` 1 → 2; pass registry SET key as second argument.

2.3.3 Branch-write path: extend the existing `LUA_COMPLETE_BRANCH` Lua script (currently writes the result via `SET KEYS[2]` at body-line corresponding to redis-fan-out-barrier.ts:75) with `redis.call('SADD', KEYS[3], ARGV[4])` immediately after the SET. Pass the registry SET key as `KEYS[3]` (= `barrier:{<id>}:result-keys`) and `branchKey` as `ARGV[4]`. Update the `eval` call site (around `redis-fan-out-barrier.ts:189` per existing pattern) to bump `numberOfKeys` from 2 to 3 and pass the registry key as the 3rd KEYS argument. All three keys share `{<id>}` → same slot → single Lua atomic write. **Do NOT use a separate `multi()` or `pipeline()` for the SADD** — keeping the SADD inside the same Lua atomicity boundary preserves the existing "completeBranch is fully atomic" contract.

2.3.4 Hash-tag all barrier-related keys at construction: `prefix = 'barrier'`, key = `${prefix}:{${barrierId}}` (NOT `${prefix}:${barrierId}` as before). Cascade through `create`, `completeBranch`, `collectAllResults`, `delete`.

2.3.5 Constructor: keeps the existing local `RedisClient` interface from `redis-callback-registry.ts` (a minimal `{ set, get, del, eval }` shape). Both `ioredis.Redis` and `ioredis.Cluster` satisfy this shape structurally — TypeScript structural typing accepts a `Cluster` instance at the constructor boundary without an explicit cast. Add a one-line type-test in the Phase 2.3 cluster integration test to lock this contract: `const _typeTest: import('./redis-callback-registry.js').RedisClient = clusterClient;`. Note: if a future phase introduces non-Lua operations (e.g., `pipeline()`, `nodes('master')`, or `scanKeys()`) in fan-out-barrier, switch the import to `@agent-platform/redis`'s `RedisClient` (the `Redis | Cluster` union from `types.ts`).

**Files Touched**: `packages/execution/src/redis-fan-out-barrier.ts`.

**Exit Criteria**:

- [ ] `LUA_CREATE_BARRIER` eval call uses `numberOfKeys: 1`; TTL passed as ARGV (cluster CROSSSLOT fix per 2.3.0).
- [ ] `LUA_SCAN_RESULT_KEYS` and `LUA_DELETE_BARRIER` eval calls use `numberOfKeys: 2`; registry SET key passed as second KEYS argument.
- [ ] No `redis.call('KEYS', ...)` remains in the file (grep confirms).
- [ ] Barrier hash + registry SET + all per-branch result keys share `CLUSTER KEYSLOT` (INT-5 verifies).
- [ ] All branches' results are collected via registry SET (no missed branches).
- [ ] `delete` removes everything (no leaked keys; verified via post-delete `scanKeys`).
- [ ] INT-7 subset (standalone parity) passes.

**Test Strategy**:

- Integration: INT-5 (4-branch happy path + cleanup) + grep assertion that no Lua body contains `redis.call('KEYS'`.
- Unit: existing `redis-fan-out-barrier.test.ts` (which uses the grandfathered `FakeRedis`) keeps passing — FakeRedis behavior unchanged for the registry-SET pattern.

**Rollback**: revert PR. Old barrier keys self-expire within per-execution timeout.

---

### Phase 3 — Consumer migration off `.duplicate()` and factory bypass

**Goal**: Replace ~25 `.duplicate()` call sites with `createSubscriber` or `createBullMQPair`. Migrate 3 bypass services to `createRedisConnection`. Land ESLint rule + INT-13 static guard at end of phase.

**Sub-commits** (CLAUDE.md max-3-packages rule):

#### 3a — apps/runtime pub/sub call sites

**Tasks**:
3a.1 **Factory bypass migration** (`apps/runtime/src/services/redis/redis-client.ts:97-100`): replace `new Redis.Cluster(...)` and `new Redis(...)` direct construction with `createRedisConnection(opts)` from `@agent-platform/redis`. Add a local `getRedisHandle(): RedisConnectionHandle | null` accessor (mirrors the shared singleton). The file's `getRedisClient()` API is preserved (return type widened to `RedisClient | null`). This is the **fourth** factory bypass; not previously listed in the feature spec. **Same-edit cleanup**: the file has `console.warn` calls at lines 48, 118, and 176 (CLAUDE.md `console.*` violations); replace each with `log.warn(...)` using `createLogger('redis-client')` from `@abl/compiler/platform` since the file is being modified anyway.
3a.2 `apps/runtime/src/services/redis/redis-client.ts:174` — `client.duplicate()` → `createSubscriber(handle)` using the `getRedisHandle()` added in 3a.1.
3a.3 `apps/runtime/src/websocket/handler.ts:781` — `redis.duplicate()` → `createSubscriber(handle)`.
3a.4 `apps/runtime/src/services/trace/redis-trace-store.ts:510` — `this.redis.duplicate()` → `createSubscriber(handle)`. Update doc comment at `:9`.
3a.5 `apps/runtime/src/services/agent-transfer/index.ts:448` — `redis.duplicate()` → `createSubscriber(handle)`.
3a.6 `apps/runtime/src/services/auth-profile/paused-execution-store.ts:583` — `redis.duplicate()` → `createSubscriber(handle)`.
3a.7 `apps/runtime/src/services/sync-execution.ts:18` — the only `.duplicate(` occurrence in this file is a comment-only reference. The actual subscriber for `SyncExecutionService` is constructed in `server.ts:2004` and passed in (covered by task 3a.8). The only change to this file is updating the comment at `:18` to reference `createSubscriber` instead of `redis.duplicate()`. No code change.

3a.8 `apps/runtime/src/server.ts:2004` — `redis.duplicate({ maxRetriesPerRequest: null })` is the `redisSubscriber` argument constructed for `SyncExecutionService`. This is a **pub/sub subscriber** (despite the `maxRetriesPerRequest: null` override, which is harmless for subscribers — it just prevents timeouts on blocking SUBSCRIBE). Convert to `createSubscriber(handle)`. (Resolves OQ-LLD-3.)
3a.8 **Recount note**: `apps/runtime/src/services/agent-transfer/message-bridge.ts:306` was named in the feature spec / HLD but verified absent (zero `.duplicate()` calls in that file). The cross-pod relay subscriber lives at `agent-transfer/index.ts:448` (3a.5 above). The previously-reported "~16 sites" in apps/runtime is the production count including 3a.1's factory bypass + 6 pub/sub sites + ~9 BullMQ sites covered in sub-3b — total verified by `grep -rn '\.duplicate(' apps/runtime --include='*.ts' | grep -v __tests__` immediately before the sub-3a/3b PRs land.

**Exit**: 7 files migrated (incl. factory bypass); `pnpm --filter=runtime test` + existing E2E suite pass; standalone behavior unchanged.

#### 3b — apps/runtime BullMQ pairs

**Tasks**:
3b.1 (moved to sub-3a as task 3a.8 — `server.ts:2004` is a subscriber, not a BullMQ worker.)
3b.2 `apps/runtime/src/services/message-persistence-queue.ts:904,1002` — both duplicates → `createBullMQPair(handle)`.
3b.3 `apps/runtime/src/services/kms/reencryption-queue.ts:88-89` — both duplicates → `createBullMQPair(handle)`.
3b.4 `apps/runtime/src/services/llm/llm-queue.ts:196,206` — both duplicates → `createBullMQPair(handle)`. Update shutdown logic referenced at `:548`.
3b.5 `apps/runtime/src/services/queues/channel-queues.ts` — **No `.duplicate()` calls in this file**. It uses a local `parseRedisUrl(config.redis.url)` from `./redis-utils.ts` to build BullMQ `ConnectionOptions` for Queue-only instances (no Workers). Migrate by replacing the `parseRedisUrl` import + usage with `createBullMQConnectionOptions(opts)` from `@agent-platform/redis/bullmq`. In cluster mode, `createBullMQConnectionOptions` is insufficient (BullMQ accepts a `Cluster` instance directly at `connection`); for that path, pass `createRedisConnection(opts).client` as the `connection`. Document in the file's header comment that the `parseRedisUrl` local utility is deprecated. Note: `redis-utils.ts` is effectively a fifth factory bypass; this PR closes it for the Queue construction path.

**Exit**: all `apps/runtime` BullMQ pairs migrated; existing BullMQ unit + integration tests pass.

#### 3c — apps/workflow-engine

**Tasks**:
3c.1 `apps/workflow-engine/src/index.ts:733,736,809` — three duplicates → `createBullMQPair(handle)` (one pair per queue+worker tuple).
3c.2 `apps/workflow-engine/src/services/trigger-scheduler.ts:64-65` — both duplicates → `createBullMQPair(handle)`.
3c.3 `apps/workflow-engine/src/services/callback-delivery-worker.ts:51-52` — both duplicates → `createBullMQPair(handle)`.
3c.4 `apps/workflow-engine/src/services/redis.ts` — replace `new Redis(...)` direct construction with `createRedisConnection(opts)` from `@agent-platform/redis`. Preserve existing `getRedisClient()` API surface (return type `RedisClient | null`); internal callers continue to receive the client.

**Exit**: workflow-engine no longer constructs Redis directly; all BullMQ pairs migrated; existing tests pass.

#### 3d — apps/search-ai connector-presence

**Tasks**:
3d.1 `apps/search-ai/src/services/connector-presence.service.ts` — replace `new Redis(...)` construction with `createRedisConnection(opts)`. Preserve service interface unchanged.

**Exit**: connector-presence no longer constructs Redis directly; existing tests pass.

#### 3e — apps/search-ai-runtime cache wrapper

**Tasks**:
3e.1 `apps/search-ai-runtime/src/services/cache/redis-client.ts` — replace direct construction with `createRedisConnection(opts)`. The wrapper continues to expose a `.keys(pattern)` method (consumed by `idp-token-validator-compat.ts:36` and `end-user-auth.service.ts:89` adapters); internally, this method now delegates to `scanKeys` and returns an array. Adapter callers see no API change.

**Exit**: cache wrapper migrated; both adapter consumers (`idp-token-validator-compat.ts`, `end-user-auth.service.ts`) work unchanged.

#### 3f — Session-store race mitigation (GAP-003)

**Tasks**:
3f.0 **`DistributedLockManager` type widening** (`packages/shared-observability/src/distributed-lock.ts:39-41`): the constructor signature is `constructor(redis: Redis)`. All operations are single-key `SET NX PX` (already cluster-safe per HLD §8 Dependencies "Distributed Locks"), but the type forbids passing a `Cluster` instance. Widen to `constructor(redis: RedisClient)` (import from `@agent-platform/redis`). Identical runtime behavior; allows cluster-mode runtime deployments to construct the lock manager without an `as Redis` cast.

3f.1 `apps/runtime/src/services/session/redis-session-store.ts` — hash-tag the reverse-lookup key. Today: `sess-tid:{id}` stores `{tid}` (no inner braces). New: `sess-tid:{<sessionId>}` (the inner `{<sessionId>}` is the hash tag itself; key is single-key, slot matches the session-hash slot if and only if the session-hash key is also tagged with `{<sessionId>}` — but the session hash today is `sess:{tid}:{id}`, slotted by `{tid}`). Decision: store both forms slot-co-located by hash-tagging the session hash and reverse-lookup with the same tag, OR add retry-on-miss in `resolveTenantId`. **Pick retry-on-miss** for minimal disruption: in `resolveTenantId(sessionId)`, if first GET returns null, retry once after a 50 ms sleep. Document the rationale in code: "Cluster-mode pipeline reordering may make the reverse-lookup key visible briefly after the session-hash key; single retry covers the gap. Standalone mode never hits the retry."

**Exit**: INT-11 passes (1000 tight-loop resolves succeed in cluster mode).

#### 3g — ESLint rule + static guard

**Tasks**:
3g.1 Extend `.eslintrc.base.json` with a second `no-restricted-syntax` selector:

```json
{
  "selector": "CallExpression[callee.type='MemberExpression'][callee.property.name='duplicate']",
  "message": "Use createSubscriber() or createBullMQPair() from @agent-platform/redis instead of .duplicate(). Cluster instances do not expose .duplicate()."
}
```

Severity `error`. The existing `overrides` block from Phase 1 step 1.12 already excludes `packages/redis/**` and `**/__tests__/**`; no change needed there.
3g.2 `packages/redis/src/__tests__/migration-completeness.static.test.ts` (existing from Phase 1): add INT-13 portion — grep for `.duplicate(` outside the package and tests, assert empty.

**Exit**: ESLint reports zero violations across the repo; INT-13 passes; existing E2E suite passes.

**Files Touched (Phase 3 total)**:

- 7 files in `apps/runtime` (sub-3a)
- 5 files in `apps/runtime` BullMQ (sub-3b)
- 4 files in `apps/workflow-engine` (sub-3c)
- 1 file in `apps/search-ai` (sub-3d)
- 1 file in `apps/search-ai-runtime` (sub-3e)
- 1 file in `apps/runtime/src/services/session/redis-session-store.ts` (sub-3f)
- 2 ESLint rule files + 1 test file + ESLint config (sub-3g)

**Phase 3 Exit Criteria**:

- [ ] Zero `.duplicate()` calls outside `packages/redis/src/**` and tests (grep + INT-13 confirm).
- [ ] All three bypass services use `createRedisConnection` (`apps/workflow-engine/src/services/redis.ts`, `apps/search-ai/src/services/connector-presence.service.ts`, `apps/search-ai-runtime/src/services/cache/redis-client.ts`).
- [ ] ESLint reports zero violations of the new `no-restricted-syntax` `.duplicate()` selector.
- [ ] All existing tests pass — standalone parity confirmed.
- [ ] INT-3 (BullMQ pair cluster + failover) passes.
- [ ] INT-11 (session-store race) passes.

**Rollback**: per-sub-commit revert is safe because each sub-commit keeps standalone behavior unchanged. Worst case: revert the entire phase; helpers from Phase 0 remain unused, no harm done.

---

### Phase 4 — SIT validation

**Goal**: Stand up SIT with `REDIS_CLUSTER=true`; validate p95 ≤ 2× standalone, p50 ≤ 1.1×, zero `redis.crossslot.errors`, pub/sub reconnect ≤ 30 s, write-throughput degradation ≤ 20% during reshard.

**Tasks**:

4.1 Update SIT helm values: set `REDIS_CLUSTER: 'true'` in `deploy/helm-values/sit/values.yaml` (or whatever the SIT values path is — confirm during SIT bring-up; this is a one-line change once verified).

4.2 Run full E2E suite against SIT — every cluster `*.cluster.test.ts` plus the existing standalone suite.

4.3 Run k6 load tests via `load-test-analysis` skill:

- Scenario A: 1000 RPS sustained, 5 min — compare cluster vs standalone p50/p95.
- Scenario B: slot reshard mid-traffic — measure write-throughput degradation.
- Scenario C: master failover under 500 RPS — measure failover-blip duration (target ≤ 30 s p95).

  4.4 GAP-008 verification: monitor BullMQ Worker behavior across forced master failover. If Worker stalls > 30 s after reconnect, enable `createBullMQPair(handle, { watchdog: true })` for SIT and re-test. Decision point: if watchdog is required, Phase 5 must enable it for prod tiers.

  4.5 Document operator runbook (`docs/guides/redis-cluster-mode.md` NEW):

- `REDIS_CLUSTER` flag flip procedure.
- Recovery-gap reconciliation snippet (FR-9 / D-5).
- Failure-mode runbook: master loss, slot resharding, cluster-bus partition.
- Dashboard / alert links (per OQ-5).

  4.6 Confirm OQ-2 (tier-S Sentinel direction with stakeholders): keep Sentinel for tier-S (current scope). Note in runbook.

  4.7 Confirm OQ-H-2 (canary path): document SIT → tier-M direct path; if pre-prod env exists, add 7d soak step before tier-M.

  4.8 **Chaos rehearsal** (round-7 finding from Houzz migration retrospective): before tier-M rollout, run a SIT exercise that injects (a) `CLUSTER RESHARD` mid-load, (b) `docker stop` of a master under load, and (c) prolonged partition (cluster-bus block for 30 s). Capture jemalloc memory fragmentation metrics during slot resharding (Houzz observed fragmentation requiring rolling restarts). Block tier-M rollout if fragmentation > 1.5x baseline or if any chaos scenario produces > 1 % error rate.

  4.9 **Document split-brain write-loss behavior** in the runbook (round-7 finding): with `cluster-require-full-coverage: 'no'`, the cluster accepts writes to available slots even when minority slots are unreachable. After partition heals, minority-side writes are silently lost (last-writer-wins on the majority). For session data (agent-transfer), this can produce divergent session state. Operators must understand this trade-off when responding to partition events.

  4.10 **Document pub/sub scaling cliff** (round-7 finding from Redis #2672): traditional pub/sub broadcast cost is O(masters × message size). At 50 nodes with 5 KB messages, throughput drops to ~500 RPS. Document the threshold (estimated ~12 masters at current message volumes — tier-XL upper bound) at which sharded pub/sub (GAP-007 follow-up) becomes operationally urgent.

  4.11 **Note BullMQ `getWorkers()` cluster limitation** (round-7 finding from BullMQ #3340): `CLIENT LIST` runs on only one cluster node, so BullMQ's `getWorkers()` / `getWorkersCount()` always undercount in cluster mode. Audit any health-check or operational tooling that uses these APIs; document the limitation in the runbook.

**Files Touched**:

- `deploy/helm-values/sit/values.yaml` (1-line change)
- `docs/guides/redis-cluster-mode.md` (NEW)
- `packages/redis/src/bullmq.ts` (only if GAP-008 watchdog activation needed)

**Exit Criteria**:

- [ ] SIT runs `REDIS_CLUSTER=true` for ≥ 7 days with zero `redis.crossslot.errors`.
- [ ] k6 reports cluster p95 ≤ 2× standalone, p50 ≤ 1.1×, slot-cache refresh after MOVED ≤ 500 ms.
- [ ] Write throughput degradation during slot resharding ≤ 20%.
- [ ] Forced master failover recovers within 30 s end-to-end (pub/sub + BullMQ).
- [ ] Operator runbook landed and reviewed by SRE.
- [ ] GAP-008 watchdog decision recorded; flag set per outcome.

**Test Strategy**:

- E2E: full `*.cluster.test.ts` suite against SIT cluster.
- Manual / chaos: k6 + `redis-cli CLUSTER FAILOVER` + `docker stop` (in SIT env).
- Observability: assert `redis.crossslot.errors == 0`, `redis.cluster.failover` increments only on triggered events.

**Rollback**: SIT-only flag flip; redeploy with `REDIS_CLUSTER: 'false'` to revert. No prod impact.

---

### Phase 5 — Production rollout

**Goal**: Enable cluster mode in tier-M, then tier-L, then tier-XL, with 7d soak between each.

**Tasks**:

5.1 `deploy/helm-values/tier-m/values.yaml` — set `REDIS_CLUSTER: 'true'`. Soak 7 days. Monitor `redis.crossslot.errors`, `redis.cluster.failover`, p95.

5.2 If GAP-008 watchdog needed (per Phase 4): set `WATCHDOG_ENABLED: 'true'` env in tier-M values.

5.3 If tier-M passes 7d soak with zero CROSSSLOT and p95 within budget: `deploy/helm-values/tier-l/values.yaml` flip; soak 7 days.

5.4 Same for `deploy/helm-values/tier-xl/values.yaml`; soak 7 days.

5.4b **Pod-level canary consideration** (round-7 finding from Houzz / Inngest): the current Phase 5 design flips `REDIS_CLUSTER` for an entire tier at once. If post-Phase 4 risk assessment indicates higher uncertainty than expected, evaluate adding a pod-label or percentage-based routing mechanism before tier-M cutover (e.g., 10 % of pods on cluster while 90 % stay standalone for 24 h). This is OQ-LLD-7 — confirmed not required for tier-M based on SIT outcomes; recorded here as an operational option if Phase 4 surfaces unanticipated failure modes.

5.5 30-day post-tier-XL observation window. Promote feature to STABLE in tracking. Update feature spec status: PLANNED → STABLE.

5.6 Update test spec status: PLANNED → STABLE; record final coverage (cluster suite running nightly with zero flakes).

**Files Touched**:

- `deploy/helm-values/tier-{m,l,xl}/values.yaml`
- `docs/features/redis-dual-mode.md` (status update)
- `docs/testing/redis-dual-mode.md` (status update)

**Exit Criteria**:

- [ ] All three tiers running `REDIS_CLUSTER=true` with `redis.crossslot.errors == 0` for ≥ 7d each.
- [ ] No production incidents traced to cluster behavior in the 30d post-enable window.
- [ ] Feature spec + test spec marked STABLE.

**Rollback**: per-tier `REDIS_CLUSTER: 'false'` flag flip + redeploy. Affected tier's reshaped Redis keys self-expire within minutes.

---

## 4. Wiring Checklist

> The #1 agent failure mode is writing code nothing calls. Every new export must have a verified caller before phase exit.

### Package exports

- [ ] `packages/redis/src/index.ts` re-exports `createSubscriber`, `createBullMQPair`, `runLuaScript`, `hashTag`, `scanKeys`, `RedisOperationError`, `RedisCrossSlotError`, `LuaScript`, `getRedisHandle`.
- [ ] `RedisConnectionHandle` from `types.ts` includes `nodes` + `baseOptions` optional fields.
- [ ] `BullMQConnectionPair` widened types are exported.
- [ ] `.eslintrc.base.json` contains both new `no-restricted-syntax` selectors (`.duplicate()` and `.keys()`); existing `findById`-style selectors remain unchanged.

### Consumer wiring (Phase 1)

- [ ] `lambda-deployment-store.ts:111` imports + calls `scanKeys`.
- [ ] `analytics-cache.ts:109` imports + calls `scanKeys`.
- [ ] `definition-cache.ts:93` imports + calls `scanKeys`.
- [ ] `invalidate-definition-cache.ts:21` imports + calls `scanKeys`.
- [ ] `intelligence.ts:966` imports + calls `scanKeys`.
- [ ] `idp-token-validator.ts:332` imports + calls `scanKeys`.
- [ ] `group-membership-cache.ts:130,194` imports + calls `scanKeys` (both call sites).
- [ ] `query-cache.ts:123,147` imports + calls `scanKeys` (both call sites).

### Consumer wiring (Phase 2)

- [ ] `RedisCircuitBreaker` constructor accepts `RedisClient`; existing instantiation sites in `apps/runtime/src/services/circuit-breaker/*` and elsewhere accept the widened type.
- [ ] All circuit-breaker key-construction sites use `hashTag(level, key)`.
- [ ] `TransferSessionStore` constructor accepts `RedisClient`; existing instantiation site (`apps/runtime/src/services/agent-transfer/index.ts` and similar) accepts widened type.
- [ ] `RedisFanOutBarrierStore` constructor accepts `RedisClient`; existing instantiation site in `packages/execution` consumers passes a compatible client.

### Consumer wiring (Phase 3)

- [ ] All 7 pub/sub call sites (sub-3a) use `createSubscriber(handle)`.
- [ ] All 5 BullMQ call sites in `apps/runtime` (sub-3b) use `createBullMQPair(handle)`.
- [ ] All 4 BullMQ call sites in `apps/workflow-engine` (sub-3c) use `createBullMQPair(handle)`.
- [ ] `apps/workflow-engine/src/services/redis.ts` exports `getRedisClient(): RedisClient | null` backed by `createRedisConnection`.
- [ ] `apps/search-ai/src/services/connector-presence.service.ts` constructs Redis via `createRedisConnection`.
- [ ] `apps/search-ai-runtime/src/services/cache/redis-client.ts` constructs Redis via `createRedisConnection`; its `.keys()` method delegates to `scanKeys`.
- [ ] Adapter callers (`idp-token-validator-compat.ts:36`, `end-user-auth.service.ts:89`) work unchanged after wrapper migration.
- [ ] `redis-session-store.ts` `resolveTenantId` retry-on-miss applied (GAP-003).
- [ ] ESLint `no-redis-duplicate` and `no-redis-keys-command` rules registered in root config.

### Test wiring

- [ ] `tools/cluster-test-harness.ts` imported by every `*.cluster.test.ts`.
- [ ] `vitest.cluster.config.ts` discovered by `pnpm test:cluster`.
- [ ] `package.json` script `test:cluster` defined and runs locally.
- [ ] CI nightly job + opt-in PR label `[run:cluster-tests]` configured in `.bitbucket-pipelines.yml` (or equivalent CI config — confirm during Phase 0 LLD review with SRE).

### Observability wiring

- [ ] `redis.crossslot.errors` increments on `RedisCrossSlotError` in `runLuaScript`.
- [ ] `redis.moved.redirects` increments on ioredis `Cluster` `+redirect` event.
- [ ] `redis.cluster.failover` increments on ioredis `Cluster` `+node` / `-node` events.
- [ ] `redis.subscriber.reconnect` increments on every `createSubscriber` reconnect attempt + emits structured log `{ eventType: 'redis.subscriber.reconnect', ... }`.
- [ ] Counters are emitted via `@opentelemetry/api`'s global meter provider. No app-level wiring needed beyond the existing OTel SDK registration that runtime / workflow-engine already perform at startup (observed via `packages/agent-transfer/src/observability/metrics.ts` reference pattern).

### Studio UI wiring (N/A)

This feature has no Studio UI surface (per HLD §6).

The one Studio E2E (`E2E-ERR-1`) exercises a pre-existing trigger form under cluster mode — no new UI code is added by this LLD.

---

## 5. Cross-Phase Concerns

### Database migrations

None. No MongoDB schema changes. Redis key reshape only; old/new formats coexist via TTLs (per HLD §5).

### Feature flags

- `REDIS_CLUSTER` env var (already exists in `RedisConfigSchema`; LLD wires `resolveRedisOptionsFromEnv` to read it). Default `false`. Operator-set via helm values.
- `BULLMQ_WATCHDOG_ENABLED` (new, Phase 4 conditional): env-driven; default `false`. Read by `createBullMQPair` if exposed; alternative is per-call-site `{ watchdog: true }` opts. Decision in Phase 4 based on GAP-008 outcome.

### Configuration changes

| Variable                  | Where consumed                                                 | Default | Phase introduced |
| ------------------------- | -------------------------------------------------------------- | ------- | ---------------- |
| `REDIS_CLUSTER`           | `resolveRedisOptionsFromEnv`, `resolveBullMQConnectionFromEnv` | `false` | P0               |
| `BULLMQ_WATCHDOG_ENABLED` | `createBullMQPair`                                             | `false` | P4 (conditional) |

### CI / build configuration

- `package.json` adds `test:cluster` script.
- `.bitbucket-pipelines.yml` (or equivalent): nightly job runs `pnpm test:cluster`; PR opt-in via `[run:cluster-tests]` label or path-filter on `packages/redis/`, `packages/circuit-breaker/`, `packages/agent-transfer/`, `packages/execution/`.
- `vitest.cluster.config.ts` configures test-name filter `*.cluster.test.ts`, `testTimeout: 30_000`, `teardownTimeout: 60_000`.

### Lint configuration

- Two ESLint custom rules registered in root config; severity `error`.
- Rules excluded from `__tests__/` paths (test fixtures may exercise the violations intentionally — e.g., UT-ERR-3 verifies `.duplicate()` on `Cluster` throws, INT-9 verifies raw `KEYS` returns partial results).
- Rules excluded from `packages/redis/src/**` (the helpers themselves call `.duplicate()` and use `keys` for legitimate reasons).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete; each phase's exit criteria met.
- [ ] Every functional requirement (FR-1 .. FR-16) covered by at least one task with verified test coverage:
  - FR-1: Tasks 0.4 + INT-1, INT-7, E2E-2.
  - FR-2: Tasks 0.5 + INT-3, E2E-WIRE-1.
  - FR-3: Tasks 0.6 + INT-1, INT-7, INT-10.
  - FR-4: Tasks 0.7 + UT-1.
  - FR-5: Tasks 0.8 + INT-2, INT-12, E2E-6.
  - FR-6: Phase 3 sub-3a/b/c + INT-13 + ESLint rule.
  - FR-7: Phase 1 + INT-14 + ESLint rule.
  - FR-8: Phase 2.1 + INT-1.
  - FR-9: Phase 2.2 + INT-4 + E2E-3.
  - FR-10: Phase 2.3 + INT-5.
  - FR-11: Phase 3 sub-3c/d/e.
  - FR-12: Tasks 0.11 + INT-6, UT-3.
  - FR-13: All phases keep standalone working; E2E-PARITY enforces no regression in CI.
  - FR-14: Tasks 0.13/0.14/0.15 + cluster suite running.
  - FR-15: Tasks 0.4 reconnect logic + INT-3 + E2E-2.
  - FR-16: Tasks 0.3/0.9 + observability counters wired in INT-1, E2E-2, etc.
- [ ] Every gap (GAP-001 .. GAP-008) has a mitigation or documented acceptance:
  - GAP-001: documented as known limitation; chaos tests are manual in SIT (Phase 4).
  - GAP-002: documented as known limitation in non-atomic multi-key operations; session cleanup audit covered by sub-3f.
  - GAP-003: addressed by sub-3f retry-on-miss; INT-11 verifies.
  - GAP-004: documented; `runLuaScript` standardizes on `eval`.
  - GAP-005: addressed by `scanKeys` dedupe SET + per-node retry; INT-12 verifies.
  - GAP-006: documented; queue sharding deferred to follow-up feature.
  - GAP-007: documented; sharded pub/sub deferred to follow-up.
  - GAP-008: addressed by D-12 watchdog scaffolding; activated only if Phase 4 SIT shows the issue.
- [ ] E2E + integration tests from `docs/testing/redis-dual-mode.md` all passing.
- [ ] No regression in existing tests (`pnpm build && pnpm test`).
- [ ] `REDIS_CLUSTER=true` validated in SIT for ≥ 7 days with zero CROSSSLOT.
- [ ] `REDIS_CLUSTER=true` rolled out to tier-M, tier-L, tier-XL with 7d soak between each.
- [ ] Operator runbook (`docs/guides/redis-cluster-mode.md`) landed and SRE-reviewed.
- [ ] Feature spec + test spec status updated to STABLE.

---

## 7. Open Questions

1. **OQ-LLD-1** — Confirm the SIT helm values path (`deploy/helm-values/sit/values.yaml` is assumed; SRE may use a different convention). Locked in during Phase 4 bring-up.
2. **OQ-LLD-2** — `apps/runtime/src/services/sync-execution.ts:18` is a comment-only line. The actual `.duplicate()` call must be located by grep at sub-3a time; confirm the call site is a pub/sub pattern (→ `createSubscriber`) rather than a BullMQ pair.
3. **OQ-LLD-3** — `apps/runtime/src/server.ts:2004` — single duplicate may be a half of a BullMQ pair (the queue half is elsewhere) or a standalone worker connection. Sub-3b1 audits the caller before deciding `createSubscriber` vs `createBullMQPair`.
4. **OQ-LLD-4** — ESLint rule scope: should the rule allow `.duplicate()` inside `node_modules/` (it currently doesn't matter — ESLint ignores `node_modules` by default — but tooling that lints generated code may surface false positives). Default: keep the rule scoped to first-party `apps/**` and `packages/**` only.
5. **OQ-LLD-5** — INT-3 cluster failover: should the test be tagged `@chaos` (nightly) or run on every PR via `pnpm test:cluster`? Recommend `@chaos`-tagged because failover takes 5-30 s and would slow PR feedback; nightly is sufficient.
6. **OQ-LLD-6** — Carries forward from HLD: OQ-1 (timeline), OQ-2 (Sentinel direction), OQ-4 (lint severity — recommended `error`/block; confirmed in D-7), OQ-5 (dashboard ownership), OQ-H-1 (BullMQ #2964 — verified during P4), OQ-H-2 (canary path), OQ-H-3 (operator reconciliation tool — snippet only per D-5).

---

## 8. References

- Feature spec: [`../features/redis-dual-mode.md`](../features/redis-dual-mode.md)
- HLD: [`../specs/redis-dual-mode.hld.md`](../specs/redis-dual-mode.hld.md)
- Test spec: [`../testing/redis-dual-mode.md`](../testing/redis-dual-mode.md)
- HLD audit log: [`../sdlc-logs/redis-dual-mode/hld-phase.log.md`](../sdlc-logs/redis-dual-mode/hld-phase.log.md)
- Connection factory: `packages/redis/src/connection.ts`
- BullMQ wiring: `packages/redis/src/bullmq.ts`
- Type union: `packages/redis/src/types.ts`
- Circuit-breaker: `packages/circuit-breaker/src/{scripts,redis-circuit-breaker}.ts`
- Agent-transfer Lua: `packages/agent-transfer/src/session/lua-scripts.ts`
- Fan-out-barrier: `packages/execution/src/redis-fan-out-barrier.ts`
- Helm values: `deploy/helm-values/tier-{s,m,l,xl}/values.yaml`
- Platform invariants: `CLAUDE.md` (#2 Tenant Isolation, #3 Stateless Distributed, #4 Traceability, #6 Performance)
- ioredis Cluster: https://github.com/redis/ioredis#cluster
- BullMQ Cluster: https://docs.bullmq.io/guide/connections#cluster
- BullMQ #2964 (GAP-008): https://github.com/taskforcesh/bullmq/issues/2964
- BullMQ #3340 (`getWorkers()` cluster limitation): https://github.com/taskforcesh/bullmq/issues/3340
- BullMQ #906 (cluster prefix): https://github.com/taskforcesh/bullmq/issues/906
- BullMQ "Going to Production": https://docs.bullmq.io/guide/going-to-production
- BullMQ Redis Cluster pattern: https://docs.bullmq.io/bull/patterns/redis-cluster
- ioredis #1189 (MOVED retry storm): https://github.com/redis/ioredis/issues/1189
- ioredis #1766 (slots-cache infinite loop): https://github.com/redis/ioredis/issues/1766
- ioredis #2071 (slots-cache after 5.9.x): https://github.com/redis/ioredis/issues/2071
- ioredis #581 (`enableOfflineQueue` + Cluster memory growth): https://github.com/redis/ioredis/issues/581
- Redis #2672 (pub/sub O(N) at scale): https://github.com/redis/redis/issues/2672
- Redis Cluster Spec: https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
- Houzz Migration retrospective: https://blog.houzz.com/migration-to-redis-cluster/
- Inngest sharding lessons: https://www.inngest.com/blog/sharding-at-inngest
- cluster-key-slot (Apache-2.0; recommended for test slot-equality assertions): https://www.npmjs.com/package/cluster-key-slot
- @testcontainers/redis (MIT; option for cluster harness lifecycle — see appendix): https://www.npmjs.com/package/@testcontainers/redis

---

## Appendix A: Round 6-8 Audit Findings & Resolutions

**Round 6 (platform audit)** — 1 CRITICAL (re-classified HIGH; runtime works, type clarification needed), 3 HIGH, ~6 MEDIUM. All resolved:

| Finding                                                    | Resolution                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- | ---------- | ----------- | -------------------------------------------------------------- |
| `observability.ts` reinvents OTel                          | Replaced custom Counter / `setMetricsSink` with direct `@opentelemetry/api` usage (matches `packages/agent-transfer/src/observability/metrics.ts` reference pattern). Wiring checklist updated.                            |
| `errors.ts` should extend platform `AppError`              | Updated section 1 errors.ts spec to extend `AppError` from `@agent-platform/shared-kernel` with `code: 'REDIS_OPERATION_ERROR'` / `'REDIS_CROSSSLOT_ERROR'`. Mirrors existing `CircuitOpenError extends AppError` pattern. |
| `readFileSync` async cascade                               | Task 2.1.1 expanded to specify cascade through `getScripts()` and `registerScripts()`; lock decision (top-level await vs lazy resolve) at Phase 2.1 PR time based on verified ESM/build target.                            |
| Fan-out-barrier `RedisClient` type                         | Task 2.3.5 clarified: ioredis `Cluster` structurally satisfies the local minimal interface; lock with a one-line type-test in cluster integration test.                                                                    |
| Phantom task 3a.7 (sync-execution.ts)                      | Task 3a.7 narrowed to comment-only update; actual subscriber covered by 3a.8 (`server.ts:2004`).                                                                                                                           |
| `DistributedLockManager` type widening missed              | New task 3f.0 widens constructor `Redis` → `RedisClient`.                                                                                                                                                                  |
| `console.warn` violations in `redis-client.ts`             | Task 3a.1 expanded to replace `console.warn` at `:48,118,176` with `log.warn` from `createLogger`.                                                                                                                         |
| `LUA_END_SESSION` `or ''` fallback                         | Task 2.2.2 updated with explicit `or ''` Lua pattern matching the original code.                                                                                                                                           |
| `LUA_UPDATE_SESSION` not addressed                         | New task 2.2.4b explicitly notes this script is single-key and requires no change.                                                                                                                                         |
| ESLint `.keys()` selector false positives on `Object.keys` | Task 1.11 narrowed selector to receiver-name match (`redis                                                                                                                                                                 | client | redisClient | this.redis | this.client | this.redisClient`); INT-14 grep is the authoritative backstop. |

**Round 7 (industry research)** — 6 RISK + 2 IMPROVEMENT + 2 GAP findings. Integrated:

| Finding                                                                             | Resolution                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `retryDelayOnFailover` rationale conflated with `retryDelayOnMoved` (ioredis #1189) | Task 0.3 expanded with both options and explicit semantics. `retryDelayOnMoved: 50` added (was unset → ping-pong storm risk). |
| ioredis #1766/#2071 awareness                                                       | Task 0.3 documents the risk; Phase 4.5 runbook will cover symptoms + `slotsRefreshInterval` mitigation if it manifests.       |
| BullMQ #2964 severity (workers stall on every reconnect)                            | D-12 reversed to default `watchdog: true` for cluster mode; default `false` for standalone (where #2964 doesn't manifest).    |
| BullMQ `getWorkers()` undercount in cluster (#3340)                                 | New task 4.11 — audit and document.                                                                                           |
| BullMQ queue prefix hash tags                                                       | Task 0.5 updated to document `prefix: '{...}'` requirement.                                                                   |
| Pub/sub O(N) scaling cliff (Redis #2672)                                            | New task 4.10 — quantify threshold + document in runbook. GAP-007 follow-up reaffirmed.                                       |
| `cluster-require-full-coverage: 'no'` split-brain write-loss                        | New task 4.9 — explicit runbook section.                                                                                      |
| `enableOfflineQueue` memory pressure under partition (ioredis #581)                 | Task 0.3 documents the trade-off; Phase 4 runbook covers tuning if symptoms appear.                                           |
| Chaos rehearsal before tier-M (Houzz retrospective)                                 | New task 4.8 — Phase 4 SIT exercise with reshard / docker-stop / partition; jemalloc fragmentation gating.                    |
| Pod-level canary within tier (Houzz / Inngest)                                      | New task 5.4b — operational option; not blocking unless Phase 4 surfaces concerns (OQ-LLD-7).                                 |

**Round 8 (OSS library audit)** — no GPL candidates; 2 viable adoptions:

| Surface                                                            | Recommendation                                                                                                                                                                                                    | Status                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runLuaScript`, `scanKeys`, `createSubscriber`, `createBullMQPair` | Build custom (no viable OSS replacement); ioredis primitives + `node-redis` `scanIterator` are design references only.                                                                                            | Locked.                                                                                                                                                                                                                                                                                                      |
| `hashTag`                                                          | Build custom (1 line). **Adopt `cluster-key-slot` (Apache-2.0, 8.2M weekly DL) for test slot-equality assertions** — replaces hand-rolled slot-comparison with one-liner `assert(keySlot('a') === keySlot('b'))`. | Adopted: add `cluster-key-slot` as dev-dep in Phase 0; use in INT-1 / INT-4 / INT-5 / hash-tag isolation tests.                                                                                                                                                                                              |
| `ClusterTestHarness`                                               | **Optional adoption: `@testcontainers/redis` (MIT, 560k weekly DL)** for container lifecycle. Saves ~1.5 dev-days; eliminates `docker-compose.cluster.yml` static file. Failover primitives still custom.         | Recorded as OQ-LLD-8: implementer may choose testcontainers OR docker-compose during Phase 0; both paths satisfy the harness contract (`boot`/`flushAllMasters`/`forceFailover`/`getNodes`). Default to `docker-compose.cluster.yml` since it matches the existing platform pattern in `docker-compose.yml`. |

**New Open Questions added by Rounds 6-8**:

- **OQ-LLD-7**: Pod-level canary within a tier — confirm not required after Phase 4 SIT outcomes; activate only if anomalies surface.
- **OQ-LLD-8**: Cluster harness lifecycle — `@testcontainers/redis` vs `docker-compose.cluster.yml`. Default chosen: docker-compose for parity with existing platform pattern; implementer may switch during Phase 0 if testcontainers offers material velocity.
